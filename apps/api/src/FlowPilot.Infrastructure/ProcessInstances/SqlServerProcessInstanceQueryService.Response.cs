using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Persistence;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceQueryService
{
    private static ProcessInstanceDetailDto BuildDetail(DetailSource source)
    {
        var pendingNodeNames = source.Tasks
            .Where(task => task.TaskType == "approval" && task.Status == "pending")
            .Select(task => task.NodeNameSnapshot!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var currentNodeNames = pendingNodeNames.Length > 0
            ? pendingNodeNames
            : SplitNodeNames(source.Instance.CurrentNodeSummary);
        var taskDtos = source.Tasks
            .Select(task => BuildTaskDto(task, source))
            .ToArray();

        return new ProcessInstanceDetailDto
        {
            Id = source.Instance.Id,
            Revision = source.Instance.Revision,
            DefinitionId = source.Instance.DefinitionId,
            VersionId = source.Instance.VersionId,
            Code = source.Instance.InstanceNumber,
            Title = source.Instance.Title,
            ProcessName = source.Definition.Name,
            VersionLabel = source.Version.VersionLabel,
            WorkflowType = source.Definition.Type,
            Status = source.Instance.Status,
            Round = source.Instance.CurrentRound,
            CurrentNodeNames = currentNodeNames,
            CurrentAssignee = User(source.Users, source.Instance.CurrentAssigneeId),
            Initiator = source.Initiator,
            CreatedAt = AsUtc(source.Instance.CreatedAt),
            UpdatedAt = AsUtc(source.Instance.UpdatedAt),
            ListValues = ProjectListValues(source.FormValues, source.Fields),
            FormValues = source.FormValues.DeepClone().AsObject(),
            FieldRevisions = source.FieldRevisions.DeepClone().AsObject(),
            Attachments = BuildAttachments(source),
            ReviewProgress = BuildReviewProgress(source),
            Tasks = taskDtos,
            Timeline = BuildTimeline(source),
            FreeTimeline = BuildFreeTimeline(source),
        };
    }

    private static TaskCenterTaskDto BuildTaskDto(
        WorkflowTaskEntity task,
        DetailSource source)
    {
        var node = ReadNodeSettings(source.Snapshot, task.NodeId);
        var isApproval = task.TaskType == "approval";
        var canUseApproval = task.Status == "pending"
            && source.Actor.CanReview
            && (source.Actor.IsSuperAdmin
                || task.GroupId.HasValue && source.EffectiveGroupIds.Contains(task.GroupId.Value));
        IReadOnlyList<string> allowedActions = task.TaskType switch
        {
            "approval" when canUseApproval =>
                node.HandlingMode == "confirmation" ? ["confirm"] : ["pass", "reject"],
            "free-collaboration" when task.Status == "pending"
                && source.Actor.CanReview
                && (source.Actor.IsSuperAdmin || task.AssigneeId == source.Actor.UserId) =>
                ["reply", "change-assignee"],
            "resubmission" when task.Status == "pending"
                && source.Actor.CanResubmit
                && (source.Actor.IsSuperAdmin || task.AssigneeId == source.Actor.UserId) =>
                ["resubmit"],
            _ => [],
        };

        return new TaskCenterTaskDto
        {
            Id = task.Id,
            Revision = task.Revision,
            InstanceId = task.InstanceId,
            DefinitionId = source.Instance.DefinitionId,
            VersionId = task.VersionId,
            TaskType = task.TaskType,
            NodeId = isApproval ? task.NodeId : null,
            NodeName = isApproval ? task.NodeNameSnapshot : null,
            HandlingMode = isApproval ? node.HandlingMode : null,
            PermissionGroupId = isApproval ? task.GroupId : null,
            Assignee = User(source.Users, task.AssigneeId),
            DefaultAssignee = User(source.Users, task.DefaultAssigneeId),
            CompletedBy = User(source.Users, task.ActualAssigneeId),
            Status = task.Status,
            Action = task.Action,
            ResultStatus = task.Action switch
            {
                "pass" => "passed",
                "confirm" => "confirmed",
                "reject" => "rejected",
                _ => null,
            },
            Comment = task.ResultComment,
            Round = isApproval || task.TaskType == "resubmission" ? task.Round : null,
            EditableFieldIds = isApproval ? node.EditableFieldIds : null,
            AllowRepeatedEditing = isApproval ? node.AllowRepeatedEditing : null,
            AllowedActions = allowedActions,
            CreatedAt = AsUtc(task.ActivatedAt),
            CompletedAt = task.CompletedAt.HasValue ? AsUtc(task.CompletedAt.Value) : null,
        };
    }

    private static ProcessInstanceReviewProgressDto[] BuildReviewProgress(
        DetailSource source) => source.Tasks
        .Where(task => task.TaskType == "approval")
        .Select(task =>
        {
            var node = ReadNodeSettings(source.Snapshot, task.NodeId);
            var status = task.Action switch
            {
                "pass" => "passed",
                "confirm" => "confirmed",
                "reject" => "rejected",
                _ when task.Status == "cancelled" => "cancelled",
                _ when task.Status == "skipped" => "skipped",
                _ => "pending",
            };
            return new ProcessInstanceReviewProgressDto(
                task.NodeId!,
                task.NodeNameSnapshot!,
                node.HandlingMode,
                status,
                task.Round,
                User(source.Users, task.ActualAssigneeId),
                task.CompletedAt.HasValue ? AsUtc(task.CompletedAt.Value) : null,
                task.ResultComment,
                task.ActualAssigneeId.HasValue
                    && task.DefaultAssigneeId.HasValue
                    && task.ActualAssigneeId != task.DefaultAssigneeId);
        })
        .ToArray();

    private static ProcessInstanceTimelineEventDto[] BuildTimeline(
        DetailSource source) => source.Events
        .Select(item => new ProcessInstanceTimelineEventDto(
            item.Id,
            item.EventType,
            AsUtc(item.OccurredAt),
            source.Users[item.EffectiveUserId],
            EventSummary(item, source),
            ParseOptionalObject(item.MetadataJson)))
        .ToArray();

    private static string EventSummary(WorkflowEventEntity item, DetailSource source) =>
        item.EventType switch
        {
            "instance-created" => $"{source.Users[item.EffectiveUserId].Name} 发起流程 {source.Instance.InstanceNumber}",
            "submission-updated" => SubmissionUpdatedSummary(item, source),
            "task-completed" => $"{source.Users[item.EffectiveUserId].Name} 完成处理",
            "instance-completed" => $"流程 {source.Instance.InstanceNumber} 已完成",
            "instance-closed" => $"流程 {source.Instance.InstanceNumber} 已关闭",
            _ => item.EventType,
        };

    private static string SubmissionUpdatedSummary(WorkflowEventEntity item, DetailSource source)
    {
        var names = ParseOptionalObject(item.MetadataJson)["fieldNames"] is JsonArray values
            ? values.Select(StringValue).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray()
            : [];
        return names.Length == 0
            ? $"{source.Users[item.EffectiveUserId].Name} 保存发起内容"
            : $"{source.Users[item.EffectiveUserId].Name} 修改发起内容：{string.Join("、", names)}";
    }

    private static FreeTimelineEntryDto[] BuildFreeTimeline(DetailSource source) =>
        source.FreeTimeline.Select(item => new FreeTimelineEntryDto(
            item.Id,
            item.Revision,
            item.EntryType,
            AsUtc(item.OccurredAt),
            source.Users[item.ActorUserId],
            item.EntryType == "created"
                ? StringValue(source.FormValues["initialContent"])
                : item.Content ?? item.Reason,
            User(source.Users, item.AssigneeId),
            User(source.Users, item.PreviousAssigneeId),
            item.RelatedEntryId,
            User(source.Users, item.EditedBy),
            item.EditedAt.HasValue ? AsUtc(item.EditedAt.Value) : null))
        .ToArray();

    private static ProcessInstanceAttachmentDto[] BuildAttachments(DetailSource source)
    {
        var attachmentsById = source.Attachments.ToDictionary(item => item.Id);
        return source.AttachmentReferences
            .Where(reference => attachmentsById.ContainsKey(reference.AttachmentId))
            .GroupBy(reference => reference.AttachmentId)
            .Select(group =>
            {
                var attachment = attachmentsById[group.Key];
                return new ProcessInstanceAttachmentDto(
                    attachment.Id,
                    attachment.Revision,
                    attachment.OriginalFileName,
                    attachment.SizeBytes ?? 0,
                    attachment.DetectedContentType
                        ?? attachment.DeclaredContentType
                        ?? "application/octet-stream",
                    attachment.State,
                    source.Users[attachment.UploadedBy],
                    AsUtc(attachment.StagedAt ?? attachment.CreatedAt),
                    group.Select(reference => new ProcessInstanceAttachmentReferenceDto(
                        reference.ReferenceType == "free-timeline" ? "free-timeline-entry" : "process-instance",
                        reference.FreeTimelineEntryId ?? source.Instance.Id,
                        reference.FieldId)).ToArray(),
                    $"/api/flowpilot/v1/attachments/{attachment.Id:D}/content");
            })
            .ToArray();
    }

    private static JsonObject ProjectListValues(
        JsonObject formValues,
        IReadOnlyList<RuntimeVersionField> fields)
    {
        var result = new JsonObject();
        foreach (var field in fields.Where(item => item.TableFieldId is null))
        {
            if (formValues.TryGetPropertyValue(field.FieldId, out var value))
            {
                result[field.FieldId] = value?.DeepClone();
            }
        }

        foreach (var table in fields
                     .Where(item => item.TableFieldId is not null && item.ColumnId is not null)
                     .GroupBy(item => item.TableFieldId!, StringComparer.Ordinal))
        {
            if (formValues[table.Key] is not JsonArray rows)
            {
                continue;
            }

            var allowedColumns = table.Select(item => item.ColumnId!).ToHashSet(StringComparer.Ordinal);
            var projectedRows = new JsonArray();
            foreach (var row in rows.OfType<JsonObject>())
            {
                var projected = new JsonObject();
                foreach (var property in row)
                {
                    if (allowedColumns.Contains(property.Key) || property.Key is "id" or "rowId" or "key")
                    {
                        projected[property.Key] = property.Value?.DeepClone();
                    }
                }

                projectedRows.Add(projected);
            }

            result[table.Key] = projectedRows;
        }

        return result;
    }

    private static NodeSettings ReadNodeSettings(JsonObject snapshot, string? nodeId)
    {
        if (string.IsNullOrWhiteSpace(nodeId)
            || snapshot["flow"]?["nodes"] is not JsonArray nodes)
        {
            return NodeSettings.Default;
        }

        var node = nodes.OfType<JsonObject>()
            .FirstOrDefault(item => StringValue(item["id"]) == nodeId);
        var data = node?["data"] as JsonObject;
        var editableFields = data?["editableFieldIds"] is JsonArray values
            ? values.Select(StringValue).Where(value => value is not null).Select(value => value!).ToArray()
            : [];
        return new NodeSettings(
            StringValue(data?["handlingMode"]) == "confirmation" ? "confirmation" : "approval",
            editableFields,
            data?["allowRepeatedEditing"] is JsonValue repeated
                && repeated.TryGetValue<bool>(out var enabled)
                && enabled);
    }

    private static TaskCenterUserRefDto? User(
        IReadOnlyDictionary<Guid, TaskCenterUserRefDto> users,
        Guid? userId) => userId.HasValue ? users.GetValueOrDefault(userId.Value) : null;

    private static string? StringValue(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static JsonObject ParseOptionalObject(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }

        try
        {
            return JsonNode.Parse(json) as JsonObject ?? [];
        }
        catch (System.Text.Json.JsonException)
        {
            return [];
        }
    }

    private static string[] SplitNodeNames(string? summary) =>
        string.IsNullOrWhiteSpace(summary)
            ? []
            : summary.Split(['、', ',', '，', ';', '；'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private sealed record NodeSettings(
        string HandlingMode,
        IReadOnlyList<string> EditableFieldIds,
        bool AllowRepeatedEditing)
    {
        public static NodeSettings Default { get; } = new("approval", [], false);
    }
}
