using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using FlowPilot.Application.Authentication;

namespace FlowPilot.Application.Organization;

public sealed record OrganizationPageMetaDto(
    int Page,
    int PageSize,
    long Total,
    int TotalPages);

public sealed record OrganizationPageDto<T>(
    IReadOnlyList<T> Items,
    OrganizationPageMetaDto Meta);

public sealed record DepartmentDto(
    Guid Id,
    int Revision,
    string Code,
    string Name,
    Guid? ParentId,
    string Path,
    int Level,
    int SortOrder,
    string Status,
    string Description,
    int UserCount,
    IReadOnlyList<DepartmentDto> Children);

public sealed record PositionDto(
    Guid Id,
    int Revision,
    string Name,
    int SortOrder,
    string Status,
    string Description,
    int UserCount);

public sealed record RoleDto(
    Guid Id,
    int Revision,
    string Code,
    string Name,
    string Description,
    string Status,
    bool BuiltIn,
    int MemberCount,
    IReadOnlyList<Guid> MemberIds,
    int PermissionCount,
    int PagePermissionCount,
    int ActionPermissionCount);

public sealed record ProcessDefinitionRefDto(Guid Id, string Code, string Name);

public sealed record WorkflowPermissionGroupDto(
    Guid Id,
    int Revision,
    string Code,
    string Name,
    string Description,
    IReadOnlyList<string> Purposes,
    string Status,
    IReadOnlyList<Guid> DirectUserIds,
    IReadOnlyList<Guid> RoleIds,
    int EffectiveMemberCount,
    int OpenTaskCount,
    IReadOnlyList<ProcessDefinitionRefDto> ReferencedProcesses,
    DateTimeOffset UpdatedAt);

public sealed record WorkflowMemberUserRefDto(
    Guid Id,
    string Name,
    string LoginName,
    string Email,
    string DepartmentPath);

public sealed record WorkflowMemberSourceDto(
    string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    RoleRefDto? Role = null);

public sealed record EffectiveWorkflowMemberDto(
    WorkflowMemberUserRefDto User,
    IReadOnlyList<WorkflowMemberSourceDto> Sources);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateRoleRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }

    [Required]
    public required string Status { get; init; }

    [Required]
    public required IReadOnlyList<Guid> MemberIds { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateUserRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string LoginName { get; init; }

    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    [Required, EmailAddress, StringLength(320)]
    public required string Email { get; init; }

    public required Guid DepartmentId { get; init; }

    public required Guid PositionId { get; init; }

    [Required]
    public required IReadOnlyList<Guid> RoleIds { get; init; }

    [Required]
    public required string AuthenticationMode { get; init; }

    [StringLength(200, MinimumLength = 1)]
    public string? InitialPassword { get; init; }

    [Required]
    public required string Status { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateWorkflowPermissionGroupRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }

    [Required, MinLength(1)]
    public required IReadOnlyList<string> Purposes { get; init; }

    [Required]
    public required string Status { get; init; }

    [Required]
    public required IReadOnlyList<Guid> DirectUserIds { get; init; }

    [Required]
    public required IReadOnlyList<Guid> RoleIds { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpdateWorkflowPermissionGroupRequest
{
    [StringLength(100, MinimumLength = 1)]
    public string? Name { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }

    [MinLength(1)]
    public IReadOnlyList<string>? Purposes { get; init; }

    public string? Status { get; init; }

    public IReadOnlyList<Guid>? DirectUserIds { get; init; }

    public IReadOnlyList<Guid>? RoleIds { get; init; }

    public bool HasChanges => Name is not null
        || Description is not null
        || Purposes is not null
        || Status is not null
        || DirectUserIds is not null
        || RoleIds is not null;
}

public sealed record OrganizationPageQuery(
    int Page,
    int PageSize,
    string? Search = null,
    string? Status = null,
    Guid? DepartmentId = null,
    Guid? PositionId = null,
    Guid? RoleId = null,
    bool? HasEmail = null,
    string? AuthenticationMode = null,
    string? Purpose = null);

public sealed record WorkflowGroupMutationActor(
    Guid EffectiveUserId,
    Guid OperatorUserId);

public enum OrganizationCommandError
{
    NotFound,
    RevisionMismatch,
    ValidationFailed,
    Conflict,
    IdempotencyKeyReused,
    IdempotencyRequestInProgress,
}

public sealed record OrganizationInputIssueDto(
    string Path,
    string Code,
    string Message);

public sealed record OrganizationCommandFailure(
    OrganizationCommandError Error,
    string Code,
    string Title,
    string Detail,
    IReadOnlyList<OrganizationInputIssueDto>? Issues = null,
    int? CurrentRevision = null);

public sealed record OrganizationCommandValue<T>(
    T Data,
    bool Replayed = false);

public sealed record OrganizationCommandResult<T>(
    OrganizationCommandValue<T>? Value,
    OrganizationCommandFailure? Failure)
{
    public bool Succeeded => Failure is null;
}

public interface IOrganizationService
{
    Task<OrganizationPageDto<UserDto>> ListUsersAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default);

    Task<OrganizationPageDto<RoleDto>> ListRolesAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<DepartmentDto>> ListDepartmentsAsync(
        bool includeDisabled,
        CancellationToken cancellationToken = default);

    Task<OrganizationPageDto<PositionDto>> ListPositionsAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default);

    Task<OrganizationPageDto<WorkflowPermissionGroupDto>> ListWorkflowGroupsAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<RoleDto>> CreateRoleAsync(
        CreateRoleRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<UserDto>> CreateUserAsync(
        CreateUserRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<WorkflowPermissionGroupDto?> GetWorkflowGroupAsync(
        Guid groupId,
        CancellationToken cancellationToken = default);

    Task<OrganizationPageDto<EffectiveWorkflowMemberDto>?> ListEffectiveMembersAsync(
        Guid groupId,
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<WorkflowPermissionGroupDto>> CreateWorkflowGroupAsync(
        CreateWorkflowPermissionGroupRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<WorkflowPermissionGroupDto>> UpdateWorkflowGroupAsync(
        Guid groupId,
        UpdateWorkflowPermissionGroupRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<bool>> DeleteWorkflowGroupAsync(
        Guid groupId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);
}
