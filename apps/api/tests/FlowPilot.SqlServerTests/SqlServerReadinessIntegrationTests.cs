using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Health;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class SqlServerReadinessIntegrationTests
{
    private const string ConnectionStringVariable =
        "FLOWPILOT_SQLSERVER_TEST_CONNECTION_STRING";

    private const string SchemaVersionVariable =
        "FLOWPILOT_SQLSERVER_TEST_REQUIRED_SCHEMA_VERSION";

    private const string ExpectedCollationVariable =
        "FLOWPILOT_SQLSERVER_TEST_EXPECTED_COLLATION";

    [Fact]
    public async Task ConfiguredDatabaseSatisfiesTheSupportedServerAndSchemaBaseline()
    {
        var connectionString = Environment.GetEnvironmentVariable(ConnectionStringVariable);
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            Assert.Skip($"Set {ConnectionStringVariable} to run SQL Server integration tests.");
        }

        var requiredSchemaVersion = Environment.GetEnvironmentVariable(SchemaVersionVariable);
        Assert.False(
            string.IsNullOrWhiteSpace(requiredSchemaVersion),
            $"Set {SchemaVersionVariable} when enabling SQL Server integration tests.");
        var expectedCollation = Environment.GetEnvironmentVariable(ExpectedCollationVariable);
        Assert.False(
            string.IsNullOrWhiteSpace(expectedCollation),
            $"Set {ExpectedCollationVariable} when enabling SQL Server integration tests.");

        var options = new DbContextOptionsBuilder<FlowPilotDbContext>()
            .UseSqlServer(
                connectionString,
                sqlServerOptions => sqlServerOptions.UseCompatibilityLevel(
                    FlowPilotDbContext.SqlServerCompatibilityLevel))
            .Options;

        await using var context = new FlowPilotDbContext(options);
        var reader = new SqlServerReadinessSnapshotReader(context);
        var snapshot = await reader.ReadAsync(TestContext.Current.CancellationToken);
        var result = DatabaseReadinessSnapshotEvaluator.Evaluate(
            snapshot,
            new DatabaseReadinessRequirements(requiredSchemaVersion, expectedCollation));

        Assert.True(result.IsReady, $"Database readiness failed with code {result.Code}.");
    }
}
