using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FlowPilot.Infrastructure.Persistence;

public sealed class FlowPilotDbContext(DbContextOptions<FlowPilotDbContext> options) : DbContext(options)
{
    public const string DefaultSchema = "flowpilot";
    public const int SqlServerCompatibilityLevel = 130;

    internal DbSet<DepartmentEntity> Departments => Set<DepartmentEntity>();
    internal DbSet<PositionEntity> Positions => Set<PositionEntity>();
    internal DbSet<OrganizationUserReference> OrganizationUserReferences => Set<OrganizationUserReference>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.HasDefaultSchema(DefaultSchema);

        ConfigureDepartment(modelBuilder.Entity<DepartmentEntity>());
        ConfigurePosition(modelBuilder.Entity<PositionEntity>());
        ConfigureOrganizationUserReference(modelBuilder.Entity<OrganizationUserReference>());

        base.OnModelCreating(modelBuilder);
    }

    private static void ConfigureDepartment(EntityTypeBuilder<DepartmentEntity> entity)
    {
        entity.ToTable("departments", table => table.UseSqlOutputClause(false));
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.Code).HasColumnName("code").HasMaxLength(100);
        entity.Property(item => item.NormalizedCode).HasColumnName("normalized_code").HasMaxLength(100);
        entity.Property(item => item.Name).HasColumnName("name").HasMaxLength(200);
        entity.Property(item => item.ParentId).HasColumnName("parent_id");
        entity.Property(item => item.Path).HasColumnName("path_cache").HasMaxLength(1000);
        entity.Property(item => item.SortOrder).HasColumnName("sort_order");
        entity.Property(item => item.IsEnabled).HasColumnName("is_enabled");
        entity.Property(item => item.Description).HasColumnName("description").HasMaxLength(1000);
        entity.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        entity.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        entity.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        entity.Property(item => item.CreatedBy).HasColumnName("created_by");
        entity.Property(item => item.UpdatedBy).HasColumnName("updated_by");
        entity.HasIndex(item => item.NormalizedCode).IsUnique();
        entity.HasIndex(item => new { item.ParentId, item.SortOrder, item.Id });
    }

    private static void ConfigurePosition(EntityTypeBuilder<PositionEntity> entity)
    {
        entity.ToTable("positions");
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.Code).HasColumnName("code").HasMaxLength(100);
        entity.Property(item => item.NormalizedCode).HasColumnName("normalized_code").HasMaxLength(100);
        entity.Property(item => item.Name).HasColumnName("name").HasMaxLength(200);
        entity.Property(item => item.NormalizedName).HasColumnName("normalized_name").HasMaxLength(200);
        entity.Property(item => item.SortOrder).HasColumnName("sort_order");
        entity.Property(item => item.IsEnabled).HasColumnName("is_enabled");
        entity.Property(item => item.Description).HasColumnName("description").HasMaxLength(1000);
        entity.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        entity.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        entity.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        entity.Property(item => item.CreatedBy).HasColumnName("created_by");
        entity.Property(item => item.UpdatedBy).HasColumnName("updated_by");
        entity.HasIndex(item => item.NormalizedCode).IsUnique();
        entity.HasIndex(item => item.NormalizedName).IsUnique();
    }

    private static void ConfigureOrganizationUserReference(
        EntityTypeBuilder<OrganizationUserReference> entity)
    {
        entity.ToTable("users");
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.DepartmentId).HasColumnName("department_id");
        entity.Property(item => item.PositionId).HasColumnName("position_id");
    }
}
