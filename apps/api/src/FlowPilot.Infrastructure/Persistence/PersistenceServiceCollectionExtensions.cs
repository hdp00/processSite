using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Health;
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
            new DatabaseReadinessRequirements(
                configuration["FlowPilot:Database:RequiredSchemaVersion"],
                configuration["FlowPilot:Database:ExpectedCollation"]));
    }

    public static IServiceCollection AddFlowPilotPersistence(
        this IServiceCollection services,
        string? connectionString,
        DatabaseReadinessRequirements readinessRequirements)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(readinessRequirements);

        services.AddSingleton(readinessRequirements);
        services.AddDbContext<FlowPilotDbContext>(options =>
        {
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                options.UseSqlServer(sqlServerOptions =>
                    sqlServerOptions.UseCompatibilityLevel(FlowPilotDbContext.SqlServerCompatibilityLevel));
                return;
            }

            options.UseSqlServer(
                connectionString,
                sqlServerOptions =>
                    sqlServerOptions.UseCompatibilityLevel(FlowPilotDbContext.SqlServerCompatibilityLevel));
        });

        services.AddScoped<ISqlServerReadinessSnapshotReader, SqlServerReadinessSnapshotReader>();
        services.AddScoped<IDatabaseReadinessCheck, SqlServerDatabaseReadinessCheck>();

        return services;
    }
}
