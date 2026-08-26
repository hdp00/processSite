using FlowPilot.Infrastructure.Deployment;

namespace FlowPilot.Api.Configuration;

public static class FlowPilotConfigurationExtensions
{
    public static IConfigurationBuilder AddFlowPilotProductionConfiguration(
        this IConfigurationBuilder configuration,
        DeploymentPaths deploymentPaths)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(deploymentPaths);

        configuration
            .AddJsonFile(
                deploymentPaths.ProductionConfigurationFile,
                optional: false,
                reloadOnChange: false)
            .AddJsonFile(
                deploymentPaths.ProductionSecretsFile,
                optional: false,
                reloadOnChange: false)
            // WebApplication's default environment provider was registered before
            // these external files. Registering it again preserves the documented
            // precedence: defaults < Config < Secrets < process environment.
            .AddEnvironmentVariables();

        return configuration;
    }
}
