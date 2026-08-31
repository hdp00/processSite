using System.Data;
using System.Text.Json;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private const string FreeCloseRouteScope =
        "POST /process-instances/{instanceId}/free-collaboration/close";

    public async Task<ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>> CloseFreeAsync(
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

        var requestHash = RequestHash(new { instanceId, reason });
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadFreeCloseReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var preparation = await LoadFreeInstanceAsync(
                instanceId,
                expectedRevision,
                transaction,
                cancellationToken).ConfigureAwait(false);
            if (preparation.Failure is not null)
            {
                return CloseFailed(preparation.Failure);
            }

            if (!actor.CanClose)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return CloseFailed(Failure(
                    ProcessInstanceCommandError.Forbidden,
                    "FREE_CLOSE_FORBIDDEN",
                    "不能关闭该事项",
                    "当前账号没有关闭流程的动作权限。"));
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
                return CloseFailed(Failure(
                    ProcessInstanceCommandError.Conflict,
                    "LOCKED_VERSION_INVALID",
                    "流程版本不可用",
                    "实例锁定的自由协作版本配置无法读取。"));
            }

            var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                .ConfigureAwait(false);
            if (!actor.IsSuperAdmin && !access.IsCloser(actor.EffectiveUserId))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return CloseFailed(Failure(
                    ProcessInstanceCommandError.Forbidden,
                    "FREE_CLOSE_FORBIDDEN",
                    "不能关闭该事项",
                    "当前账号不属于实例锁定版本的有效关闭流程权限组。"));
            }

            var currentTask = await _dbContext.WorkflowTasks
                .SingleOrDefaultAsync(task => task.InstanceId == instance.Id
                    && task.TaskType == "free-collaboration"
                    && task.Status == "pending", cancellationToken)
                .ConfigureAwait(false);
            if (instance.CurrentAssigneeId is null
                || currentTask is null
                || currentTask.AssigneeId != instance.CurrentAssigneeId)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return CloseFailed(InvalidFreeRuntime());
            }

            var now = _timeProvider.GetUtcNow();
            currentTask.Status = "cancelled";
            currentTask.CompletedAt = now.UtcDateTime;
            currentTask.Revision = checked(currentTask.Revision + 1);
            instance.Status = "closed";
            instance.CurrentNodeSummary = string.Empty;
            instance.CurrentAssigneeId = null;
            instance.ClosedAt = now.UtcDateTime;
            instance.UpdatedAt = now.UtcDateTime;

            var entry = new FreeTimelineEntryEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instance.Id,
                EntryType = "closed",
                ActorUserId = actor.EffectiveUserId,
                Reason = reason,
                OccurredAt = now.UtcDateTime,
                Revision = 1,
            };
            _dbContext.FreeTimelineEntries.Add(entry);
            AddFreeAudit(instance.Id, "close", actor, traceId, now);

            var value = new CloseProcessInstanceCommandValue(
                instance.Id,
                instance.Revision,
                [currentTask.Id],
                false);
            _dbContext.IdempotencyRecords.Add(CreateFreeIdempotencyRecord(
                actor.EffectiveUserId,
                FreeCloseRouteScope,
                idempotencyKey,
                requestHash,
                value,
                now));
            await _emailOutboxWriter.EnqueueAsync(
                instance,
                definition,
                version,
                snapshot!,
                [currentTask],
                now,
                cancellationToken).ConfigureAwait(false);

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

    private async Task<ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>?> LoadFreeCloseReplayAsync(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var existing = await LoadFreeIdempotencyAsync(
            actorId,
            FreeCloseRouteScope,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        var failure = ValidateFreeIdempotency(existing, requestHash, "关闭");
        if (failure is not null)
        {
            return CloseFailed(failure);
        }

        var stored = JsonSerializer.Deserialize<CloseProcessInstanceCommandValue>(
            existing.ResponseBodyJson!,
            JsonOptions) ?? throw new InvalidDataException("Stored free close response is invalid.");
        return new ProcessInstanceCommandResult<CloseProcessInstanceCommandValue>(
            stored with { Replayed = true },
            null);
    }
}
