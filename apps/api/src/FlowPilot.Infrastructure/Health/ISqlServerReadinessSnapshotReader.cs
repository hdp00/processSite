using FlowPilot.Application.Health;

namespace FlowPilot.Infrastructure.Health;

public interface ISqlServerReadinessSnapshotReader
{
    bool IsConfigured { get; }

    Task<DatabaseReadinessSnapshot> ReadAsync(CancellationToken cancellationToken = default);
}
