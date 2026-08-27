using FlowPilot.Infrastructure.Deployment;

namespace FlowPilot.Api.Configuration;

public static class FlowPilotConfigurationExtensions
{
    public const string DevelopmentLocalFileName = "appsettings.Development.local.json";

    public static IConfigurationBuilder AddFlowPilotDevelopmentConfiguration(
        this IConfigurationBuilder configuration,
        string contentRootPath,
        string[] commandLineArguments)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentException.ThrowIfNullOrWhiteSpace(contentRootPath);
        ArgumentNullException.ThrowIfNull(commandLineArguments);

        var localConfigurationFile = Path.GetFullPath(
            Path.Combine(
                contentRootPath,
                "..",
                "..",
                "config",
                DevelopmentLocalFileName));

        configuration
            .AddJsonFile(
                localConfigurationFile,
                optional: true,
                reloadOnChange: false)
            // WebApplication's default environment and command-line providers were
            // registered before the local file. Register them again so private
            // developer settings cannot override process or launch arguments.
            .AddEnvironmentVariables()
            .AddCommandLine(commandLineArguments);

        return configuration;
    }

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
