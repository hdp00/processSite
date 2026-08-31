using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Health;
using FlowPilot.Infrastructure.Persistence.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FlowPilot.Infrastructure.Persistence;

public static class PersistenceServiceCollectionExtensions
{
    public static IServiceCollection AddFlowPilotPersistence(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        return services.AddFlowPilotPersistence(
            configuration.GetConnectionString("FlowPilot"),
            FlowPilotDatabaseOptions.FromConfiguration(configuration));
    }

    public static IServiceCollection AddFlowPilotPersistence(
        this IServiceCollection services,
        string? connectionString,
        FlowPilotDatabaseOptions databaseOptions)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(databaseOptions);

        services.AddSingleton(databaseOptions);
        services.AddSingleton(
            new DatabaseReadinessRequirements(
                databaseOptions.RequiredSchemaVersion,
                databaseOptions.ExpectedCollation));
        services.AddSingleton(
            new BuiltinSeedReadinessRequirements(databaseOptions.RequiredBuiltinSeedVersion));
        services.AddDbContext<FlowPilotDbContext>(options =>
        {
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                options.UseSqlServer(sqlServerOptions =>
                    sqlServerOptions
                        .UseCompatibilityLevel(FlowPilotDbContext.SqlServerCompatibilityLevel)
                        .CommandTimeout(databaseOptions.ApplicationCommandTimeoutSeconds));
                return;
            }

            options.UseSqlServer(
                connectionString,
                sqlServerOptions =>
                    sqlServerOptions
                        .UseCompatibilityLevel(FlowPilotDbContext.SqlServerCompatibilityLevel)
                        .CommandTimeout(databaseOptions.ApplicationCommandTimeoutSeconds));
        });

        services.AddSingleton<ISqlServerSchemaStructureProbe, SqlServerSchemaStructureProbe>();
        services.AddScoped<ISqlServerReadinessSnapshotReader, SqlServerReadinessSnapshotReader>();
        services.AddScoped<SqlServerDatabaseReadinessCheck>();
        services.AddScoped<IBuiltinSeedVersionReader, SqlServerBuiltinSeedVersionReader>();
        services.AddScoped<IDatabaseReadinessCheck, ApplicationDatabaseReadinessCheck>();
        services.AddScoped<IOperationalHealthService, OperationalHealthService>();

        return services;
    }
}
