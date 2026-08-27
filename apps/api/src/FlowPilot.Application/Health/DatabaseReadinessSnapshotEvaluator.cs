using System.Globalization;

namespace FlowPilot.Application.Health;

public static class DatabaseReadinessSnapshotEvaluator
{
    public const int MinimumCompatibilityLevel = 130;
    private const int SqlServer2016MajorVersion = 13;

    public static DatabaseReadinessResult Evaluate(
        DatabaseReadinessSnapshot snapshot,
        DatabaseReadinessRequirements requirements)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(requirements);

        var requiredSchemaVersion = Normalize(requirements.RequiredSchemaVersion);
        var expectedCollation = Normalize(requirements.ExpectedCollation);
        if (requiredSchemaVersion is null || expectedCollation is null)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.ConfigurationMissing);
        }

        if (!TryReadMajorVersion(snapshot.ProductVersion, out var serverMajorVersion) ||
            !IsSupportedServerVersion(serverMajorVersion, snapshot.ProductLevel))
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.ServerVersionUnsupported);
        }

        if (snapshot.CompatibilityLevel < MinimumCompatibilityLevel)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.CompatibilityLevelUnsupported);
        }

        if (!string.Equals(
                expectedCollation,
                Normalize(snapshot.Collation),
                StringComparison.OrdinalIgnoreCase))
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.CollationMismatch);
        }

        if (!snapshot.FlowPilotSchemaExists)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.SchemaMissing);
        }

        if (!snapshot.SchemaVersionStoreExists)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.SchemaVersionStoreMissing);
        }

        if (!snapshot.SchemaVersionStoreIsValid)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.SchemaVersionStoreInvalid);
        }

        if (!snapshot.SchemaStructureIsValid)
        {
            return DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.SchemaStructureMismatch);
        }

        var appliedSchemaVersion = Normalize(snapshot.AppliedSchemaVersion);
        return appliedSchemaVersion is null
            ? DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.SchemaVersionMissing)
            : string.Equals(requiredSchemaVersion, appliedSchemaVersion, StringComparison.Ordinal)
                ? DatabaseReadinessResult.Ready
                : DatabaseReadinessResult.NotReady(DatabaseReadinessCodes.SchemaVersionMismatch);
    }

    private static bool TryReadMajorVersion(string? productVersion, out int majorVersion)
    {
        majorVersion = default;
        var normalizedVersion = Normalize(productVersion);
        if (normalizedVersion is null)
        {
            return false;
        }

        var separatorIndex = normalizedVersion.IndexOf('.');
        var majorVersionText = separatorIndex < 0
            ? normalizedVersion
            : normalizedVersion[..separatorIndex];

        return int.TryParse(
            majorVersionText,
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out majorVersion);
    }

    private static bool IsSupportedServerVersion(int majorVersion, string? productLevel)
    {
        if (majorVersion > SqlServer2016MajorVersion)
        {
            return true;
        }

        if (majorVersion != SqlServer2016MajorVersion)
        {
            return false;
        }

        var normalizedProductLevel = Normalize(productLevel);
        return string.Equals(normalizedProductLevel, "SP2", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(normalizedProductLevel, "SP3", StringComparison.OrdinalIgnoreCase);
    }

    private static string? Normalize(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
