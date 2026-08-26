using System.Data;
using System.Data.Common;
using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Health;

public sealed class SqlServerReadinessSnapshotReader(FlowPilotDbContext dbContext)
    : ISqlServerReadinessSnapshotReader
{
    private const int CommandTimeoutSeconds = 5;

    private const string MetadataQuery = """
        SELECT
            CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')),
            CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductLevel')),
            CONVERT(int, [compatibility_level]),
            CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), N'Collation')),
            CASE WHEN SCHEMA_ID(N'flowpilot') IS NULL THEN CONVERT(bit, 0) ELSE CONVERT(bit, 1) END,
            CASE WHEN OBJECT_ID(N'flowpilot.schema_migrations', N'U') IS NULL
                THEN CONVERT(bit, 0) ELSE CONVERT(bit, 1) END,
            CASE WHEN OBJECT_ID(N'flowpilot.schema_migrations', N'U') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'migration_id') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'completed_at') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'result') IS NOT NULL
                THEN CONVERT(bit, 1) ELSE CONVERT(bit, 0) END
        FROM sys.databases
        WHERE [name] = DB_NAME();
        """;

    private const string SchemaVersionQuery = """
        SELECT TOP (1) CONVERT(nvarchar(450), [migration_id])
        FROM [flowpilot].[schema_migrations]
        WHERE [completed_at] IS NOT NULL
            AND [result] = N'succeeded'
        ORDER BY [completed_at] DESC, [migration_id] DESC;
        """;

    private readonly FlowPilotDbContext _dbContext = dbContext;

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_dbContext.Database.GetConnectionString());

    public async Task<DatabaseReadinessSnapshot> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        var connection = _dbContext.Database.GetDbConnection();
        var shouldCloseConnection = connection.State != ConnectionState.Open;

        if (shouldCloseConnection)
        {
            await _dbContext.Database.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        }

        try
        {
            var metadata = await ReadMetadataAsync(connection, cancellationToken).ConfigureAwait(false);
            string? appliedSchemaVersion = null;

            if (metadata.SchemaVersionStoreExists && metadata.SchemaVersionStoreIsValid)
            {
                appliedSchemaVersion = await ReadAppliedSchemaVersionAsync(connection, cancellationToken)
                    .ConfigureAwait(false);
            }

            return new DatabaseReadinessSnapshot(
                metadata.ProductVersion,
                metadata.ProductLevel,
                metadata.CompatibilityLevel,
                metadata.Collation,
                metadata.FlowPilotSchemaExists,
                metadata.SchemaVersionStoreExists,
                metadata.SchemaVersionStoreIsValid,
                appliedSchemaVersion);
        }
        finally
        {
            if (shouldCloseConnection)
            {
                await _dbContext.Database.CloseConnectionAsync().ConfigureAwait(false);
            }
        }
    }

    private static async Task<SqlServerMetadata> ReadMetadataAsync(
        DbConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = MetadataQuery;
        command.CommandTimeout = CommandTimeoutSeconds;

        await using var reader = await command
            .ExecuteReaderAsync(CommandBehavior.SingleRow, cancellationToken)
            .ConfigureAwait(false);

        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The SQL Server metadata probe returned no row.");
        }

        return new SqlServerMetadata(
            ReadNullableString(reader, 0),
            ReadNullableString(reader, 1),
            reader.GetInt32(2),
            ReadNullableString(reader, 3),
            reader.GetBoolean(4),
            reader.GetBoolean(5),
            reader.GetBoolean(6));
    }

    private static async Task<string?> ReadAppliedSchemaVersionAsync(
        DbConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = SchemaVersionQuery;
        command.CommandTimeout = CommandTimeoutSeconds;

        var value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        return value is null or DBNull ? null : Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string? ReadNullableString(DbDataReader reader, int ordinal)
    {
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private sealed record SqlServerMetadata(
        string? ProductVersion,
        string? ProductLevel,
        int CompatibilityLevel,
        string? Collation,
        bool FlowPilotSchemaExists,
        bool SchemaVersionStoreExists,
        bool SchemaVersionStoreIsValid);
}
