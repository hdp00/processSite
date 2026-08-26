namespace FlowPilot.Infrastructure.Deployment;

internal sealed class PhysicalDeploymentFileSystem : IDeploymentFileSystem
{
    public static PhysicalDeploymentFileSystem Instance { get; } = new();

    private PhysicalDeploymentFileSystem()
    {
    }

    public bool DirectoryExists(string path) => Directory.Exists(path);

    public bool FileExists(string path) => File.Exists(path);

    public string? ResolveDirectoryLinkTarget(string path) =>
        new DirectoryInfo(path).ResolveLinkTarget(returnFinalTarget: true)?.FullName;
}
