using FlowPilot.Database.Migrations;
using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public sealed class FlowPilotSchemaManifestTests
{
    [Fact]
    public void CurrentManifest_ExactlyMatchesTheInitialMigrationInventory()
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
        Assert.Equal(356, inventory.ColumnSignatures.Count);
        Assert.All(
            inventory.ColumnSignatures,
            signature =>
            {
                Assert.Contains("|collation=", signature);
                Assert.Contains("|computed=", signature);
                Assert.Contains("|computedDefinition=", signature);
                Assert.Contains("|persisted=", signature);
                Assert.Contains("|identity=", signature);
                Assert.Contains("|seed=", signature);
                Assert.Contains("|increment=", signature);
                Assert.Contains("|rowGuid=", signature);
                Assert.Contains("|sparse=", signature);
                Assert.Contains("|ansiPadded=", signature);
                Assert.Contains(
                    "|computed=0|computedDefinition=-|persisted=0" +
                    "|identity=0|seed=-|increment=-|rowGuid=0|sparse=0|",
                    signature);
            });
        Assert.Equal(
            134,
            inventory.ColumnSignatures.Count(signature =>
                signature.Contains("|collation=database_default|", StringComparison.Ordinal)));
        Assert.Equal(
            136,
            inventory.ColumnSignatures.Count(signature =>
                signature.EndsWith("|ansiPadded=1", StringComparison.Ordinal)));
        Assert.Equal(169, inventory.CheckConstraintSignatures.Count);
        Assert.Equal(80, inventory.ForeignKeySignatures.Count);
        Assert.Equal(34, inventory.KeyConstraintSignatures.Count);
        Assert.Equal(86, inventory.IndexSignatures.Count);
        Assert.Equal(6, inventory.TriggerSignatures.Count);
        Assert.Equal(
            32,
            inventory.IndexSignatures.Count(signature =>
                signature.Contains("|unique=1|", StringComparison.Ordinal)));
        Assert.Equal(
            21,
            inventory.IndexSignatures.Count(signature =>
                !signature.EndsWith("|filter=-", StringComparison.Ordinal)));
        Assert.Single(
            inventory.IndexSignatures,
            signature => !signature.Contains("|include=|", StringComparison.Ordinal));
        Assert.True(manifest.Tables.SetEquals(inventory.Tables));
        Assert.True(manifest.Columns.SetEquals(inventory.Columns));
        Assert.True(manifest.Constraints.SetEquals(inventory.Constraints));
        Assert.True(manifest.Indexes.SetEquals(inventory.Indexes));
        Assert.True(manifest.Triggers.SetEquals(inventory.Triggers));
        Assert.True(manifest.ColumnSignatures.SetEquals(inventory.ColumnSignatures));
        Assert.True(manifest.CheckConstraintSignatures.SetEquals(
            inventory.CheckConstraintSignatures));
        Assert.True(manifest.ForeignKeySignatures.SetEquals(inventory.ForeignKeySignatures));
        Assert.True(manifest.KeyConstraintSignatures.SetEquals(
            inventory.KeyConstraintSignatures));
        Assert.True(manifest.IndexSignatures.SetEquals(inventory.IndexSignatures));
        Assert.True(manifest.TriggerSignatures.SetEquals(inventory.TriggerSignatures));
    }
}
