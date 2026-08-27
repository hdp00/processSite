using FlowPilot.Database.Migrations;

namespace FlowPilot.UnitTests.Database;

public sealed class DatabaseMigrationInputValidatorTests
{
    private const string ValidConnectionString =
        "Server=sql.example;Database=FlowPilot;User ID=migrator;Password=secret";

    [Fact]
    public void Validate_AcceptsNamedNonSystemDatabase()
    {
        var request = new DatabaseMigrationRequest(
            ValidConnectionString,
            "Chinese_PRC_CI_AS",
            "2026.08.26.1");

        DatabaseMigrationInputValidator.Validate(request);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-connection-string")]
    public void Validate_RejectsMissingOrInvalidConnectionString(string? connectionString)
    {
        var request = new DatabaseMigrationRequest(
            connectionString,
            "Chinese_PRC_CI_AS",
            "2026.08.26.1");

        AssertFailure(request, DatabaseMigrationFailure.InvalidConnectionString);
    }

    [Fact]
    public void Validate_RejectsConnectionWithoutDatabaseName()
    {
        var request = new DatabaseMigrationRequest(
            "Server=sql.example;User ID=migrator;Password=secret",
            "Chinese_PRC_CI_AS",
            "2026.08.26.1");

        AssertFailure(request, DatabaseMigrationFailure.DatabaseNameMissing);
    }

    [Theory]
    [InlineData("master")]
    [InlineData("MODEL")]
    [InlineData("msdb")]
    [InlineData("TempDb")]
    public void Validate_RejectsSystemDatabaseNames(string databaseName)
    {
        var request = new DatabaseMigrationRequest(
            $"Server=sql.example;Database={databaseName};User ID=migrator;Password=secret",
            "Chinese_PRC_CI_AS",
            "2026.08.26.1");

        AssertFailure(request, DatabaseMigrationFailure.SystemDatabaseNotAllowed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Validate_RejectsMissingExpectedCollation(string? expectedCollation)
    {
        var request = new DatabaseMigrationRequest(
            ValidConnectionString,
            expectedCollation,
            "2026.08.26.1");

        AssertFailure(request, DatabaseMigrationFailure.ExpectedCollationMissing);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Validate_RejectsMissingToolVersion(string? toolVersion)
    {
        var request = new DatabaseMigrationRequest(
            ValidConnectionString,
            "Chinese_PRC_CI_AS",
            toolVersion);

        AssertFailure(request, DatabaseMigrationFailure.InvalidInput);
    }

    private static void AssertFailure(
        DatabaseMigrationRequest request,
        DatabaseMigrationFailure expectedFailure)
    {
        var exception = Assert.Throws<DatabaseMigrationException>(
            () => DatabaseMigrationInputValidator.Validate(request));

        Assert.Equal(expectedFailure, exception.Failure);
        Assert.DoesNotContain("secret", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sql.example", exception.Message, StringComparison.OrdinalIgnoreCase);
    }
}
