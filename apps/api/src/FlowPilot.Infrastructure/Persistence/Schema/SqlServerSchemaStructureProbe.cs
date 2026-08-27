using System.Data;
using System.Data.Common;
using FlowPilot.Infrastructure.Configuration;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed class SqlServerSchemaStructureProbe : ISqlServerSchemaStructureProbe
{
    private const string InventoryQuery = """
        SELECT N'table' AS [category], CONVERT(nvarchar(776), t.[name]) AS [object_key]
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0

        UNION ALL

        SELECT N'column', CONVERT(nvarchar(776), t.[name] + N'.' + c.[name])
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.columns AS c ON c.[object_id] = t.[object_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0

        UNION ALL

        SELECT N'constraint', CONVERT(nvarchar(776), t.[name] + N'.' + o.[name])
        FROM sys.objects AS o
        INNER JOIN sys.tables AS t ON t.[object_id] = o.[parent_object_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND o.[is_ms_shipped] = 0
            AND o.[type] IN (N'C', N'D', N'F', N'PK', N'UQ')

        UNION ALL

        SELECT N'index', CONVERT(nvarchar(776), t.[name] + N'.' + i.[name])
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

        SELECT N'trigger', CONVERT(nvarchar(776), t.[name] + N'.' + tr.[name])
        FROM sys.triggers AS tr
        INNER JOIN sys.tables AS t ON t.[object_id] = tr.[parent_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND tr.[parent_class] = 1
            AND tr.[is_ms_shipped] = 0

        UNION ALL

        SELECT N'other', CONVERT(nvarchar(776), o.[type_desc] + N':' + o.[name])
        FROM sys.objects AS o
        INNER JOIN sys.schemas AS s ON s.[schema_id] = o.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND o.[is_ms_shipped] = 0
            AND o.[type] NOT IN (N'U', N'C', N'D', N'F', N'PK', N'UQ', N'TR')
            AND (o.[parent_object_id] = 0 OR o.[type] = N'EC')

        UNION ALL

        SELECT N'other', CONVERT(nvarchar(776), N'TYPE:' + ty.[name])
        FROM sys.types AS ty
        INNER JOIN sys.schemas AS s ON s.[schema_id] = ty.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND ty.[is_user_defined] = 1

        UNION ALL

        SELECT N'other', CONVERT(nvarchar(776), N'XML_SCHEMA_COLLECTION:' + xsc.[name])
        FROM sys.xml_schema_collections AS xsc
        INNER JOIN sys.schemas AS s ON s.[schema_id] = xsc.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2

        UNION ALL

        SELECT N'other', CONVERT(nvarchar(776), N'FULLTEXT_INDEX:' + t.[name])
        FROM sys.fulltext_indexes AS fi
        INNER JOIN sys.tables AS t ON t.[object_id] = fi.[object_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0

        ORDER BY [category], [object_key];

        SELECT
            t.[name],
            c.[name],
            type_schema.[name],
            ty.[name],
            CONVERT(int, c.[max_length]),
            c.[precision],
            c.[scale],
            ty.[is_user_defined],
            c.[is_nullable],
            CASE
                WHEN c.[collation_name] IS NULL THEN NULL
                WHEN c.[collation_name] COLLATE Latin1_General_100_BIN2 =
                    CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), N'Collation'))
                        COLLATE Latin1_General_100_BIN2
                    THEN N'database_default'
                ELSE c.[collation_name]
            END,
            c.[is_computed],
            computed_column.[definition],
            computed_column.[is_persisted],
            c.[is_identity],
            identity_column.[seed_value],
            identity_column.[increment_value],
            c.[is_rowguidcol],
            c.[is_sparse],
            c.[is_ansi_padded]
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.columns AS c ON c.[object_id] = t.[object_id]
        INNER JOIN sys.types AS ty ON ty.[user_type_id] = c.[user_type_id]
        INNER JOIN sys.schemas AS type_schema ON type_schema.[schema_id] = ty.[schema_id]
        LEFT JOIN sys.computed_columns AS computed_column
            ON computed_column.[object_id] = c.[object_id]
            AND computed_column.[column_id] = c.[column_id]
        LEFT JOIN sys.identity_columns AS identity_column
            ON identity_column.[object_id] = c.[object_id]
            AND identity_column.[column_id] = c.[column_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0
        ORDER BY t.[name], c.[column_id];

        SELECT
            t.[name],
            cc.[name],
            cc.[is_disabled],
            cc.[is_not_trusted],
            cc.[is_not_for_replication],
            cc.[definition]
        FROM sys.check_constraints AS cc
        INNER JOIN sys.tables AS t ON t.[object_id] = cc.[parent_object_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND cc.[is_ms_shipped] = 0
        ORDER BY t.[name], cc.[name];

        SELECT
            t.[name],
            fk.[name],
            fk.[is_disabled],
            fk.[is_not_trusted],
            fk.[is_not_for_replication],
            fk.[delete_referential_action_desc],
            fk.[update_referential_action_desc],
            fkc.[constraint_column_id],
            parent_column.[name],
            referenced_schema.[name],
            referenced_table.[name],
            referenced_column.[name]
        FROM sys.foreign_keys AS fk
        INNER JOIN sys.tables AS t ON t.[object_id] = fk.[parent_object_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.foreign_key_columns AS fkc
            ON fkc.[constraint_object_id] = fk.[object_id]
        INNER JOIN sys.columns AS parent_column
            ON parent_column.[object_id] = fk.[parent_object_id]
            AND parent_column.[column_id] = fkc.[parent_column_id]
        INNER JOIN sys.tables AS referenced_table
            ON referenced_table.[object_id] = fk.[referenced_object_id]
        INNER JOIN sys.schemas AS referenced_schema
            ON referenced_schema.[schema_id] = referenced_table.[schema_id]
        INNER JOIN sys.columns AS referenced_column
            ON referenced_column.[object_id] = fk.[referenced_object_id]
            AND referenced_column.[column_id] = fkc.[referenced_column_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND fk.[is_ms_shipped] = 0
        ORDER BY t.[name], fk.[name], fkc.[constraint_column_id];

        SELECT
            t.[name],
            kc.[name],
            kc.[type],
            i.[type_desc],
            i.[is_disabled],
            ic.[key_ordinal],
            c.[name],
            ic.[is_descending_key]
        FROM sys.key_constraints AS kc
        INNER JOIN sys.tables AS t ON t.[object_id] = kc.[parent_object_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.indexes AS i
            ON i.[object_id] = kc.[parent_object_id]
            AND i.[index_id] = kc.[unique_index_id]
        INNER JOIN sys.index_columns AS ic
            ON ic.[object_id] = i.[object_id]
            AND ic.[index_id] = i.[index_id]
            AND ic.[key_ordinal] > 0
        INNER JOIN sys.columns AS c
            ON c.[object_id] = ic.[object_id]
            AND c.[column_id] = ic.[column_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND kc.[is_ms_shipped] = 0
        ORDER BY t.[name], kc.[name], ic.[key_ordinal];

        SELECT
            t.[name],
            i.[name],
            i.[is_unique],
            i.[is_disabled],
            i.[type_desc],
            i.[has_filter],
            i.[filter_definition],
            ic.[key_ordinal],
            ic.[is_included_column],
            ic.[index_column_id],
            c.[name],
            ic.[is_descending_key]
        FROM sys.tables AS t
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.indexes AS i ON i.[object_id] = t.[object_id]
        INNER JOIN sys.index_columns AS ic
            ON ic.[object_id] = i.[object_id]
            AND ic.[index_id] = i.[index_id]
        INNER JOIN sys.columns AS c
            ON c.[object_id] = ic.[object_id]
            AND c.[column_id] = ic.[column_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND t.[is_ms_shipped] = 0
            AND i.[index_id] > 0
            AND i.[name] IS NOT NULL
            AND i.[is_hypothetical] = 0
            AND i.[is_primary_key] = 0
            AND i.[is_unique_constraint] = 0
        ORDER BY t.[name], i.[name], ic.[is_included_column],
            ic.[key_ordinal], ic.[index_column_id];

        SELECT
            t.[name],
            tr.[name],
            tr.[is_disabled],
            tr.[is_instead_of_trigger],
            tr.[is_not_for_replication],
            te.[type_desc],
            sm.[definition],
            sm.[uses_ansi_nulls],
            sm.[uses_quoted_identifier]
        FROM sys.triggers AS tr
        INNER JOIN sys.tables AS t ON t.[object_id] = tr.[parent_id]
        INNER JOIN sys.schemas AS s ON s.[schema_id] = t.[schema_id]
        INNER JOIN sys.trigger_events AS te ON te.[object_id] = tr.[object_id]
        LEFT JOIN sys.sql_modules AS sm ON sm.[object_id] = tr.[object_id]
        WHERE s.[name] COLLATE Latin1_General_100_BIN2 =
                @schema_name COLLATE Latin1_General_100_BIN2
            AND tr.[parent_class] = 1
            AND tr.[is_ms_shipped] = 0
        ORDER BY t.[name], tr.[name], te.[type_desc];
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
        var otherObjects = new HashSet<string>(StringComparer.Ordinal);
        var columnSignatures = new HashSet<string>(StringComparer.Ordinal);
        var checkConstraintSignatures = new HashSet<string>(StringComparer.Ordinal);
        var foreignKeyRows = new List<ForeignKeyRow>();
        var keyConstraintRows = new List<KeyConstraintRow>();
        var indexRows = new List<IndexRow>();
        var triggerRows = new List<TriggerRow>();

        await using var reader = await command
            .ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken)
            .ConfigureAwait(false);
        await ReadObjectInventoryAsync(
                reader,
                tables,
                columns,
                constraints,
                indexes,
                triggers,
                otherObjects,
                cancellationToken)
            .ConfigureAwait(false);
        await MoveToNextResultAsync(reader, cancellationToken).ConfigureAwait(false);
        await ReadColumnsAsync(reader, columnSignatures, cancellationToken).ConfigureAwait(false);
        await MoveToNextResultAsync(reader, cancellationToken).ConfigureAwait(false);
        await ReadChecksAsync(reader, checkConstraintSignatures, cancellationToken)
            .ConfigureAwait(false);
        await MoveToNextResultAsync(reader, cancellationToken).ConfigureAwait(false);
        await ReadForeignKeysAsync(reader, foreignKeyRows, cancellationToken).ConfigureAwait(false);
        await MoveToNextResultAsync(reader, cancellationToken).ConfigureAwait(false);
        await ReadKeyConstraintsAsync(reader, keyConstraintRows, cancellationToken)
            .ConfigureAwait(false);
        await MoveToNextResultAsync(reader, cancellationToken).ConfigureAwait(false);
        await ReadIndexesAsync(reader, indexRows, cancellationToken).ConfigureAwait(false);
        await MoveToNextResultAsync(reader, cancellationToken).ConfigureAwait(false);
        await ReadTriggersAsync(reader, triggerRows, cancellationToken).ConfigureAwait(false);

        var foreignKeySignatures = foreignKeyRows
            .GroupBy(row => new
            {
                row.Table,
                row.Name,
                row.IsDisabled,
                row.IsTrusted,
                row.IsNotForReplication,
                row.DeleteAction,
                row.UpdateAction,
            })
            .Select(group => SqlServerSchemaSignatures.ForeignKey(
                group.Key.Table,
                group.Key.Name,
                group.Key.IsDisabled,
                group.Key.IsTrusted,
                group.Key.IsNotForReplication,
                group.Key.DeleteAction,
                group.Key.UpdateAction,
                group
                    .OrderBy(row => row.Ordinal)
                    .Select(row => row.Column)))
            .ToHashSet(StringComparer.Ordinal);
        var keyConstraintSignatures = keyConstraintRows
            .GroupBy(row => new
            {
                row.Table,
                row.Name,
                row.Kind,
                row.IndexType,
                row.IsDisabled,
            })
            .Select(group => SqlServerSchemaSignatures.KeyConstraint(
                group.Key.Table,
                group.Key.Name,
                group.Key.Kind,
                group.Key.IndexType,
                group.Key.IsDisabled,
                group
                    .OrderBy(row => row.Ordinal)
                    .Select(row => row.Column)))
            .ToHashSet(StringComparer.Ordinal);
        var indexSignatures = indexRows
            .GroupBy(row => new
            {
                row.Table,
                row.Name,
                row.IsUnique,
                row.IsDisabled,
                row.IndexType,
                row.HasFilter,
                row.FilterDefinition,
            })
            .Select(group => SqlServerSchemaSignatures.Index(
                group.Key.Table,
                group.Key.Name,
                group.Key.IsUnique,
                group.Key.IsDisabled,
                group.Key.IndexType,
                group
                    .Where(row => row.KeyOrdinal > 0)
                    .OrderBy(row => row.KeyOrdinal)
                    .Select(row => new SqlServerIndexKeyColumn(
                        row.Column,
                        row.IsDescending)),
                group
                    .Where(row => row.IsIncluded)
                    .OrderBy(row => row.IndexColumnId)
                    .Select(row => row.Column),
                group.Key.HasFilter,
                group.Key.FilterDefinition))
            .ToHashSet(StringComparer.Ordinal);
        var triggerSignatures = triggerRows
            .GroupBy(row => new
            {
                row.Table,
                row.Name,
                row.IsDisabled,
                row.IsInsteadOf,
                row.IsNotForReplication,
                row.UsesAnsiNulls,
                row.UsesQuotedIdentifier,
                row.Definition,
            })
            .Select(group => SqlServerSchemaSignatures.Trigger(
                group.Key.Table,
                group.Key.Name,
                group.Key.IsDisabled,
                group.Key.IsInsteadOf,
                group.Key.IsNotForReplication,
                group.Key.UsesAnsiNulls,
                group.Key.UsesQuotedIdentifier,
                group.Select(row => row.Event),
                group.Key.Definition))
            .ToHashSet(StringComparer.Ordinal);

        return new SqlServerSchemaSnapshot(
            tables,
            columns,
            constraints,
            indexes,
            triggers,
            otherObjects,
            columnSignatures,
            checkConstraintSignatures,
            foreignKeySignatures,
            keyConstraintSignatures,
            indexSignatures,
            triggerSignatures);
    }

    private static async Task ReadObjectInventoryAsync(
        DbDataReader reader,
        ISet<string> tables,
        ISet<string> columns,
        ISet<string> constraints,
        ISet<string> indexes,
        ISet<string> triggers,
        ISet<string> otherObjects,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (reader.IsDBNull(0) || reader.IsDBNull(1))
            {
                throw new InvalidOperationException("The SQL Server schema probe returned an invalid row.");
            }

            var destination = reader.GetString(0) switch
            {
                "table" => tables,
                "column" => columns,
                "constraint" => constraints,
                "index" => indexes,
                "trigger" => triggers,
                "other" => otherObjects,
                _ => throw new InvalidOperationException(
                    "The SQL Server schema probe returned an unknown category."),
            };
            _ = destination.Add(reader.GetString(1));
        }
    }

    private static async Task ReadColumnsAsync(
        DbDataReader reader,
        HashSet<string> signatures,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            _ = signatures.Add(SqlServerSchemaSignatures.Column(
                ReadRequiredString(reader, 0),
                ReadRequiredString(reader, 1),
                ReadRequiredString(reader, 2),
                ReadRequiredString(reader, 3),
                reader.GetInt32(4),
                reader.GetByte(5),
                reader.GetByte(6),
                reader.GetBoolean(7),
                reader.GetBoolean(8),
                ReadNullableString(reader, 9),
                reader.GetBoolean(10),
                ReadNullableString(reader, 11),
                ReadNullableBooleanValue(reader, 12),
                reader.GetBoolean(13),
                ReadNullableInvariantValue(reader, 14),
                ReadNullableInvariantValue(reader, 15),
                reader.GetBoolean(16),
                reader.GetBoolean(17),
                reader.GetBoolean(18)));
        }
    }

    private static async Task ReadChecksAsync(
        DbDataReader reader,
        HashSet<string> signatures,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            _ = signatures.Add(SqlServerSchemaSignatures.CheckConstraint(
                ReadRequiredString(reader, 0),
                ReadRequiredString(reader, 1),
                reader.GetBoolean(2),
                !reader.GetBoolean(3),
                reader.GetBoolean(4),
                ReadNullableString(reader, 5)));
        }
    }

    private static async Task ReadForeignKeysAsync(
        DbDataReader reader,
        ICollection<ForeignKeyRow> rows,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new ForeignKeyRow(
                ReadRequiredString(reader, 0),
                ReadRequiredString(reader, 1),
                reader.GetBoolean(2),
                !reader.GetBoolean(3),
                reader.GetBoolean(4),
                ReadRequiredString(reader, 5),
                ReadRequiredString(reader, 6),
                reader.GetInt32(7),
                new SqlServerForeignKeyColumn(
                    ReadRequiredString(reader, 8),
                    ReadRequiredString(reader, 9),
                    ReadRequiredString(reader, 10),
                    ReadRequiredString(reader, 11))));
        }
    }

    private static async Task ReadKeyConstraintsAsync(
        DbDataReader reader,
        ICollection<KeyConstraintRow> rows,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new KeyConstraintRow(
                ReadRequiredString(reader, 0),
                ReadRequiredString(reader, 1),
                ReadRequiredString(reader, 2),
                ReadRequiredString(reader, 3),
                reader.GetBoolean(4),
                reader.GetByte(5),
                new SqlServerIndexKeyColumn(
                    ReadRequiredString(reader, 6),
                    reader.GetBoolean(7))));
        }
    }

    private static async Task ReadIndexesAsync(
        DbDataReader reader,
        ICollection<IndexRow> rows,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new IndexRow(
                ReadRequiredString(reader, 0),
                ReadRequiredString(reader, 1),
                reader.GetBoolean(2),
                reader.GetBoolean(3),
                ReadRequiredString(reader, 4),
                reader.GetBoolean(5),
                ReadNullableString(reader, 6),
                reader.GetByte(7),
                reader.GetBoolean(8),
                reader.GetInt32(9),
                ReadRequiredString(reader, 10),
                reader.GetBoolean(11)));
        }
    }

    private static async Task ReadTriggersAsync(
        DbDataReader reader,
        ICollection<TriggerRow> rows,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new TriggerRow(
                ReadRequiredString(reader, 0),
                ReadRequiredString(reader, 1),
                reader.GetBoolean(2),
                reader.GetBoolean(3),
                reader.GetBoolean(4),
                ReadRequiredString(reader, 5),
                ReadNullableString(reader, 6),
                ReadNullableBoolean(reader, 7),
                ReadNullableBoolean(reader, 8)));
        }
    }

    private static async Task MoveToNextResultAsync(
        DbDataReader reader,
        CancellationToken cancellationToken)
    {
        if (!await reader.NextResultAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The SQL Server schema probe returned an incomplete result.");
        }
    }

    private static string ReadRequiredString(DbDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
        {
            throw new InvalidOperationException("The SQL Server schema probe returned an invalid row.");
        }

        return reader.GetString(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static bool ReadNullableBoolean(DbDataReader reader, int ordinal) =>
        !reader.IsDBNull(ordinal) && reader.GetBoolean(ordinal);

    private static bool? ReadNullableBooleanValue(DbDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetBoolean(ordinal);

    private static string? ReadNullableInvariantValue(DbDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
        {
            return null;
        }

        var value = reader.GetValue(ordinal);
        return value is IFormattable formattable
            ? formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture)
            : value.ToString();
    }

    private sealed record ForeignKeyRow(
        string Table,
        string Name,
        bool IsDisabled,
        bool IsTrusted,
        bool IsNotForReplication,
        string DeleteAction,
        string UpdateAction,
        int Ordinal,
        SqlServerForeignKeyColumn Column);

    private sealed record KeyConstraintRow(
        string Table,
        string Name,
        string Kind,
        string IndexType,
        bool IsDisabled,
        byte Ordinal,
        SqlServerIndexKeyColumn Column);

    private sealed record IndexRow(
        string Table,
        string Name,
        bool IsUnique,
        bool IsDisabled,
        string IndexType,
        bool HasFilter,
        string? FilterDefinition,
        byte KeyOrdinal,
        bool IsIncluded,
        int IndexColumnId,
        string Column,
        bool IsDescending);

    private sealed record TriggerRow(
        string Table,
        string Name,
        bool IsDisabled,
        bool IsInsteadOf,
        bool IsNotForReplication,
        string Event,
        string? Definition,
        bool UsesAnsiNulls,
        bool UsesQuotedIdentifier);
}
