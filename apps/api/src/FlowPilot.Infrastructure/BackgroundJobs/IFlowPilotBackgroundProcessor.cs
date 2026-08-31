namespace FlowPilot.Infrastructure.BackgroundJobs;

public interface IFlowPilotBackgroundProcessor
{
    Task RunOnceAsync(CancellationToken cancellationToken = default);
}
