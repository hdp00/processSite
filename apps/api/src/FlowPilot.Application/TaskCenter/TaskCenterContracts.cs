using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using FlowPilot.Application.ProcessInstances;

namespace FlowPilot.Application.TaskCenter;

public sealed record PageMetaDto(
    int Page,
    int PageSize,
    long Total,
    int TotalPages);

public sealed record PageDto<T>(
    IReadOnlyList<T> Items,
    PageMetaDto Meta,
    IReadOnlyList<TaskCenterFlowCategoryDto> Categories);

public sealed record TaskCenterFlowCategoryDto(
    Guid DefinitionId,
    string WorkflowType,
    long Count);

public sealed record TaskCenterUserRefDto(
    Guid Id,
    string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? DepartmentPath = null);

public sealed record ProcessInstanceSummaryDto
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

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TaskCenterUserRefDto? CurrentAssignee { get; init; }

    public required TaskCenterUserRefDto Initiator { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }

    public required JsonObject ListValues { get; init; }
}

public sealed record TaskCenterTaskDto
{
    public required Guid Id { get; init; }

    public required int Revision { get; init; }

    public required Guid InstanceId { get; init; }

    public required Guid DefinitionId { get; init; }

    public required Guid VersionId { get; init; }

    public required string TaskType { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? NodeId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? NodeName { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? HandlingMode { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Guid? PermissionGroupId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TaskCenterUserRefDto? Assignee { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TaskCenterUserRefDto? DefaultAssignee { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TaskCenterUserRefDto? CompletedBy { get; init; }

    public required string Status { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Action { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ResultStatus { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Comment { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Round { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? EditableFieldIds { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? AllowRepeatedEditing { get; init; }

    public required IReadOnlyList<string> AllowedActions { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<WorkflowFieldChangeDto>? SubmittedFieldChanges { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<WorkflowFieldRevisionDto>? FieldRevisions { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? CompletedAt { get; init; }
}

public sealed record TaskCenterListItemDto(
    IReadOnlyList<TaskCenterTaskDto> Tasks,
    ProcessInstanceSummaryDto Instance);

public sealed record TaskCenterActor(
    Guid UserId,
    bool IsSuperAdmin,
    bool CanReview,
    bool CanResubmit,
    bool CanViewAllInstances);

public sealed record WorkflowTaskPageQuery(
    int Page,
    int PageSize,
    string View,
    string? Search,
    Guid? DefinitionId);

public sealed record ProcessInstancePageQuery(
    int Page,
    int PageSize,
    DateOnly DateFrom,
    DateOnly DateTo,
    string? Search,
    Guid? DefinitionId,
    string? Status,
    Guid? InitiatorId,
    bool ActiveOnly,
    string? CurrentNode,
    bool ForceCurrentUser);

public interface ITaskCenterQueryService
{
    Task<PageDto<TaskCenterListItemDto>> ListTasksAsync(
        TaskCenterActor actor,
        WorkflowTaskPageQuery query,
        CancellationToken cancellationToken = default);

    Task<PageDto<ProcessInstanceSummaryDto>> ListInstancesAsync(
        TaskCenterActor actor,
        ProcessInstancePageQuery query,
        CancellationToken cancellationToken = default);
}
