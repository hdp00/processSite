using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace FlowPilot.Application.ProcessDefinitions;

public sealed record ProcessDefinitionPageMetaDto(
    int Page,
    int PageSize,
    long Total,
    int TotalPages);

public sealed record ProcessDefinitionPageDto<T>(
    IReadOnlyList<T> Items,
    ProcessDefinitionPageMetaDto Meta);

public sealed record ProcessDefinitionUserRefDto(
    Guid Id,
    string Name);

public sealed record ProcessDefinitionValidationIssueDto(
    string Code,
    string Message,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? Path = null);

public sealed record ProcessVersionValidationDto(
    string Status,
    DateTimeOffset CheckedAt,
    IReadOnlyList<ProcessDefinitionValidationIssueDto> Issues);

public record ProcessVersionSummaryDto
{
    public required Guid Id { get; init; }

    public required Guid DefinitionId { get; init; }

    public required int Revision { get; init; }

    public required int VersionNumber { get; init; }

    public required string VersionLabel { get; init; }

    public required int InstanceCount { get; init; }

    public required bool Editable { get; init; }

    public required string Status { get; init; }

    public required ProcessVersionValidationDto Validation { get; init; }

    public required string Checksum { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ChangeNote { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProcessDefinitionUserRefDto? CreatedBy { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProcessDefinitionUserRefDto? UpdatedBy { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? FirstPublishedAt { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProcessDefinitionUserRefDto? FirstPublishedBy { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? PublishedAt { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? LastUnpublishedAt { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProcessDefinitionUserRefDto? LastUnpublishedBy { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LastUnpublishReason { get; init; }
}

public sealed record ProcessVersionDto : ProcessVersionSummaryDto
{
    public required JsonObject Basic { get; init; }

    public required JsonObject Snapshot { get; init; }
}

public record ProcessDefinitionDto
{
    public required Guid Id { get; init; }

    public required int Revision { get; init; }

    public required string Code { get; init; }

    public required string Name { get; init; }

    public required string Description { get; init; }

    public required string Type { get; init; }

    public required bool Disabled { get; init; }

    public required string Status { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Guid? PublishedVersionId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProcessVersionSummaryDto? PublishedVersion { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PublishedInstancePrefix { get; init; }

    public required int NextVersionNumber { get; init; }

    public required int VersionCount { get; init; }

    public required int InstanceCount { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }

    public required ProcessDefinitionUserRefDto UpdatedBy { get; init; }
}

public sealed record VisibleProcessVersionDto
{
    public required Guid Id { get; init; }

    public required Guid DefinitionId { get; init; }

    public required int VersionNumber { get; init; }

    public required string VersionLabel { get; init; }

    public required string Checksum { get; init; }

    public required JsonObject Basic { get; init; }

    public required JsonObject Snapshot { get; init; }
}

public sealed record VisibleProcessDefinitionDto
{
    public required Guid Id { get; init; }

    public required string Code { get; init; }

    public required string Name { get; init; }

    public required string Description { get; init; }

    public required string Type { get; init; }

    public required bool Disabled { get; init; }

    public required string Status { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Guid? PublishedVersionId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PublishedInstancePrefix { get; init; }

    public required IReadOnlyList<VisibleProcessVersionDto> Versions { get; init; }
}

public sealed record ProcessDefinitionGroupRefDto(
    Guid Id,
    string Name);

public sealed record LaunchableProcessDefinitionDto(
    Guid DefinitionId,
    string Code,
    string Name,
    string Type,
    Guid VersionId,
    string VersionLabel,
    string Description,
    IReadOnlyList<ProcessDefinitionGroupRefDto> StarterGroups);

public sealed record ProcessLaunchConfigDto(
    ProcessDefinitionDto Definition,
    ProcessVersionDto Version,
    IReadOnlyDictionary<string, IReadOnlyList<ProcessDefinitionUserRefDto>> AssigneeCandidatesByNode,
    IReadOnlyList<ProcessDefinitionUserRefDto> FirstAssigneeCandidates);

public enum ProcessLaunchConfigError
{
    NotFound,
    NotLaunchable,
    Forbidden,
}

public sealed record ProcessLaunchConfigResult(
    ProcessLaunchConfigDto? Config,
    ProcessLaunchConfigError? Error);

public sealed record ProcessDefinitionActor(
    Guid UserId,
    bool IsSuperAdmin,
    bool CanViewAllInstances);

public sealed record ProcessDefinitionPageQuery(
    int Page,
    int PageSize,
    string? Search,
    string? Type,
    string? Status);

public sealed record VisibleProcessDefinitionPageQuery(
    int Page,
    int PageSize);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ProcessBasicConfigInput
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    [Required, StringLength(30, MinimumLength = 1)]
    [RegularExpression("^[A-Za-z0-9_-]+$")]
    public required string InstancePrefix { get; init; }

    [Required, RegularExpression("^(approval|free)$")]
    public required string Type { get; init; }

    [StringLength(2000)]
    public required string Description { get; init; }

    [MinLength(1)]
    public required Guid[] StarterGroupIds { get; init; }

    public Guid[] AssigneeGroupIds { get; init; } = [];

    [MinLength(1)]
    public required Guid[] CloseGroupIds { get; init; }

    public Guid[] VisibleRoleIds { get; init; } = [];

    public Guid[] VisibleUserIds { get; init; } = [];
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateProcessDefinitionRequest
{
    [Required]
    public required ProcessBasicConfigInput Basic { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SaveFormDesignerRequest
{
    [Required]
    public required JsonObject Form { get; init; }

    [Required]
    public required JsonArray SystemFields { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ProcessFlowBasicPatch
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    [MinLength(1)]
    public required Guid[] StarterGroupIds { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SaveFlowDesignerRequest
{
    [Required]
    public required ProcessFlowBasicPatch BasicPatch { get; init; }

    [Required]
    public required JsonObject Flow { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record PublishProcessVersionRequest
{
    [Required(AllowEmptyStrings = true)]
    public required string ChangeNote { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UnpublishProcessVersionRequest
{
    [Required(AllowEmptyStrings = true)]
    public required string Reason { get; init; }
}

public sealed record CreateProcessDefinitionResponseDto(
    ProcessDefinitionDto Definition,
    ProcessVersionDto Version);

public sealed record RemovedSnapshotReferenceDto(
    string Kind,
    string OwnerId,
    string ReferencedId,
    string Reason);

public sealed record SaveProcessVersionResponseDto(
    ProcessVersionDto Version,
    IReadOnlyList<RemovedSnapshotReferenceDto> RemovedReferences);

public sealed record PublishProcessVersionResponseDto(
    ProcessDefinitionDto Definition,
    ProcessVersionDto PublishedVersion,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    Guid? PreviousPublishedVersionId);

public sealed record ProcessDefinitionMutationActor(
    Guid EffectiveUserId,
    Guid OperatorUserId,
    string EffectiveUserName);

public sealed record ProcessDefinitionInputIssueDto(
    string Path,
    string Code,
    string Message);

public enum ProcessDefinitionCommandError
{
    NotFound,
    VersionNotEditable,
    RevisionMismatch,
    ValidationFailed,
    Conflict,
    IdempotencyKeyReused,
    IdempotencyRequestInProgress,
}

public sealed record ProcessDefinitionCommandFailure(
    ProcessDefinitionCommandError Error,
    string Code,
    string Title,
    string Detail,
    IReadOnlyList<ProcessDefinitionInputIssueDto>? Issues = null,
    int? CurrentRevision = null);

public sealed record ProcessDefinitionCommandResult<T>(
    T? Value,
    ProcessDefinitionCommandFailure? Failure)
{
    public bool Succeeded => Failure is null;
}

public sealed record CreateProcessDefinitionCommandValue(
    CreateProcessDefinitionResponseDto Response,
    int Revision,
    bool Replayed);

public sealed record SaveProcessVersionCommandValue(
    int Revision,
    IReadOnlyList<RemovedSnapshotReferenceDto> RemovedReferences);

public sealed record ValidateProcessVersionCommandValue(
    ProcessVersionValidationDto Validation,
    int Revision,
    bool Replayed);

public sealed record PublishProcessVersionCommandValue(
    int DefinitionRevision,
    int VersionRevision,
    Guid? PreviousPublishedVersionId,
    bool Replayed);

public sealed record UnpublishProcessVersionCommandValue(
    int DefinitionRevision,
    int VersionRevision,
    bool Replayed);

public interface IProcessDefinitionQueryService
{
    Task<IReadOnlyList<LaunchableProcessDefinitionDto>> ListLaunchableAsync(
        ProcessDefinitionActor actor,
        CancellationToken cancellationToken = default);

    Task<ProcessLaunchConfigResult> GetLaunchConfigAsync(
        Guid definitionId,
        ProcessDefinitionActor actor,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionPageDto<ProcessDefinitionDto>> ListAsync(
        ProcessDefinitionPageQuery query,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionPageDto<VisibleProcessDefinitionDto>> ListVisibleAsync(
        ProcessDefinitionActor actor,
        VisibleProcessDefinitionPageQuery query,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionDto?> GetAsync(
        Guid definitionId,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<ProcessVersionSummaryDto>?> ListVersionsAsync(
        Guid definitionId,
        CancellationToken cancellationToken = default);

    Task<ProcessVersionDto?> GetVersionAsync(
        Guid definitionId,
        Guid versionId,
        CancellationToken cancellationToken = default);
}

public interface IProcessDefinitionCommandService
{
    Task<ProcessDefinitionCommandResult<CreateProcessDefinitionCommandValue>> CreateAsync(
        ProcessBasicConfigInput basic,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveBasicAsync(
        Guid definitionId,
        Guid versionId,
        ProcessBasicConfigInput basic,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveFormAsync(
        Guid definitionId,
        Guid versionId,
        SaveFormDesignerRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveFlowAsync(
        Guid definitionId,
        Guid versionId,
        SaveFlowDesignerRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionCommandResult<ValidateProcessVersionCommandValue>> ValidateAsync(
        Guid definitionId,
        Guid versionId,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionCommandResult<PublishProcessVersionCommandValue>> PublishAsync(
        Guid definitionId,
        Guid versionId,
        PublishProcessVersionRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ProcessDefinitionCommandResult<UnpublishProcessVersionCommandValue>> UnpublishAsync(
        Guid definitionId,
        Guid versionId,
        UnpublishProcessVersionRequest request,
        int expectedDefinitionRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);
}
