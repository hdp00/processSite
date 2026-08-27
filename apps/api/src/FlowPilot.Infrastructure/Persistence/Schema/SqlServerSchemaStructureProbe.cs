using System.Data;
using System.Data.Common;
using FlowPilot.Infrastructure.Configuration;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed class SqlServerSchemaStructureProbe : ISqlServerSchemaStructureProbe
{
    private const string InventoryQuery = """
        SELECT
            N'table' COLLATE Latin1_General_100_BIN2 AS [category],
            CONVERT(nvarchar(776), t.[name]) COLLATE Latin1_General_100_BIN2 AS [object_key]
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0

        UNION ALL

        SELECT
            N'column' COLLATE Latin1_General_100_BIN2,
            CONVERT(nvarchar(776), t.[name] + N'.' + c.[name]) COLLATE Latin1_General_100_BIN2
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.columns AS c ON c.[object_id] = t.[object_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0

        UNION ALL

        SELECT
            N'constraint' COLLATE Latin1_General_100_BIN2,
            CONVERT(nvarchar(776), t.[name] + N'.' + o.[name]) COLLATE Latin1_General_100_BIN2
        FROM sys.objects AS o
        INNER JOIN sys.tables AS t ON t.[object_id] = o.[parent_object_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND o.[is_ms_shipped] = 0
            AND o.[type] IN (N'C', N'D', N'F', N'PK', N'UQ')

        UNION ALL

        SELECT
            N'index' COLLATE Latin1_General_100_BIN2,
            CONVERT(nvarchar(776), t.[name] + N'.' + i.[name]) COLLATE Latin1_General_100_BIN2
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.indexes AS i ON i.[object_id] = t.[object_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0
            AND i.[index_id] > 0
            AND i.[name] IS NOT NULL
            AND i.[is_hypothetical] = 0
            AND i.[is_primary_key] = 0
            AND i.[is_unique_constraint] = 0

        UNION ALL

        SELECT
            N'trigger' COLLATE Latin1_General_100_BIN2,
            CONVERT(nvarchar(776), t.[name] + N'.' + tr.[name]) COLLATE Latin1_General_100_BIN2
        FROM sys.triggers AS tr
        INNER JOIN sys.tables AS t ON t.[object_id] = tr.[parent_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND tr.[parent_class] = 1
            AND tr.[is_ms_shipped] = 0

        ORDER BY [category], [object_key];
        """;

    private readonly FlowPilotSchemaManifest _manifest;
    private readonly FlowPilotDatabaseOptions _databaseOptions;

    public SqlServerSchemaStructureProbe()
        : this(FlowPilotSchemaManifest.Current, FlowPilotDatabaseOptions.Default)
    {
    }

    public SqlServerSchemaStructureProbe(FlowPilotSchemaManifest manifest)
        : this(manifest, FlowPilotDatabaseOptions.Default)
    {
    }

    public SqlServerSchemaStructureProbe(FlowPilotDatabaseOptions databaseOptions)
        : this(FlowPilotSchemaManifest.Current, databaseOptions)
    {
    }

    public SqlServerSchemaStructureProbe(
        FlowPilotSchemaManifest manifest,
        FlowPilotDatabaseOptions databaseOptions)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(databaseOptions);
        _manifest = manifest;
        _databaseOptions = databaseOptions;
    }

    public async Task<SqlServerSchemaValidationResult> ValidateAsync(
        DbConnection connection,
        DbTransaction? transaction = null,
        CancellationToken cancellationToken = default)
    {
        var snapshot = await ReadAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
        return SqlServerSchemaManifestEvaluator.Evaluate(_manifest, snapshot);
    }

    public async Task<SqlServerSchemaSnapshot> ReadAsync(
        DbConnection connection,
        DbTransaction? transaction = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(connection);

        await using var command = connection.CreateCommand();
        command.CommandText = InventoryQuery;
        command.CommandTimeout = _databaseOptions.SchemaProbeCommandTimeoutSeconds;
        command.Transaction = transaction;

        var schemaParameter = command.CreateParameter();
        schemaParameter.ParameterName = "@schema_name";
        schemaParameter.DbType = DbType.String;
        schemaParameter.Size = 128;
        schemaParameter.Value = _manifest.SchemaName;
        _ = command.Parameters.Add(schemaParameter);

        var tables = new HashSet<string>(StringComparer.Ordinal);
        var columns = new HashSet<string>(StringComparer.Ordinal);
        var constraints = new HashSet<string>(StringComparer.Ordinal);
        var indexes = new HashSet<string>(StringComparer.Ordinal);
        var triggers = new HashSet<string>(StringComparer.Ordinal);

        await using var reader = await command
            .ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken)
            .ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var category = ReadRequiredString(reader, 0);
            var objectKey = ReadRequiredString(reader, 1);
            var destination = category switch
            {
                "table" => tables,
                "column" => columns,
                "constraint" => constraints,
                "index" => indexes,
                "trigger" => triggers,
                _ => throw new InvalidOperationException(
                    "The SQL Server schema probe returned an unknown category."),
            };
            _ = destination.Add(objectKey);
        }

        return new SqlServerSchemaSnapshot(tables, columns, constraints, indexes, triggers);
    }

    private static string ReadRequiredString(DbDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
        {
            throw new InvalidOperationException("The SQL Server schema probe returned an invalid row.");
        }

        return reader.GetString(ordinal);
    }
}
