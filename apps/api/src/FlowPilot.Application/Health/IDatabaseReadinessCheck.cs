namespace FlowPilot.Application.Health;

public interface IDatabaseReadinessCheck
{
    Task<DatabaseReadinessResult> CheckAsync(CancellationToken cancellationToken = default);
}
