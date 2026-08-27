using FlowPilot.Database.Migrations;

namespace FlowPilot.UnitTests.Database;

public sealed class SqlServerPreflightEvaluatorTests
{
    private const string DatabaseName = "FlowPilot";
    private const string ExpectedCollation = "Chinese_PRC_CI_AS";

    [Theory]
    [InlineData("13.0.5026.0", "SP2")]
    [InlineData("13.0.6300.2", " sp3 ")]
    [InlineData("14.0.1000.169", "RTM")]
    [InlineData("17", null)]
    public void Validate_AcceptsSupportedServerVersions(string productVersion, string? productLevel)
    {
        var snapshot = CreateSupportedSnapshot() with
        {
            ProductVersion = productVersion,
            ProductLevel = productLevel,
        };

        SqlServerPreflightEvaluator.Validate(snapshot, ExpectedCollation, DatabaseName);
    }

    [Theory]
    [InlineData("12.0.6433.1", "SP3")]
    [InlineData("13.0.1601.5", "RTM")]
    [InlineData("13.0.4001.0", "SP1")]
    [InlineData("invalid", "SP3")]
    public void Validate_RejectsUnsupportedServerVersions(string productVersion, string? productLevel)
    {
        var snapshot = CreateSupportedSnapshot() with
        {
            ProductVersion = productVersion,
            ProductLevel = productLevel,
        };

        AssertFailure(snapshot, DatabaseMigrationFailure.ServerVersionUnsupported);
    }

    [Fact]
    public void Validate_RejectsCompatibilityLevelBelow130()
    {
        var snapshot = CreateSupportedSnapshot() with { CompatibilityLevel = 129 };

        AssertFailure(snapshot, DatabaseMigrationFailure.CompatibilityLevelUnsupported);
    }

    [Fact]
    public void Validate_RejectsCollationMismatch()
    {
        var snapshot = CreateSupportedSnapshot() with { Collation = "Latin1_General_CI_AS" };

        AssertFailure(snapshot, DatabaseMigrationFailure.CollationMismatch);
    }

    [Theory]
    [InlineData("master")]
    [InlineData("MODEL")]
    [InlineData("msdb")]
    [InlineData("TempDb")]
    public void Validate_RejectsActualSystemDatabase(string databaseName)
    {
        var snapshot = CreateSupportedSnapshot() with { DatabaseName = databaseName };

        AssertFailure(snapshot, DatabaseMigrationFailure.SystemDatabaseNotAllowed);
    }

    [Fact]
    public void Validate_RejectsDatabaseNameFallbackOrMismatch()
    {
        var snapshot = CreateSupportedSnapshot() with { DatabaseName = "AnotherDatabase" };

        AssertFailure(snapshot, DatabaseMigrationFailure.DatabaseNameMismatch);
    }

    private static SqlServerPreflightSnapshot CreateSupportedSnapshot() =>
        new(
            DatabaseName,
            "13.0.6300.2",
            "SP3",
            SqlServerPreflightEvaluator.MinimumCompatibilityLevel,
            ExpectedCollation);

    private static void AssertFailure(
        SqlServerPreflightSnapshot snapshot,
        DatabaseMigrationFailure expectedFailure)
    {
        var exception = Assert.Throws<DatabaseMigrationException>(
            () => SqlServerPreflightEvaluator.Validate(
                snapshot,
                ExpectedCollation,
                DatabaseName));

        Assert.Equal(expectedFailure, exception.Failure);
    }
}
