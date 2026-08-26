namespace FlowPilot.Infrastructure.Deployment;

public sealed class DeploymentPaths
{
    internal DeploymentPaths(string deploymentRootDirectory, string apiBaseDirectory)
    {
        DeploymentRootDirectory = deploymentRootDirectory;
        ApiBaseDirectory = apiBaseDirectory;
        AppDirectory = Path.Combine(deploymentRootDirectory, "App");
        ReleasesDirectory = Path.Combine(AppDirectory, "releases");
        ConfigDirectory = Path.Combine(deploymentRootDirectory, "Config");
        SecretsDirectory = Path.Combine(deploymentRootDirectory, "Secrets");
        DataDirectory = Path.Combine(deploymentRootDirectory, "Data");
        LogsDirectory = Path.Combine(deploymentRootDirectory, "Logs");
        TempDirectory = Path.Combine(deploymentRootDirectory, "Temp");
        BackupDirectory = Path.Combine(deploymentRootDirectory, "Backup");
        AttachmentsDirectory = Path.Combine(DataDirectory, "Attachments");
        ProductionConfigurationFile = Path.Combine(ConfigDirectory, "appsettings.Production.json");
        ProductionSecretsFile = Path.Combine(SecretsDirectory, "secrets.Production.json");
    }

    public string DeploymentRootDirectory { get; }

    public string ApiBaseDirectory { get; }

    public string AppDirectory { get; }

    public string ReleasesDirectory { get; }

    public string ConfigDirectory { get; }

    public string SecretsDirectory { get; }

    public string DataDirectory { get; }

    public string AttachmentsDirectory { get; }

    public string LogsDirectory { get; }

    public string TempDirectory { get; }

    public string BackupDirectory { get; }

    public string ProductionConfigurationFile { get; }

    public string ProductionSecretsFile { get; }
}
