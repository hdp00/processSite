using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Configuration;
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
        var databaseOptions = new FlowPilotDatabaseOptions(
            requiredSchemaVersion: "202608260001",
            requiredBuiltinSeedVersion: "202608260001",
            applicationCommandTimeoutSeconds: 42);
        services.AddFlowPilotPersistence(
            ConnectionString,
            databaseOptions);
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
        var context = scope.ServiceProvider.GetRequiredService<FlowPilotDbContext>();
        Assert.Equal(42, context.Database.GetCommandTimeout());
    }

    [Fact]
    public void AddFlowPilotPersistence_RegistersReadinessServices()
    {
        var services = new ServiceCollection();
        var databaseOptions = new FlowPilotDatabaseOptions(
            requiredSchemaVersion: "202608260001",
            requiredBuiltinSeedVersion: "202608260001");
        services.AddFlowPilotPersistence(ConnectionString, databaseOptions);
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();

        Assert.Same(
            databaseOptions,
            scope.ServiceProvider.GetRequiredService<FlowPilotDatabaseOptions>());
        Assert.Equal(
            databaseOptions.RequiredSchemaVersion,
            scope.ServiceProvider
                .GetRequiredService<DatabaseReadinessRequirements>()
                .RequiredSchemaVersion);
        Assert.Equal(
            databaseOptions.RequiredBuiltinSeedVersion,
            scope.ServiceProvider
                .GetRequiredService<BuiltinSeedReadinessRequirements>()
                .RequiredBuiltinSeedVersion);
        Assert.IsType<ApplicationDatabaseReadinessCheck>(
            scope.ServiceProvider.GetRequiredService<IDatabaseReadinessCheck>());
        Assert.IsType<SqlServerDatabaseReadinessCheck>(
            scope.ServiceProvider.GetRequiredService<SqlServerDatabaseReadinessCheck>());
        Assert.IsType<SqlServerReadinessSnapshotReader>(
            scope.ServiceProvider.GetRequiredService<ISqlServerReadinessSnapshotReader>());
        Assert.IsType<SqlServerBuiltinSeedVersionReader>(
            scope.ServiceProvider.GetRequiredService<IBuiltinSeedVersionReader>());
    }

    [Fact]
    public async Task AddFlowPilotPersistence_AllowsMissingConnectionToFailReadinessSafely()
    {
        var services = new ServiceCollection();
        services.AddFlowPilotPersistence(
            connectionString: null,
            new FlowPilotDatabaseOptions(
                requiredSchemaVersion: "202608260001",
                requiredBuiltinSeedVersion: "202608260001"));
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var check = scope.ServiceProvider.GetRequiredService<IDatabaseReadinessCheck>();

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.ConfigurationMissing, result.Code);
    }
}
