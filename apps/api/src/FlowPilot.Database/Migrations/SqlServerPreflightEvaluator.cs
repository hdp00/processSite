using System.Globalization;

namespace FlowPilot.Database.Migrations;

public static class SqlServerPreflightEvaluator
{
    public const int MinimumCompatibilityLevel = 130;
    private const int SqlServer2016MajorVersion = 13;

    public static void Validate(
        SqlServerPreflightSnapshot snapshot,
        string expectedCollation,
        string configuredDatabaseName)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        var databaseName = Normalize(snapshot.DatabaseName);
        if (databaseName is null || IsSystemDatabase(databaseName))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.SystemDatabaseNotAllowed);
        }

        if (!string.Equals(
                databaseName,
                Normalize(configuredDatabaseName),
                StringComparison.OrdinalIgnoreCase))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseNameMismatch);
        }

        if (!TryReadMajorVersion(snapshot.ProductVersion, out var majorVersion) ||
            !IsSupportedServerVersion(majorVersion, snapshot.ProductLevel))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.ServerVersionUnsupported);
        }

        if (snapshot.CompatibilityLevel < MinimumCompatibilityLevel)
        {
            throw new DatabaseMigrationException(
                DatabaseMigrationFailure.CompatibilityLevelUnsupported);
        }

        if (!string.Equals(
                Normalize(expectedCollation),
                Normalize(snapshot.Collation),
                StringComparison.OrdinalIgnoreCase))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.CollationMismatch);
        }
    }

    internal static bool IsSystemDatabase(string databaseName) =>
        string.Equals(databaseName, "master", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(databaseName, "model", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(databaseName, "msdb", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(databaseName, "tempdb", StringComparison.OrdinalIgnoreCase);

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

        var normalizedProductLevel = Normalize(productLevel);
        return majorVersion == SqlServer2016MajorVersion &&
            (string.Equals(normalizedProductLevel, "SP2", StringComparison.OrdinalIgnoreCase) ||
             string.Equals(normalizedProductLevel, "SP3", StringComparison.OrdinalIgnoreCase));
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
