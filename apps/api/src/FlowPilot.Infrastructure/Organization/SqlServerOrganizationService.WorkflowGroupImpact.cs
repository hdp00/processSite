using FlowPilot.Application.Organization;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService
{
    public async Task<OrganizationCommandResult<WorkflowGroupChangeImpactDto>> PreviewWorkflowGroupChangeImpactAsync(
        Guid groupId,
        WorkflowGroupChangeImpactRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var directUserIds = request.NextDirectUserIds.Distinct().Order().ToArray();
        var roleIds = request.NextRoleIds.Distinct().Order().ToArray();
        var purposes = request.NextPurposes
            .Select(ToDatabasePurpose)
            .Where(purpose => purpose is not null)
            .Select(purpose => purpose!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var issues = ValidateWorkflowGroupImpactRequest(request, directUserIds, roleIds, purposes);
        if (issues.Count > 0)
        {
            return Failed<WorkflowGroupChangeImpactDto>(
                IdentityValidationFailure("流程权限组变更影响校验失败", issues));
        }

        var group = await _dbContext.RuntimeWorkflowGroups
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == groupId, cancellationToken)
            .ConfigureAwait(false);
        if (group is null)
        {
            return Failed<WorkflowGroupChangeImpactDto>(Failure(
                OrganizationCommandError.NotFound,
                "WORKFLOW_GROUP_NOT_FOUND",
                "流程权限组不存在",
                "未找到指定的流程权限组。"));
        }

        var nextUsers = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(user => directUserIds.Contains(user.Id))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (nextUsers.Length != directUserIds.Length
            || nextUsers.Any(user => !user.IsEnabled || user.IsBuiltInSuperAdmin))
        {
            return Failed<WorkflowGroupChangeImpactDto>(IdentityValidationFailure(
                "流程权限组变更影响校验失败",
                [Issue("nextDirectUserIds", "INVALID_REFERENCE", "直接成员必须是存在且已启用的普通用户。")]
            ));
        }

        var nextRoles = await _dbContext.RuntimeRoles
            .AsNoTracking()
            .Where(role => roleIds.Contains(role.Id))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (nextRoles.Length != roleIds.Length
            || nextRoles.Any(role => !role.IsEnabled || role.IsBuiltIn))
        {
            return Failed<WorkflowGroupChangeImpactDto>(IdentityValidationFailure(
                "流程权限组变更影响校验失败",
                [Issue("nextRoleIds", "INVALID_REFERENCE", "关联角色必须是存在且已启用的非内置角色。")]
            ));
        }

        var currentDirectUserIds = await _dbContext.RuntimeWorkflowGroupUsers
            .AsNoTracking()
            .Where(item => item.GroupId == groupId)
            .Select(item => item.UserId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var currentRoleIds = await _dbContext.RuntimeWorkflowGroupRoles
            .AsNoTracking()
            .Where(item => item.GroupId == groupId)
            .Select(item => item.RoleId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);

        var currentEffectiveIds = group.IsEnabled
            ? await ResolveEffectiveMemberIdsAsync(currentDirectUserIds, currentRoleIds, cancellationToken)
                .ConfigureAwait(false)
            : [];
        var nextEffectiveIds = request.NextStatus == "enabled"
            ? await ResolveEffectiveMemberIdsAsync(directUserIds, roleIds, cancellationToken)
                .ConfigureAwait(false)
            : [];
        var losingIds = currentEffectiveIds.Except(nextEffectiveIds).ToArray();

        var losingUserRows = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(user => losingIds.Contains(user.Id))
            .OrderBy(user => user.DisplayName)
            .ThenBy(user => user.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var departmentIds = losingUserRows
            .Where(user => user.DepartmentId.HasValue)
            .Select(user => user.DepartmentId!.Value)
            .Distinct()
            .ToArray();
        var departmentPaths = await _dbContext.Departments
            .AsNoTracking()
            .Where(department => departmentIds.Contains(department.Id))
            .ToDictionaryAsync(department => department.Id, department => department.Path, cancellationToken)
            .ConfigureAwait(false);
        var losingUsers = losingUserRows
            .Select(user => new WorkflowMemberUserRefDto(
                user.Id,
                user.DisplayName,
                user.LoginName,
                user.Email,
                user.DepartmentId.HasValue
                    && departmentPaths.TryGetValue(user.DepartmentId.Value, out var path)
                        ? path
                        : string.Empty))
            .ToArray();

        var affectedTasks = losingIds.Length == 0
            ? 0
            : await _dbContext.WorkflowTasks
                .AsNoTracking()
                .CountAsync(
                    task => task.GroupId == groupId
                        && (task.Status == "inactive" || task.Status == "pending"),
                    cancellationToken)
                .ConfigureAwait(false);

        return Succeeded(new WorkflowGroupChangeImpactDto(
            losingUsers.Length,
            affectedTasks,
            losingUsers));
    }

    private async Task<HashSet<Guid>> ResolveEffectiveMemberIdsAsync(
        IReadOnlyCollection<Guid> directUserIds,
        IReadOnlyCollection<Guid> roleIds,
        CancellationToken cancellationToken)
    {
        var enabledDirectUserIds = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(user => directUserIds.Contains(user.Id) && user.IsEnabled)
            .Select(user => user.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var enabledRoleIds = await _dbContext.RuntimeRoles
            .AsNoTracking()
            .Where(role => roleIds.Contains(role.Id) && role.IsEnabled)
            .Select(role => role.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var roleMemberIds = await _dbContext.RuntimeUserRoles
            .AsNoTracking()
            .Where(item => enabledRoleIds.Contains(item.RoleId))
            .Join(
                _dbContext.OrganizationUserReferences.Where(user => user.IsEnabled),
                item => item.UserId,
                user => user.Id,
                (item, user) => user.Id)
            .Distinct()
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);

        return enabledDirectUserIds.Concat(roleMemberIds).ToHashSet();
    }

    private static List<OrganizationInputIssueDto> ValidateWorkflowGroupImpactRequest(
        WorkflowGroupChangeImpactRequest request,
        Guid[] directUserIds,
        Guid[] roleIds,
        string[] purposes)
    {
        var issues = new List<OrganizationInputIssueDto>();
        if (directUserIds.Length != request.NextDirectUserIds.Count)
        {
            issues.Add(Issue("nextDirectUserIds", "DUPLICATE", "直接成员不能重复。"));
        }

        if (roleIds.Length != request.NextRoleIds.Count)
        {
            issues.Add(Issue("nextRoleIds", "DUPLICATE", "关联角色不能重复。"));
        }

        if (request.NextPurposes.Count == 0
            || purposes.Length != request.NextPurposes.Distinct(StringComparer.Ordinal).Count())
        {
            issues.Add(Issue(
                "nextPurposes",
                "INVALID_VALUE",
                "允许用途只能包含 start、review-or-accept、close，且不能重复。"));
        }

        if (request.NextStatus is not ("enabled" or "disabled"))
        {
            issues.Add(Issue("nextStatus", "INVALID_VALUE", "状态只能是 enabled 或 disabled。"));
        }

        return issues;
    }
}
