namespace FlowPilot.Infrastructure.BackgroundJobs;

public sealed class BackgroundJobHealthState
{
    private readonly object _sync = new();
    private DateTimeOffset? _lastSucceededAt;
    private DateTimeOffset? _lastFailedAt;

    public void RecordSuccess(DateTimeOffset occurredAt)
    {
        lock (_sync) _lastSucceededAt = occurredAt;
    }

    public void RecordFailure(DateTimeOffset occurredAt)
    {
        lock (_sync) _lastFailedAt = occurredAt;
    }

    public BackgroundJobHealthSnapshot Read()
    {
        lock (_sync) return new(_lastSucceededAt, _lastFailedAt);
    }
}

public sealed record BackgroundJobHealthSnapshot(
    DateTimeOffset? LastSucceededAt,
    DateTimeOffset? LastFailedAt)
{
    public bool HasCurrentFailure => LastFailedAt.HasValue
        && (!LastSucceededAt.HasValue || LastFailedAt > LastSucceededAt);
}
