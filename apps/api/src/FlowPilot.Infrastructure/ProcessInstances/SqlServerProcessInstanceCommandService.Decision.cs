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
    private const string TaskDecisionRouteScope = "POST /workflow-tasks/{taskId}/decision";

    public async Task<ProcessInstanceCommandResult<TaskDecisionCommandValue>> DecideTaskAsync(
        Guid taskId,
        TaskDecisionRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var requestFailure = ValidateDecisionRequest(request);
        if (requestFailure is not null)
        {
            return DecisionFailed(requestFailure);
        }

        var requestHash = Convert.ToHexStringLower(SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(new { taskId, request }, JsonOptions)));
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var replay = await LoadTaskDecisionReplayAsync(
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
            var taskFailure = ValidatePendingApprovalTask(task, expectedRevision);
            if (taskFailure is not null)
            {
                return await RollbackDecisionFailureAsync(transaction, taskFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var pendingTask = task!;
            var instance = await LoadInstanceForUpdateAsync(
                pendingTask.InstanceId,
                cancellationToken).ConfigureAwait(false);
            if (instance.Status != "reviewing" || instance.CurrentRound != pendingTask.Round)
            {
                return await RollbackDecisionFailureAsync(
                    transaction,
                    TaskAlreadyCompleted(),
                    cancellationToken).ConfigureAwait(false);
            }

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            if (!TryParseVersion(version, out var basic, out var snapshot))
            {
                return await RollbackDecisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "LOCKED_VERSION_INVALID", "流程版本不可用", "实例锁定的审批流程版本配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var node = ReadFlowNodes(snapshot!)
                .Where(item => ReadString(item["data"] as JsonObject, "kind") == "approval")
                .Select(CreateNodePlan)
                .SingleOrDefault(item => item.Id == pendingTask.NodeId);
            if (node is null || node.GroupId != pendingTask.GroupId)
            {
                return await RollbackDecisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "INSTANCE_RUNTIME_INVALID", "流程运行数据不完整", "当前任务与实例锁定版本不一致。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var access = await LoadRuntimeAccessAsync(version.Id, basic!, cancellationToken)
                .ConfigureAwait(false);
            if (!actor.CanReview
                || !actor.IsSuperAdmin && !access.IsGroupMember(node.GroupId, actor.EffectiveUserId))
            {
                return await RollbackDecisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Forbidden, "TASK_DECISION_FORBIDDEN", "不能处理该任务", "当前账号没有审核权限，或已不属于该节点的有效流程权限组。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (!ActionAllowed(node.HandlingMode, request.Action))
            {
                return await RollbackDecisionFailureAsync(
                    transaction,
                    Failure(ProcessInstanceCommandError.Conflict, "ACTION_NOT_ALLOWED_FOR_NODE", "处理动作不适用于当前节点", node.HandlingMode == "confirmation" ? "确认节点只接受确认操作。" : "审批节点只接受通过或驳回操作。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var currentValues = ParseStoredObject(instance.FormValuesJson);
            var fieldUpdate = ApplyReviewerFieldValues(currentValues, request.FieldValues, snapshot!, node);
            if (fieldUpdate.Failure is not null)
            {
                return await RollbackDecisionFailureAsync(transaction, fieldUpdate.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var currentReferences = await _dbContext.AttachmentReferences
                .Where(reference => reference.InstanceId == instance.Id
                    && reference.ReferenceType == "form-field")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var attachmentRequest = MergeAttachmentRequest(request, currentReferences, node);
            if (attachmentRequest.Failure is not null)
            {
                return await RollbackDecisionFailureAsync(transaction, attachmentRequest.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var attachments = await ValidateUpdatedAttachmentsAsync(
                attachmentRequest.Value!,
                snapshot!,
                actor.EffectiveUserId,
                currentReferences,
                cancellationToken).ConfigureAwait(false);
            if (attachments.Failure is not null)
            {
                return await RollbackDecisionFailureAsync(transaction, attachments.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var changedFields = ChangedFieldIds(currentValues, fieldUpdate.Values!);
            var revisionFailure = ValidateBaseFieldRevisions(
                ParseStoredObject(instance.FieldRevisionsJson),
                request.BaseFieldRevisions,
                changedFields.Concat(request.AttachmentIdsByField.Keys));
            if (revisionFailure is not null)
            {
                return await RollbackDecisionFailureAsync(transaction, revisionFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            if (request.Action is "pass" or "confirm")
            {
                var requiredFailure = ValidateReviewerRequiredFields(fieldUpdate.Values!, snapshot!, node);
                if (requiredFailure is not null)
                {
                    return await RollbackDecisionFailureAsync(transaction, requiredFailure, cancellationToken)
                        .ConfigureAwait(false);
                }
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
            var fieldRevisions = UpdateFieldRevisions(
                ParseStoredObject(instance.FieldRevisionsJson),
                revisedFieldIds);

            pendingTask.Status = "completed";
            pendingTask.CompletedAt = now.UtcDateTime;
            pendingTask.ActualAssigneeId = actor.EffectiveUserId;
            pendingTask.Action = request.Action;
            pendingTask.ResultComment = NormalizeComment(request.Comment);
            pendingTask.Revision = checked(pendingTask.Revision + 1);

            var roundTasks = await _dbContext.WorkflowTasks
                .Where(item => item.InstanceId == instance.Id
                    && item.Round == instance.CurrentRound
                    && item.TaskType == "approval")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var transition = request.Action == "reject"
                ? RejectCurrentRound(instance, roundTasks, snapshot!, now)
                : AdvanceCurrentRound(instance, roundTasks, snapshot!, fieldUpdate.Values!, now);

            instance.FormValuesJson = fieldUpdate.Values!.ToJsonString(JsonOptions);
            instance.FieldRevisionsJson = fieldRevisions.ToJsonString(JsonOptions);
            instance.Title = ReadRequiredString(fieldUpdate.Values, "title");
            instance.UpdatedAt = now.UtcDateTime;

            var projections = await _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == instance.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            _dbContext.InstanceFieldValues.RemoveRange(projections);
            await AddFieldProjectionsAsync(instance, fieldUpdate.Values, cancellationToken)
                .ConfigureAwait(false);

            AddTaskDecisionFacts(instance, pendingTask, node, snapshot!, revisedFieldIds, actor, traceId, now);
            var value = new TaskDecisionCommandValue(
                instance.Id,
                pendingTask.Id,
                transition.ActivatedTaskIds,
                transition.CancelledTaskIds,
                false);
            _dbContext.IdempotencyRecords.Add(CreateTaskDecisionIdempotencyRecord(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                value,
                now));

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<TaskDecisionCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return DecisionFailed(TaskAlreadyCompleted());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessInstanceCommandResult<TaskDecisionCommandValue>?> LoadTaskDecisionReplayAsync(
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
                  AND [route_scope] = {TaskDecisionRouteScope}
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
            return DecisionFailed(Failure(
                ProcessInstanceCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于其他请求",
                "请为不同的任务处理请求生成新的 Idempotency-Key。"));
        }

        var stored = JsonSerializer.Deserialize<TaskDecisionCommandValue>(
            existing.ResponseBodyJson ?? string.Empty,
            JsonOptions) ?? throw new InvalidDataException("Stored task decision response is invalid.");
        return new ProcessInstanceCommandResult<TaskDecisionCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private static ProcessInstanceCommandFailure? ValidateDecisionRequest(TaskDecisionRequest request)
    {
        if (request.Action is not ("pass" or "confirm" or "reject"))
        {
            return Failure(ProcessInstanceCommandError.ValidationFailed, "VALIDATION_FAILED", "处理数据无效", "action 必须是 pass、confirm 或 reject。",
                [Issue("action", "INVALID_VALUE", "请选择有效的处理动作。")]);
        }

        if (request.Comment?.Length > 2000)
        {
            return Failure(ProcessInstanceCommandError.ValidationFailed, "VALIDATION_FAILED", "处理数据无效", "审核意见不能超过 2000 个字符。",
                [Issue("comment", "INVALID_LENGTH", "审核意见不能超过 2000 个字符。")]);
        }

        return request.Action == "reject" && string.IsNullOrWhiteSpace(request.Comment)
            ? Failure(ProcessInstanceCommandError.ValidationFailed, "REVIEW_COMMENT_REQUIRED", "请填写驳回意见", "驳回时必须填写审核意见。",
                [Issue("comment", "REQUIRED", "驳回时必须填写审核意见。")])
            : null;
    }

    private static ProcessInstanceCommandFailure? ValidatePendingApprovalTask(
        WorkflowTaskEntity? task,
        int expectedRevision)
    {
        if (task is null)
        {
            return Failure(ProcessInstanceCommandError.NotFound, "TASK_NOT_FOUND", "任务不存在", "指定的任务不存在。");
        }

        if (task.TaskType != "approval")
        {
            return Failure(ProcessInstanceCommandError.Conflict, "TASK_TYPE_NOT_SUPPORTED", "不能使用此操作", "该接口只处理审批或确认任务。");
        }

        if (task.Status != "pending")
        {
            return TaskAlreadyCompleted();
        }

        return task.Revision == expectedRevision
            ? null
            : Failure(ProcessInstanceCommandError.PreconditionFailed, "REVISION_MISMATCH", "任务已发生变化", "任务已被其他操作更新，请刷新后重试。");
    }

    private static bool ActionAllowed(string handlingMode, string action) =>
        handlingMode == "confirmation" ? action == "confirm" : action is "pass" or "reject";

    private static ReviewerFieldUpdate ApplyReviewerFieldValues(
        JsonObject current,
        JsonObject updates,
        JsonObject snapshot,
        NodePlan node)
    {
        var fields = ReadFormFields(snapshot).ToDictionary(
            field => ReadRequiredString(field, "id"),
            StringComparer.Ordinal);
        var values = current.DeepClone().AsObject();
        var issues = new List<ProcessInstanceInputIssueDto>();
        foreach (var update in updates)
        {
            if (!fields.TryGetValue(update.Key, out var field)
                || !CanEditField(node.EditableFieldIds, update.Key))
            {
                issues.Add(Issue($"fieldValues.{update.Key}", "FIELD_EDIT_FORBIDDEN", "当前节点不能修改该字段。"));
                continue;
            }

            if (ReadString(field, "type") == "table"
                && !node.EditableFieldIds.Contains(update.Key, StringComparer.Ordinal))
            {
                values[update.Key] = MergeEditableTableColumns(
                    current[update.Key] as JsonArray,
                    update.Value as JsonArray,
                    update.Key,
                    node.EditableFieldIds,
                    issues);
            }
            else
            {
                values[update.Key] = update.Value?.DeepClone();
            }
        }

        return issues.Count == 0
            ? new ReviewerFieldUpdate(values, null)
            : new ReviewerFieldUpdate(null, Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "字段修改未通过校验",
                "只能修改当前审批节点授权的字段。",
                issues));
    }

    private static JsonArray MergeEditableTableColumns(
        JsonArray? current,
        JsonArray? updates,
        string fieldId,
        IReadOnlyList<string> editableFieldIds,
        List<ProcessInstanceInputIssueDto> issues)
    {
        if (current is null || updates is null || current.Count != updates.Count)
        {
            issues.Add(Issue($"fieldValues.{fieldId}", "TABLE_STRUCTURE_EDIT_FORBIDDEN", "当前节点只能修改授权列，不能增删表格行。"));
            return current?.DeepClone().AsArray() ?? [];
        }

        var editableColumns = editableFieldIds
            .Where(id => id.StartsWith($"{fieldId}.", StringComparison.Ordinal))
            .Select(id => id[(fieldId.Length + 1)..])
            .ToHashSet(StringComparer.Ordinal);
        var result = new JsonArray();
        for (var index = 0; index < current.Count; index++)
        {
            if (current[index] is not JsonObject oldRow || updates[index] is not JsonObject newRow)
            {
                issues.Add(Issue($"fieldValues.{fieldId}.{index}", "INVALID_VALUE", "表格行格式不正确。"));
                result.Add(current[index]?.DeepClone());
                continue;
            }

            var merged = oldRow.DeepClone().AsObject();
            foreach (var columnId in editableColumns)
            {
                merged[columnId] = newRow[columnId]?.DeepClone();
            }

            result.Add(merged);
        }

        return result;
    }

    private static AttachmentRequestPreparation MergeAttachmentRequest(
        TaskDecisionRequest request,
        IReadOnlyList<AttachmentReferenceEntity> currentReferences,
        NodePlan node)
    {
        var invalidField = request.AttachmentIdsByField.Keys
            .FirstOrDefault(fieldId => !node.EditableFieldIds.Contains(fieldId, StringComparer.Ordinal));
        if (invalidField is not null)
        {
            return AttachmentRequestPreparation.Failed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "附件修改未通过校验",
                "当前节点不能修改指定附件字段。",
                [Issue($"attachmentIdsByField.{invalidField}", "FIELD_EDIT_FORBIDDEN", "当前节点不能修改该附件字段。")]));
        }

        var idsByField = currentReferences
            .Where(reference => reference.FieldId is not null)
            .GroupBy(reference => reference.FieldId!, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<Guid>)group.Select(reference => reference.AttachmentId).ToArray(),
                StringComparer.Ordinal);
        foreach (var pair in request.AttachmentIdsByField)
        {
            idsByField[pair.Key] = pair.Value;
        }

        var allIds = idsByField.Values.SelectMany(ids => ids).ToArray();
        return AttachmentRequestPreparation.Succeeded(new UpdateProcessInstanceSubmissionRequest
        {
            FormValues = [],
            AttachmentIds = allIds,
            AttachmentIdsByField = idsByField,
        });
    }

    private static ProcessInstanceCommandFailure? ValidateBaseFieldRevisions(
        JsonObject currentRevisions,
        IReadOnlyDictionary<string, int> requestedRevisions,
        IEnumerable<string> changedFieldIds)
    {
        foreach (var fieldId in changedFieldIds.Distinct(StringComparer.Ordinal))
        {
            var current = currentRevisions[fieldId] is JsonValue value
                && value.TryGetValue<int>(out var revision) ? revision : 0;
            if (!requestedRevisions.TryGetValue(fieldId, out var requested) || requested != current)
            {
                return Failure(
                    ProcessInstanceCommandError.Conflict,
                    "FIELD_REVISION_CONFLICT",
                    "字段已发生变化",
                    "其他处理人刚刚修改了同一字段，请刷新后重试。",
                    [Issue($"baseFieldRevisions.{fieldId}", "FIELD_REVISION_CONFLICT", "字段版本与当前数据不一致。")]);
            }
        }

        return null;
    }

    private static ProcessInstanceCommandFailure? ValidateReviewerRequiredFields(
        JsonObject values,
        JsonObject snapshot,
        NodePlan node)
    {
        var issues = new List<ProcessInstanceInputIssueDto>();
        foreach (var field in ReadFormFields(snapshot))
        {
            var fieldId = ReadRequiredString(field, "id");
            if (!ConditionMatches(field["displayCondition"] as JsonObject, values)
                || !CanEditField(node.EditableFieldIds, fieldId))
            {
                continue;
            }

            if (ReadBool(field, "required") && IsEmpty(values[fieldId]))
            {
                issues.Add(Issue($"fieldValues.{fieldId}", "REQUIRED", $"请填写{ReadString(field, "label") ?? fieldId}。"));
            }

            if (ReadString(field, "type") == "table" && values[fieldId] is JsonArray rows)
            {
                ValidateReviewerTableCells(field, rows, fieldId, node.EditableFieldIds, issues);
            }
        }

        return issues.Count == 0
            ? null
            : Failure(ProcessInstanceCommandError.ValidationFailed, "FORM_VALIDATION_FAILED", "表单校验未通过", "请填写本节点负责的必填字段。", issues);
    }

    private static void ValidateReviewerTableCells(
        JsonObject field,
        JsonArray rows,
        string fieldId,
        IReadOnlyList<string> editableFieldIds,
        List<ProcessInstanceInputIssueDto> issues)
    {
        if (field["columns"] is not JsonArray columns)
        {
            return;
        }

        var wholeTable = editableFieldIds.Contains(fieldId, StringComparer.Ordinal);
        for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
        {
            if (rows[rowIndex] is not JsonObject row)
            {
                issues.Add(Issue($"fieldValues.{fieldId}.{rowIndex}", "INVALID_VALUE", "表格行格式不正确。"));
                continue;
            }

            foreach (var column in columns.OfType<JsonObject>().Where(item => ReadBool(item, "required")))
            {
                var columnId = ReadRequiredString(column, "id");
                if ((wholeTable || editableFieldIds.Contains($"{fieldId}.{columnId}", StringComparer.Ordinal))
                    && IsEmpty(row[columnId]))
                {
                    issues.Add(Issue($"fieldValues.{fieldId}.{rowIndex}.{columnId}", "REQUIRED", $"请填写{ReadString(column, "label") ?? columnId}。"));
                }
            }
        }
    }

    private static bool CanEditField(IReadOnlyList<string> editableFieldIds, string fieldId) =>
        editableFieldIds.Contains(fieldId, StringComparer.Ordinal)
        || editableFieldIds.Any(id => id.StartsWith($"{fieldId}.", StringComparison.Ordinal));

    private TaskTransition RejectCurrentRound(
        WorkflowInstanceEntity instance,
        IReadOnlyList<WorkflowTaskEntity> tasks,
        JsonObject snapshot,
        DateTimeOffset now)
    {
        var cancelled = new List<Guid>();
        foreach (var task in tasks.Where(item => item.Status is "inactive" or "pending"))
        {
            task.Status = "cancelled";
            task.CompletedAt = now.UtcDateTime;
            task.Revision = checked(task.Revision + 1);
            cancelled.Add(task.Id);
        }

        if (ReadString(snapshot["flow"]?["meta"] as JsonObject, "rejectionHandling") == "auto-close")
        {
            instance.Status = "closed";
            instance.CurrentNodeSummary = "流程结束";
            instance.CurrentAssigneeId = null;
            instance.ClosedAt = now.UtcDateTime;
        }
        else
        {
            instance.Status = "rejected-pending";
            instance.CurrentNodeSummary = "待重新提交";
            instance.CurrentAssigneeId = instance.InitiatorUserId;
            _dbContext.WorkflowTasks.Add(new WorkflowTaskEntity
            {
                Id = Guid.NewGuid(),
                TaskType = "resubmission",
                InstanceId = instance.Id,
                VersionId = instance.VersionId,
                AssigneeId = instance.InitiatorUserId,
                Round = instance.CurrentRound,
                Status = "pending",
                ActivatedAt = now.UtcDateTime,
                Revision = 1,
            });
        }

        return new TaskTransition([], cancelled);
    }

    private static TaskTransition AdvanceCurrentRound(
        WorkflowInstanceEntity instance,
        IReadOnlyList<WorkflowTaskEntity> tasks,
        JsonObject snapshot,
        JsonObject formValues,
        DateTimeOffset now)
    {
        var nodes = ReadFlowNodes(snapshot)
            .Where(item => ReadString(item["data"] as JsonObject, "kind") == "approval")
            .Select(CreateNodePlan)
            .ToDictionary(item => item.Id, StringComparer.Ordinal);
        var tasksByNode = tasks.ToDictionary(task => task.NodeId!, StringComparer.Ordinal);
        var edges = ReadFlowEdges(snapshot);
        var activated = new List<Guid>();
        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var task in tasks.Where(item => item.Status == "inactive"))
            {
                var predecessors = edges
                    .Where(edge => edge.Target == task.NodeId && tasksByNode.ContainsKey(edge.Source))
                    .Select(edge => tasksByNode[edge.Source])
                    .ToArray();
                var ready = predecessors.All(IsPositiveOrSkipped);
                if (!ready)
                {
                    continue;
                }

                changed = true;
                var plan = nodes[task.NodeId!];
                task.Status = ConditionMatches(plan.ActivationCondition, formValues) ? "pending" : "skipped";
                task.ActivatedAt = now.UtcDateTime;
                task.CompletedAt = task.Status == "skipped" ? now.UtcDateTime : null;
                task.Revision = checked(task.Revision + 1);
                if (task.Status == "pending")
                {
                    activated.Add(task.Id);
                }
            }
        }

        var pending = tasks.Where(task => task.Status == "pending").ToArray();
        var completed = tasks.All(IsPositiveOrSkipped);
        instance.Status = completed ? "completed" : "reviewing";
        instance.CurrentNodeSummary = completed
            ? "流程结束"
            : string.Join("、", pending.Select(task => task.NodeNameSnapshot).Where(name => name is not null).Distinct(StringComparer.Ordinal));
        instance.CurrentAssigneeId = null;
        instance.CompletedAt = completed ? now.UtcDateTime : null;
        return new TaskTransition(activated, []);
    }

    private static bool IsPositiveOrSkipped(WorkflowTaskEntity task) =>
        task.Status == "skipped"
        || task.Status == "completed" && task.Action is "pass" or "confirm";

    private void AddTaskDecisionFacts(
        WorkflowInstanceEntity instance,
        WorkflowTaskEntity task,
        NodePlan node,
        JsonObject snapshot,
        IReadOnlyList<string> changedFieldIds,
        ProcessInstanceActor actor,
        string traceId,
        DateTimeOffset now)
    {
        var labels = ReadFormFields(snapshot).ToDictionary(
            field => ReadRequiredString(field, "id"),
            field => ReadString(field, "label") ?? ReadRequiredString(field, "id"),
            StringComparer.Ordinal);
        var metadata = new JsonObject
        {
            ["action"] = task.Action,
            ["nodeName"] = node.Name,
            ["comment"] = task.ResultComment,
            ["defaultAssigneeId"] = task.DefaultAssigneeId,
            ["actualAssigneeId"] = task.ActualAssigneeId,
            ["substitute"] = task.DefaultAssigneeId.HasValue && task.DefaultAssigneeId != task.ActualAssigneeId,
            ["fieldIds"] = new JsonArray(changedFieldIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
            ["fieldNames"] = new JsonArray(changedFieldIds.Select(id => (JsonNode?)JsonValue.Create(labels.GetValueOrDefault(id, id))).ToArray()),
        };
        _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
        {
            Id = Guid.NewGuid(),
            EventType = "task-completed",
            InstanceId = instance.Id,
            TaskId = task.Id,
            NodeId = task.NodeId,
            Round = task.Round,
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            OccurredAt = now.UtcDateTime,
            MetadataJson = metadata.ToJsonString(JsonOptions),
        });

        if (instance.Status is "completed" or "closed")
        {
            _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
            {
                Id = Guid.NewGuid(),
                EventType = instance.Status == "completed" ? "instance-completed" : "instance-closed",
                InstanceId = instance.Id,
                TaskId = task.Id,
                Round = task.Round,
                OperatorUserId = actor.OperatorUserId,
                EffectiveUserId = actor.EffectiveUserId,
                OccurredAt = now.UtcDateTime,
                MetadataJson = new JsonObject { ["reason"] = task.ResultComment }.ToJsonString(JsonOptions),
            });
        }

        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "workflow-task",
            ResourceId = task.Id,
            Action = $"decision.{task.Action}",
            FieldIdentifiersJson = JsonSerializer.Serialize(changedFieldIds, JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
    }

    private static IdempotencyRecordEntity CreateTaskDecisionIdempotencyRecord(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        TaskDecisionCommandValue value,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            ActorId = actorId,
            RouteScope = TaskDecisionRouteScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = 200,
            ResponseBodyJson = JsonSerializer.Serialize(value, JsonOptions),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddDays(7).UtcDateTime,
        };

    private static string? NormalizeComment(string? comment) =>
        string.IsNullOrWhiteSpace(comment) ? null : comment.Trim();

    private static ProcessInstanceCommandFailure TaskAlreadyCompleted() => Failure(
        ProcessInstanceCommandError.Conflict,
        "TASK_ALREADY_COMPLETED",
        "任务已被处理",
        "该任务已经由其他处理人完成，请刷新页面查看最新结果。");

    private static ProcessInstanceCommandResult<TaskDecisionCommandValue> DecisionFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static async Task<ProcessInstanceCommandResult<TaskDecisionCommandValue>> RollbackDecisionFailureAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessInstanceCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return DecisionFailed(failure);
    }

    private sealed record ReviewerFieldUpdate(
        JsonObject? Values,
        ProcessInstanceCommandFailure? Failure);

    private sealed record AttachmentRequestPreparation(
        UpdateProcessInstanceSubmissionRequest? Value,
        ProcessInstanceCommandFailure? Failure)
    {
        public static AttachmentRequestPreparation Succeeded(UpdateProcessInstanceSubmissionRequest value) => new(value, null);
        public static AttachmentRequestPreparation Failed(ProcessInstanceCommandFailure failure) => new(null, failure);
    }

    private sealed record TaskTransition(
        IReadOnlyList<Guid> ActivatedTaskIds,
        IReadOnlyList<Guid> CancelledTaskIds);
}
