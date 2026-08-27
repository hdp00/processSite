using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace FlowPilot.Database.Migrations;

[DbContext(typeof(FlowPilotDbContext))]
[Migration("202608260001_initial_schema")]
public sealed class InitialSchemaEfMigration : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);

        var migration = MigrationCatalog.Migrations.Single();
        migrationBuilder.Sql(migration.Sql);
        migrationBuilder.Sql(
            $"""
            INSERT INTO [flowpilot].[schema_migrations]
            (
                [migration_id],
                [name],
                [checksum],
                [started_at],
                [completed_at],
                [tool_version],
                [result]
            )
            VALUES
            (
                N'{migration.Id}',
                N'{migration.Name}',
                '{migration.Checksum}',
                SYSUTCDATETIME(),
                SYSUTCDATETIME(),
                N'ef-core-10.0.11',
                N'succeeded'
            );
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        throw new NotSupportedException(
            "FlowPilot database migrations use reviewed forward fixes and do not support rollback DDL.");
    }
}
