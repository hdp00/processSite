using System.Data;
using System.Globalization;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Persistence.Schema;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Database.Migrations;

public sealed class SqlServerDatabaseMigrator : IDatabaseMigrator
{
    private const string MigrationLockResource = "FlowPilot.Database.SchemaMigration";

    private const string PreflightQuery = """
        SELECT
            CONVERT(nvarchar(128), DB_NAME()),
            CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')),
            CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductLevel')),
            CONVERT(int, [compatibility_level]),
            CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), N'Collation'))
        FROM sys.databases
        WHERE [name] = DB_NAME();
        """;

    private const string MigrationStateQuery = """
        SELECT
            CASE WHEN EXISTS
            (
                SELECT 1
                FROM sys.objects
                WHERE [is_ms_shipped] = 0
            ) OR EXISTS
            (
                SELECT 1
                FROM sys.types
                WHERE [is_user_defined] = 1
            ) OR EXISTS
            (
                SELECT 1
                FROM sys.xml_schema_collections AS xsc
                INNER JOIN sys.schemas AS s ON s.[schema_id] = xsc.[schema_id]
                WHERE s.[name] NOT IN (N'sys', N'INFORMATION_SCHEMA')
            ) THEN CONVERT(bit, 1) ELSE CONVERT(bit, 0) END,
            CASE WHEN SCHEMA_ID(N'flowpilot') IS NULL
                THEN CONVERT(bit, 0) ELSE CONVERT(bit, 1) END,
            CASE WHEN OBJECT_ID(N'flowpilot.schema_migrations', N'U') IS NULL
                THEN CONVERT(bit, 0) ELSE CONVERT(bit, 1) END,
            CASE WHEN OBJECT_ID(N'flowpilot.schema_migrations', N'U') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'migration_id') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'name') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'checksum') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'started_at') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'completed_at') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'tool_version') IS NOT NULL
                    AND COL_LENGTH(N'flowpilot.schema_migrations', N'result') IS NOT NULL
                THEN CONVERT(bit, 1) ELSE CONVERT(bit, 0) END;
        """;

    private const string MigrationLedgerQuery = """
        SELECT
            CONVERT(nvarchar(100), [migration_id]),
            CONVERT(nvarchar(200), [name]),
            CONVERT(varchar(64), [checksum]),
            CONVERT(nvarchar(20), [result])
        FROM [flowpilot].[schema_migrations]
        ORDER BY [migration_id];
        """;

    private const string AcquireMigrationLockQuery = """
        DECLARE @lock_result int;
        EXEC @lock_result = sys.sp_getapplock
            @Resource = @resource,
            @LockMode = 'Exclusive',
            @LockOwner = 'Transaction',
            @LockTimeout = 0,
            @DbPrincipal = 'public';
        SELECT @lock_result;
        """;

    private const string InsertLedgerQuery = """
        INSERT INTO [flowpilot].[schema_migrations]
        (
            [migration_id],
            [name],
            [checksum],
            [started_at],
            [completed_at],
            [tool_version],
            [result]
        )
        VALUES
        (
            @migration_id,
            @name,
            @checksum,
            @started_at,
            @completed_at,
            @tool_version,
            N'succeeded'
        );
        """;

    private readonly IReadOnlyList<SchemaMigration> _catalog;
    private readonly TimeProvider _timeProvider;
    private readonly ISqlServerSchemaStructureProbe _schemaStructureProbe;
    private readonly FlowPilotDatabaseOptions _databaseOptions;

    public SqlServerDatabaseMigrator()
        : this(
            MigrationCatalog.Migrations,
            TimeProvider.System,
            new SqlServerSchemaStructureProbe(FlowPilotDatabaseOptions.Default),
            FlowPilotDatabaseOptions.Default)
    {
    }

    public SqlServerDatabaseMigrator(FlowPilotDatabaseOptions databaseOptions)
        : this(
            MigrationCatalog.Migrations,
            TimeProvider.System,
            new SqlServerSchemaStructureProbe(databaseOptions),
            databaseOptions)
    {
    }

    public SqlServerDatabaseMigrator(
        IReadOnlyList<SchemaMigration> catalog,
        TimeProvider timeProvider)
        : this(
            catalog,
            timeProvider,
            new SqlServerSchemaStructureProbe(FlowPilotDatabaseOptions.Default),
            FlowPilotDatabaseOptions.Default)
    {
    }

    public SqlServerDatabaseMigrator(
        IReadOnlyList<SchemaMigration> catalog,
        TimeProvider timeProvider,
        ISqlServerSchemaStructureProbe schemaStructureProbe)
        : this(catalog, timeProvider, schemaStructureProbe, FlowPilotDatabaseOptions.Default)
    {
    }

