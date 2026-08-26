namespace FlowPilot.Infrastructure.Deployment;

public sealed class DeploymentPathException : InvalidOperationException
{
    public DeploymentPathException(DeploymentPathFailure failure, string message)
        : base(message)
    {
        Failure = failure;
    }

    public DeploymentPathFailure Failure { get; }
}
