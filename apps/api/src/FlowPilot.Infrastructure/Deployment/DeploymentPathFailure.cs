namespace FlowPilot.Infrastructure.Deployment;

public enum DeploymentPathFailure
{
    StartPathInvalid,
    StartPathNotAbsolute,
    StartDirectoryNotFound,
    MarkerNotFound,
    MultipleMarkersFound,
    DeploymentRootIsFileSystemRoot,
    ApiOutsideAppDirectory,
    ApiOutsideReleaseDirectory,
}
