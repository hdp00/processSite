using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Organization;
using FlowPilot.Domain.Common;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class OrganizationController(
    IAuthService authService,
    IOrganizationService organizationService) : ControllerBase
{
    private static readonly string[] DirectoryReadPermissions =
    [
        "org-user:查看",
        "org-role:查看",
        "org-group:查看",
        "config-definition:查看",
        "config-definition:编辑",
    ];

    private static readonly string[] ReferenceDataReadPermissions =
    [
        .. DirectoryReadPermissions,
        "work-launch:查看",
        "work-task:查看",
        "work-list:查看",
        "system-monitor:查看",
    ];

    [HttpGet("users")]
    [ProducesResponseType<OrganizationPageDto<UserDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<OrganizationPageDto<UserDto>>> ListUsers(
        [FromQuery] UserListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, DirectoryReadPermissions))
        {
            return Forbidden("当前账号没有读取用户目录的权限。");
        }

        if (!IsOptionalStatus(parameters.Status)
            || !IsOptionalAuthenticationMode(parameters.AuthenticationMode))
        {
            return BadRequestProblem("status 或 authenticationMode 不是有效值。");
        }

        return Ok(await organizationService.ListUsersAsync(
            new OrganizationPageQuery(
                parameters.Page,
                parameters.PageSize,
                NormalizeOptional(parameters.Q),
                NormalizeOptional(parameters.Status),
                parameters.DepartmentId,
                parameters.PositionId,
                parameters.RoleId,
                parameters.HasEmail,
                NormalizeOptional(parameters.AuthenticationMode)),
            cancellationToken).ConfigureAwait(false));
    }

    [HttpPost("users")]
    [ProducesResponseType<UserDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<UserDto>> CreateUser(
        [FromBody] CreateUserRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, "org-user:编辑"))
        {
            return Forbidden("当前账号没有创建用户的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await organizationService.CreateUserAsync(
            request,
            CreateActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Created($"/users/{value.Id:D}", value);
    }

    [HttpGet("users/{userId:guid}")]
    [ProducesResponseType<UserDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserDto>> GetUser(
        Guid userId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasAnyPermission(session, DirectoryReadPermissions))
        {
            return Forbidden("当前账号没有读取用户详情的权限。");
        }

        var user = await organizationService.GetUserAsync(userId, cancellationToken)
            .ConfigureAwait(false);
        if (user is null) return UserNotFoundProblem();
        Response.Headers.ETag = new Revision(user.Revision).ToStrongEntityTag();
        return Ok(user);
    }

    [HttpPatch("users/{userId:guid}")]
    [ProducesResponseType<UserDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<UserDto>> UpdateUser(
        Guid userId,
        [FromBody] UpdateUserRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-user:编辑"))
        {
            return Forbidden("当前账号没有修改用户的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
            return revisionProblem!;
        var result = await organizationService.UpdateUserAsync(
            userId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpPut("users/{userId:guid}/status")]
    [ProducesResponseType<UserDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<UserDto>> SetUserStatus(
        Guid userId,
        [FromBody] SetStatusRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-user:编辑"))
        {
            return Forbidden("当前账号没有启用或停用用户的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
            return revisionProblem!;
        var result = await organizationService.SetUserStatusAsync(
            userId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpPost("users/{userId:guid}/reset-password")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> ResetUserPassword(
        Guid userId,
        [FromBody] ResetPasswordRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-user:重置密码"))
        {
            return Forbidden("当前账号没有重置用户密码的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
            return revisionProblem!;
        if (!TryGetIdempotencyKey(out _, out var idempotencyProblem))
            return idempotencyProblem!;
        var result = await organizationService.ResetUserPasswordAsync(
            userId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpDelete("users/{userId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeleteUser(
        Guid userId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-user:删除"))
        {
            return Forbidden("当前账号没有删除用户的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
            return revisionProblem!;
        var result = await organizationService.DeleteUserAsync(
            userId,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpGet("roles")]
    [ProducesResponseType<OrganizationPageDto<RoleDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<OrganizationPageDto<RoleDto>>> ListRoles(
        [FromQuery] OrganizationListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, ReferenceDataReadPermissions))
        {
            return Forbidden("当前账号没有读取角色目录的权限。");
        }

        if (!IsOptionalStatus(parameters.Status))
        {
            return BadRequestProblem("status 只能是 enabled 或 disabled。");
        }

        return Ok(await organizationService.ListRolesAsync(
            CreatePageQuery(parameters),
            cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("roles/{roleId:guid}")]
    [ProducesResponseType<RoleDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<RoleDto>> GetRole(
        Guid roleId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasAnyPermission(session, ReferenceDataReadPermissions))
        {
            return Forbidden("当前账号没有读取角色详情的权限。");
        }

        var role = await organizationService.GetRoleAsync(roleId, cancellationToken).ConfigureAwait(false);
        if (role is null)
        {
            return ProblemResponse(
                StatusCodes.Status404NotFound,
                "ROLE_NOT_FOUND",
                "角色不存在",
                "未找到指定的角色。");
        }

        Response.Headers.ETag = new Revision(role.Revision).ToStrongEntityTag();
        return Ok(role);
    }

    [HttpPatch("roles/{roleId:guid}")]
    [ProducesResponseType<RoleDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<RoleDto>> UpdateRole(
        Guid roleId,
        [FromBody] UpdateRoleRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-role:编辑"))
        {
            return Forbidden("当前账号没有编辑角色的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.UpdateRoleAsync(
            roleId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpDelete("roles/{roleId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeleteRole(
        Guid roleId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-role:删除"))
        {
            return Forbidden("当前账号没有删除角色的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.DeleteRoleAsync(
            roleId,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpPost("roles/{roleId:guid}/change-impact")]
    [ProducesResponseType<WorkflowGroupChangeImpactDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<WorkflowGroupChangeImpactDto>> PreviewRoleChangeImpact(
        Guid roleId,
        [FromBody] RoleChangeImpactRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-role:编辑"))
        {
            return Forbidden("当前账号没有编辑角色的权限。");
        }

        var result = await organizationService.PreviewRoleChangeImpactAsync(
            roleId,
            request,
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? Ok(result.Value!.Data) : CommandFailure(result.Failure!);
    }

    [HttpGet("permissions")]
    [ProducesResponseType<IReadOnlyList<PermissionDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<IReadOnlyList<PermissionDto>>> ListPermissions(
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasAnyPermission(session, "org-role:查看", "org-role:授权"))
        {
            return Forbidden("当前账号没有读取权限目录的权限。");
        }

        return Ok(await organizationService.ListPermissionsAsync(cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("roles/{roleId:guid}/permissions")]
    [ProducesResponseType<RolePermissionsDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<RolePermissionsDto>> GetRolePermissions(
        Guid roleId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasAnyPermission(session, "org-role:查看", "org-role:授权"))
        {
            return Forbidden("当前账号没有读取角色权限的权限。");
        }

        var permissions = await organizationService.GetRolePermissionsAsync(roleId, cancellationToken)
            .ConfigureAwait(false);
        if (permissions is null)
        {
            return ProblemResponse(
                StatusCodes.Status404NotFound,
                "ROLE_NOT_FOUND",
                "角色不存在",
                "未找到指定的角色。");
        }

        Response.Headers.ETag = new Revision(permissions.Revision).ToStrongEntityTag();
        return Ok(permissions);
    }

    [HttpPut("roles/{roleId:guid}/permissions")]
    [ProducesResponseType<RolePermissionsDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<RolePermissionsDto>> ReplaceRolePermissions(
        Guid roleId,
        [FromBody] ReplaceRolePermissionsRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-role:授权"))
        {
            return Forbidden("当前账号没有配置角色权限的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.ReplaceRolePermissionsAsync(
            roleId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpPost("roles")]
    [ProducesResponseType<RoleDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<RoleDto>> CreateRole(
        [FromBody] CreateRoleRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, "org-role:编辑"))
        {
            return Forbidden("当前账号没有创建角色的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await organizationService.CreateRoleAsync(
            request,
            CreateActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Created($"/roles/{value.Id:D}", value);
    }

    [HttpGet("departments")]
    [ProducesResponseType<IReadOnlyList<DepartmentDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<IReadOnlyList<DepartmentDto>>> ListDepartments(
        [FromQuery] bool includeDisabled = false,
        CancellationToken cancellationToken = default)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, ReferenceDataReadPermissions.Append("org-department:查看").ToArray()))
        {
            return Forbidden("当前账号没有读取部门目录的权限。");
        }

        return Ok(await organizationService.ListDepartmentsAsync(
            includeDisabled,
            cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("departments/{departmentId:guid}")]
    [ProducesResponseType<DepartmentDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<DepartmentDto>> GetDepartment(
        Guid departmentId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasAnyPermission(session, ReferenceDataReadPermissions.Append("org-department:查看").ToArray()))
        {
            return Forbidden("当前账号没有读取部门详情的权限。");
        }

        var department = await organizationService.GetDepartmentAsync(departmentId, cancellationToken)
            .ConfigureAwait(false);
        if (department is null)
        {
            return ProblemResponse(
                StatusCodes.Status404NotFound,
                "DEPARTMENT_NOT_FOUND",
                "部门不存在",
                "未找到指定的部门。");
        }

        Response.Headers.ETag = new Revision(department.Revision).ToStrongEntityTag();
        return Ok(department);
    }

    [HttpPost("departments")]
    [ProducesResponseType<DepartmentDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<DepartmentDto>> CreateDepartment(
        [FromBody] UpsertDepartmentRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-department:编辑"))
        {
            return Forbidden("当前账号没有创建部门的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await organizationService.CreateDepartmentAsync(
            request,
            CreateActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Created($"/departments/{value.Id:D}", value);
    }

    [HttpPatch("departments/{departmentId:guid}")]
    [ProducesResponseType<DepartmentDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<DepartmentDto>> UpdateDepartment(
        Guid departmentId,
        [FromBody] UpdateDepartmentRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-department:编辑"))
        {
            return Forbidden("当前账号没有编辑部门的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.UpdateDepartmentAsync(
            departmentId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpDelete("departments/{departmentId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeleteDepartment(
        Guid departmentId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-department:删除"))
        {
            return Forbidden("当前账号没有删除部门的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.DeleteDepartmentAsync(
            departmentId,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpGet("positions")]
    [ProducesResponseType<OrganizationPageDto<PositionDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<OrganizationPageDto<PositionDto>>> ListPositions(
        [FromQuery] OrganizationListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, ReferenceDataReadPermissions.Append("org-department:查看").ToArray()))
        {
            return Forbidden("当前账号没有读取职务目录的权限。");
        }

        if (!IsOptionalStatus(parameters.Status))
        {
            return BadRequestProblem("status 只能是 enabled 或 disabled。");
        }

        return Ok(await organizationService.ListPositionsAsync(
            CreatePageQuery(parameters),
            cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("positions/{positionId:guid}")]
    [ProducesResponseType<PositionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PositionDto>> GetPosition(
        Guid positionId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasAnyPermission(session, ReferenceDataReadPermissions.Append("org-department:查看").ToArray()))
        {
            return Forbidden("当前账号没有读取职务详情的权限。");
        }

        var position = await organizationService.GetPositionAsync(positionId, cancellationToken)
            .ConfigureAwait(false);
        if (position is null)
        {
            return ProblemResponse(
                StatusCodes.Status404NotFound,
                "POSITION_NOT_FOUND",
                "职务不存在",
                "未找到指定的职务。");
        }

        Response.Headers.ETag = new Revision(position.Revision).ToStrongEntityTag();
        return Ok(position);
    }

    [HttpPost("positions")]
    [ProducesResponseType<PositionDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<PositionDto>> CreatePosition(
        [FromBody] UpsertPositionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-department:编辑"))
        {
            return Forbidden("当前账号没有创建职务的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await organizationService.CreatePositionAsync(
            request,
            CreateActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Created($"/positions/{value.Id:D}", value);
    }

    [HttpPatch("positions/{positionId:guid}")]
    [ProducesResponseType<PositionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<PositionDto>> UpdatePosition(
        Guid positionId,
        [FromBody] UpdatePositionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-department:编辑"))
        {
            return Forbidden("当前账号没有编辑职务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.UpdatePositionAsync(
            positionId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpDelete("positions/{positionId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeletePosition(
        Guid positionId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "org-department:删除"))
        {
            return Forbidden("当前账号没有删除职务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.DeletePositionAsync(
            positionId,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpGet("workflow-permission-groups")]
    [ProducesResponseType<OrganizationPageDto<WorkflowPermissionGroupDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<OrganizationPageDto<WorkflowPermissionGroupDto>>> ListWorkflowGroups(
        [FromQuery] WorkflowGroupListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, ReferenceDataReadPermissions))
        {
            return Forbidden("当前账号没有读取流程权限组的权限。");
        }

        if (!IsOptionalStatus(parameters.Status) || !IsOptionalPurpose(parameters.Purpose))
        {
            return BadRequestProblem("status 或 purpose 不是有效值。");
        }

        return Ok(await organizationService.ListWorkflowGroupsAsync(
            new OrganizationPageQuery(
                parameters.Page,
                parameters.PageSize,
                NormalizeOptional(parameters.Q),
                NormalizeOptional(parameters.Status),
                Purpose: NormalizeOptional(parameters.Purpose)),
            cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("workflow-permission-groups/{groupId:guid}")]
    [ProducesResponseType<WorkflowPermissionGroupDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<WorkflowPermissionGroupDto>> GetWorkflowGroup(
        Guid groupId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, "org-group:查看", "config-definition:查看", "config-definition:编辑"))
        {
            return Forbidden("当前账号没有读取流程权限组的权限。");
        }

        var group = await organizationService.GetWorkflowGroupAsync(groupId, cancellationToken)
            .ConfigureAwait(false);
        if (group is null)
        {
            return NotFoundProblem();
        }

        Response.Headers.ETag = new Revision(group.Revision).ToStrongEntityTag();
        return Ok(group);
    }

    [HttpGet("workflow-permission-groups/{groupId:guid}/effective-members")]
    [ProducesResponseType<OrganizationPageDto<EffectiveWorkflowMemberDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<OrganizationPageDto<EffectiveWorkflowMemberDto>>> ListEffectiveMembers(
        Guid groupId,
        [FromQuery] MemberListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(session, "org-group:查看", "config-definition:编辑"))
        {
            return Forbidden("当前账号没有查看流程权限组成员的权限。");
        }

        var page = await organizationService.ListEffectiveMembersAsync(
            groupId,
            new OrganizationPageQuery(
                parameters.Page,
                parameters.PageSize,
                NormalizeOptional(parameters.Q)),
            cancellationToken).ConfigureAwait(false);
        return page is null ? NotFoundProblem() : Ok(page);
    }

    [HttpPost("workflow-permission-groups/{groupId:guid}/change-impact")]
    [ProducesResponseType<WorkflowGroupChangeImpactDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<WorkflowGroupChangeImpactDto>> PreviewWorkflowGroupChangeImpact(
        Guid groupId,
        [FromBody] WorkflowGroupChangeImpactRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, "org-group:编辑"))
        {
            return Forbidden("当前账号没有修改流程权限组的权限。");
        }

        var result = await organizationService.PreviewWorkflowGroupChangeImpactAsync(
            groupId,
            request,
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? Ok(result.Value!.Data) : CommandFailure(result.Failure!);
    }

    [HttpPost("workflow-permission-groups")]
    [ProducesResponseType<WorkflowPermissionGroupDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<WorkflowPermissionGroupDto>> CreateWorkflowGroup(
        [FromBody] CreateWorkflowPermissionGroupRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, "org-group:编辑"))
        {
            return Forbidden("当前账号没有创建流程权限组的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await organizationService.CreateWorkflowGroupAsync(
            request,
            CreateActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Created($"/workflow-permission-groups/{value.Id:D}", value);
    }

    [HttpPatch("workflow-permission-groups/{groupId:guid}")]
    [ProducesResponseType<WorkflowPermissionGroupDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<WorkflowPermissionGroupDto>> UpdateWorkflowGroup(
        Guid groupId,
        [FromBody] UpdateWorkflowPermissionGroupRequest request,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, "org-group:编辑"))
        {
            return Forbidden("当前账号没有修改流程权限组的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.UpdateWorkflowGroupAsync(
            groupId,
            request,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!.Data;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value);
    }

    [HttpDelete("workflow-permission-groups/{groupId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeleteWorkflowGroup(
        Guid groupId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, "org-group:删除"))
        {
            return Forbidden("当前账号没有删除流程权限组的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await organizationService.DeleteWorkflowGroupAsync(
            groupId,
            expectedRevision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    private async Task<SessionDto?> RequireSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        return (await authService.GetCurrentSessionAsync(sessionToken, cancellationToken)
            .ConfigureAwait(false)).Session;
    }

    private static OrganizationPageQuery CreatePageQuery(OrganizationListParameters parameters) =>
        new(
            parameters.Page,
            parameters.PageSize,
            NormalizeOptional(parameters.Q),
            NormalizeOptional(parameters.Status));

    private static WorkflowGroupMutationActor CreateActor(SessionDto session) =>
        new(session.User.Id, session.OperatorUser.Id);

    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);

    private static bool HasAnyPermission(SessionDto session, params string[] permissions) =>
        session.SuperAdmin || permissions.Any(permission =>
            session.Permissions.Contains(permission, StringComparer.Ordinal));

    private static string? NormalizeOptional(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static bool IsOptionalStatus(string? value) =>
        NormalizeOptional(value) is null or "enabled" or "disabled";

    private static bool IsOptionalAuthenticationMode(string? value) =>
        NormalizeOptional(value) is null or "domain" or "password";

    private static bool IsOptionalPurpose(string? value) =>
        NormalizeOptional(value) is null or "start" or "review-or-accept" or "close";

    private bool TryGetExpectedRevision(out int expectedRevision, out ObjectResult? problem)
    {
        expectedRevision = default;
        problem = null;
        var values = Request.Headers.IfMatch;
        if (values.Count == 0)
        {
            problem = ProblemResponse(
                StatusCodes.Status428PreconditionRequired,
                "PRECONDITION_REQUIRED",
                "缺少并发版本",
                "请求必须携带上次读取资源时获得的 If-Match 强 ETag。");
            return false;
        }

        if (values.Count != 1 || !Revision.TryParseStrongEntityTag(values[0], out var revision))
        {
            problem = BadRequestProblem("If-Match 必须是单个强 ETag，例如 \"1\"。");
            return false;
        }

        expectedRevision = revision.Value;
        return true;
    }

    private bool TryGetIdempotencyKey(out string key, out ObjectResult? problem)
    {
        key = string.Empty;
        problem = null;
        var values = Request.Headers["Idempotency-Key"];
        if (values.Count != 1 || values[0] is not { } raw)
        {
            problem = BadRequestProblem("请求必须携带一个 Idempotency-Key。");
            return false;
        }

        key = raw.Trim();
        if (key.Length is < 16 or > 100)
        {
            problem = BadRequestProblem("Idempotency-Key 的长度必须为 16 到 100 个字符。");
            return false;
        }

        return true;
    }

    private ObjectResult CommandFailure(OrganizationCommandFailure failure)
    {
        var status = failure.Error switch
        {
            OrganizationCommandError.NotFound => StatusCodes.Status404NotFound,
            OrganizationCommandError.RevisionMismatch => StatusCodes.Status412PreconditionFailed,
            OrganizationCommandError.ValidationFailed => StatusCodes.Status422UnprocessableEntity,
            OrganizationCommandError.Conflict
                or OrganizationCommandError.IdempotencyKeyReused
                or OrganizationCommandError.IdempotencyRequestInProgress => StatusCodes.Status409Conflict,
            _ => throw new InvalidOperationException("Unsupported organization command failure."),
        };

        string? currentEtag = null;
        if (failure.CurrentRevision is { } revision)
        {
            currentEtag = new Revision(revision).ToStrongEntityTag();
            Response.Headers.ETag = currentEtag;
        }

        return ProblemResponse(
            status,
            failure.Code,
            failure.Title,
            failure.Detail,
            failure.Issues,
            currentEtag);
    }

    private ObjectResult AuthenticationRequired() => ProblemResponse(
        StatusCodes.Status401Unauthorized,
        "AUTHENTICATION_REQUIRED",
        "尚未登录",
        "当前会话不存在或已失效，请重新登录。");

    private ObjectResult Forbidden(string detail) => ProblemResponse(
        StatusCodes.Status403Forbidden,
        "PERMISSION_DENIED",
        "没有操作权限",
        detail);

    private ObjectResult BadRequestProblem(string detail) => ProblemResponse(
        StatusCodes.Status400BadRequest,
        "BAD_REQUEST",
        "请求参数无效",
        detail);

    private ObjectResult NotFoundProblem() => ProblemResponse(
        StatusCodes.Status404NotFound,
        "WORKFLOW_GROUP_NOT_FOUND",
        "流程权限组不存在",
        "未找到指定的流程权限组。");

    private ObjectResult UserNotFoundProblem() => ProblemResponse(
        StatusCodes.Status404NotFound,
        "USER_NOT_FOUND",
        "用户不存在",
        "未找到指定的用户。");

    private ObjectResult ProblemResponse(
        int status,
        string code,
        string title,
        string detail,
        IReadOnlyList<OrganizationInputIssueDto>? errors = null,
        string? currentEtag = null)
    {
        var problem = new ProblemDetails
        {
            Status = status,
            Type = $"/problems/{code.ToLowerInvariant().Replace('_', '-')}",
            Title = title,
            Detail = detail,
            Instance = Request.Path,
        };
        problem.Extensions["code"] = code;
        problem.Extensions["traceId"] = GetTraceId();
        if (errors is not null)
        {
            problem.Extensions["errors"] = errors;
        }

        if (currentEtag is not null)
        {
            problem.Extensions["currentEtag"] = currentEtag;
        }

        return StatusCode(status, problem);
    }

    private string GetTraceId() => Activity.Current?.TraceId.ToString()
        ?? HttpContext.TraceIdentifier;
}

public class OrganizationListParameters
{
    [Range(1, 1_000_000)]
    public int Page { get; init; } = 1;

    [Range(1, 200)]
    public int PageSize { get; init; } = 20;

    [StringLength(100)]
    public string? Q { get; init; }

    public string? Status { get; init; }
}

public sealed class WorkflowGroupListParameters : OrganizationListParameters
{
    public string? Purpose { get; init; }
}

public sealed class MemberListParameters
{
    [Range(1, 1_000_000)]
    public int Page { get; init; } = 1;

    [Range(1, 200)]
    public int PageSize { get; init; } = 20;

    [StringLength(100)]
    public string? Q { get; init; }
}

public sealed class UserListParameters : OrganizationListParameters
{
    public Guid? DepartmentId { get; init; }

    public Guid? PositionId { get; init; }

    public Guid? RoleId { get; init; }

    public bool? HasEmail { get; init; }

    public string? AuthenticationMode { get; init; }
}
