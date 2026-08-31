using System.Data;
using System.Text.Json;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private const string FreeReopenRouteScope =
        "POST /process-instances/{instanceId}/free-collaboration/reopen";

    public async Task<ProcessInstanceCommandResult<ReopenFreeCollaborationCommandValue>> ReopenFreeAsync(
        Guid instanceId,
        ReopenFreeCollaborationRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var reason = request.Reason?.Trim() ?? string.Empty;
        var requestFailure = ValidateFreeReopenRequest(reason, request.AssigneeId);
        if (requestFailure is not null)
        {
            return FreeReopenFailed(requestFailure);
        }

        var requestHash = RequestHash(new { instanceId, reason, request.AssigneeId });
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadFreeReopenReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var preparation = await LoadClosedFreeInstanceAsync(
                instanceId,
                expectedRevision,
                transaction,
                cancellationToken).ConfigureAwait(false);
            if (preparation.Failure is not null)
            {
                return FreeReopenFailed(preparation.Failure);
            }

            var instance = preparation.Value!;
            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleAsync(item => item.Id == instance.DefinitionId, cancellationToken)
                .ConfigureAwait(false);
            if (!TryParseVersion(version, out var basic, out var snapshot))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReopenFailed(Failure(
                    ProcessInstanceCommandError.Conflict,
                    "LOCKED_VERSION_INVALID",
                    "流程版本不可用",
                    "实例锁定的自由协作版本配置无法读取。"));
            }

            var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                .ConfigureAwait(false);
            var isParticipant = await _dbContext.FreeParticipants
                .AnyAsync(item => item.InstanceId == instance.Id
                    && item.UserId == actor.EffectiveUserId, cancellationToken)
                .ConfigureAwait(false);
            if (!actor.IsSuperAdmin
                && !access.IsStarter(actor.EffectiveUserId)
                && !isParticipant)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReopenFailed(Failure(
                    ProcessInstanceCommandError.Forbidden,
                    "FREE_REOPEN_FORBIDDEN",
                    "不能重新打开该事项",
                    "只有实例锁定版本发起权限组的当前成员或历史参与人可以重新打开。"));
            }

            if (!access.IsReviewMember(request.AssigneeId))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReopenFailed(Failure(
                    ProcessInstanceCommandError.ValidationFailed,
                    "ASSIGNEE_INVALID",
                    "受理人无效",
                    "请选择实例锁定版本审批/受理流程权限组中的当前有效用户。",
                    [Issue("assigneeId", "INVALID_REFERENCE", "所选用户当前不具备受理资格。")]));
            }

            var hasPendingTask = await _dbContext.WorkflowTasks
                .AnyAsync(task => task.InstanceId == instance.Id
                    && task.TaskType == "free-collaboration"
                    && task.Status == "pending", cancellationToken)
                .ConfigureAwait(false);
            if (hasPendingTask || instance.CurrentAssigneeId is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReopenFailed(InvalidFreeRuntime());
            }

            var assignee = access.User(request.AssigneeId)
                ?? throw new InvalidDataException("Validated free-collaboration assignee is missing.");
            var now = _timeProvider.GetUtcNow();
            var task = new WorkflowTaskEntity
            {
                Id = Guid.NewGuid(),
                TaskType = "free-collaboration",
                InstanceId = instance.Id,
                VersionId = instance.VersionId,
                AssigneeId = assignee.Id,
                Round = instance.CurrentRound,
                Status = "pending",
                ActivatedAt = now.UtcDateTime,
                Revision = 1,
            };
            var entry = new FreeTimelineEntryEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instance.Id,
                EntryType = "reopened",
                ActorUserId = actor.EffectiveUserId,
                AssigneeId = assignee.Id,
                Reason = reason,
                OccurredAt = now.UtcDateTime,
                Revision = 1,
            };

            instance.Status = "in-progress";
            instance.CurrentAssigneeId = assignee.Id;
            instance.CurrentNodeSummary = assignee.Name;
            instance.ClosedAt = null;
            instance.UpdatedAt = now.UtcDateTime;
            _dbContext.WorkflowTasks.Add(task);
            _dbContext.FreeTimelineEntries.Add(entry);
            await AddFreeParticipantAsync(instance.Id, assignee.Id, 2, now, cancellationToken)
                .ConfigureAwait(false);
            AddFreeAudit(instance.Id, "reopen", actor, traceId, now);

            var value = new ReopenFreeCollaborationCommandValue(
                instance.Id,
                instance.Revision,
                task.Id,
                entry.Id,
                false);
            _dbContext.IdempotencyRecords.Add(CreateFreeIdempotencyRecord(
                actor.EffectiveUserId,
                FreeReopenRouteScope,
                idempotencyKey,
                requestHash,
                value,
                now));
            await _emailOutboxWriter.EnqueueAsync(
                instance,
                definition,
                version,
                snapshot!,
                [task],
                now,
                cancellationToken).ConfigureAwait(false);

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<ReopenFreeCollaborationCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeReopenFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<FreeInstancePreparation> LoadClosedFreeInstanceAsync(
        Guid instanceId,
        int expectedRevision,
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (!await _dbContext.WorkflowInstances.AsNoTracking()
                .AnyAsync(item => item.Id == instanceId, cancellationToken)
                .ConfigureAwait(false))
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeInstancePreparation.Failed(Failure(
                ProcessInstanceCommandError.NotFound,
                "FREE_FLOW_NOT_FOUND",
                "自由协作事项不存在",
                "未找到指定的自由协作事项。"));
        }

        var instance = await LoadInstanceForUpdateAsync(instanceId, cancellationToken)
            .ConfigureAwait(false);
        if (instance.Revision - 1 != expectedRevision)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeInstancePreparation.Failed(RevisionMismatch());
        }

        var workflowType = await _dbContext.RuntimeWorkflowDefinitions
            .Where(item => item.Id == instance.DefinitionId)
            .Select(item => item.Type)
            .SingleAsync(cancellationToken)
            .ConfigureAwait(false);
        if (workflowType != "free")
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeInstancePreparation.Failed(Failure(
                ProcessInstanceCommandError.NotFound,
                "FREE_FLOW_NOT_FOUND",
                "自由协作事项不存在",
                "未找到指定的自由协作事项。"));
        }

        if (instance.Status != "closed")
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeInstancePreparation.Failed(Failure(
                ProcessInstanceCommandError.Conflict,
                "FREE_FLOW_NOT_CLOSED",
                "事项当前不能重新打开",
                "只有已关闭的自由协作事项可以重新打开。"));
        }

        return FreeInstancePreparation.Succeeded(instance);
    }

    private async Task<ProcessInstanceCommandResult<ReopenFreeCollaborationCommandValue>?> LoadFreeReopenReplayAsync(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var existing = await LoadFreeIdempotencyAsync(
            actorId,
            FreeReopenRouteScope,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        var failure = ValidateFreeIdempotency(existing, requestHash, "重新打开");
        if (failure is not null)
        {
            return FreeReopenFailed(failure);
        }

        var stored = JsonSerializer.Deserialize<ReopenFreeCollaborationCommandValue>(
            existing.ResponseBodyJson!,
            JsonOptions) ?? throw new InvalidDataException("Stored free reopen response is invalid.");
        return new ProcessInstanceCommandResult<ReopenFreeCollaborationCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private static ProcessInstanceCommandFailure? ValidateFreeReopenRequest(
        string reason,
        Guid assigneeId)
    {
        var issues = new List<ProcessInstanceInputIssueDto>();
        if (string.IsNullOrWhiteSpace(reason))
        {
            issues.Add(Issue("reason", "REQUIRED", "请填写重新打开原因。"));
        }
        else if (reason.Length > 2000)
        {
            issues.Add(Issue("reason", "INVALID_LENGTH", "重新打开原因不能超过 2000 个字符。"));
        }

        if (assigneeId == Guid.Empty)
        {
            issues.Add(Issue("assigneeId", "REQUIRED", "请选择受理人。"));
        }

        return issues.Count == 0
            ? null
            : Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "重新打开内容不完整",
                "请填写原因并选择有效受理人。",
                issues);
    }

    private static ProcessInstanceCommandResult<ReopenFreeCollaborationCommandValue> FreeReopenFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);
}
