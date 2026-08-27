using FlowPilot.Database.Migrations;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

public sealed class SqlServerMigrationIntegrationTests
{
    [Fact]
    public async Task EmptyDedicatedDatabaseExecutesMigrationAndRollsBackValidation()
    {
        var configuration = SqlServerTestConfiguration.Load();
        var connectionString = SqlServerTestConfiguration.RequireOrSkip(
            configuration.GetConnectionString("FlowPilotMigrationTest"),
            "ConnectionStrings:FlowPilotMigrationTest");
        var expectedCollation = SqlServerTestConfiguration.RequireOrSkip(
            configuration["FlowPilot:Database:ExpectedCollation"],
            "FlowPilot:Database:ExpectedCollation");
        await AssertDedicatedTestDatabaseAsync(
            connectionString,
            configuration,
            TestContext.Current.CancellationToken);

        var request = new DatabaseMigrationRequest(
            connectionString,
            expectedCollation,
            "sql-integration-tests");
        var migrator = new SqlServerDatabaseMigrator();

        var firstResult = await migrator.ValidateEmptyDatabaseAsync(
            request,
            TestContext.Current.CancellationToken);
        Assert.Equal(DatabaseMigrationOutcome.Validated, firstResult.Outcome);
        Assert.Equal(1, firstResult.AppliedMigrationCount);

        var failingMigration = new SchemaMigration(
            "999999999999",
            "rollback_probe",
            """
            CREATE TABLE [flowpilot].[migration_failure_probe]
            (
                [id] int NOT NULL
            );
            THROW 51090, 'Intentional integration-test migration failure.', 1;
            """);
        var failingCatalog = MigrationCatalog.Migrations.Append(failingMigration).ToArray();
        var failingMigrator = new SqlServerDatabaseMigrator(failingCatalog, TimeProvider.System);

        var exception = await Assert.ThrowsAsync<DatabaseMigrationException>(
            () => failingMigrator.ApplyAsync(request, TestContext.Current.CancellationToken));
        Assert.Equal(DatabaseMigrationFailure.MigrationExecutionFailed, exception.Failure);

        var afterFailure = await migrator.ValidateEmptyDatabaseAsync(
            request,
            TestContext.Current.CancellationToken);
        Assert.Equal(DatabaseMigrationOutcome.Validated, afterFailure.Outcome);
    }

    private static async Task AssertDedicatedTestDatabaseAsync(
        string connectionString,
        IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        var testIdentity = await ReadDatabaseIdentityAsync(connectionString, cancellationToken);
        if (!System.Text.RegularExpressions.Regex.IsMatch(
                testIdentity.DatabaseName,
                "(?:_tests|_migrationtests)$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase |
                System.Text.RegularExpressions.RegexOptions.CultureInvariant))
        {
            Assert.Fail("FlowPilotMigrationTest must target a database whose actual name ends in _Tests or _MigrationTests.");
        }

        foreach (var connectionName in new[] { "FlowPilot", "FlowPilotMigration" })
        {
            var otherConnectionString = configuration.GetConnectionString(connectionName);
            if (string.IsNullOrWhiteSpace(otherConnectionString))
            {
                continue;
            }

            var otherIdentity = await ReadDatabaseIdentityAsync(
                otherConnectionString,
                cancellationToken);
            if (testIdentity.IsSameAs(otherIdentity))
            {
                Assert.Fail("FlowPilotMigrationTest must not target the development or runtime database.");
            }
        }
    }

    private static async Task<DatabaseIdentity> ReadDatabaseIdentityAsync(
        string connectionString,
        CancellationToken cancellationToken)
    {
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT CONVERT(nvarchar(128), SERVERPROPERTY(N'ServerName')), CONVERT(nvarchar(128), DB_NAME());";
        command.CommandTimeout = 15;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        Assert.True(await reader.ReadAsync(cancellationToken));
        Assert.False(reader.IsDBNull(0));
        Assert.False(reader.IsDBNull(1));
        return new DatabaseIdentity(reader.GetString(0), reader.GetString(1));
    }

    private sealed record DatabaseIdentity
    {
        public DatabaseIdentity(string serverName, string databaseName)
        {
            ServerName = serverName.Trim();
            DatabaseName = databaseName.Trim();
        }

        public string ServerName { get; }

        public string DatabaseName { get; }

        public bool IsSameAs(DatabaseIdentity? other) =>
            other is not null &&
            string.Equals(ServerName, other.ServerName, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(DatabaseName, other.DatabaseName, StringComparison.OrdinalIgnoreCase);
    }
}
