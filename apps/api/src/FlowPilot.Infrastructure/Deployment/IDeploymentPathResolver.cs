namespace FlowPilot.Infrastructure.Deployment;

public interface IDeploymentPathResolver
{
    DeploymentPaths Resolve();

    DeploymentPaths Resolve(string startDirectory);
}
