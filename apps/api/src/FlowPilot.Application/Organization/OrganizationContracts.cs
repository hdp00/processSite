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

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpsertDepartmentRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    public Guid? ParentId { get; init; }

    public int SortOrder { get; init; }

    [Required]
    public required string Status { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpdateDepartmentRequest
{
    private Guid? _parentId;

    [StringLength(100, MinimumLength = 1)]
    public string? Name { get; init; }

    public Guid? ParentId
    {
        get => _parentId;
        init
        {
            _parentId = value;
            ParentIdSpecified = true;
        }
    }

    [JsonIgnore]
    public bool ParentIdSpecified { get; private set; }

    public int? SortOrder { get; init; }

    public string? Status { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }

    [JsonIgnore]
    public bool HasChanges => Name is not null
        || ParentIdSpecified
        || SortOrder is not null
        || Status is not null
        || Description is not null;
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpsertPositionRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    public int SortOrder { get; init; }

    [Required]
    public required string Status { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpdatePositionRequest
{
    [StringLength(100, MinimumLength = 1)]
    public string? Name { get; init; }

    public int? SortOrder { get; init; }

    public string? Status { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }

    [JsonIgnore]
    public bool HasChanges => Name is not null
        || SortOrder is not null
        || Status is not null
        || Description is not null;
}

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

public sealed record PermissionDto(
    string Code,
    string Name,
    string Category,
    string Kind,
    string Description);

public sealed record RolePermissionsDto(
    Guid RoleId,
    int Revision,
    IReadOnlyList<string> PermissionCodes);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ReplaceRolePermissionsRequest
{
    [Required]
    public required IReadOnlyList<string> PermissionCodes { get; init; }
}

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
public sealed record UpdateRoleRequest
{
    [StringLength(100, MinimumLength = 1)]
    public string? Name { get; init; }

    [StringLength(500)]
    public string? Description { get; init; }

    public string? Status { get; init; }

    public IReadOnlyList<Guid>? MemberIds { get; init; }

    [JsonIgnore]
    public bool HasChanges => Name is not null
        || Description is not null
        || Status is not null
        || MemberIds is not null;
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record RoleChangeImpactRequest
{
    [Required]
    public required IReadOnlyList<Guid> NextMemberIds { get; init; }

    [Required]
    public required string NextStatus { get; init; }
}

public sealed record WorkflowGroupChangeImpactDto(
    int LosingEffectiveMemberCount,
    int AffectedPendingTaskCount,
    IReadOnlyList<WorkflowMemberUserRefDto> LosingUsers);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateUserRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public required string LoginName { get; init; }

    [Required, StringLength(100, MinimumLength = 1)]
    public required string Name { get; init; }

    [Required, EmailAddress, StringLength(320)]
    public required string Email { get; init; }

    public Guid? DepartmentId { get; init; }

    public Guid? PositionId { get; init; }

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
public sealed record UpdateUserRequest
{
    private Guid? _departmentId;
    private Guid? _positionId;

    [StringLength(100, MinimumLength = 1)]
    public string? Name { get; init; }

    [EmailAddress, StringLength(320)]
    public string? Email { get; init; }

    public Guid? DepartmentId
    {
        get => _departmentId;
        init
        {
            _departmentId = value;
            DepartmentIdSpecified = true;
        }
    }

    [JsonIgnore]
    public bool DepartmentIdSpecified { get; private set; }

    public Guid? PositionId
    {
        get => _positionId;
        init
        {
            _positionId = value;
            PositionIdSpecified = true;
        }
    }

    [JsonIgnore]
    public bool PositionIdSpecified { get; private set; }

    public IReadOnlyList<Guid>? RoleIds { get; init; }

    public string? AuthenticationMode { get; init; }

    [StringLength(200, MinimumLength = 1)]
    public string? NewPassword { get; init; }

    [JsonIgnore]
    public bool HasChanges => Name is not null
        || Email is not null
        || DepartmentIdSpecified
        || PositionIdSpecified
        || RoleIds is not null
        || AuthenticationMode is not null
        || NewPassword is not null;
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SetStatusRequest
{
    [Required]
    public required string Status { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ResetPasswordRequest
{
    [Required, StringLength(200, MinimumLength = 1)]
    public required string NewPassword { get; init; }
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

    Task<RoleDto?> GetRoleAsync(
        Guid roleId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<RoleDto>> UpdateRoleAsync(
        Guid roleId,
        UpdateRoleRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<bool>> DeleteRoleAsync(
        Guid roleId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<WorkflowGroupChangeImpactDto>> PreviewRoleChangeImpactAsync(
        Guid roleId,
        RoleChangeImpactRequest request,
        CancellationToken cancellationToken = default);

    Task<UserDto?> GetUserAsync(
        Guid userId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<UserDto>> UpdateUserAsync(
        Guid userId,
        UpdateUserRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<UserDto>> SetUserStatusAsync(
        Guid userId,
        SetStatusRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<bool>> ResetUserPasswordAsync(
        Guid userId,
        ResetPasswordRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<bool>> DeleteUserAsync(
        Guid userId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<PermissionDto>> ListPermissionsAsync(
        CancellationToken cancellationToken = default);

    Task<RolePermissionsDto?> GetRolePermissionsAsync(
        Guid roleId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<RolePermissionsDto>> ReplaceRolePermissionsAsync(
        Guid roleId,
        ReplaceRolePermissionsRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<DepartmentDto>> ListDepartmentsAsync(
        bool includeDisabled,
        CancellationToken cancellationToken = default);

    Task<DepartmentDto?> GetDepartmentAsync(
        Guid departmentId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<DepartmentDto>> CreateDepartmentAsync(
        UpsertDepartmentRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<DepartmentDto>> UpdateDepartmentAsync(
        Guid departmentId,
        UpdateDepartmentRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<bool>> DeleteDepartmentAsync(
        Guid departmentId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationPageDto<PositionDto>> ListPositionsAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default);

    Task<PositionDto?> GetPositionAsync(
        Guid positionId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<PositionDto>> CreatePositionAsync(
        UpsertPositionRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<PositionDto>> UpdatePositionAsync(
        Guid positionId,
        UpdatePositionRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<OrganizationCommandResult<bool>> DeletePositionAsync(
        Guid positionId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
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
