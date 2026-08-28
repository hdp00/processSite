using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Persistence;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private static ProcessInstanceDetailDto BuildDetail(
        WorkflowInstanceEntity instance,
        RuntimeWorkflowDefinition definition,
        RuntimeWorkflowVersion version,
        ProcessInstanceActor actor,
        JsonObject formValues,
        JsonObject fieldRevisions,
        RuntimeValue runtime,
        IReadOnlyList<AttachmentSelection> attachments)
    {
        var initiator = new TaskCenterUserRefDto(
            actor.EffectiveUserId,
            actor.EffectiveUserName,
            actor.EffectiveUserDepartmentPath);
        var tasks = runtime.TaskPlans.Select(plan => BuildTaskDto(
            plan,
            instance,
            definition.Id)).ToArray();
        var reviewProgress = runtime.TaskPlans
            .Where(plan => plan.Entity.TaskType == "approval")
            .Select(plan => new ProcessInstanceReviewProgressDto(
                plan.NodeId!,
                plan.NodeName!,
                plan.HandlingMode,
                plan.Entity.Status == "skipped" ? "skipped" : "pending",
                1,
                ConditionSummary: plan.ConditionSummary,
                ActionAt: plan.ConditionEvaluatedAt))
            .ToArray();
        var timelineDetails = new JsonObject
        {
            ["instanceNumber"] = instance.InstanceNumber,
            ["versionId"] = instance.VersionId,
        };
        var freeTimeline = runtime.FreeTimelineId.HasValue && runtime.FirstAssignee is not null
            ? new FreeTimelineEntryDto[]
            {
                new(
                    runtime.FreeTimelineId.Value,
                    1,
                    "created",
                    AsUtc(instance.CreatedAt),
                    initiator,
                    formValues["initialContent"] is JsonValue initialContent
                        && initialContent.TryGetValue<string>(out var content)
                            ? content
                            : null,
                    runtime.FirstAssignee),
            }
            : [];

        return new ProcessInstanceDetailDto
        {
            Id = instance.Id,
            Revision = instance.Revision,
            DefinitionId = instance.DefinitionId,
            VersionId = instance.VersionId,
            Code = instance.InstanceNumber,
            Title = instance.Title,
            ProcessName = definition.Name,
            VersionLabel = version.VersionLabel,
            WorkflowType = definition.Type,
            Status = instance.Status,
            Round = instance.CurrentRound,
            CurrentNodeNames = runtime.CurrentNodeNames,
            CurrentAssignee = runtime.CurrentAssignee,
            Initiator = initiator,
            CreatedAt = AsUtc(instance.CreatedAt),
            UpdatedAt = AsUtc(instance.UpdatedAt),
            ListValues = formValues.DeepClone().AsObject(),
            FormValues = formValues.DeepClone().AsObject(),
            FieldRevisions = fieldRevisions.DeepClone().AsObject(),
            Attachments = attachments.Select(selection => new ProcessInstanceAttachmentDto(
                selection.Attachment.Id,
                selection.Attachment.Revision,
                selection.Attachment.OriginalFileName,
                selection.Attachment.SizeBytes ?? 0,
                selection.Attachment.DetectedContentType
                    ?? selection.Attachment.DeclaredContentType
                    ?? "application/octet-stream",
                selection.Attachment.State,
                initiator,
                AsUtc(selection.Attachment.StagedAt ?? selection.Attachment.CreatedAt),
                [new ProcessInstanceAttachmentReferenceDto("process-instance", instance.Id, selection.FieldId)],
                $"/api/flowpilot/v1/attachments/{selection.Attachment.Id:D}/content")).ToArray(),
            ReviewProgress = reviewProgress,
            Tasks = tasks,
            Timeline =
            [
                new ProcessInstanceTimelineEventDto(
                    runtime.CreatedEventId,
                    "instance-created",
                    AsUtc(instance.CreatedAt),
                    initiator,
                    $"{actor.EffectiveUserName} 发起流程 {instance.InstanceNumber}",
                    timelineDetails),
            ],
            FreeTimeline = freeTimeline,
        };
    }

    private static TaskCenterTaskDto BuildTaskDto(
        RuntimeTask plan,
        WorkflowInstanceEntity instance,
        Guid definitionId)
    {
        var isApproval = plan.Entity.TaskType == "approval";
        return new TaskCenterTaskDto
        {
            Id = plan.Entity.Id,
            Revision = plan.Entity.Revision,
            InstanceId = instance.Id,
            DefinitionId = definitionId,
            VersionId = instance.VersionId,
            TaskType = plan.Entity.TaskType,
            NodeId = isApproval ? plan.NodeId : null,
            NodeName = isApproval ? plan.NodeName : null,
            HandlingMode = isApproval ? plan.HandlingMode : null,
            PermissionGroupId = isApproval ? plan.Entity.GroupId : null,
            Assignee = !isApproval ? plan.Assignee : null,
            DefaultAssignee = isApproval ? plan.Assignee : null,
            Status = plan.Entity.Status,
            Round = isApproval ? 1 : null,
            EditableFieldIds = isApproval ? plan.EditableFieldIds : null,
            AllowRepeatedEditing = isApproval ? plan.AllowRepeatedEditing : null,
            AllowedActions = [],
            CreatedAt = AsUtc(plan.Entity.ActivatedAt),
            CompletedAt = plan.Entity.CompletedAt.HasValue
                ? AsUtc(plan.Entity.CompletedAt.Value)
                : null,
        };
    }

    private static IdempotencyRecordEntity CreateIdempotencyRecord(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        ProcessInstanceDetailDto detail,
        DateTimeOffset now) => new()
    {
        Id = Guid.NewGuid(),
        ActorId = actorId,
        RouteScope = CreateRouteScope,
        IdempotencyKey = idempotencyKey,
        RequestHash = requestHash,
        Status = "completed",
        FirstHttpStatus = 201,
        ReplayHeadersJson = new JsonObject
        {
            ["etag"] = $"\"{detail.Revision}\"",
            ["location"] = $"/api/flowpilot/v1/process-instances/{detail.Id:D}",
        }.ToJsonString(JsonOptions),
        ResponseBodyJson = JsonSerializer.Serialize(detail, JsonOptions),
        CreatedAt = now.UtcDateTime,
        CompletedAt = now.UtcDateTime,
        ExpiresAt = now.AddDays(7).UtcDateTime,
    };

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}
