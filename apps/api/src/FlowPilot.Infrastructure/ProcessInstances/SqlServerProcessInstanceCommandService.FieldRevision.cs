using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private const string TaskFieldRevisionRouteScope = "POST /workflow-tasks/{taskId}/field-revisions";

    public async Task<ProcessInstanceCommandResult<ReviseTaskFieldsCommandValue>> ReviseTaskFieldsAsync(
        Guid taskId,
        ReviseTaskFieldsRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var requestFailure = ValidateFieldRevisionRequest(request);
        if (requestFailure is not null)
        {
            return FieldRevisionFailed(requestFailure);
        }

        var requestHash = Convert.ToHexStringLower(SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(new { taskId, request }, JsonOptions)));
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadFieldRevisionReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var task = await _dbContext.WorkflowTasks
                .SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken)
                .ConfigureAwait(false);
            var taskFailure = ValidateRevisableTask(task, actor, expectedRevision);
            if (taskFailure is not null)
            {
                return await RollbackFieldRevisionFailureAsync(transaction, taskFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var completedTask = task!;
            var instance = await LoadInstanceForUpdateAsync(
                completedTask.InstanceId,
                cancellationToken).ConfigureAwait(false);
            if (instance.Status is "rejected-pending" or "closed"
                || instance.CurrentRound != completedTask.Round)
            {
                return await RollbackFieldRevisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "REPEAT_EDIT_FORBIDDEN", "不能继续修改", "当前流程状态或审核轮次已不允许继续修改该节点字段。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            if (!TryParseVersion(version, out _, out var snapshot))
            {
                return await RollbackFieldRevisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "LOCKED_VERSION_INVALID", "流程版本不可用", "实例锁定的审批流程版本配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var lockedSnapshot = snapshot!;
            var node = ReadFlowNodes(lockedSnapshot)
                .Where(item => ReadString(item["data"] as JsonObject, "kind") == "approval")
                .Select(CreateNodePlan)
                .SingleOrDefault(item => item.Id == completedTask.NodeId);
            if (node is null || !node.AllowRepeatedEditing || node.EditableFieldIds.Count == 0)
            {
                return await RollbackFieldRevisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "REPEAT_EDIT_FORBIDDEN", "不能继续修改", "该审批节点没有开启结果提交后的重复修改。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var currentValues = ParseStoredObject(instance.FormValuesJson);
            var fieldUpdate = ApplyReviewerFieldValues(currentValues, request.FieldValues, lockedSnapshot, node);
            if (fieldUpdate.Failure is not null)
            {
                return await RollbackFieldRevisionFailureAsync(transaction, fieldUpdate.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var currentReferences = await _dbContext.AttachmentReferences
                .Where(reference => reference.InstanceId == instance.Id
                    && reference.ReferenceType == "form-field")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var attachmentSource = new TaskDecisionRequest
            {
                FieldValues = request.FieldValues,
                BaseFieldRevisions = request.BaseFieldRevisions,
                AttachmentIdsByField = request.AttachmentIdsByField,
            };
            var attachmentRequest = MergeAttachmentRequest(attachmentSource, currentReferences, node);
            if (attachmentRequest.Failure is not null)
            {
                return await RollbackFieldRevisionFailureAsync(transaction, attachmentRequest.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var attachments = await ValidateUpdatedAttachmentsAsync(
                attachmentRequest.Value!,
                lockedSnapshot,
                actor.EffectiveUserId,
                currentReferences,
                cancellationToken).ConfigureAwait(false);
            if (attachments.Failure is not null)
            {
                return await RollbackFieldRevisionFailureAsync(transaction, attachments.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var changedFields = ChangedFieldIds(currentValues, fieldUpdate.Values!);
            var revisionFailure = ValidateBaseFieldRevisions(
                ParseStoredObject(instance.FieldRevisionsJson),
                request.BaseFieldRevisions,
                changedFields.Concat(request.AttachmentIdsByField.Keys));
            if (revisionFailure is not null)
            {
                return await RollbackFieldRevisionFailureAsync(transaction, revisionFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var requiredFailure = ValidateReviewerRequiredFields(fieldUpdate.Values!, lockedSnapshot, node);
            if (requiredFailure is not null)
            {
                return await RollbackFieldRevisionFailureAsync(transaction, requiredFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var now = _timeProvider.GetUtcNow();
            var changedAttachmentFields = await ReplaceAttachmentReferencesAsync(
                instance.Id,
                currentReferences,
                attachments.Value!,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            var revisedFieldIds = changedFields
                .Concat(changedAttachmentFields)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (revisedFieldIds.Length == 0)
            {
                return await RollbackFieldRevisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.ValidationFailed, "NO_FIELD_CHANGES", "没有字段变化", "请修改至少一个本节点授权字段后再保存。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var fieldRevisions = UpdateFieldRevisions(
                ParseStoredObject(instance.FieldRevisionsJson),
                revisedFieldIds);
            instance.FormValuesJson = fieldUpdate.Values!.ToJsonString(JsonOptions);
            instance.FieldRevisionsJson = fieldRevisions.ToJsonString(JsonOptions);
            instance.Title = ReadRequiredString(fieldUpdate.Values, "title");
            instance.UpdatedAt = now.UtcDateTime;
            completedTask.Revision = checked(completedTask.Revision + 1);

            var projections = await _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == instance.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            _dbContext.InstanceFieldValues.RemoveRange(projections);
            await AddFieldProjectionsAsync(instance, fieldUpdate.Values, cancellationToken)
                .ConfigureAwait(false);

            var sequence = checked(await _dbContext.WorkflowEvents.CountAsync(
                item => item.TaskId == completedTask.Id && item.EventType == "task-fields-revised",
                cancellationToken).ConfigureAwait(false) + 1);
            var revision = CreateFieldRevision(
                lockedSnapshot,
                revisedFieldIds,
                actor,
                request.Comment,
                sequence,
                now);
            AddFieldRevisionFacts(instance, completedTask, revision, actor, traceId);

            var value = new ReviseTaskFieldsCommandValue(
                instance.Id,
                completedTask.Id,
                revision,
                false);
            _dbContext.IdempotencyRecords.Add(CreateFieldRevisionIdempotencyRecord(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                value,
                now));

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<ReviseTaskFieldsCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return FieldRevisionFailed(Failure(
                ProcessInstanceCommandError.PreconditionFailed,
                "REVISION_MISMATCH",
                "任务已发生变化",
                "任务已被其他操作更新，请刷新后重试。"));
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessInstanceCommandResult<ReviseTaskFieldsCommandValue>?> LoadFieldRevisionReplayAsync(
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
                  AND [route_scope] = {TaskFieldRevisionRouteScope}
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
            return FieldRevisionFailed(Failure(
                ProcessInstanceCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于其他请求",
                "请为不同的字段修改请求生成新的 Idempotency-Key。"));
        }

        var stored = JsonSerializer.Deserialize<ReviseTaskFieldsCommandValue>(
            existing.ResponseBodyJson ?? string.Empty,
            JsonOptions) ?? throw new InvalidDataException("Stored field revision response is invalid.");
        return new ProcessInstanceCommandResult<ReviseTaskFieldsCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private static ProcessInstanceCommandFailure? ValidateFieldRevisionRequest(
        ReviseTaskFieldsRequest request)
    {
        if (request.FieldValues.Count == 0 && request.AttachmentIdsByField.Count == 0)
        {
            return Failure(ProcessInstanceCommandError.ValidationFailed, "NO_FIELD_CHANGES", "没有字段变化", "请提交至少一个需要修改的字段。");
        }

        return request.Comment?.Length > 2000
            ? Failure(ProcessInstanceCommandError.ValidationFailed, "VALIDATION_FAILED", "修改说明无效", "修改说明不能超过 2000 个字符。",
                [Issue("comment", "INVALID_LENGTH", "修改说明不能超过 2000 个字符。")])
            : null;
    }

    private static ProcessInstanceCommandFailure? ValidateRevisableTask(
        WorkflowTaskEntity? task,
        ProcessInstanceActor actor,
        int expectedRevision)
    {
        if (task is null)
        {
            return Failure(ProcessInstanceCommandError.NotFound, "TASK_NOT_FOUND", "任务不存在", "指定的任务不存在。");
        }

        if (task.TaskType != "approval")
        {
            return Failure(ProcessInstanceCommandError.Conflict, "TASK_TYPE_NOT_SUPPORTED", "不能使用此操作", "该接口只修改已完成审批或确认任务的授权字段。");
        }

        if (task.Revision != expectedRevision)
        {
            return Failure(ProcessInstanceCommandError.PreconditionFailed, "REVISION_MISMATCH", "任务已发生变化", "任务已被其他操作更新，请刷新后重试。");
        }

        if (task.Status != "completed" || task.Action is not ("pass" or "confirm"))
        {
            return Failure(ProcessInstanceCommandError.Conflict, "REPEAT_EDIT_FORBIDDEN", "不能继续修改", "只有已经通过或确认的审批任务可以继续修改字段。");
        }

        if (!actor.CanReview || !actor.IsSuperAdmin && task.ActualAssigneeId != actor.EffectiveUserId)
        {
            return Failure(ProcessInstanceCommandError.Forbidden, "REPEAT_EDIT_FORBIDDEN", "不能继续修改", "只有该任务的实际处理人或超级管理员可以继续修改字段。");
        }

        return null;
    }

    private static WorkflowFieldRevisionDto CreateFieldRevision(
        JsonObject snapshot,
        IReadOnlyList<string> fieldIds,
        ProcessInstanceActor actor,
        string? comment,
        int sequence,
        DateTimeOffset now)
    {
        var labels = ReadFormFields(snapshot).ToDictionary(
            field => ReadRequiredString(field, "id"),
            field => ReadString(field, "label") ?? ReadRequiredString(field, "id"),
            StringComparer.Ordinal);
        return new WorkflowFieldRevisionDto(
            Guid.NewGuid(),
            sequence,
            new TaskCenterUserRefDto(actor.EffectiveUserId, actor.EffectiveUserName, actor.EffectiveUserDepartmentPath),
            now,
            NormalizeComment(comment),
            fieldIds.Select(fieldId => new WorkflowFieldChangeDto(
                fieldId,
                labels.GetValueOrDefault(fieldId, fieldId))).ToArray());
    }

    private void AddFieldRevisionFacts(
        WorkflowInstanceEntity instance,
        WorkflowTaskEntity task,
        WorkflowFieldRevisionDto revision,
        ProcessInstanceActor actor,
        string traceId)
    {
        var fieldIds = revision.Changes.Select(change => change.FieldId).ToArray();
        var metadata = new JsonObject
        {
            ["sequence"] = revision.Sequence,
            ["comment"] = revision.Comment,
            ["fieldIds"] = new JsonArray(fieldIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
            ["fieldNames"] = new JsonArray(revision.Changes.Select(change => (JsonNode?)JsonValue.Create(change.LabelSnapshot)).ToArray()),
        };
        _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
        {
            Id = revision.Id,
            EventType = "task-fields-revised",
            InstanceId = instance.Id,
            TaskId = task.Id,
            NodeId = task.NodeId,
            Round = task.Round,
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            OccurredAt = revision.EditedAt.UtcDateTime,
            MetadataJson = metadata.ToJsonString(JsonOptions),
        });
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "workflow-task",
            ResourceId = task.Id,
            Action = "revise-fields",
            FieldIdentifiersJson = JsonSerializer.Serialize(fieldIds, JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = revision.EditedAt.UtcDateTime,
        });
    }

    private static IdempotencyRecordEntity CreateFieldRevisionIdempotencyRecord(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        ReviseTaskFieldsCommandValue value,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            ActorId = actorId,
            RouteScope = TaskFieldRevisionRouteScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = 201,
            ResponseBodyJson = JsonSerializer.Serialize(value, JsonOptions),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddDays(7).UtcDateTime,
        };

    private static ProcessInstanceCommandResult<ReviseTaskFieldsCommandValue> FieldRevisionFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static async Task<ProcessInstanceCommandResult<ReviseTaskFieldsCommandValue>> RollbackFieldRevisionFailureAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessInstanceCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return FieldRevisionFailed(failure);
    }
}
