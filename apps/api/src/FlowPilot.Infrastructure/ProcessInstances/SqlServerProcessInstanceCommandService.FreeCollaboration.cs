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
    private const string FreeReplyRouteScope =
        "POST /process-instances/{instanceId}/free-collaboration/replies";
    private const string FreeTransferRouteScope =
        "POST /process-instances/{instanceId}/free-collaboration/transfers";

    public async Task<ProcessInstanceCommandResult<AddFreeReplyCommandValue>> AddFreeReplyAsync(
        Guid instanceId,
        CreateFreeReplyRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var content = request.Content?.Trim() ?? string.Empty;
        var attachmentIds = request.AttachmentIds ?? [];
        var requestFailure = ValidateFreeReplyRequest(content, attachmentIds);
        if (requestFailure is not null)
        {
            return FreeReplyFailed(requestFailure);
        }

        var requestHash = RequestHash(new { instanceId, content, attachmentIds });
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadFreeReplyReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var instance = await LoadFreeInstanceAsync(
                instanceId,
                expectedRevision,
                transaction,
                cancellationToken).ConfigureAwait(false);
            if (instance.Failure is not null)
            {
                return FreeReplyFailed(instance.Failure);
            }

            var isParticipant = await _dbContext.FreeParticipants
                .AnyAsync(item => item.InstanceId == instanceId
                    && item.UserId == actor.EffectiveUserId, cancellationToken)
                .ConfigureAwait(false);
            var canReply = actor.IsSuperAdmin || isParticipant;
            if (!canReply)
            {
                var version = await _dbContext.RuntimeWorkflowVersions
                    .SingleAsync(item => item.Id == instance.Value!.VersionId, cancellationToken)
                    .ConfigureAwait(false);
                if (!TryParseVersion(version, out var basic, out _))
                {
                    await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                    return FreeReplyFailed(Failure(
                        ProcessInstanceCommandError.Conflict,
                        "LOCKED_VERSION_INVALID",
                        "流程版本不可用",
                        "实例锁定的自由协作版本配置无法读取。"));
                }

                var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                    .ConfigureAwait(false);
                canReply = access.CanTransferFree(actor.EffectiveUserId);
            }

            if (!canReply)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReplyFailed(Failure(
                    ProcessInstanceCommandError.Forbidden,
                    "FREE_REPLY_FORBIDDEN",
                    "不能回复该事项",
                    "只有参与人或实例锁定版本的有效发起、受理流程权限组成员可以回复。"));
            }

            var attachmentPreparation = await PrepareFreeReplyAttachmentsAsync(
                attachmentIds,
                actor.EffectiveUserId,
                cancellationToken).ConfigureAwait(false);
            if (attachmentPreparation.Failure is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReplyFailed(attachmentPreparation.Failure);
            }

            var now = _timeProvider.GetUtcNow();
            var entry = new FreeTimelineEntryEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instanceId,
                EntryType = "reply",
                ActorUserId = actor.EffectiveUserId,
                Content = content,
                OccurredAt = now.UtcDateTime,
                Revision = 1,
            };
            _dbContext.FreeTimelineEntries.Add(entry);
            AddFreeReplyAttachmentReferences(
                instanceId,
                entry.Id,
                attachmentPreparation.Value!,
                actor.EffectiveUserId,
                now);
            await AddFreeParticipantAsync(instanceId, actor.EffectiveUserId, 4, now, cancellationToken)
                .ConfigureAwait(false);

            instance.Value!.UpdatedAt = now.UtcDateTime;
            AddFreeAudit(instanceId, "reply", actor, traceId, now);
            var value = new AddFreeReplyCommandValue(
                instanceId,
                instance.Value.Revision,
                entry.Id,
                false);
            _dbContext.IdempotencyRecords.Add(CreateFreeIdempotencyRecord(
                actor.EffectiveUserId,
                FreeReplyRouteScope,
                idempotencyKey,
                requestHash,
                value,
                now));

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<AddFreeReplyCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeReplyFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ProcessInstanceCommandResult<TransferFreeCollaborationCommandValue>> TransferFreeAsync(
        Guid instanceId,
        TransferFreeCollaborationRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var content = request.Content?.Trim();
        var attachmentIds = request.AttachmentIds ?? [];
        var requestFailure = ValidateFreeTransferRequest(request.NextAssigneeId, content, attachmentIds);
        if (requestFailure is not null)
        {
            return FreeTransferFailed(requestFailure);
        }

        var requestHash = RequestHash(new { instanceId, request.NextAssigneeId, content, attachmentIds });
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadFreeTransferReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var instance = await LoadFreeInstanceAsync(
                instanceId,
                expectedRevision,
                transaction,
                cancellationToken).ConfigureAwait(false);
            if (instance.Failure is not null)
            {
                return FreeTransferFailed(instance.Failure);
            }

            var current = instance.Value!;
            if (current.CurrentAssigneeId is null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(InvalidFreeRuntime());
            }

            if (current.CurrentAssigneeId == request.NextAssigneeId)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(Failure(
                    ProcessInstanceCommandError.Conflict,
                    "ASSIGNEE_UNCHANGED",
                    "受理人没有变化",
                    "新受理人不能与当前受理人相同。"));
            }

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == current.VersionId, cancellationToken)
                .ConfigureAwait(false);
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleAsync(item => item.Id == current.DefinitionId, cancellationToken)
                .ConfigureAwait(false);
            if (!TryParseVersion(version, out var basic, out var snapshot))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(Failure(
                    ProcessInstanceCommandError.Conflict,
                    "LOCKED_VERSION_INVALID",
                    "流程版本不可用",
                    "实例锁定的自由协作版本配置无法读取。"));
            }

            var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                .ConfigureAwait(false);
            if (!actor.IsSuperAdmin && !access.CanTransferFree(actor.EffectiveUserId))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(Failure(
                    ProcessInstanceCommandError.Forbidden,
                    "FREE_TRANSFER_FORBIDDEN",
                    "不能变更受理人",
                    "当前账号不属于实例锁定版本的有效发起或受理流程权限组。"));
            }

            if (!access.IsReviewMember(request.NextAssigneeId))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(Failure(
                    ProcessInstanceCommandError.ValidationFailed,
                    "ASSIGNEE_INVALID",
                    "新受理人无效",
                    "请选择实例锁定版本审批/受理流程权限组中的当前有效用户。",
                    [Issue("nextAssigneeId", "INVALID_REFERENCE", "所选用户当前不具备受理资格。")]));
            }

            var attachmentPreparation = await PrepareFreeReplyAttachmentsAsync(
                attachmentIds,
                actor.EffectiveUserId,
                cancellationToken).ConfigureAwait(false);
            if (attachmentPreparation.Failure is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(attachmentPreparation.Failure);
            }

            var currentTask = await _dbContext.WorkflowTasks
                .SingleOrDefaultAsync(task => task.InstanceId == instanceId
                    && task.TaskType == "free-collaboration"
                    && task.Status == "pending", cancellationToken)
                .ConfigureAwait(false);
            if (currentTask is null || currentTask.AssigneeId != current.CurrentAssigneeId)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeTransferFailed(InvalidFreeRuntime());
            }

            var nextAssignee = access.User(request.NextAssigneeId)
                ?? throw new InvalidDataException("Validated free-collaboration assignee is missing.");
            var now = _timeProvider.GetUtcNow();
            var transferAt = string.IsNullOrEmpty(content) ? now : now.AddMilliseconds(1);
            currentTask.Status = "completed";
            currentTask.CompletedAt = transferAt.UtcDateTime;
            currentTask.Revision = checked(currentTask.Revision + 1);
            current.CurrentAssigneeId = nextAssignee.Id;
            current.CurrentNodeSummary = nextAssignee.Name;
            current.UpdatedAt = transferAt.UtcDateTime;

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            Guid? replyEntryId = null;
            if (!string.IsNullOrEmpty(content))
            {
                replyEntryId = Guid.NewGuid();
                _dbContext.FreeTimelineEntries.Add(new FreeTimelineEntryEntity
                {
                    Id = replyEntryId.Value,
                    InstanceId = instanceId,
                    EntryType = "reply",
                    ActorUserId = actor.EffectiveUserId,
                    Content = content,
                    OccurredAt = now.UtcDateTime,
                    Revision = 1,
                });
                AddFreeReplyAttachmentReferences(
                    instanceId,
                    replyEntryId.Value,
                    attachmentPreparation.Value!,
                    actor.EffectiveUserId,
                    now);
                await AddFreeParticipantAsync(instanceId, actor.EffectiveUserId, 4, now, cancellationToken)
                    .ConfigureAwait(false);
                AddFreeAudit(instanceId, "reply", actor, traceId, now);
            }

            var newTask = new WorkflowTaskEntity
            {
                Id = Guid.NewGuid(),
                TaskType = "free-collaboration",
                InstanceId = instanceId,
                VersionId = current.VersionId,
                AssigneeId = nextAssignee.Id,
                Round = current.CurrentRound,
                Status = "pending",
                ActivatedAt = transferAt.UtcDateTime,
                Revision = 1,
            };
            var transferEntry = new FreeTimelineEntryEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instanceId,
                EntryType = "transferred",
                ActorUserId = actor.EffectiveUserId,
                PreviousAssigneeId = currentTask.AssigneeId,
                AssigneeId = nextAssignee.Id,
                OccurredAt = transferAt.UtcDateTime,
                Revision = 1,
            };
            _dbContext.WorkflowTasks.Add(newTask);
            _dbContext.FreeTimelineEntries.Add(transferEntry);
            await AddFreeParticipantAsync(instanceId, nextAssignee.Id, 2, transferAt, cancellationToken)
                .ConfigureAwait(false);
            AddFreeAudit(current.Id, "transfer", actor, traceId, transferAt);

            var value = new TransferFreeCollaborationCommandValue(
                instanceId,
                current.Revision,
                newTask.Id,
                transferEntry.Id,
                false);
            _dbContext.IdempotencyRecords.Add(CreateFreeIdempotencyRecord(
                actor.EffectiveUserId,
                FreeTransferRouteScope,
                idempotencyKey,
                requestHash,
                value,
                transferAt));
            // Outbox rows reference the newly-created task. Persist the task first because
            // these lightweight runtime projections intentionally have no EF navigation relationship.
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await _emailOutboxWriter.EnqueueAsync(
                current,
                definition,
                version,
                snapshot!,
                [newTask],
                transferAt,
                cancellationToken).ConfigureAwait(false);

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<TransferFreeCollaborationCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeTransferFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ProcessInstanceCommandResult<EditFreeReplyCommandValue>> EditFreeReplyAsync(
        Guid instanceId,
        Guid entryId,
        EditFreeReplyRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var content = request.Content?.Trim() ?? string.Empty;
        var requestFailure = ValidateFreeReplyContent(content);
        if (requestFailure is not null)
        {
            return FreeReplyEditFailed(requestFailure);
        }

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var instance = await LoadFreeInstanceAsync(
                instanceId,
                expectedRevision,
                transaction,
                cancellationToken).ConfigureAwait(false);
            if (instance.Failure is not null)
            {
                return FreeReplyEditFailed(instance.Failure);
            }

            var entry = await _dbContext.FreeTimelineEntries
                .SingleOrDefaultAsync(item => item.Id == entryId
                    && item.InstanceId == instanceId, cancellationToken)
                .ConfigureAwait(false);
            if (entry is null || entry.EntryType != "reply")
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReplyEditFailed(Failure(
                    ProcessInstanceCommandError.NotFound,
                    "FREE_REPLY_NOT_FOUND",
                    "回复不存在",
                    "未找到指定的自由协作回复。"));
            }

            if (entry.ActorUserId != actor.EffectiveUserId)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReplyEditFailed(Failure(
                    ProcessInstanceCommandError.Forbidden,
                    "EDIT_REPLY_FORBIDDEN",
                    "不能编辑该回复",
                    "只有回复作者本人可以编辑进行中事项的回复。"));
            }

            if (string.Equals(entry.Content, content, StringComparison.Ordinal))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return FreeReplyEditFailed(Failure(
                    ProcessInstanceCommandError.Conflict,
                    "FREE_REPLY_UNCHANGED",
                    "回复内容没有变化",
                    "请修改回复内容后再保存。"));
            }

            var now = _timeProvider.GetUtcNow();
            entry.Content = content;
            entry.EditedBy = actor.EffectiveUserId;
            entry.EditedAt = now.UtcDateTime;
            entry.Revision = checked(entry.Revision + 1);
            instance.Value!.UpdatedAt = now.UtcDateTime;

            _dbContext.FreeTimelineEntries.Add(new FreeTimelineEntryEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instanceId,
                EntryType = "reply-edited",
                ActorUserId = actor.EffectiveUserId,
                RelatedEntryId = entry.Id,
                OccurredAt = now.UtcDateTime,
                Revision = 1,
            });
            AddFreeAudit(instanceId, "edit-reply", actor, traceId, now);

            var value = new EditFreeReplyCommandValue(
                instanceId,
                instance.Value.Revision,
                entry.Id);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<EditFreeReplyCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeReplyEditFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<FreeInstancePreparation> LoadFreeInstanceAsync(
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

        if (instance.Status != "in-progress")
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FreeInstancePreparation.Failed(Failure(
                ProcessInstanceCommandError.Conflict,
                "FREE_FLOW_NOT_IN_PROGRESS",
                "事项当前不能处理",
                "只有进行中的自由协作事项可以回复或变更受理人。"));
        }

        return FreeInstancePreparation.Succeeded(instance);
    }

    private async Task AddFreeParticipantAsync(
        Guid instanceId,
        Guid userId,
        int sourceFlag,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var participant = _dbContext.FreeParticipants.Local
            .FirstOrDefault(item => item.InstanceId == instanceId && item.UserId == userId)
            ?? await _dbContext.FreeParticipants.SingleOrDefaultAsync(
                item => item.InstanceId == instanceId && item.UserId == userId,
                cancellationToken).ConfigureAwait(false);
        if (participant is null)
        {
            _dbContext.FreeParticipants.Add(new FreeParticipantEntity
            {
                InstanceId = instanceId,
                UserId = userId,
                SourceFlags = sourceFlag,
                FirstParticipatedAt = now.UtcDateTime,
                LastParticipatedAt = now.UtcDateTime,
            });
            return;
        }

        participant.SourceFlags |= sourceFlag;
        participant.LastParticipatedAt = now.UtcDateTime;
    }

    private async Task<ProcessInstanceCommandResult<AddFreeReplyCommandValue>?> LoadFreeReplyReplayAsync(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var existing = await LoadFreeIdempotencyAsync(
            actorId,
            FreeReplyRouteScope,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        var failure = ValidateFreeIdempotency(existing, requestHash, "回复");
        if (failure is not null)
        {
            return FreeReplyFailed(failure);
        }

        var stored = JsonSerializer.Deserialize<AddFreeReplyCommandValue>(
            existing.ResponseBodyJson!,
            JsonOptions) ?? throw new InvalidDataException("Stored free reply response is invalid.");
        return new ProcessInstanceCommandResult<AddFreeReplyCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private async Task<ProcessInstanceCommandResult<TransferFreeCollaborationCommandValue>?> LoadFreeTransferReplayAsync(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var existing = await LoadFreeIdempotencyAsync(
            actorId,
            FreeTransferRouteScope,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        var failure = ValidateFreeIdempotency(existing, requestHash, "受理人变更");
        if (failure is not null)
        {
            return FreeTransferFailed(failure);
        }

        var stored = JsonSerializer.Deserialize<TransferFreeCollaborationCommandValue>(
            existing.ResponseBodyJson!,
            JsonOptions) ?? throw new InvalidDataException("Stored free transfer response is invalid.");
        return new ProcessInstanceCommandResult<TransferFreeCollaborationCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private Task<IdempotencyRecordEntity?> LoadFreeIdempotencyAsync(
        Guid actorId,
        string routeScope,
        string idempotencyKey,
        CancellationToken cancellationToken) => _dbContext.IdempotencyRecords
        .FromSqlInterpolated(
            $"""
            SELECT * FROM [flowpilot].[idempotency_records] WITH (UPDLOCK, HOLDLOCK)
            WHERE [actor_id] = {actorId}
              AND [route_scope] = {routeScope}
              AND [idempotency_key] = {idempotencyKey}
            """)
        .SingleOrDefaultAsync(cancellationToken);

    private static ProcessInstanceCommandFailure? ValidateFreeIdempotency(
        IdempotencyRecordEntity existing,
        string requestHash,
        string operationName)
    {
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(existing.RequestHash),
                Encoding.ASCII.GetBytes(requestHash)))
        {
            return Failure(
                ProcessInstanceCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于其他请求",
                $"请为不同的{operationName}请求生成新的 Idempotency-Key。");
        }

        return existing.Status == "completed" && !string.IsNullOrWhiteSpace(existing.ResponseBodyJson)
            ? null
            : Failure(
                ProcessInstanceCommandError.Conflict,
                "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                "相同请求正在处理中",
                $"请稍后使用相同的 Idempotency-Key 重试{operationName}。");
    }

    private static IdempotencyRecordEntity CreateFreeIdempotencyRecord<T>(
        Guid actorId,
        string routeScope,
        string idempotencyKey,
        string requestHash,
        T value,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            ActorId = actorId,
            RouteScope = routeScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = routeScope == FreeReplyRouteScope ? (short)201 : (short)200,
            ResponseBodyJson = JsonSerializer.Serialize(value, JsonOptions),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddDays(7).UtcDateTime,
        };

    private void AddFreeAudit(
        Guid resourceId,
        string action,
        ProcessInstanceActor actor,
        string traceId,
        DateTimeOffset now,
        IReadOnlyList<string>? fieldIds = null) => _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "free-collaboration",
            ResourceId = resourceId,
            Action = action,
            FieldIdentifiersJson = fieldIds is null
            ? null
            : JsonSerializer.Serialize(fieldIds, JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });

    private static ProcessInstanceCommandFailure? ValidateFreeReplyRequest(
        string content,
        IReadOnlyList<Guid> attachmentIds)
    {
        var contentFailure = ValidateFreeReplyContent(content);
        if (contentFailure is not null)
        {
            return contentFailure;
        }

        return ValidateFreeReplyAttachmentIds(attachmentIds);
    }

    private static ProcessInstanceCommandFailure? ValidateFreeReplyAttachmentIds(
        IReadOnlyList<Guid> attachmentIds)
    {
        if (attachmentIds.Count > 20)
        {
            return Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "ATTACHMENT_LIMIT_REACHED",
                "回复附件过多",
                "每条回复最多可以添加 20 个附件。",
                [Issue("attachmentIds", "MAX_ITEMS", "每条回复最多可以添加 20 个附件。")]);
        }

        return attachmentIds.Any(id => id == Guid.Empty)
            || attachmentIds.Distinct().Count() != attachmentIds.Count
            ? Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "ATTACHMENT_IDS_INVALID",
                "回复附件无效",
                "attachmentIds 不能包含空值或重复值。",
                [Issue("attachmentIds", "UNIQUE_VALID_IDS_REQUIRED", "请选择有效且不重复的附件。")])
            : null;
    }

    private async Task<FreeReplyAttachmentPreparation> PrepareFreeReplyAttachmentsAsync(
        IReadOnlyList<Guid> attachmentIds,
        Guid actorId,
        CancellationToken cancellationToken)
    {
        if (attachmentIds.Count == 0)
        {
            return FreeReplyAttachmentPreparation.Succeeded([]);
        }

        var attachments = await _dbContext.RuntimeAttachments
            .Where(item => attachmentIds.Contains(item.Id))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var hasReferences = await _dbContext.AttachmentReferences
            .AsNoTracking()
            .AnyAsync(item => attachmentIds.Contains(item.AttachmentId), cancellationToken)
            .ConfigureAwait(false);
        if (attachments.Length != attachmentIds.Count
            || hasReferences
            || attachments.Any(item => item.State != "staged"
                || item.UploadedBy != actorId
                || item.Purpose != "free-reply"))
        {
            return FreeReplyAttachmentPreparation.Failed(Failure(
                ProcessInstanceCommandError.Forbidden,
                "ATTACHMENT_REFERENCE_FORBIDDEN",
                "不能使用部分回复附件",
                "回复只能使用当前用户为该事项上传且尚未被引用的暂存附件。"));
        }

        return FreeReplyAttachmentPreparation.Succeeded(attachments);
    }

    private void AddFreeReplyAttachmentReferences(
        Guid instanceId,
        Guid entryId,
        IReadOnlyList<RuntimeAttachment> attachments,
        Guid actorId,
        DateTimeOffset now)
    {
        foreach (var attachment in attachments)
        {
            attachment.State = "active";
            attachment.CleanupAfter = null;
            attachment.Revision = checked(attachment.Revision + 1);
            _dbContext.AttachmentReferences.Add(new AttachmentReferenceEntity
            {
                Id = Guid.NewGuid(),
                AttachmentId = attachment.Id,
                InstanceId = instanceId,
                FreeTimelineEntryId = entryId,
                ReferenceType = "free-timeline",
                CreatedBy = actorId,
                CreatedAt = now.UtcDateTime,
            });
        }
    }

    private static ProcessInstanceCommandFailure? ValidateFreeReplyContent(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "CONTENT_REQUIRED",
                "回复内容不能为空",
                "请填写回复内容。",
                [Issue("content", "REQUIRED", "请填写回复内容。")]);
        }

        return content.Length <= 20000
            ? null
            : Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "回复内容无效",
                "回复内容不能超过 20000 个字符。",
                [Issue("content", "INVALID_LENGTH", "回复内容不能超过 20000 个字符。")]);
    }

    private static ProcessInstanceCommandFailure? ValidateFreeTransferRequest(
        Guid nextAssigneeId,
        string? content,
        IReadOnlyList<Guid> attachmentIds)
    {
        if (nextAssigneeId == Guid.Empty)
        {
            return Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "ASSIGNEE_REQUIRED",
                "请选择新受理人",
                "新受理人不能为空。",
                [Issue("nextAssigneeId", "REQUIRED", "请选择新受理人。")]);
        }

        if (content is not null && content.Length == 0)
        {
            return Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "CONTENT_REQUIRED",
                "回复内容不能为空",
                "传入 content 时必须填写回复内容。",
                [Issue("content", "REQUIRED", "请填写回复内容，或不传 content。")]);
        }

        if (content is null && attachmentIds.Count > 0)
        {
            return Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "CONTENT_REQUIRED",
                "回复内容不能为空",
                "添加回复附件时必须同时填写回复内容。",
                [Issue("content", "REQUIRED", "请填写回复内容，或移除回复附件。")]);
        }

        var attachmentFailure = ValidateFreeReplyAttachmentIds(attachmentIds);
        if (attachmentFailure is not null)
        {
            return attachmentFailure;
        }

        return content?.Length <= 20000 || content is null
            ? null
            : Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "回复内容无效",
                "回复内容不能超过 20000 个字符。",
                [Issue("content", "INVALID_LENGTH", "回复内容不能超过 20000 个字符。")]);
    }

    private static ProcessInstanceCommandFailure InvalidFreeRuntime() => Failure(
        ProcessInstanceCommandError.Conflict,
        "FREE_FLOW_RUNTIME_INVALID",
        "事项运行数据不完整",
        "当前受理人与待办数据不一致，请联系管理员检查。");

    private static string RequestHash<T>(T value) => Convert.ToHexStringLower(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions)));

    private static ProcessInstanceCommandResult<AddFreeReplyCommandValue> FreeReplyFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static ProcessInstanceCommandResult<EditFreeReplyCommandValue> FreeReplyEditFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static ProcessInstanceCommandResult<TransferFreeCollaborationCommandValue> FreeTransferFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private sealed record FreeInstancePreparation(
        WorkflowInstanceEntity? Value,
        ProcessInstanceCommandFailure? Failure)
    {
        public static FreeInstancePreparation Succeeded(WorkflowInstanceEntity value) => new(value, null);

        public static FreeInstancePreparation Failed(ProcessInstanceCommandFailure failure) => new(null, failure);
    }

    private sealed record FreeReplyAttachmentPreparation(
        IReadOnlyList<RuntimeAttachment>? Value,
        ProcessInstanceCommandFailure? Failure)
    {
        public static FreeReplyAttachmentPreparation Succeeded(IReadOnlyList<RuntimeAttachment> value) => new(value, null);

        public static FreeReplyAttachmentPreparation Failed(ProcessInstanceCommandFailure failure) => new(null, failure);
    }
}
