using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Persistence;

public sealed class FlowPilotDbContext(DbContextOptions<FlowPilotDbContext> options) : DbContext(options)
{
    public const string DefaultSchema = "flowpilot";
    public const int SqlServerCompatibilityLevel = 130;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.HasDefaultSchema(DefaultSchema);
        base.OnModelCreating(modelBuilder);
    }
}
