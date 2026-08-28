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

// 组织模块只需要用这几个字段判断部门或职务是否仍被用户引用。
internal sealed class OrganizationUserReference
{
    public Guid Id { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? PositionId { get; set; }
}
