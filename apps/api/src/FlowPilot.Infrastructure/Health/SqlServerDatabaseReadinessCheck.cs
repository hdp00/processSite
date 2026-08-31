using System.Data.Common;
using FlowPilot.Application.Health;

namespace FlowPilot.Infrastructure.Health;

public sealed class SqlServerDatabaseReadinessCheck(
    ISqlServerReadinessSnapshotReader snapshotReader,
    DatabaseReadinessRequirements requirements) : IDatabaseReadinessCheck
{
    private readonly ISqlServerReadinessSnapshotReader _snapshotReader = snapshotReader;
    private readonly DatabaseReadinessRequirements _requirements = requirements;

    public async Task<DatabaseReadinessResult> CheckAsync(
        CancellationToken cancellationToken = default)
    {
        if (!_snapshotReader.IsConfigured)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.ConfigurationMissing);
        }

        try
        {
            var snapshot = await _snapshotReader.ReadAsync(cancellationToken).ConfigureAwait(false);
            return DatabaseReadinessSnapshotEvaluator.Evaluate(snapshot, _requirements);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (DbException)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.Unavailable);
        }
        catch (TimeoutException)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.Unavailable);
        }
        catch (InvalidOperationException)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.Unavailable);
        }
    }
}
