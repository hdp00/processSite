using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using FlowPilot.Application.TaskCenter;

namespace FlowPilot.Application.ProcessInstances;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateProcessInstanceRequest
{
    public Guid DefinitionId { get; init; }

    public JsonObject? FormValues { get; init; }

    public Guid? CopySourceInstanceId { get; init; }

    public IReadOnlyDictionary<string, Guid?> AssigneeByNode { get; init; } =
        new Dictionary<string, Guid?>();

    public Guid? FirstAssigneeId { get; init; }

    public IReadOnlyList<Guid> AttachmentIds { get; init; } = [];

    public IReadOnlyDictionary<string, IReadOnlyList<Guid>> AttachmentIdsByField { get; init; } =
        new Dictionary<string, IReadOnlyList<Guid>>();
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpdateProcessInstanceSubmissionRequest
{
    public JsonObject? FormValues { get; init; }

    public IReadOnlyList<Guid> AttachmentIds { get; init; } = [];

    public IReadOnlyDictionary<string, IReadOnlyList<Guid>> AttachmentIdsByField { get; init; } =
        new Dictionary<string, IReadOnlyList<Guid>>();

    public IReadOnlyDictionary<string, Guid> AssigneeByNode { get; init; } =
        new Dictionary<string, Guid>();
}

public sealed record ProcessInstanceActor(
    Guid EffectiveUserId,
    Guid OperatorUserId,
    bool IsSuperAdmin,
    bool CanCopyCompletedInstance,
    bool CanReview,
    string EffectiveUserName,
    string EffectiveUserDepartmentPath);

public sealed record ProcessInstanceAttachmentReferenceDto(
    string AggregateType,
    Guid AggregateId,
    string? FieldId);

public sealed record ProcessInstanceAttachmentDto(
    Guid Id,
    int Revision,
    string OriginalName,
    long SizeBytes,
    string ContentType,
    string Status,
    TaskCenterUserRefDto UploadedBy,
    DateTimeOffset UploadedAt,
    IReadOnlyList<ProcessInstanceAttachmentReferenceDto> ReferencedBy,
    string ContentUrl);

public sealed record ProcessInstanceReviewProgressDto(
    string NodeId,
    string NodeName,
    string HandlingMode,
    string Status,
    int Round,
    TaskCenterUserRefDto? Actor = null,
    DateTimeOffset? ActionAt = null,
    string? Comment = null,
    bool? Substitute = null,
    string? ConditionSummary = null);

public sealed record ProcessInstanceTimelineEventDto(
    Guid Id,
    string Type,
    DateTimeOffset OccurredAt,
    TaskCenterUserRefDto Actor,
    string Summary,
    JsonObject Details);

public sealed record FreeTimelineEntryDto(
    Guid Id,
    int Revision,
    string Type,
    DateTimeOffset OccurredAt,
    TaskCenterUserRefDto Actor,
    string? Content,
    TaskCenterUserRefDto? Assignee,
    TaskCenterUserRefDto? PreviousAssignee = null,
    Guid? RelatedEntryId = null,
    TaskCenterUserRefDto? EditedBy = null,
    DateTimeOffset? EditedAt = null);

public sealed record ProcessInstanceDetailDto
{
    public required Guid Id { get; init; }

    public required int Revision { get; init; }

    public required Guid DefinitionId { get; init; }

    public required Guid VersionId { get; init; }

    public required string Code { get; init; }

    public required string Title { get; init; }

    public required string ProcessName { get; init; }

    public required string VersionLabel { get; init; }

    public required string WorkflowType { get; init; }

    public required string Status { get; init; }

    public required int Round { get; init; }

    public required IReadOnlyList<string> CurrentNodeNames { get; init; }

    public TaskCenterUserRefDto? CurrentAssignee { get; init; }

    public required TaskCenterUserRefDto Initiator { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }

    public required JsonObject ListValues { get; init; }

    public required JsonObject FormValues { get; init; }

    public required JsonObject FieldRevisions { get; init; }

    public required IReadOnlyList<ProcessInstanceAttachmentDto> Attachments { get; init; }

    public required IReadOnlyList<ProcessInstanceReviewProgressDto> ReviewProgress { get; init; }

    public required IReadOnlyList<TaskCenterTaskDto> Tasks { get; init; }

    public required IReadOnlyList<ProcessInstanceTimelineEventDto> Timeline { get; init; }

    public required IReadOnlyList<FreeTimelineEntryDto> FreeTimeline { get; init; }
}

public sealed record CreateProcessInstanceCommandValue(
    ProcessInstanceDetailDto Instance,
    bool Replayed);

public sealed record UpdateProcessInstanceSubmissionCommandValue(
    Guid InstanceId,
    int Revision);

public sealed record ProcessInstanceInputIssueDto(
    string Path,
    string Code,
    string Message);

public enum ProcessInstanceCommandError
{
    NotFound,
    Forbidden,
    NotLaunchable,
    ValidationFailed,
    Conflict,
    PreconditionFailed,
    IdempotencyKeyReused,
}

public sealed record ProcessInstanceCommandFailure(
    ProcessInstanceCommandError Error,
    string Code,
    string Title,
    string Detail,
    IReadOnlyList<ProcessInstanceInputIssueDto>? Issues = null);

public sealed record ProcessInstanceCommandResult<T>(
    T? Value,
    ProcessInstanceCommandFailure? Failure)
{
    public bool Succeeded => Failure is null;
}

public interface IProcessInstanceCommandService
{
    Task<ProcessInstanceCommandResult<CreateProcessInstanceCommandValue>> CreateAsync(
        CreateProcessInstanceRequest request,
        ProcessInstanceActor actor,
        string idempotencyKey,
        string verifiedEntryBaseUrl,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessInstanceCommandResult<UpdateProcessInstanceSubmissionCommandValue>> UpdateSubmissionAsync(
        Guid instanceId,
        UpdateProcessInstanceSubmissionRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string traceId,
        CancellationToken cancellationToken = default);
}

public sealed record ProcessInstanceQueryActor(
    Guid UserId,
    bool IsSuperAdmin,
    bool CanReview,
    bool CanResubmit,
    bool CanViewAllInstances);

public enum ProcessInstanceQueryError
{
    NotFound,
    Forbidden,
}

public sealed record ProcessInstanceQueryResult(
    ProcessInstanceDetailDto? Instance,
    ProcessInstanceQueryError? Error);

public interface IProcessInstanceQueryService
{
    Task<ProcessInstanceQueryResult> GetAsync(
        Guid instanceId,
        ProcessInstanceQueryActor actor,
        CancellationToken cancellationToken = default);
}
