using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Health;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

public sealed class SqlServerReadinessIntegrationTests
{
    [Fact]
    public async Task ConfiguredDatabaseSatisfiesTheSupportedServerAndSchemaBaseline()
    {
        var configuration = SqlServerTestConfiguration.Load();
        var connectionString = SqlServerTestConfiguration.RequireOrSkip(
            configuration.GetConnectionString("FlowPilot"),
            $"ConnectionStrings:FlowPilot or {SqlServerTestConfiguration.ConnectionStringOverrideVariable}");

        var expectedCollation = SqlServerTestConfiguration.RequireOrSkip(
            configuration["FlowPilot:Database:ExpectedCollation"],
            $"FlowPilot:Database:ExpectedCollation or {SqlServerTestConfiguration.ExpectedCollationOverrideVariable}");

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
            new DatabaseReadinessRequirements(expectedCollation));

        Assert.True(result.IsReady, $"Database readiness failed with code {result.Code}.");
    }
}
