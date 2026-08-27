namespace FlowPilot.Database.Migrations;

public interface IDatabaseMigrator
{
    Task<DatabaseMigrationResult> ApplyAsync(
        DatabaseMigrationRequest request,
        CancellationToken cancellationToken = default);
}
