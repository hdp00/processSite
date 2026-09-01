using System.Data;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.BackgroundJobs;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService(
    FlowPilotDbContext dbContext,
    TimeProvider timeProvider,
    EmailOutboxWriter emailOutboxWriter) : IProcessInstanceCommandService
{
    private const string CreateRouteScope = "POST /process-instances";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly TimeProvider _timeProvider = timeProvider;
    private readonly EmailOutboxWriter _emailOutboxWriter = emailOutboxWriter;

    public async Task<ProcessInstanceCommandResult<CreateProcessInstanceCommandValue>> CreateAsync(
        CreateProcessInstanceRequest request,
        ProcessInstanceActor actor,
        string idempotencyKey,
        string verifiedEntryBaseUrl,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var requestProblem = ValidateRequest(request);
        if (requestProblem is not null)
        {
            return Failed(requestProblem);
        }

        var requestHash = Convert.ToHexStringLower(
            SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request, JsonOptions)));
        var now = _timeProvider.GetUtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var replay = await LoadReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleOrDefaultAsync(item => item.Id == request.DefinitionId, cancellationToken)
                .ConfigureAwait(false);
            if (definition is null)
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.NotFound, "DEFINITION_NOT_FOUND", "流程不存在", "指定的流程定义不存在。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (definition.IsDisabled || definition.PublishedVersionId is null)
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.NotLaunchable, "DEFINITION_NOT_LAUNCHABLE", "流程当前不可发起", "流程已停用或没有发布版本。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleOrDefaultAsync(
                    item => item.Id == definition.PublishedVersionId
                        && item.DefinitionId == definition.Id,
                    cancellationToken)
                .ConfigureAwait(false);
            if (version is null || version.ValidationStatus != "passed")
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.NotLaunchable, "DEFINITION_NOT_LAUNCHABLE", "流程当前不可发起", "当前发布版本未通过校验。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (!TryParseVersion(version, out var basic, out var snapshot))
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.NotLaunchable, "PUBLISHED_VERSION_INVALID", "发布版本不可用", "当前发布版本的配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                .ConfigureAwait(false);
            if (!access.DependenciesReady)
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.NotLaunchable, "DEFINITION_DEPENDENCY_UNAVAILABLE", "流程依赖当前不可用", "请检查发布版本引用的权限组、角色和用户是否仍然有效。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (!actor.IsSuperAdmin && !access.IsStarter(actor.EffectiveUserId))
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Forbidden, "INSTANCE_CREATE_FORBIDDEN", "不能发起该流程", "当前账号不是该流程发起权限组的有效成员。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var copyFailure = await ValidateCopySourceAsync(
                request,
                definition,
                actor,
                access,
                cancellationToken).ConfigureAwait(false);
            if (copyFailure is not null)
            {
                return await RollbackFailureAsync(transaction, copyFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var form = NormalizeAndValidateForm(request.FormValues!, snapshot!);
            if (form.Failure is not null)
            {
                return await RollbackFailureAsync(transaction, form.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var runtime = BuildInitialRuntime(
                definition.Type,
                version.Id,
                snapshot!,
                form.Values!,
                request,
                access,
                now);
            if (runtime.Failure is not null)
            {
                return await RollbackFailureAsync(transaction, runtime.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var attachments = await ValidateAttachmentsAsync(
                request,
                snapshot!,
                actor.EffectiveUserId,
                cancellationToken).ConfigureAwait(false);
            if (attachments.Failure is not null)
            {
                return await RollbackFailureAsync(transaction, attachments.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var prefix = ReadRequiredString(basic!, "instancePrefix");
            var instanceNumber = await IssueInstanceNumberAsync(prefix, now, cancellationToken)
                .ConfigureAwait(false);
            if (instanceNumber is null)
            {
                return await RollbackFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "INSTANCE_NUMBER_EXHAUSTED", "本月实例编号已用完", "该编号前缀本月的四位流水号已经用完。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var instanceId = Guid.NewGuid();
            var instance = CreateInstanceEntity(
                instanceId,
                instanceNumber,
                definition,
                version,
                actor,
                verifiedEntryBaseUrl,
                form.Values!,
                form.FieldRevisions!,
                runtime.Value!,
                now);

            _dbContext.WorkflowInstances.Add(instance);
            // These runtime tables use database foreign keys but intentionally have no EF navigation
            // properties. Persist each parent level before adding its dependent rows.
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            foreach (var task in runtime.Value!.Tasks)
            {
                task.InstanceId = instanceId;
            }

            _dbContext.WorkflowTasks.AddRange(runtime.Value.Tasks);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            AddRuntimeFacts(instance, runtime.Value, actor, request.CopySourceInstanceId, traceId, now);
            await AddFieldProjectionsAsync(instance, form.Values!, cancellationToken).ConfigureAwait(false);
            AddAttachmentReferences(instanceId, attachments.Value!, actor.EffectiveUserId, now);
            await _emailOutboxWriter.EnqueueAsync(
                instance,
                definition,
                version,
                snapshot!,
                runtime.Value.Tasks,
                now,
                cancellationToken).ConfigureAwait(false);

            definition.InstanceCount = checked(definition.InstanceCount + 1);
            definition.Revision = checked(definition.Revision + 1);
            definition.UpdatedAt = now.UtcDateTime;
            definition.UpdatedBy = actor.EffectiveUserId;
            version.InstanceCount = checked(version.InstanceCount + 1);
            version.Revision = checked(version.Revision + 1);

            var detail = BuildDetail(
                instance,
                definition,
                version,
                actor,
                actor.CanClose && (actor.IsSuperAdmin || access.IsCloser(actor.EffectiveUserId)),
                form.Values!,
                form.FieldRevisions!,
                runtime.Value,
                attachments.Value!);
            _dbContext.IdempotencyRecords.Add(CreateIdempotencyRecord(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                detail,
                now));

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(detail, replayed: false);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed(Failure(
                ProcessInstanceCommandError.Conflict,
                "INSTANCE_CREATE_CONFLICT",
                "流程发起发生冲突",
                "流程配置刚刚发生变化，请刷新页面后重新提交。"));
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessInstanceCommandResult<CreateProcessInstanceCommandValue>?> LoadReplayAsync(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var existing = await _dbContext.IdempotencyRecords
            .FromSqlInterpolated(
                $"""
                SELECT * FROM [flowpilot].[idempotency_records] WITH (UPDLOCK, HOLDLOCK)
                WHERE [actor_id] = {actorId}
                  AND [route_scope] = {CreateRouteScope}
                  AND [idempotency_key] = {idempotencyKey}
                """)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        if (!CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.ASCII.GetBytes(existing.RequestHash),
                System.Text.Encoding.ASCII.GetBytes(requestHash)))
        {
            return Failed(Failure(
                ProcessInstanceCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于其他请求",
                "请为不同的流程发起请求生成新的 Idempotency-Key。"));
        }

        if (existing.Status != "completed" || string.IsNullOrWhiteSpace(existing.ResponseBodyJson))
        {
            return Failed(Failure(
                ProcessInstanceCommandError.Conflict,
                "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                "相同请求正在处理中",
                "请稍后使用相同的 Idempotency-Key 重试。"));
        }

        var detail = JsonSerializer.Deserialize<ProcessInstanceDetailDto>(
            existing.ResponseBodyJson,
            JsonOptions) ?? throw new InvalidDataException("Stored process instance response is invalid.");
        return Succeeded(detail, replayed: true);
    }

    private static ProcessInstanceCommandFailure? ValidateRequest(CreateProcessInstanceRequest request)
    {
        var issues = new List<ProcessInstanceInputIssueDto>();
        if (request.DefinitionId == Guid.Empty)
        {
            issues.Add(Issue("definitionId", "REQUIRED", "请选择要发起的流程。"));
        }

        if (request.FormValues is null)
        {
            issues.Add(Issue("formValues", "REQUIRED", "请填写流程表单。"));
        }

        return issues.Count == 0
            ? null
            : Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "发起数据不完整",
                "请检查流程定义和表单内容。",
                issues);
    }

    private static ProcessInstanceCommandResult<CreateProcessInstanceCommandValue> Succeeded(
        ProcessInstanceDetailDto detail,
        bool replayed) => new(new CreateProcessInstanceCommandValue(detail, replayed), null);

    private static ProcessInstanceCommandResult<CreateProcessInstanceCommandValue> Failed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static async Task<ProcessInstanceCommandResult<CreateProcessInstanceCommandValue>> RollbackFailureAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessInstanceCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return Failed(failure);
    }

    private static ProcessInstanceCommandFailure Failure(
        ProcessInstanceCommandError error,
        string code,
        string title,
        string detail,
        IReadOnlyList<ProcessInstanceInputIssueDto>? issues = null) =>
        new(error, code, title, detail, issues);

    private static ProcessInstanceInputIssueDto Issue(string path, string code, string message) =>
        new(path, code, message);
}
