namespace FlowPilot.Infrastructure.Deployment;

public interface IDeploymentFileSystem
{
    bool DirectoryExists(string path);

    bool FileExists(string path);

    string? ResolveDirectoryLinkTarget(string path);
}
