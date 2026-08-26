using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Health;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace FlowPilot.UnitTests.Persistence;

public sealed class FlowPilotDbContextTests
{
    private const string ConnectionString =
        "Server=127.0.0.1;Database=FlowPilot;User Id=test;Password=test;Encrypt=True;TrustServerCertificate=True";

    [Fact]
    public void Model_UsesFlowPilotAsDefaultSchema()
    {
        var options = new DbContextOptionsBuilder<FlowPilotDbContext>()
            .UseSqlServer(ConnectionString)
            .Options;
        using var context = new FlowPilotDbContext(options);

        Assert.Equal(FlowPilotDbContext.DefaultSchema, context.Model.GetDefaultSchema());
        Assert.Equal("flowpilot", FlowPilotDbContext.DefaultSchema);
    }

    [Fact]
    public void AddFlowPilotPersistence_ConfiguresSqlServerCompatibilityLevel130()
    {
        var services = new ServiceCollection();
        services.AddFlowPilotPersistence(
            ConnectionString,
            new DatabaseReadinessRequirements("202608260001", null));
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();

        var options = scope.ServiceProvider
            .GetRequiredService<DbContextOptions<FlowPilotDbContext>>();
        var sqlServerOptions = Assert.Single(
            options.Extensions,
            extension => extension.GetType().Name == "SqlServerOptionsExtension");
        var compatibilityLevelProperty = sqlServerOptions
            .GetType()
            .GetProperty("SqlServerCompatibilityLevel");

        Assert.NotNull(compatibilityLevelProperty);
        Assert.Equal(
            FlowPilotDbContext.SqlServerCompatibilityLevel,
            compatibilityLevelProperty.GetValue(sqlServerOptions));
        Assert.Equal(130, FlowPilotDbContext.SqlServerCompatibilityLevel);
    }

    [Fact]
    public void AddFlowPilotPersistence_RegistersReadinessServices()
    {
        var services = new ServiceCollection();
        var requirements = new DatabaseReadinessRequirements("202608260001", null);
        services.AddFlowPilotPersistence(ConnectionString, requirements);
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();

        Assert.Same(
            requirements,
            scope.ServiceProvider.GetRequiredService<DatabaseReadinessRequirements>());
        Assert.IsType<SqlServerDatabaseReadinessCheck>(
            scope.ServiceProvider.GetRequiredService<IDatabaseReadinessCheck>());
        Assert.IsType<SqlServerReadinessSnapshotReader>(
            scope.ServiceProvider.GetRequiredService<ISqlServerReadinessSnapshotReader>());
    }

    [Fact]
    public async Task AddFlowPilotPersistence_AllowsMissingConnectionToFailReadinessSafely()
    {
        var services = new ServiceCollection();
        services.AddFlowPilotPersistence(
            connectionString: null,
            new DatabaseReadinessRequirements("202608260001", null));
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var check = scope.ServiceProvider.GetRequiredService<IDatabaseReadinessCheck>();

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.ConfigurationMissing, result.Code);
    }
}
