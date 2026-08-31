using FlowPilot.Application.Health;

namespace FlowPilot.UnitTests.Health;

public sealed class DatabaseReadinessSnapshotEvaluatorTests
{
    private const string ExpectedCollation = "Chinese_PRC_100_CI_AS_SC";

    [Theory]
    [InlineData("13.0.5026.0", "SP2")]
    [InlineData("13.0.6300.2", " sp3 ")]
    [InlineData("14.0.1000.169", "RTM")]
    [InlineData("17", null)]
    public void Evaluate_AcceptsSupportedSqlServerVersions(string productVersion, string? productLevel)
    {
        var snapshot = CreateReadySnapshot() with
        {
            ProductVersion = productVersion,
            ProductLevel = productLevel,
        };

        var result = DatabaseReadinessSnapshotEvaluator.Evaluate(snapshot, CreateRequirements());

        Assert.True(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.Ready, result.Code);
    }

    [Theory]
    [InlineData(null, "SP3")]
    [InlineData("", "SP3")]
    [InlineData("not-a-version", "SP3")]
    [InlineData("12.0.6433.1", "SP3")]
    [InlineData("13.0.1601.5", "RTM")]
    [InlineData("13.0.4001.0", "SP1")]
    [InlineData("13.0.4001.0", null)]
    public void Evaluate_RejectsUnsupportedSqlServerVersions(string? productVersion, string? productLevel)
    {
        var snapshot = CreateReadySnapshot() with
        {
            ProductVersion = productVersion,
            ProductLevel = productLevel,
        };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.ServerVersionUnsupported);
    }

    [Fact]
    public void Evaluate_RejectsCompatibilityLevelBelow130()
    {
        var snapshot = CreateReadySnapshot() with { CompatibilityLevel = 129 };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.CompatibilityLevelUnsupported);
    }

    [Fact]
    public void Evaluate_AllowsCompatibilityLevelAbove130()
    {
        var snapshot = CreateReadySnapshot() with { CompatibilityLevel = 160 };

        var result = DatabaseReadinessSnapshotEvaluator.Evaluate(snapshot, CreateRequirements());

        Assert.True(result.IsReady);
    }

    [Fact]
    public void Evaluate_RejectsOmittedExpectedCollation()
    {
        var requirements = CreateRequirements() with { ExpectedCollation = null };
        var snapshot = CreateReadySnapshot() with { Collation = null };

        AssertNotReady(
            snapshot,
            requirements,
            DatabaseReadinessCodes.ConfigurationMissing);
    }

    [Fact]
    public void Evaluate_MatchesExpectedCollationWithoutCaseOrOuterWhitespace()
    {
        var requirements = CreateRequirements() with
        {
            ExpectedCollation = $" {ExpectedCollation.ToLowerInvariant()} ",
        };

        var result = DatabaseReadinessSnapshotEvaluator.Evaluate(
            CreateReadySnapshot(),
            requirements);

        Assert.True(result.IsReady);
    }

    [Fact]
    public void Evaluate_RejectsUnexpectedCollation()
    {
        var snapshot = CreateReadySnapshot() with { Collation = "Latin1_General_100_CI_AS_SC" };

        AssertNotReady(snapshot, CreateRequirements(), DatabaseReadinessCodes.CollationMismatch);
    }

    [Fact]
    public void Evaluate_RejectsMissingFlowPilotSchema()
    {
        var snapshot = CreateReadySnapshot() with { FlowPilotSchemaExists = false };

        AssertNotReady(snapshot, CreateRequirements(), DatabaseReadinessCodes.SchemaMissing);
    }

    [Fact]
    public void Evaluate_RejectsMissingSchemaVersionStore()
    {
        var snapshot = CreateReadySnapshot() with { SchemaVersionStoreExists = false };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.SchemaVersionStoreMissing);
    }

    [Fact]
    public void Evaluate_RejectsInvalidSchemaVersionStore()
    {
        var snapshot = CreateReadySnapshot() with { SchemaVersionStoreIsValid = false };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.SchemaVersionStoreInvalid);
    }

    [Fact]
    public void Evaluate_RejectsSchemaStructureMismatch()
    {
        var snapshot = CreateReadySnapshot() with { SchemaStructureIsValid = false };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.SchemaStructureMismatch);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Evaluate_RejectsMissingAppliedSchemaVersion(string? appliedSchemaVersion)
    {
        var snapshot = CreateReadySnapshot() with { AppliedSchemaVersion = appliedSchemaVersion };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.SchemaVersionMissing);
    }

    [Fact]
    public void Evaluate_RejectsSchemaVersionMismatch()
    {
        var snapshot = CreateReadySnapshot() with { AppliedSchemaVersion = "202608250001" };

        AssertNotReady(
            snapshot,
            CreateRequirements(),
            DatabaseReadinessCodes.SchemaVersionMismatch);
    }

    [Fact]
    public void Evaluate_TrimsSchemaVersionsBeforeComparison()
    {
        var snapshot = CreateReadySnapshot() with
        {
            AppliedSchemaVersion = $" {DatabaseSchemaVersion.Current} ",
        };

        var result = DatabaseReadinessSnapshotEvaluator.Evaluate(snapshot, CreateRequirements());

        Assert.True(result.IsReady);
    }

    private static DatabaseReadinessSnapshot CreateReadySnapshot() =>
        new(
            "13.0.6300.2",
            "SP3",
            DatabaseReadinessSnapshotEvaluator.MinimumCompatibilityLevel,
            ExpectedCollation,
            FlowPilotSchemaExists: true,
            SchemaVersionStoreExists: true,
            SchemaVersionStoreIsValid: true,
            DatabaseSchemaVersion.Current);

    private static DatabaseReadinessRequirements CreateRequirements() =>
        new(ExpectedCollation);

    private static void AssertNotReady(
        DatabaseReadinessSnapshot snapshot,
        DatabaseReadinessRequirements requirements,
        string expectedCode)
    {
        var result = DatabaseReadinessSnapshotEvaluator.Evaluate(snapshot, requirements);

        Assert.False(result.IsReady);
        Assert.Equal(expectedCode, result.Code);
    }
}
