using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private const string CloseRouteScope = "POST /process-instances/{instanceId}/close";

    public async Task<ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>> CloseAsync(
        Guid instanceId,
        CloseInstanceRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var reason = request.Reason?.Trim() ?? string.Empty;
        var requestFailure = ValidateCloseRequest(reason);
        if (requestFailure is not null)
        {
            return CloseFailed(requestFailure);
        }

        var requestHash = Convert.ToHexStringLower(SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(new { instanceId, reason }, JsonOptions)));
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadCloseReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var exists = await _dbContext.WorkflowInstances
                .AsNoTracking()
                .AnyAsync(item => item.Id == instanceId, cancellationToken)
                .ConfigureAwait(false);
            if (!exists)
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.NotFound, "INSTANCE_NOT_FOUND", "流程实例不存在", "指定的流程实例不存在。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var instance = await LoadInstanceForUpdateAsync(instanceId, cancellationToken)
                .ConfigureAwait(false);
            if (instance.Revision - 1 != expectedRevision)
            {
                return await RollbackCloseFailureAsync(transaction, RevisionMismatch(), cancellationToken)
                    .ConfigureAwait(false);
            }

            if (instance.Status == "closed")
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "INSTANCE_ALREADY_CLOSED", "流程已经关闭", "已关闭的流程不能重复关闭。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (!actor.CanClose)
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Forbidden, "INSTANCE_CLOSE_FORBIDDEN", "不能关闭该流程", "当前账号没有关闭流程的动作权限。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleAsync(item => item.Id == instance.DefinitionId, cancellationToken)
                .ConfigureAwait(false);
            if (definition.Type != "approval")
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "INSTANCE_TYPE_NOT_SUPPORTED", "不能使用此操作", "自由协作事项请使用自由协作关闭操作。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (!TryParseVersion(version, out var basic, out var snapshot))
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "LOCKED_VERSION_INVALID", "流程版本不可用", "实例锁定的审批流程版本配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                .ConfigureAwait(false);
            if (!actor.IsSuperAdmin && !access.IsCloser(actor.EffectiveUserId))
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Forbidden, "INSTANCE_CLOSE_FORBIDDEN", "不能关闭该流程", "当前账号不属于实例锁定版本的有效关闭流程权限组。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (instance.Status == "rejected-pending"
                && ReadString(snapshot!["flow"]?["meta"] as JsonObject, "rejectionHandling") == "resubmit-only")
            {
                return await RollbackCloseFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "INSTANCE_CLOSE_NOT_ALLOWED", "当前流程不能关闭", "实例锁定版本只允许驳回后重新提交。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var now = _timeProvider.GetUtcNow();
            var unfinishedTasks = await _dbContext.WorkflowTasks
                .Where(task => task.InstanceId == instance.Id
                    && (task.Status == "inactive" || task.Status == "pending"))
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            foreach (var task in unfinishedTasks)
            {
                task.Status = "cancelled";
                task.CompletedAt = now.UtcDateTime;
                task.Revision = checked(task.Revision + 1);
            }

            instance.Status = "closed";
            instance.CurrentNodeSummary = "流程结束";
            instance.CurrentAssigneeId = null;
            instance.ClosedAt = now.UtcDateTime;
            instance.UpdatedAt = now.UtcDateTime;

            var cancelledTaskIds = unfinishedTasks.Select(task => task.Id).ToArray();
            AddCloseFacts(instance, reason, cancelledTaskIds, actor, traceId, now);
            var value = new CloseProcessInstanceCommandValue(
                instance.Id,
                instance.Revision,
                cancelledTaskIds,
                false);
            _dbContext.IdempotencyRecords.Add(CreateCloseIdempotencyRecord(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                value,
                now));

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return CloseFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>?> LoadCloseReplayAsync(
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
                  AND [route_scope] = {CloseRouteScope}
                  AND [idempotency_key] = {idempotencyKey}
                """)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(existing.RequestHash),
                Encoding.ASCII.GetBytes(requestHash)))
        {
            return CloseFailed(Failure(
                ProcessInstanceCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于其他请求",
                "请为不同的关闭请求生成新的 Idempotency-Key。"));
        }

        if (existing.Status != "completed" || string.IsNullOrWhiteSpace(existing.ResponseBodyJson))
        {
            return CloseFailed(Failure(
                ProcessInstanceCommandError.Conflict,
                "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                "相同请求正在处理中",
                "请稍后使用相同的 Idempotency-Key 重试。"));
        }

        var stored = JsonSerializer.Deserialize<CloseProcessInstanceCommandValue>(
            existing.ResponseBodyJson,
            JsonOptions) ?? throw new InvalidDataException("Stored close response is invalid.");
        return new ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private static ProcessInstanceCommandFailure? ValidateCloseRequest(string reason)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            return Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "REASON_REQUIRED",
                "请填写关闭原因",
                "关闭原因不能为空。",
                [Issue("reason", "REQUIRED", "请填写关闭原因。")]);
        }

        return reason.Length <= 2000
            ? null
            : Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "关闭数据无效",
                "关闭原因不能超过 2000 个字符。",
                [Issue("reason", "INVALID_LENGTH", "关闭原因不能超过 2000 个字符。")]);
    }

    private void AddCloseFacts(
        WorkflowInstanceEntity instance,
        string reason,
        IReadOnlyList<Guid> cancelledTaskIds,
        ProcessInstanceActor actor,
        string traceId,
        DateTimeOffset now)
    {
        _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
        {
            Id = Guid.NewGuid(),
            EventType = "instance-closed",
            InstanceId = instance.Id,
            Round = instance.CurrentRound,
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            OccurredAt = now.UtcDateTime,
            MetadataJson = new JsonObject
            {
                ["reason"] = reason,
                ["cancelledTaskIds"] = new JsonArray(cancelledTaskIds
                    .Select(id => (JsonNode?)JsonValue.Create(id))
                    .ToArray()),
            }.ToJsonString(JsonOptions),
        });
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "process-instance",
            ResourceId = instance.Id,
            Action = "close",
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
    }

    private static IdempotencyRecordEntity CreateCloseIdempotencyRecord(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CloseProcessInstanceCommandValue value,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            ActorId = actorId,
            RouteScope = CloseRouteScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = 200,
            ReplayHeadersJson = new JsonObject
            {
                ["etag"] = $"\"{value.Revision}\"",
            }.ToJsonString(JsonOptions),
            ResponseBodyJson = JsonSerializer.Serialize(value, JsonOptions),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddDays(7).UtcDateTime,
        };

    private static ProcessInstanceCommandResult<CloseProcessInstanceCommandValue> CloseFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static async Task<ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>> RollbackCloseFailureAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessInstanceCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return CloseFailed(failure);
    }
}
