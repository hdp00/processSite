using FlowPilot.Database.Migrations;

namespace FlowPilot.UnitTests.Database;

public sealed class MigrationPlannerTests
{
    private static readonly SchemaMigration Migration =
        new("202608260001", "initial_schema", "SELECT 1;");

    private static readonly IReadOnlyList<SchemaMigration> Catalog = [Migration];

    [Fact]
    public void CreatePlan_PlansTheCatalogForAnEmptyDatabase()
    {
        var state = new DatabaseMigrationState(
            HasUserObjects: false,
            FlowPilotSchemaExists: false,
            MigrationLedgerExists: false,
            MigrationLedgerIsValid: false,
            Entries: []);

        var plan = MigrationPlanner.CreatePlan(state, Catalog);

        Assert.False(plan.IsCurrent);
        Assert.Equal(Migration, Assert.Single(plan.PendingMigrations));
    }

    [Fact]
    public void CreatePlan_ReturnsNoOpForMatchingSucceededMigration()
    {
        var state = CreateInitializedState(
            new MigrationLedgerEntry(
                Migration.Id,
                Migration.Name,
                Migration.Checksum,
                "succeeded"));

        var plan = MigrationPlanner.CreatePlan(state, Catalog);

        Assert.True(plan.IsCurrent);
        Assert.Empty(plan.PendingMigrations);
    }

    [Fact]
    public void CreatePlan_RejectsChecksumDrift()
    {
        var state = CreateInitializedState(
            new MigrationLedgerEntry(
                Migration.Id,
                Migration.Name,
                new string('0', 64),
                "succeeded"));

        AssertFailure(
            state,
            DatabaseMigrationFailure.MigrationChecksumMismatch);
    }

    [Theory]
    [InlineData("running")]
    [InlineData("failed")]
    [InlineData("Succeeded")]
    public void CreatePlan_RejectsNonSucceededLedgerRows(string result)
    {
        var state = CreateInitializedState(
            new MigrationLedgerEntry(
                Migration.Id,
                Migration.Name,
                Migration.Checksum,
                result));

        AssertFailure(state, DatabaseMigrationFailure.MigrationNotSucceeded);
    }

    [Fact]
    public void CreatePlan_RejectsUnknownAppliedMigration()
    {
        var state = CreateInitializedState(
            new MigrationLedgerEntry(
                "202608260099",
                "unknown",
                new string('0', 64),
                "succeeded"));

        AssertFailure(state, DatabaseMigrationFailure.UnknownMigration);
    }

    [Fact]
    public void CreatePlan_RejectsExistingSchemaWithoutLedger()
    {
        var state = new DatabaseMigrationState(
            HasUserObjects: false,
            FlowPilotSchemaExists: true,
            MigrationLedgerExists: false,
            MigrationLedgerIsValid: false,
            Entries: []);

        AssertFailure(state, DatabaseMigrationFailure.DatabaseStateUnknown);
    }

    [Fact]
    public void CreatePlan_RejectsNonEmptyDatabaseWithoutFlowPilotLedger()
    {
        var state = new DatabaseMigrationState(
            HasUserObjects: true,
            FlowPilotSchemaExists: false,
            MigrationLedgerExists: false,
            MigrationLedgerIsValid: false,
            Entries: []);

        AssertFailure(state, DatabaseMigrationFailure.DatabaseStateUnknown);
    }

    [Fact]
    public void CreatePlan_RejectsEmptyOrUnsortedCatalog()
    {
        var emptyState = new DatabaseMigrationState(false, false, false, false, []);
        var later = new SchemaMigration("202608260002", "later", "SELECT 2;");

        var emptyException = Assert.Throws<DatabaseMigrationException>(
            () => MigrationPlanner.CreatePlan(emptyState, []));
        var unsortedException = Assert.Throws<DatabaseMigrationException>(
            () => MigrationPlanner.CreatePlan(emptyState, [later, Migration]));

        Assert.Equal(DatabaseMigrationFailure.MigrationCatalogInvalid, emptyException.Failure);
        Assert.Equal(DatabaseMigrationFailure.MigrationCatalogInvalid, unsortedException.Failure);
    }

    private static DatabaseMigrationState CreateInitializedState(MigrationLedgerEntry entry) =>
        new(
            HasUserObjects: true,
            FlowPilotSchemaExists: true,
            MigrationLedgerExists: true,
            MigrationLedgerIsValid: true,
            Entries: [entry]);

    private static void AssertFailure(
        DatabaseMigrationState state,
        DatabaseMigrationFailure expectedFailure)
    {
        var exception = Assert.Throws<DatabaseMigrationException>(
            () => MigrationPlanner.CreatePlan(state, Catalog));

        Assert.Equal(expectedFailure, exception.Failure);
    }
}
