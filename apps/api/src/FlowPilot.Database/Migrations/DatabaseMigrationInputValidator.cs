using Microsoft.Data.SqlClient;

namespace FlowPilot.Database.Migrations;

public static class DatabaseMigrationInputValidator
{
    private const int MaximumCollationLength = 128;
    private const int MaximumToolVersionLength = 100;

    public static void Validate(DatabaseMigrationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        _ = CreateConnectionStringBuilder(request.ConnectionString);

        if (string.IsNullOrWhiteSpace(request.ExpectedCollation) ||
            request.ExpectedCollation.Trim().Length > MaximumCollationLength)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.ExpectedCollationMissing);
        }

        if (string.IsNullOrWhiteSpace(request.ToolVersion) ||
            request.ToolVersion.Trim().Length > MaximumToolVersionLength)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.InvalidInput);
        }
    }

    internal static SqlConnectionStringBuilder CreateConnectionStringBuilder(string? connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.InvalidConnectionString);
        }

        SqlConnectionStringBuilder builder;
        try
        {
            builder = new SqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.InvalidConnectionString);
        }

        var databaseName = builder.InitialCatalog.Trim();
        if (databaseName.Length == 0)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseNameMissing);
        }

        if (SqlServerPreflightEvaluator.IsSystemDatabase(databaseName))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.SystemDatabaseNotAllowed);
        }

        return builder;
    }
}
