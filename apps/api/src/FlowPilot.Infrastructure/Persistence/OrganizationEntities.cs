namespace FlowPilot.Infrastructure.Persistence;

internal sealed class DepartmentEntity
{
    public Guid Id { get; set; }
    public string Code { get; set; } = string.Empty;
    public string NormalizedCode { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public Guid? ParentId { get; set; }
    public string Path { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public bool IsEnabled { get; set; }
    public string? Description { get; set; }
    public int Revision { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public Guid? UpdatedBy { get; set; }
}

internal sealed class PositionEntity
{
    public Guid Id { get; set; }
    public string Code { get; set; } = string.Empty;
    public string NormalizedCode { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string NormalizedName { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public bool IsEnabled { get; set; }
    public string? Description { get; set; }
    public int Revision { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public Guid? UpdatedBy { get; set; }
}

// 组织和流程运行时共用这份轻量用户投影，避免为同一张表重复建模。
internal sealed class OrganizationUserReference
{
    public Guid Id { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? PositionId { get; set; }
    public string LoginName { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public bool IsEnabled { get; set; }
    public bool IsBuiltInSuperAdmin { get; set; }
}
