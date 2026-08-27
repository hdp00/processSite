namespace FlowPilot.Database.Migrations;

public sealed record MigrationPlan(IReadOnlyList<SchemaMigration> PendingMigrations)
{
    public bool IsCurrent => PendingMigrations.Count == 0;
}
