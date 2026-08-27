using System.Data.Common;
using FlowPilot.Application.Health;

namespace FlowPilot.Infrastructure.Health;

public sealed class ApplicationDatabaseReadinessCheck(
    SqlServerDatabaseReadinessCheck structuralReadinessCheck,
    IBuiltinSeedVersionReader builtinSeedVersionReader,
    BuiltinSeedReadinessRequirements requirements) : IDatabaseReadinessCheck
{
    private readonly SqlServerDatabaseReadinessCheck _structuralReadinessCheck =
        structuralReadinessCheck;
    private readonly IBuiltinSeedVersionReader _builtinSeedVersionReader =
        builtinSeedVersionReader;
    private readonly BuiltinSeedReadinessRequirements _requirements = requirements;

    public async Task<DatabaseReadinessResult> CheckAsync(
        CancellationToken cancellationToken = default)
    {
        var requiredVersion = Normalize(_requirements.RequiredBuiltinSeedVersion);
        if (requiredVersion is null)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.ConfigurationMissing);
        }

        var structuralResult = await _structuralReadinessCheck
            .CheckAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!structuralResult.IsReady)
        {
            return structuralResult;
        }

        try
        {
            var appliedVersion = Normalize(
                await _builtinSeedVersionReader.ReadAsync(cancellationToken).ConfigureAwait(false));
            if (appliedVersion is null)
            {
                return DatabaseReadinessResult.NotReady(
                    DatabaseReadinessCodes.BuiltinSeedVersionMissing);
            }

            return string.Equals(requiredVersion, appliedVersion, StringComparison.Ordinal)
                ? DatabaseReadinessResult.Ready
                : DatabaseReadinessResult.NotReady(
                    DatabaseReadinessCodes.BuiltinSeedVersionMismatch);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is DbException or TimeoutException or InvalidOperationException)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.Unavailable);
        }
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
