using FlowPilot.Infrastructure.BackgroundJobs;

namespace FlowPilot.Api.BackgroundJobs;

public sealed class FlowPilotBackgroundWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    BackgroundJobHealthState healthState,
    TimeProvider timeProvider,
    ILogger<FlowPilotBackgroundWorker> logger) : BackgroundService
{
    private static readonly Action<ILogger, Exception?> LogFailure =
        LoggerMessage.Define(
            LogLevel.Error,
            new EventId(3001, "BackgroundJobFailure"),
            "FlowPilot background job cycle failed.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var intervalSeconds = Math.Clamp(
            configuration.GetValue("FlowPilot:BackgroundJobs:IntervalSeconds", 15),
            5,
            3600);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(intervalSeconds));
        do
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                foreach (var processor in scope.ServiceProvider.GetServices<IFlowPilotBackgroundProcessor>())
                {
                    await processor.RunOnceAsync(stoppingToken).ConfigureAwait(false);
                }
                healthState.RecordSuccess(timeProvider.GetUtcNow());
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                healthState.RecordFailure(timeProvider.GetUtcNow());
                LogFailure(logger, exception);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false));
    }
}
