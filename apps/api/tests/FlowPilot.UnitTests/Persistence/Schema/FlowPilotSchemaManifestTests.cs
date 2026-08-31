using FlowPilot.Database.Migrations;
using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public sealed class FlowPilotSchemaManifestTests
{
    [Fact]
    public void CurrentManifestMatchesTheCompleteMigrationInventory()
    {
        var initialMigration = MigrationCatalog.Migrations[0];
        var inventory = InitialSchemaDdlInventoryParser.Parse(initialMigration.Sql);
        var manifest = FlowPilotSchemaManifest.Current;
        var expectedColumns = inventory.Columns
            .Append("workflow_definition_versions.change_note")
            .Append("sessions.impersonation_record_id")
            .ToHashSet(StringComparer.Ordinal);
        var expectedConstraints = inventory.Constraints
            .Append("sessions.fk_sessions_impersonation_record")
            .ToHashSet(StringComparer.Ordinal);
        var expectedIndexes = inventory.Indexes
            .Append("sessions.ux_sessions_impersonation_record")
            .ToHashSet(StringComparer.Ordinal);

        Assert.Equal(MigrationCatalog.CurrentSchemaVersion, manifest.Version);
        Assert.Equal("flowpilot", manifest.SchemaName);
        Assert.True(manifest.Tables.SetEquals(inventory.Tables));
        Assert.True(manifest.Columns.SetEquals(expectedColumns));
        Assert.True(manifest.Constraints.SetEquals(expectedConstraints));
        Assert.True(manifest.Indexes.SetEquals(expectedIndexes));
        Assert.True(manifest.Triggers.SetEquals(inventory.Triggers));
    }
}
