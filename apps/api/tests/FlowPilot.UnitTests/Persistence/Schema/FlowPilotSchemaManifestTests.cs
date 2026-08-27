using FlowPilot.Database.Migrations;
using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public sealed class FlowPilotSchemaManifestTests
{
    [Fact]
    public void CurrentManifestMatchesTheInitialMigrationInventory()
    {
        var migration = Assert.Single(MigrationCatalog.Migrations);
        var inventory = InitialSchemaDdlInventoryParser.Parse(migration.Sql);
        var manifest = FlowPilotSchemaManifest.Current;

        Assert.Equal(MigrationCatalog.CurrentSchemaVersion, manifest.Version);
        Assert.Equal("flowpilot", manifest.SchemaName);
        Assert.Equal(34, inventory.Tables.Count);
        Assert.Equal(356, inventory.Columns.Count);
        Assert.Equal(283, inventory.Constraints.Count);
        Assert.Equal(86, inventory.Indexes.Count);
        Assert.Equal(6, inventory.Triggers.Count);
        Assert.True(manifest.Tables.SetEquals(inventory.Tables));
        Assert.True(manifest.Columns.SetEquals(inventory.Columns));
        Assert.True(manifest.Constraints.SetEquals(inventory.Constraints));
        Assert.True(manifest.Indexes.SetEquals(inventory.Indexes));
        Assert.True(manifest.Triggers.SetEquals(inventory.Triggers));
    }
}