    public SqlServerDatabaseMigrator(
        IReadOnlyList<SchemaMigration> catalog,
        TimeProvider timeProvider,
        ISqlServerSchemaStructureProbe schemaStructureProbe,
        FlowPilotDatabaseOptions databaseOptions)
    {
        ArgumentNullException.ThrowIfNull(catalog);
        ArgumentNullException.ThrowIfNull(timeProvider);
        ArgumentNullException.ThrowIfNull(schemaStructureProbe);
        ArgumentNullException.ThrowIfNull(databaseOptions);

        _catalog = catalog;
        _timeProvider = timeProvider;
        _schemaStructureProbe = schemaStructureProbe;
        _databaseOptions = databaseOptions;
    }

    public Task<DatabaseMigrationResult> ApplyAsync(
        DatabaseMigrationRequest request,
        CancellationToken cancellationToken = default) =>
        ExecuteAsync(request, rollbackAfterValidation: false, cancellationToken);

    public Task<DatabaseMigrationResult> ValidateEmptyDatabaseAsync(
        DatabaseMigrationRequest request,
        CancellationToken cancellationToken = default) =>
        ExecuteAsync(request, rollbackAfterValidation: true, cancellationToken);

    private async Task<DatabaseMigrationResult> ExecuteAsync(
        DatabaseMigrationRequest request,
        bool rollbackAfterValidation,
        CancellationToken cancellationToken)
    {
        DatabaseMigrationInputValidator.Validate(request);
        var connectionStringBuilder = DatabaseMigrationInputValidator
            .CreateConnectionStringBuilder(request.ConnectionString);

        await using var connection = new SqlConnection(connectionStringBuilder.ConnectionString);
        try
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is SqlException or InvalidOperationException)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseUnavailable);
        }

        try
        {
            var preflight = await ReadPreflightAsync(
                    connection,
                    _databaseOptions.MigrationPreflightCommandTimeoutSeconds,
                    cancellationToken)
                .ConfigureAwait(false);
            SqlServerPreflightEvaluator.Validate(
                preflight,
                request.ExpectedCollation!.Trim(),
                connectionStringBuilder.InitialCatalog);

            await using var transaction = (SqlTransaction)await connection
                .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
                .ConfigureAwait(false);

            try
            {
                await EnableAtomicFailureAsync(
                        connection,
                        transaction,
                        _databaseOptions.MigrationPreflightCommandTimeoutSeconds,
                        cancellationToken)
                    .ConfigureAwait(false);
                await AcquireMigrationLockAsync(
                        connection,
                        transaction,
                        _databaseOptions.MigrationPreflightCommandTimeoutSeconds,
                        cancellationToken)
                    .ConfigureAwait(false);

                var state = await ReadMigrationStateAsync(
                        connection,
                        transaction,
                        _databaseOptions.MigrationPreflightCommandTimeoutSeconds,
                        cancellationToken)
                    .ConfigureAwait(false);
                if (rollbackAfterValidation && !IsEmptyDatabaseState(state))
                {
                    throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
                }

                var plan = MigrationPlanner.CreatePlan(state, _catalog);

                if (plan.IsCurrent)
                {
                    if (rollbackAfterValidation)
                    {
                        throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
                    }

                    await ValidateSchemaStructureAsync(connection, transaction, cancellationToken)
                        .ConfigureAwait(false);
                    await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                    return new DatabaseMigrationResult(
                        DatabaseMigrationOutcome.Current,
                        _catalog[^1].Id,
                        AppliedMigrationCount: 0);
                }

                foreach (var migration in plan.PendingMigrations)
                {
                    var startedAt = _timeProvider.GetUtcNow();
                    await ExecuteMigrationAsync(
                            connection,
                            transaction,
                            migration,
                            _databaseOptions.MigrationCommandTimeoutSeconds,
                            cancellationToken)
                        .ConfigureAwait(false);
                    await InsertLedgerEntryAsync(
                            connection,
                            transaction,
                            migration,
                            request.ToolVersion!.Trim(),
                            startedAt,
                            _timeProvider.GetUtcNow(),
                            _databaseOptions.MigrationPreflightCommandTimeoutSeconds,
                            cancellationToken)
                        .ConfigureAwait(false);
                }

                await ValidateSchemaStructureAsync(connection, transaction, cancellationToken)
                    .ConfigureAwait(false);
                var finalState = await ReadMigrationStateAsync(
                        connection,
                        transaction,
                        _databaseOptions.MigrationPreflightCommandTimeoutSeconds,
                        cancellationToken)
                    .ConfigureAwait(false);
                var finalPlan = MigrationPlanner.CreatePlan(finalState, _catalog);
                if (!finalPlan.IsCurrent)
                {
                    throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
                }

                if (rollbackAfterValidation)
                {
                    await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                }

                return new DatabaseMigrationResult(
                    rollbackAfterValidation
                        ? DatabaseMigrationOutcome.Validated
                        : DatabaseMigrationOutcome.Applied,
                    _catalog[^1].Id,
                    plan.PendingMigrations.Count);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
                throw;
            }
            catch (DatabaseMigrationException)
            {
                await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
                throw;
            }
            catch (Exception exception) when (exception is SqlException or InvalidOperationException)
            {
                await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
                throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationExecutionFailed);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (DatabaseMigrationException)
        {
            throw;
        }
        catch (Exception exception) when (exception is SqlException or InvalidOperationException)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseUnavailable);
        }
    }

    private static bool IsEmptyDatabaseState(DatabaseMigrationState state) =>
        !state.HasUserObjects &&
        !state.FlowPilotSchemaExists &&
        !state.MigrationLedgerExists &&
        !state.MigrationLedgerIsValid &&
        state.Entries.Count == 0;

    private async Task ValidateSchemaStructureAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        var result = await _schemaStructureProbe
            .ValidateAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
        if (!result.IsValid)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.SchemaStructureMismatch);
        }
    }

    private static async Task<SqlServerPreflightSnapshot> ReadPreflightAsync(
        SqlConnection connection,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = new SqlCommand(PreflightQuery, connection)
        {
            CommandTimeout = commandTimeoutSeconds,
        };
        await using var reader = await command
            .ExecuteReaderAsync(CommandBehavior.SingleRow, cancellationToken)
            .ConfigureAwait(false);

        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseUnavailable);
        }

        return new SqlServerPreflightSnapshot(
            ReadNullableString(reader, 0),
            ReadNullableString(reader, 1),
            ReadNullableString(reader, 2),
            reader.GetInt32(3),
            ReadNullableString(reader, 4));
    }

    private static async Task EnableAtomicFailureAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = new SqlCommand("SET XACT_ABORT ON;", connection, transaction)
        {
            CommandTimeout = commandTimeoutSeconds,
        };
        _ = await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task AcquireMigrationLockAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = new SqlCommand(AcquireMigrationLockQuery, connection, transaction)
        {
            CommandTimeout = commandTimeoutSeconds,
        };
        command.Parameters.Add("@resource", SqlDbType.NVarChar, 255).Value = MigrationLockResource;

        var result = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        if (result is null ||
            !int.TryParse(
                Convert.ToString(result, CultureInfo.InvariantCulture),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out var lockResult) ||
            lockResult < 0)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationLockUnavailable);
        }
    }

    private static async Task<DatabaseMigrationState> ReadMigrationStateAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        bool hasUserObjects;
        bool flowPilotSchemaExists;
        bool migrationLedgerExists;
        bool migrationLedgerIsValid;

        await using (var command = new SqlCommand(MigrationStateQuery, connection, transaction)
        {
            CommandTimeout = commandTimeoutSeconds,
        })
        await using (var reader = await command
            .ExecuteReaderAsync(CommandBehavior.SingleRow, cancellationToken)
            .ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
            }

            hasUserObjects = reader.GetBoolean(0);
            flowPilotSchemaExists = reader.GetBoolean(1);
            migrationLedgerExists = reader.GetBoolean(2);
            migrationLedgerIsValid = reader.GetBoolean(3);
        }

        var entries = new List<MigrationLedgerEntry>();
        if (migrationLedgerExists && migrationLedgerIsValid)
        {
            await using var command = new SqlCommand(MigrationLedgerQuery, connection, transaction)
            {
                CommandTimeout = commandTimeoutSeconds,
            };
            await using var reader = await command.ExecuteReaderAsync(cancellationToken)
                .ConfigureAwait(false);

            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                if (reader.IsDBNull(0) ||
                    reader.IsDBNull(1) ||
                    reader.IsDBNull(2) ||
                    reader.IsDBNull(3))
                {
                    throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
                }

                entries.Add(new MigrationLedgerEntry(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3)));
            }
        }

        return new DatabaseMigrationState(
            hasUserObjects,
            flowPilotSchemaExists,
            migrationLedgerExists,
            migrationLedgerIsValid,
            entries);
    }

    private static async Task ExecuteMigrationAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        SchemaMigration migration,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = new SqlCommand(migration.Sql, connection, transaction)
        {
            CommandTimeout = commandTimeoutSeconds,
        };
        _ = await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task InsertLedgerEntryAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        SchemaMigration migration,
        string toolVersion,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = new SqlCommand(InsertLedgerQuery, connection, transaction)
        {
            CommandTimeout = commandTimeoutSeconds,
        };
        command.Parameters.Add("@migration_id", SqlDbType.NVarChar, 100).Value = migration.Id;
        command.Parameters.Add("@name", SqlDbType.NVarChar, 200).Value = migration.Name;
        command.Parameters.Add("@checksum", SqlDbType.VarChar, 64).Value = migration.Checksum;
        command.Parameters.Add("@started_at", SqlDbType.DateTime2).Value = startedAt.UtcDateTime;
        command.Parameters.Add("@completed_at", SqlDbType.DateTime2).Value = completedAt.UtcDateTime;
        command.Parameters.Add("@tool_version", SqlDbType.NVarChar, 100).Value = toolVersion;

        _ = await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task RollbackWithoutMaskingAsync(SqlTransaction transaction)
    {
        try
        {
            await transaction.RollbackAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is SqlException or InvalidOperationException)
        {
            // Preserve the original stable failure. The connection disposal still releases locks.
        }
    }

    private static string? ReadNullableString(SqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
}
