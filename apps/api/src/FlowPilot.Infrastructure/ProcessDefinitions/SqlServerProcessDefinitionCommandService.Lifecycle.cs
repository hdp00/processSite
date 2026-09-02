using System.Data;
using System.Text.Json;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionCommandService
{
    private const string CopyRouteScope =
        "POST /process-definitions/{definitionId}/copies";
    private const string CreateVersionRouteScope =
        "POST /process-definitions/{definitionId}/versions";

    public async Task<ProcessDefinitionCommandResult<UpdateProcessDefinitionCommandValue>> UpdateAvailabilityAsync(
        Guid definitionId,
        UpdateProcessDefinitionRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var definition = await _dbContext.RuntimeWorkflowDefinitions
            .SingleOrDefaultAsync(item => item.Id == definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return await RollbackFailureAsync<UpdateProcessDefinitionCommandValue>(
                transaction,
                NotFound("DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。"),
                cancellationToken).ConfigureAwait(false);
        }

        if (definition.Revision != expectedRevision)
        {
            return await RollbackFailureAsync<UpdateProcessDefinitionCommandValue>(
                transaction,
                RevisionMismatch("流程定义已被修改", definition.Revision),
                cancellationToken).ConfigureAwait(false);
        }

        if (request.Disabled && definition.PublishedVersionId is null)
        {
            return await RollbackFailureAsync<UpdateProcessDefinitionCommandValue>(
                transaction,
                Conflict(
                    "DEFINITION_NOT_PUBLISHED",
                    "未发布流程不能停用",
                    "请先发布至少一个流程版本。"),
                cancellationToken).ConfigureAwait(false);
        }

        if (definition.IsDisabled == request.Disabled)
        {
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(new UpdateProcessDefinitionCommandValue(definition.Revision));
        }

        var now = UtcNow();
        definition.IsDisabled = request.Disabled;
        definition.Revision++;
        definition.UpdatedAt = now.UtcDateTime;
        definition.UpdatedBy = actor.EffectiveUserId;
        AddLifecycleAudit(
            "process-definition",
            definitionId,
            request.Disabled ? "disable" : "enable",
            ["disabled"],
            actor,
            traceId,
            now);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(new UpdateProcessDefinitionCommandValue(definition.Revision));
    }

    public async Task<ProcessDefinitionCommandResult<bool>> DeleteDefinitionAsync(
        Guid definitionId,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var definition = await _dbContext.RuntimeWorkflowDefinitions
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return await RollbackFailureAsync<bool>(
                transaction,
                NotFound("DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。"),
                cancellationToken).ConfigureAwait(false);
        }

        if (definition.Revision != expectedRevision)
        {
            return await RollbackFailureAsync<bool>(
                transaction,
                RevisionMismatch("流程定义已被修改", definition.Revision),
                cancellationToken).ConfigureAwait(false);
        }

        var hasReferencedVersion = await _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .AnyAsync(
                version => version.DefinitionId == definitionId && version.InstanceCount > 0,
                cancellationToken)
            .ConfigureAwait(false);
        if (definition.PublishedVersionId.HasValue || definition.InstanceCount > 0 || hasReferencedVersion)
        {
            return await RollbackFailureAsync<bool>(
                transaction,
                Conflict(
                    "DEFINITION_DELETE_BLOCKED",
                    "流程定义不能删除",
                    "只有未发布且从未产生实例的流程定义可以删除。"),
                cancellationToken).ConfigureAwait(false);
        }

        await _dbContext.RuntimeWorkflowVersions
            .Where(version => version.DefinitionId == definitionId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        var deleted = await _dbContext.RuntimeWorkflowDefinitions
            .Where(item => item.Id == definitionId && item.Revision == expectedRevision)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        if (deleted != 1)
        {
            throw new DBConcurrencyException("The process definition changed while it was being deleted.");
        }

        AddLifecycleAudit(
            "process-definition",
            definitionId,
            "delete",
            ["definition", "versions"],
            actor,
            traceId,
            UtcNow());
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(true);
    }

    public async Task<ProcessDefinitionCommandResult<CopyProcessDefinitionCommandValue>> CopyAsync(
        Guid definitionId,
        CopyProcessDefinitionRequest request,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);
        var requestHash = HashRequest(
            $"{CopyRouteScope}\n{definitionId:D}:{JsonSerializer.Serialize(request, JsonOptions)}");
        var reservation = await ReserveIdempotencyAsync<CreateProcessDefinitionResponseDto>(
            actor.EffectiveUserId,
            CopyRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return Succeeded(new CopyProcessDefinitionCommandValue(
                reservation.ReplayValue,
                reservation.ReplayRevision!.Value,
                true));
        }

        if (reservation.Failure is not null)
        {
            return Failed<CopyProcessDefinitionCommandValue>(reservation.Failure);
        }

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .AsNoTracking()
                .SingleOrDefaultAsync(item => item.Id == definitionId, cancellationToken)
                .ConfigureAwait(false);
            var sourceVersion = definition is null
                ? null
                : await SelectCopySourceAsync(definition, request.SourceVersionId, cancellationToken)
                    .ConfigureAwait(false);
            if (definition is null || sourceVersion is null)
            {
                var failure = NotFound(
                    "SOURCE_VERSION_NOT_FOUND",
                    "源流程版本不存在",
                    "未找到可以复制的流程版本。");
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return Failed<CopyProcessDefinitionCommandValue>(failure);
            }

            var sourceBasic = ParseBasic(sourceVersion.BasicJson);
            var copyName = NormalizeCopyName(request.Name, sourceBasic.Name);
            if (copyName is null)
            {
                var failure = ValidationFailure(
                    "复制流程定义校验失败",
                    [InputIssue("name", "INVALID_LENGTH", "流程名称长度必须为 1 到 100 个字符。")]);
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return Failed<CopyProcessDefinitionCommandValue>(failure);
            }

            var now = UtcNow();
            var newDefinitionId = Guid.NewGuid();
            var newVersionId = Guid.NewGuid();
            var code = CreateDefinitionCode(sourceBasic.Type, newDefinitionId);
            var basic = sourceBasic with { Name = copyName };
            var snapshot = ParseObject(sourceVersion.SnapshotJson, "snapshot_json");
            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var validation = ValidateVersion(basic, snapshot, catalog, now);
            var basicJson = SerializeNode(CreateBasicNode(basic));
            var snapshotJson = SerializeNode(snapshot);

            await InsertDefinitionAsync(
                newDefinitionId,
                code,
                basic,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertVersionAsync(
                newVersionId,
                newDefinitionId,
                basicJson,
                snapshotJson,
                validation,
                SerializeValidation(validation),
                actor.EffectiveUserId,
                now,
                cancellationToken,
                sourceVersion.Id,
                sourceVersion.VersionLabel).ConfigureAwait(false);
            await ReplaceReferencesAsync(newVersionId, basic, snapshot, cancellationToken)
                .ConfigureAwait(false);
            await ReplaceFieldCatalogAsync(newVersionId, snapshot, cancellationToken)
                .ConfigureAwait(false);
            AddLifecycleAudit(
                "process-definition",
                newDefinitionId,
                "copy",
                ["definition", "version"],
                actor,
                traceId,
                now);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            var response = CreateResponse(
                newDefinitionId,
                newVersionId,
                code,
                basic,
                snapshot,
                validation,
                actor,
                now,
                basicJson,
                snapshotJson,
                new ProcessVersionSourceDto(sourceVersion.Id, sourceVersion.VersionLabel));
            await CompleteIdempotencySuccessAsync(
                reservation,
                201,
                1,
                response,
                $"/api/flowpilot/v1/process-definitions/{newDefinitionId:D}",
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(new CopyProcessDefinitionCommandValue(response, 1, false));
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ProcessDefinitionCommandResult<CreateProcessVersionCommandValue>> CreateVersionAsync(
        Guid definitionId,
        CreateProcessVersionRequest request,
        int expectedDefinitionRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);
        var requestHash = HashRequest(
            $"{CreateVersionRouteScope}\n{definitionId:D}:{request.SourceVersionId:D}:{expectedDefinitionRevision}");
        var reservation = await ReserveIdempotencyAsync<ProcessVersionDto>(
            actor.EffectiveUserId,
            CreateVersionRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return Succeeded(new CreateProcessVersionCommandValue(reservation.ReplayValue, true));
        }

        if (reservation.Failure is not null)
        {
            return Failed<CreateProcessVersionCommandValue>(reservation.Failure);
        }

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleOrDefaultAsync(item => item.Id == definitionId, cancellationToken)
                .ConfigureAwait(false);
            var failure = definition is null
                ? NotFound("DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。")
                : definition.Revision != expectedDefinitionRevision
                    ? RevisionMismatch("流程定义已被修改", definition.Revision)
                    : null;
            var sourceVersion = failure is null
                ? await _dbContext.RuntimeWorkflowVersions
                    .AsNoTracking()
                    .SingleOrDefaultAsync(
                        item => item.DefinitionId == definitionId
                            && item.Id == request.SourceVersionId,
                        cancellationToken)
                    .ConfigureAwait(false)
                : null;
            failure ??= sourceVersion is null
                ? NotFound("SOURCE_VERSION_NOT_FOUND", "源流程版本不存在", "请选择该流程定义下的有效源版本。")
                : null;
            if (failure is not null)
            {
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return Failed<CreateProcessVersionCommandValue>(failure);
            }

            var currentDefinition = definition!;
            var source = sourceVersion!;
            var now = UtcNow();
            var basic = ParseBasic(source.BasicJson);
            var snapshot = ParseObject(source.SnapshotJson, "snapshot_json");
            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var validation = ValidateVersion(basic, snapshot, catalog, now);
            var versionNumber = currentDefinition.NextVersionNumber;
            var versionId = Guid.NewGuid();
            var version = new RuntimeWorkflowVersion
            {
                Id = versionId,
                DefinitionId = definitionId,
                VersionNumber = versionNumber,
                VersionLabel = $"V{versionNumber}",
                SourceVersionId = source.Id,
                SourceVersionLabel = source.VersionLabel,
                BasicJson = source.BasicJson,
                SnapshotJson = source.SnapshotJson,
                ValidationStatus = validation.Status,
                ValidationJson = SerializeValidation(validation),
                ValidatedAt = now.UtcDateTime,
                InstanceCount = 0,
                Revision = 1,
                CreatedAt = now.UtcDateTime,
                CreatedBy = actor.EffectiveUserId,
                UpdatedAt = now.UtcDateTime,
                UpdatedBy = actor.EffectiveUserId,
            };
            _dbContext.RuntimeWorkflowVersions.Add(version);
            currentDefinition.NextVersionNumber++;
            currentDefinition.Revision++;
            currentDefinition.UpdatedAt = now.UtcDateTime;
            currentDefinition.UpdatedBy = actor.EffectiveUserId;
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await ReplaceReferencesAsync(versionId, basic, snapshot, cancellationToken)
                .ConfigureAwait(false);
            await ReplaceFieldCatalogAsync(versionId, snapshot, cancellationToken)
                .ConfigureAwait(false);
            AddLifecycleAudit(
                "process-version",
                versionId,
                "create-version",
                ["sourceVersionId", "snapshot"],
                actor,
                traceId,
                now);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            var response = CreateCopiedVersionResponse(
                version,
                currentDefinition.Code,
                validation,
                actor,
                snapshot);
            await CompleteIdempotencySuccessAsync(
                reservation,
                201,
                1,
                response,
                $"/api/flowpilot/v1/process-definitions/{definitionId:D}/versions/{versionId:D}",
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(new CreateProcessVersionCommandValue(response, false));
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ProcessDefinitionCommandResult<bool>> DeleteVersionAsync(
        Guid definitionId,
        Guid versionId,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var definition = await _dbContext.RuntimeWorkflowDefinitions
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == definitionId, cancellationToken)
            .ConfigureAwait(false);
        var version = await _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .SingleOrDefaultAsync(
                item => item.DefinitionId == definitionId && item.Id == versionId,
                cancellationToken)
            .ConfigureAwait(false);
        if (definition is null || version is null)
        {
            return await RollbackFailureAsync<bool>(
                transaction,
                NotFound("VERSION_NOT_FOUND", "流程版本不存在", "未找到指定的流程版本。"),
                cancellationToken).ConfigureAwait(false);
        }

        if (version.Revision != expectedRevision)
        {
            return await RollbackFailureAsync<bool>(
                transaction,
                RevisionMismatch("流程版本已被修改", version.Revision),
                cancellationToken).ConfigureAwait(false);
        }

        if (definition.PublishedVersionId == versionId || version.InstanceCount > 0)
        {
            return await RollbackFailureAsync<bool>(
                transaction,
                Conflict(
                    "VERSION_DELETE_BLOCKED",
                    "流程版本不能删除",
                    definition.PublishedVersionId == versionId
                        ? "当前发布版本必须先取消发布。"
                        : "已经产生实例的流程版本必须永久保留。"),
                cancellationToken).ConfigureAwait(false);
        }

        var deleted = await _dbContext.RuntimeWorkflowVersions
            .Where(item => item.Id == versionId && item.Revision == expectedRevision)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        if (deleted != 1)
        {
            throw new DBConcurrencyException("The process version changed while it was being deleted.");
        }

        var hasRemainingVersions = await _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .AnyAsync(item => item.DefinitionId == definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (hasRemainingVersions)
        {
            await _dbContext.RuntimeWorkflowDefinitions
                .Where(item => item.Id == definitionId && item.Revision == definition.Revision)
                .ExecuteUpdateAsync(
                    setters => setters
                        .SetProperty(item => item.Revision, item => item.Revision + 1)
                        .SetProperty(item => item.UpdatedAt, UtcNow().UtcDateTime)
                        .SetProperty(item => item.UpdatedBy, actor.EffectiveUserId),
                    cancellationToken)
                .ConfigureAwait(false);
        }
        else
        {
            await _dbContext.RuntimeWorkflowDefinitions
                .Where(item => item.Id == definitionId)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);
        }

        AddLifecycleAudit(
            "process-version",
            versionId,
            "delete-version",
            ["version"],
            actor,
            traceId,
            UtcNow());
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(true);
    }

    private async Task<RuntimeWorkflowVersion?> SelectCopySourceAsync(
        RuntimeWorkflowDefinition definition,
        Guid? requestedVersionId,
        CancellationToken cancellationToken)
    {
        var versionId = requestedVersionId ?? definition.PublishedVersionId;
        var versions = _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .Where(item => item.DefinitionId == definition.Id);
        return versionId.HasValue
            ? await versions.SingleOrDefaultAsync(item => item.Id == versionId.Value, cancellationToken)
                .ConfigureAwait(false)
            : await versions.OrderByDescending(item => item.VersionNumber)
                .FirstOrDefaultAsync(cancellationToken)
                .ConfigureAwait(false);
    }

    private static string? NormalizeCopyName(string? requestedName, string sourceName)
    {
        var name = string.IsNullOrWhiteSpace(requestedName)
            ? $"{sourceName}（副本）"
            : requestedName.Trim();
        return name.Length is > 0 and <= 100 ? name : null;
    }

    private static ProcessVersionDto CreateCopiedVersionResponse(
        RuntimeWorkflowVersion version,
        string definitionCode,
        ProcessVersionValidationDto validation,
        ProcessDefinitionMutationActor actor,
        System.Text.Json.Nodes.JsonObject snapshot)
    {
        var basic = ParseObject(version.BasicJson, "basic_json");
        basic["code"] = definitionCode;
        var user = new ProcessDefinitionUserRefDto(actor.EffectiveUserId, actor.EffectiveUserName);
        return new ProcessVersionDto
        {
            Id = version.Id,
            DefinitionId = version.DefinitionId,
            Revision = version.Revision,
            VersionNumber = version.VersionNumber,
            VersionLabel = version.VersionLabel,
            InstanceCount = 0,
            Editable = true,
            Status = validation.Status == "passed" ? "publishable" : "validation-failed",
            Validation = validation,
            Checksum = CreateChecksum(version.BasicJson, version.SnapshotJson),
            CreatedAt = new DateTimeOffset(version.CreatedAt, TimeSpan.Zero),
            CreatedBy = user,
            UpdatedAt = new DateTimeOffset(version.UpdatedAt, TimeSpan.Zero),
            UpdatedBy = user,
            BasedOn = version.SourceVersionId.HasValue && version.SourceVersionLabel is not null
                ? new ProcessVersionSourceDto(version.SourceVersionId.Value, version.SourceVersionLabel)
                : null,
            Basic = basic,
            Snapshot = snapshot.DeepClone().AsObject(),
        };
    }

    private void AddLifecycleAudit(
        string resourceType,
        Guid resourceId,
        string action,
        IReadOnlyList<string> fields,
        ProcessDefinitionMutationActor actor,
        string traceId,
        DateTimeOffset occurredAt) => _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = resourceType,
            ResourceId = resourceId,
            Action = action,
            FieldIdentifiersJson = JsonSerializer.Serialize(fields, JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = occurredAt.UtcDateTime,
        });

    private static ProcessDefinitionCommandFailure NotFound(
        string code,
        string title,
        string detail) => new(ProcessDefinitionCommandError.NotFound, code, title, detail);

    private static ProcessDefinitionCommandFailure Conflict(
        string code,
        string title,
        string detail) => new(ProcessDefinitionCommandError.Conflict, code, title, detail);

    private static ProcessDefinitionCommandFailure RevisionMismatch(string title, int currentRevision) => new(
        ProcessDefinitionCommandError.RevisionMismatch,
        "REVISION_MISMATCH",
        title,
        "请刷新后基于最新内容重新提交。",
        CurrentRevision: currentRevision);

    private static async Task<ProcessDefinitionCommandResult<T>> RollbackFailureAsync<T>(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessDefinitionCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return Failed<T>(failure);
    }
}
