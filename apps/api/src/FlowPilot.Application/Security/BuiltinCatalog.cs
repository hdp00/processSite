using System.Collections.ObjectModel;
using System.Text;
using Microsoft.AspNetCore.Identity;

namespace FlowPilot.Application.Security;

public static class BuiltinCatalog
{
    public const string SeedVersion = "202608270001";
    public const int PermissionSnapshotVersion = 1;

    public static Guid ManagerPositionId { get; } =
        Guid.Parse("e9ac43b2-4ad7-4560-b857-5505a4a08def");

    public const string ManagerPositionCode = "manager";
    public const string ManagerPositionName = "经理";

    public static Guid EmployeePositionId { get; } =
        Guid.Parse("3670d30b-fa21-4d8d-bd91-7ca61f66a444");

    public const string EmployeePositionCode = "employee";
    public const string EmployeePositionName = "员工";

    public static Guid SuperAdminRoleId { get; } =
        Guid.Parse("36d91a66-70ee-4ef4-835a-290595cef7f4");

    public const string SuperAdminRoleCode = "super_admin";
    public const string SuperAdminRoleName = "超级管理员";

    public static Guid SuperAdminUserId { get; } =
        Guid.Parse("f02525d0-9962-4dcd-80e4-213793180b25");

    public const string SuperAdminLoginName = "superadmin";
    public const string SuperAdminDisplayName = "超级管理员";
    public const string SuperAdminEmail = "";

    private static readonly BuiltinPermissionEntry[] PermissionItems =
    [
        new("work-launch:查看", "work-launch", "查看", "流程发起-查看", 10),
        new("work-launch:发起", "work-launch", "发起", "流程发起-发起", 20),
        new("work-task:查看", "work-task", "查看", "任务中心-查看", 30),
        new("work-task:审核", "work-task", "审核", "任务中心-审核", 40),
        new("work-task:关闭", "work-task", "关闭", "任务中心-关闭", 50),
        new("work-list:查看", "work-list", "查看", "流程清单-查看", 60),
        new("work-list:复制新建", "work-list", "复制新建", "流程清单-复制新建", 70),
        new("work-list:打印", "work-list", "打印", "流程清单-打印", 80),
        new("config-definition:查看", "config-definition", "查看", "流程定义-查看", 90),
        new("config-definition:编辑", "config-definition", "编辑", "流程定义-编辑", 100),
        new("config-definition:发布", "config-definition", "发布", "流程定义-发布", 110),
        new("config-definition:删除", "config-definition", "删除", "流程定义-删除", 120),
        new("config-form:编辑", "config-form", "编辑", "表单设计器-编辑", 130),
        new("org-user:查看", "org-user", "查看", "用户管理-查看", 140),
        new("org-user:编辑", "org-user", "编辑", "用户管理-编辑", 150),
        new("org-user:重置密码", "org-user", "重置密码", "用户管理-重置密码", 160),
        new("org-user:删除", "org-user", "删除", "用户管理-删除", 170),
        new("org-department:查看", "org-department", "查看", "部门管理-查看", 180),
        new("org-department:编辑", "org-department", "编辑", "部门管理-编辑", 190),
        new("org-department:删除", "org-department", "删除", "部门管理-删除", 200),
        new("org-role:查看", "org-role", "查看", "角色管理-查看", 210),
        new("org-role:编辑", "org-role", "编辑", "角色管理-编辑", 220),
        new("org-role:授权", "org-role", "授权", "角色管理-授权", 230),
        new("org-role:删除", "org-role", "删除", "角色管理-删除", 240),
        new("org-group:查看", "org-group", "查看", "流程权限组-查看", 250),
        new("org-group:编辑", "org-group", "编辑", "流程权限组-编辑", 260),
        new("org-group:删除", "org-group", "删除", "流程权限组-删除", 270),
        new("system-monitor:查看", "system-monitor", "查看", "流程实例监控-查看", 280),
        new("system-audit:查看", "system-audit", "查看", "操作审计-查看", 290),
    ];

    public static IReadOnlyList<BuiltinPermissionEntry> Permissions { get; } =
        Array.AsReadOnly(PermissionItems);

    public static IReadOnlyList<string> PermissionCodes { get; } =
        new ReadOnlyCollection<string>(PermissionItems.Select(permission => permission.Code).ToArray());
}

public sealed record BuiltinPermissionEntry(
    string Code,
    string Resource,
    string Action,
    string Name,
    int SortOrder);

public static class IdentityValueNormalizer
{
    public static string Normalize(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return value.Normalize(NormalizationForm.FormKC).Trim().ToLowerInvariant();
    }
}

public static class FlowPilotPasswordHasher
{
    public static string HashPassword(string normalizedLoginName, string password)
    {
        ValidateUserAndPassword(normalizedLoginName, password, nameof(password));
        return new PasswordHasher<string>().HashPassword(normalizedLoginName, password);
    }

    public static PasswordVerificationResult VerifyHashedPassword(
        string normalizedLoginName,
        string passwordHash,
        string providedPassword)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(passwordHash);
        ValidateUserAndPassword(normalizedLoginName, providedPassword, nameof(providedPassword));
        return new PasswordHasher<string>().VerifyHashedPassword(
            normalizedLoginName,
            passwordHash,
            providedPassword);
    }

    private static void ValidateUserAndPassword(
        string normalizedLoginName,
        string password,
        string passwordParameterName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(normalizedLoginName);
        ArgumentNullException.ThrowIfNull(password, passwordParameterName);
        if (password.Length == 0)
        {
            throw new ArgumentException("Password cannot be empty.", passwordParameterName);
        }
    }
}
