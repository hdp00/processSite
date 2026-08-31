using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    public async Task<ProcessInstanceCommandResult<UpdateProcessInstanceSubmissionCommandValue>> UpdateSubmissionAsync(
        Guid instanceId,
        UpdateProcessInstanceSubmissionRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        if (request.FormValues is null)
        {
            return UpdateFailed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "发起数据不完整",
                "请填写流程表单。",
                [Issue("formValues", "REQUIRED", "请填写流程表单。")]));
        }

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var instance = await _dbContext.WorkflowInstances
                .SingleOrDefaultAsync(item => item.Id == instanceId, cancellationToken)
                .ConfigureAwait(false);
            var stateFailure = ValidateEditableInstance(instance, actor, expectedRevision);
            if (stateFailure is not null)
            {
                return await RollbackUpdateFailureAsync(transaction, stateFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var editableInstance = instance!;

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == editableInstance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleAsync(item => item.Id == editableInstance.DefinitionId, cancellationToken)
                .ConfigureAwait(false);
            if (definition.Type != "approval")
            {
                return await RollbackUpdateFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "WORKFLOW_TYPE_MISMATCH",
                        "不能使用此操作",
                        "自由协作流程请使用自由协作内容保存接口。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var hasDecision = await _dbContext.WorkflowTasks.AnyAsync(
                task => task.InstanceId == editableInstance.Id
                    && task.Round == editableInstance.CurrentRound
                    && (task.Action == "pass" || task.Action == "confirm" || task.Action == "reject"),
                cancellationToken).ConfigureAwait(false);
            if (hasDecision)
            {
                return await RollbackUpdateFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "INSTANCE_CONTENT_LOCKED",
                        "发起内容已锁定",
                        "当前轮已经产生审核结果，不能再修改发起内容或默认责任人。"),
                    cancellationToken).ConfigureAwait(false);
            }

            if (!TryParseVersion(version, out var basic, out var snapshot))
            {
                return await RollbackUpdateFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "LOCKED_VERSION_INVALID",
                        "流程版本不可用",
                        "实例锁定的流程版本配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var lockedBasic = basic!;
            var lockedSnapshot = snapshot!;

            var form = NormalizeAndValidateForm(request.FormValues, lockedSnapshot);
            if (form.Failure is not null)
            {
                return await RollbackUpdateFailureAsync(transaction, form.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var access = await LoadRuntimeAccessAsync(version.Id, lockedBasic, cancellationToken)
                .ConfigureAwait(false);
            var tasks = await _dbContext.WorkflowTasks
                .Where(task => task.InstanceId == editableInstance.Id
                    && task.Round == editableInstance.CurrentRound
                    && task.TaskType == "approval")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var previouslyPendingTaskIds = tasks
                .Where(task => task.Status == "pending")
                .Select(task => task.Id)
                .ToHashSet();
            var runtime = PrepareUpdatedRuntime(
                lockedSnapshot,
                form.Values!,
                request.AssigneeByNode,
                access,
                tasks,
                _timeProvider.GetUtcNow());
            if (runtime.Failure is not null)
            {
                return await RollbackUpdateFailureAsync(transaction, runtime.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var currentReferences = await _dbContext.AttachmentReferences
                .Where(reference => reference.InstanceId == editableInstance.Id
                    && reference.ReferenceType == "form-field")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var attachments = await ValidateUpdatedAttachmentsAsync(
                request,
                lockedSnapshot,
                actor.EffectiveUserId,
                currentReferences,
                cancellationToken).ConfigureAwait(false);
            if (attachments.Failure is not null)
            {
                return await RollbackUpdateFailureAsync(transaction, attachments.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var now = _timeProvider.GetUtcNow();
            var oldValues = ParseStoredObject(editableInstance.FormValuesJson);
            var changedFieldIds = ChangedFieldIds(oldValues, form.Values!);
            var changedAttachmentFieldIds = await ReplaceAttachmentReferencesAsync(
                editableInstance.Id,
                currentReferences,
                attachments.Value!,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            var revisedFieldIds = changedFieldIds
                .Concat(changedAttachmentFieldIds)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            var fieldRevisions = UpdateFieldRevisions(
                ParseStoredObject(editableInstance.FieldRevisionsJson),
                revisedFieldIds);

            editableInstance.Title = ReadRequiredString(form.Values!, "title");
            editableInstance.FormValuesJson = form.Values!.ToJsonString(JsonOptions);
            editableInstance.FieldRevisionsJson = fieldRevisions.ToJsonString(JsonOptions);
            editableInstance.Status = runtime.Value!.Status;
            editableInstance.CurrentNodeSummary = string.Join("、", runtime.Value.CurrentNodeNames);
            editableInstance.CompletedAt = runtime.Value.CompletedAt?.UtcDateTime;
            editableInstance.UpdatedAt = now.UtcDateTime;
            editableInstance.Revision = checked(editableInstance.Revision + 1);

            var projections = await _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == editableInstance.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            _dbContext.InstanceFieldValues.RemoveRange(projections);
            await AddFieldProjectionsAsync(editableInstance, form.Values!, cancellationToken)
                .ConfigureAwait(false);

            AddSubmissionUpdateFacts(
                editableInstance,
                lockedSnapshot,
                revisedFieldIds,
                runtime.ChangedAssigneeNodeIds,
                actor,
                traceId,
                now);
            await _emailOutboxWriter.EnqueueAsync(
                editableInstance,
                definition,
                version,
                lockedSnapshot,
                tasks.Where(task => task.Status == "pending" && !previouslyPendingTaskIds.Contains(task.Id)).ToArray(),
                now,
                cancellationToken).ConfigureAwait(false);

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return UpdateSucceeded(editableInstance.Id, editableInstance.Revision);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return UpdateFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private static ProcessInstanceCommandFailure? ValidateEditableInstance(
        WorkflowInstanceEntity? instance,
        ProcessInstanceActor actor,
        int expectedRevision)
    {
        if (instance is null)
        {
            return Failure(
                ProcessInstanceCommandError.NotFound,
                "INSTANCE_NOT_FOUND",
                "流程实例不存在",
                "指定的流程实例不存在。");
        }

        if (instance.Revision != expectedRevision)
        {
            return RevisionMismatch();
        }

        if (!actor.IsSuperAdmin && instance.InitiatorUserId != actor.EffectiveUserId)
        {
            return Failure(
                ProcessInstanceCommandError.Forbidden,
                "INSTANCE_EDIT_FORBIDDEN",
                "不能修改发起内容",
                "只有该实例的实际创建人可以修改发起内容。");
        }

        return instance.Status != "reviewing"
            ? Failure(
                ProcessInstanceCommandError.Conflict,
                "INSTANCE_CONTENT_LOCKED",
                "发起内容已锁定",
                "只有正在审核且尚未产生审核结果的实例可以修改发起内容。")
            : null;
    }

    private static ProcessInstanceCommandFailure RevisionMismatch() => Failure(
        ProcessInstanceCommandError.PreconditionFailed,
        "REVISION_MISMATCH",
        "数据已发生变化",
        "流程实例已被其他操作更新，请刷新后重试。");

    private static UpdatedRuntimePreparation PrepareUpdatedRuntime(
        JsonObject snapshot,
        JsonObject formValues,
        IReadOnlyDictionary<string, Guid> requestedAssignees,
        RuntimeAccess access,
        IReadOnlyList<WorkflowTaskEntity> tasks,
        DateTimeOffset now)
    {
        var nodes = ReadFlowNodes(snapshot)
            .Where(node => ReadString(node["data"] as JsonObject, "kind") == "approval")
            .Select(CreateNodePlan)
            .ToArray();
        var tasksByNode = tasks
            .Where(task => !string.IsNullOrWhiteSpace(task.NodeId))
            .ToDictionary(task => task.NodeId!, StringComparer.Ordinal);
        if (tasksByNode.Count != nodes.Length || nodes.Any(node => !tasksByNode.ContainsKey(node.Id)))
        {
            return UpdatedRuntimePreparation.Failed(Failure(
                ProcessInstanceCommandError.Conflict,
                "INSTANCE_RUNTIME_INVALID",
                "流程运行数据不完整",
                "当前轮任务与锁定流程版本不一致，不能保存发起内容。"));
        }

        var nodeIds = nodes.Select(node => node.Id).ToHashSet(StringComparer.Ordinal);
        var issues = requestedAssignees.Keys
            .Where(nodeId => !nodeIds.Contains(nodeId))
            .Select(nodeId => Issue(
                $"assigneeByNode.{nodeId}",
                "NODE_NOT_FOUND",
                "节点不属于实例锁定版本。"))
            .ToList();
        var plans = new List<RuntimeTask>();
        var changedAssigneeNodeIds = new List<string>();
        foreach (var node in nodes)
        {
            var task = tasksByNode[node.Id];
            Guid? assigneeId = task.DefaultAssigneeId;
            if (requestedAssignees.TryGetValue(node.Id, out var requestedId))
            {
                assigneeId = requestedId;
            }

            if (!node.SpecifyAssignee && requestedAssignees.ContainsKey(node.Id))
            {
                issues.Add(Issue(
                    $"assigneeByNode.{node.Id}",
                    "ASSIGNEE_NOT_CONFIGURED",
                    $"“{node.Name}”未开启发起时指定默认责任人。"));
            }
            else if (node.SpecifyAssignee
                && (!assigneeId.HasValue || !access.IsGroupMember(node.GroupId, assigneeId.Value)))
            {
                issues.Add(Issue(
                    $"assigneeByNode.{node.Id}",
                    "INVALID_REFERENCE",
                    $"请选择“{node.Name}”当前权限组中的有效默认责任人。"));
            }

            if (task.DefaultAssigneeId != assigneeId)
            {
                task.DefaultAssigneeId = assigneeId;
                changedAssigneeNodeIds.Add(node.Id);
            }

            task.Status = "inactive";
            task.CompletedAt = null;
            task.Revision = checked(task.Revision + 1);
            plans.Add(new RuntimeTask(
                task,
                node.Id,
                node.Name,
                node.HandlingMode,
                node.EditableFieldIds,
                node.AllowRepeatedEditing,
                assigneeId.HasValue ? access.User(assigneeId.Value) : null,
                node.ActivationCondition));
        }

        if (issues.Count > 0)
        {
            return UpdatedRuntimePreparation.Failed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "ASSIGNEE_VALIDATION_FAILED",
                "默认责任人校验未通过",
                "请重新选择当前有效的默认责任人。",
                issues));
        }

        ActivateReadyTasks(plans, ReadFlowEdges(snapshot), formValues, now);
        var pending = plans.Where(plan => plan.Entity.Status == "pending").ToArray();
        var completed = plans.Count > 0 && plans.All(plan => plan.Entity.Status == "skipped");
        return UpdatedRuntimePreparation.Succeeded(
            new RuntimeValue(
                plans,
                completed ? "completed" : "reviewing",
                completed ? ["流程结束"] : pending.Select(plan => plan.NodeName!).ToArray(),
                null,
                completed ? now : null,
                null,
                null,
                Guid.Empty),
            changedAssigneeNodeIds);
    }

    private async Task<AttachmentPreparation> ValidateUpdatedAttachmentsAsync(
        UpdateProcessInstanceSubmissionRequest request,
        JsonObject snapshot,
        Guid actorId,
        IReadOnlyList<AttachmentReferenceEntity> currentReferences,
        CancellationToken cancellationToken)
    {
        var mappedIds = request.AttachmentIdsByField.Values.SelectMany(ids => ids).ToArray();
        var requestedIds = request.AttachmentIds.Count > 0 ? request.AttachmentIds.ToArray() : mappedIds;
        var issues = ValidateAttachmentMapping(requestedIds, mappedIds, request.AttachmentIdsByField, snapshot);
        if (issues.Count > 0)
        {
            return AttachmentPreparation.Failed(AttachmentFailure(issues));
        }

        var attachments = await _dbContext.RuntimeAttachments
            .Where(item => requestedIds.Contains(item.Id))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var requestedReferences = await _dbContext.AttachmentReferences
            .AsNoTracking()
            .Where(reference => requestedIds.Contains(reference.AttachmentId))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var currentIds = currentReferences.Select(reference => reference.AttachmentId).ToHashSet();
        if (attachments.Length != requestedIds.Length || attachments.Any(attachment =>
                currentIds.Contains(attachment.Id)
                    ? attachment.State is not ("active" or "cleanup-pending")
                    : attachment.State != "staged"
                        || attachment.UploadedBy != actorId
                        || requestedReferences.Any(reference => reference.AttachmentId == attachment.Id)))
        {
            return AttachmentPreparation.Failed(Failure(
                ProcessInstanceCommandError.Forbidden,
                "ATTACHMENT_REFERENCE_FORBIDDEN",
                "不能使用部分附件",
                "只能保留本实例已有附件，或提交当前用户尚未关联业务数据的暂存附件。"));
        }

        var fieldByAttachment = request.AttachmentIdsByField
            .SelectMany(pair => pair.Value.Select(id => (Id: id, FieldId: pair.Key)))
            .ToDictionary(item => item.Id, item => item.FieldId);
        ValidateAttachmentFiles(attachments, fieldByAttachment, snapshot, issues);
        return issues.Count > 0
            ? AttachmentPreparation.Failed(AttachmentFailure(issues))
            : AttachmentPreparation.Succeeded(attachments
                .Select(item => new AttachmentSelection(item, fieldByAttachment[item.Id]))
                .ToArray());
    }

    private static List<ProcessInstanceInputIssueDto> ValidateAttachmentMapping(
        Guid[] requestedIds,
        Guid[] mappedIds,
        IReadOnlyDictionary<string, IReadOnlyList<Guid>> idsByField,
        JsonObject snapshot)
    {
        var issues = new List<ProcessInstanceInputIssueDto>();
        if (requestedIds.Distinct().Count() != requestedIds.Length
            || mappedIds.Distinct().Count() != mappedIds.Length
            || !requestedIds.ToHashSet().SetEquals(mappedIds))
        {
            issues.Add(Issue("attachmentIdsByField", "ATTACHMENT_FIELD_MISSING", "每个附件必须且只能关联一个当前表单字段。"));
        }

        var attachmentFields = ReadFormFields(snapshot)
            .Where(field => ReadString(field, "type") == "attachment")
            .ToDictionary(field => ReadRequiredString(field, "id"), StringComparer.Ordinal);
        foreach (var pair in idsByField)
        {
            if (!attachmentFields.TryGetValue(pair.Key, out var field))
            {
                issues.Add(Issue($"attachmentIdsByField.{pair.Key}", "ATTACHMENT_FIELD_INVALID", "附件字段不属于实例锁定版本。"));
                continue;
            }

            var config = field["attachment"] as JsonObject;
            var maxCount = ReadInt(config, "maxCount") ?? (ReadBool(config, "inlinePdf") ? 1 : 20);
            if (pair.Value.Count > maxCount)
            {
                issues.Add(Issue($"attachmentIdsByField.{pair.Key}", "ATTACHMENT_LIMIT_REACHED", $"该字段最多允许 {maxCount} 个附件。"));
            }
        }

        return issues;
    }

    private static void ValidateAttachmentFiles(
        IReadOnlyList<RuntimeAttachment> attachments,
        Dictionary<Guid, string> fieldByAttachment,
        JsonObject snapshot,
        List<ProcessInstanceInputIssueDto> issues)
    {
        var fields = ReadFormFields(snapshot)
            .Where(field => ReadString(field, "type") == "attachment")
            .ToDictionary(field => ReadRequiredString(field, "id"), StringComparer.Ordinal);
        foreach (var attachment in attachments)
        {
            var fieldId = fieldByAttachment[attachment.Id];
            var config = fields[fieldId]["attachment"] as JsonObject;
            var maxSizeMb = ReadInt(config, "maxSizeMb") ?? 100;
            if (attachment.SizeBytes > maxSizeMb * 1024L * 1024L)
            {
                issues.Add(Issue($"attachmentIdsByField.{fieldId}", "ATTACHMENT_TOO_LARGE", $"附件大小不能超过 {maxSizeMb} MB。"));
            }

            var contentType = attachment.DetectedContentType ?? attachment.DeclaredContentType ?? "application/octet-stream";
            if (ReadBool(config, "inlinePdf")
                && contentType != "application/pdf"
                && !attachment.OriginalFileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
            {
                issues.Add(Issue($"attachmentIdsByField.{fieldId}", "PDF_ATTACHMENT_REQUIRED", "该字段只允许 PDF 文件。"));
            }
        }
    }

    private async Task<string[]> ReplaceAttachmentReferencesAsync(
        Guid instanceId,
        IReadOnlyList<AttachmentReferenceEntity> currentReferences,
        IReadOnlyList<AttachmentSelection> selections,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var desired = selections.ToDictionary(selection => selection.Attachment.Id);
        var changedFields = new HashSet<string>(StringComparer.Ordinal);
        var referencesToRemove = currentReferences
            .Where(reference => !desired.TryGetValue(reference.AttachmentId, out var selection)
                || reference.FieldId != selection.FieldId)
            .ToArray();
        foreach (var reference in referencesToRemove)
        {
            if (reference.FieldId is not null)
            {
                changedFields.Add(reference.FieldId);
            }

            _dbContext.AttachmentReferences.Remove(reference);
        }

        var removedIds = referencesToRemove
            .Select(reference => reference.AttachmentId)
            .Where(id => !desired.ContainsKey(id))
            .Distinct()
            .ToArray();
        if (removedIds.Length > 0)
        {
            var removedReferenceIds = referencesToRemove.Select(reference => reference.Id).ToArray();
            var otherReferenceIds = await _dbContext.AttachmentReferences
                .AsNoTracking()
                .Where(reference => removedIds.Contains(reference.AttachmentId)
                    && !removedReferenceIds.Contains(reference.Id))
                .Select(reference => reference.AttachmentId)
                .Distinct()
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var unreferencedIds = removedIds.Except(otherReferenceIds).ToArray();
            var removedAttachments = await _dbContext.RuntimeAttachments
                .Where(attachment => unreferencedIds.Contains(attachment.Id))
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            foreach (var attachment in removedAttachments)
            {
                attachment.State = "cleanup-pending";
                attachment.CleanupAfter = now.UtcDateTime;
                attachment.Revision = checked(attachment.Revision + 1);
            }
        }

        var currentById = currentReferences.ToDictionary(reference => reference.AttachmentId);
        foreach (var selection in selections)
        {
            if (currentById.TryGetValue(selection.Attachment.Id, out var current)
                && current.FieldId == selection.FieldId)
            {
                continue;
            }

            changedFields.Add(selection.FieldId);
            selection.Attachment.State = "active";
            selection.Attachment.CleanupAfter = null;
            selection.Attachment.Revision = checked(selection.Attachment.Revision + 1);
            _dbContext.AttachmentReferences.Add(new AttachmentReferenceEntity
            {
                Id = Guid.NewGuid(),
                AttachmentId = selection.Attachment.Id,
                InstanceId = instanceId,
                FieldId = selection.FieldId,
                ReferenceType = "form-field",
                CreatedBy = actorId,
                CreatedAt = now.UtcDateTime,
            });
        }

        return changedFields.ToArray();
    }

    private void AddSubmissionUpdateFacts(
        WorkflowInstanceEntity instance,
        JsonObject snapshot,
        IReadOnlyList<string> changedFieldIds,
        IReadOnlyList<string> changedAssigneeNodeIds,
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
            ["fieldIds"] = new JsonArray(changedFieldIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
            ["fieldNames"] = new JsonArray(changedFieldIds.Select(id => (JsonNode?)JsonValue.Create(labels.GetValueOrDefault(id, id))).ToArray()),
            ["assigneeNodeIds"] = new JsonArray(changedAssigneeNodeIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
        };
        _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
        {
            Id = Guid.NewGuid(),
            EventType = "submission-updated",
            InstanceId = instance.Id,
            Round = instance.CurrentRound,
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            OccurredAt = now.UtcDateTime,
            MetadataJson = metadata.ToJsonString(JsonOptions),
        });
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "process-instance",
            ResourceId = instance.Id,
            Action = "update-submission",
            FieldIdentifiersJson = JsonSerializer.Serialize(changedFieldIds, JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
    }

    private static string[] ChangedFieldIds(JsonObject oldValues, JsonObject newValues) =>
        oldValues.Select(item => item.Key)
            .Concat(newValues.Select(item => item.Key))
            .Distinct(StringComparer.Ordinal)
            .Where(fieldId => !JsonNode.DeepEquals(oldValues[fieldId], newValues[fieldId]))
            .ToArray();

    private static JsonObject UpdateFieldRevisions(JsonObject revisions, IEnumerable<string> changedFieldIds)
    {
        foreach (var fieldId in changedFieldIds)
        {
            var current = revisions[fieldId] is JsonValue value && value.TryGetValue<int>(out var revision)
                ? revision
                : 0;
            revisions[fieldId] = checked(current + 1);
        }

        return revisions;
    }

    private static JsonObject ParseStoredObject(string json)
    {
        try
        {
            return JsonNode.Parse(json) as JsonObject
                ?? throw new InvalidDataException("Stored process JSON is not an object.");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("Stored process JSON is invalid.", exception);
        }
    }

    private static ProcessInstanceCommandResult<UpdateProcessInstanceSubmissionCommandValue> UpdateSucceeded(
        Guid instanceId,
        int revision) => new(new UpdateProcessInstanceSubmissionCommandValue(instanceId, revision), null);

    private static ProcessInstanceCommandResult<UpdateProcessInstanceSubmissionCommandValue> UpdateFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static async Task<ProcessInstanceCommandResult<UpdateProcessInstanceSubmissionCommandValue>> RollbackUpdateFailureAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessInstanceCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return UpdateFailed(failure);
    }

    private sealed record UpdatedRuntimePreparation(
        RuntimeValue? Value,
        IReadOnlyList<string> ChangedAssigneeNodeIds,
        ProcessInstanceCommandFailure? Failure)
    {
        public static UpdatedRuntimePreparation Succeeded(
            RuntimeValue value,
            IReadOnlyList<string> changedAssigneeNodeIds) => new(value, changedAssigneeNodeIds, null);

        public static UpdatedRuntimePreparation Failed(ProcessInstanceCommandFailure failure) => new(null, [], failure);
    }
}
