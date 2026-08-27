using System.Data;
using System.Globalization;
using System.Text;
using System.Text.Json;
using FlowPilot.Application.Security;
using FlowPilot.Database.Migrations;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Database.Seeding;

public enum BuiltinSeedOutcome
{
    Applied,
    Current,
}

public sealed record BuiltinSeedResult(
    BuiltinSeedOutcome Outcome,
    string SeedVersion,
    int PermissionCount,
    bool SuperAdminCreated);

public enum BuiltinSeedFailure
{
    InvalidConnectionString,
    DatabaseNameMissing,
    SystemDatabaseNotAllowed,
    DatabaseUnavailable,
    SchemaNotReady,
    SeedLockUnavailable,
    InitialPasswordMissing,
    InitialPasswordInvalid,
    DataConflict,
    SeedExecutionFailed,
}

public sealed class BuiltinSeedException : InvalidOperationException
{
    public BuiltinSeedException(BuiltinSeedFailure failure)
        : base($"Database seed failed ({failure}).")
    {
        Failure = failure;
    }

    public BuiltinSeedException(BuiltinSeedFailure failure, Exception innerException)
        : base($"Database seed failed ({failure}).", innerException)
    {
        ArgumentNullException.ThrowIfNull(innerException);
        Failure = failure;
    }

    public BuiltinSeedFailure Failure { get; }
}

public static class SqlServerBuiltinSeeder
{
    private const string SeedLockResource = "FlowPilot:builtin-seed";
    private const string SeedResourceSuffix = ".Seeding.202608260001_builtin_seed.sql";
    private const string InitialPasswordPlaceholder = "<仅首次初始化使用>";
    private const int MaximumInitialPasswordLength = 200;

    private static readonly HashSet<string> SystemDatabaseNames =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "master",
            "model",
            "msdb",
            "tempdb",
        };

    private static readonly Lazy<string> SeedSql =
        new(LoadSeedSql, LazyThreadSafetyMode.ExecutionAndPublication);

    public static async Task<BuiltinSeedResult> SeedAsync(
        string? connectionString,
        string? initialSuperAdminPassword,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken = default)
    {
        var connectionStringBuilder = ValidateConnectionString(connectionString);
        await using var connection = new SqlConnection(connectionStringBuilder.ConnectionString);
        await OpenConnectionAsync(connection, cancellationToken).ConfigureAwait(false);

        await using var transaction = await BeginTransactionAsync(connection, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            await SetTransactionSafetyAsync(
                    connection,
                    transaction,
                    commandTimeoutSeconds,
                    cancellationToken)
                .ConfigureAwait(false);
            await RequireMigrationLedgerAsync(
                    connection,
                    transaction,
                    commandTimeoutSeconds,
                    cancellationToken)
                .ConfigureAwait(false);

            var superAdminExists = await AcquireLockAndReadSuperAdminAsync(
                    connection,
                    transaction,
                    commandTimeoutSeconds,
                    cancellationToken)
                .ConfigureAwait(false);
            string? initialPasswordHash = null;
            if (!superAdminExists)
            {
                ValidateInitialPassword(initialSuperAdminPassword);
                initialPasswordHash = FlowPilotPasswordHasher.HashPassword(
                    IdentityValueNormalizer.Normalize(BuiltinCatalog.SuperAdminLoginName),
                    initialSuperAdminPassword!);
            }

            var changed = await ApplySeedAsync(
                    connection,
                    transaction,
                    commandTimeoutSeconds,
                    initialPasswordHash,
                    cancellationToken)
                .ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);

            return new BuiltinSeedResult(
                changed ? BuiltinSeedOutcome.Applied : BuiltinSeedOutcome.Current,
                BuiltinCatalog.SeedVersion,
                BuiltinCatalog.Permissions.Count,
                SuperAdminCreated: !superAdminExists);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
            throw;
        }
        catch (BuiltinSeedException)
        {
            await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
            throw;
        }
        catch (SqlException exception) when (exception.Number is >= 51110 and <= 51119)
        {
            await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
            throw new BuiltinSeedException(BuiltinSeedFailure.DataConflict, exception);
        }
        catch (Exception exception) when (exception is SqlException or InvalidOperationException)
        {
            await RollbackWithoutMaskingAsync(transaction).ConfigureAwait(false);
            throw new BuiltinSeedException(BuiltinSeedFailure.SeedExecutionFailed, exception);
        }
    }

    private static SqlConnectionStringBuilder ValidateConnectionString(string? connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.InvalidConnectionString);
        }

        SqlConnectionStringBuilder builder;
        try
        {
            builder = new SqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException exception)
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.InvalidConnectionString, exception);
        }

        if (string.IsNullOrWhiteSpace(builder.InitialCatalog))
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.DatabaseNameMissing);
        }

        if (SystemDatabaseNames.Contains(builder.InitialCatalog.Trim()))
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.SystemDatabaseNotAllowed);
        }

        return builder;
    }

    private static async Task OpenConnectionAsync(
        SqlConnection connection,
        CancellationToken cancellationToken)
    {
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
            throw new BuiltinSeedException(BuiltinSeedFailure.DatabaseUnavailable, exception);
        }
    }

    private static async Task<SqlTransaction> BeginTransactionAsync(
        SqlConnection connection,
        CancellationToken cancellationToken)
    {
        try
        {
            return (SqlTransaction)await connection
                .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is SqlException or InvalidOperationException)
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.SeedExecutionFailed, exception);
        }
    }

    private static void ValidateInitialPassword(string? password)
    {
        if (password is null)
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.InitialPasswordMissing);
        }

        if (password.Length is < 1 or > MaximumInitialPasswordLength ||
            string.Equals(password, InitialPasswordPlaceholder, StringComparison.Ordinal))
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.InitialPasswordInvalid);
        }
    }

    private static async Task SetTransactionSafetyAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            commandTimeoutSeconds,
            "SET XACT_ABORT ON;");
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task RequireMigrationLedgerAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            commandTimeoutSeconds,
            "SELECT OBJECT_ID(N'[flowpilot].[schema_migrations]', N'U');");
        var objectId = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        if (objectId is null or DBNull)
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.SchemaNotReady);
        }
    }

    private static async Task<bool> AcquireLockAndReadSuperAdminAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        CancellationToken cancellationToken)
    {
        const string sql = """
            DECLARE @lock_result int;
            EXEC @lock_result = sys.sp_getapplock
                @Resource = @lock_resource,
                @LockMode = N'Exclusive',
                @LockOwner = N'Transaction',
                @LockTimeout = @lock_timeout;

            IF @lock_result < 0
            BEGIN
                SELECT -1;
                RETURN;
            END;

            IF NOT EXISTS
            (
                SELECT 1
                FROM [flowpilot].[schema_migrations] WITH (UPDLOCK, HOLDLOCK)
                WHERE [migration_id] = @migration_id AND [result] = N'succeeded'
            )
            BEGIN
                SELECT -2;
                RETURN;
            END;

            IF EXISTS
            (
                SELECT 1 FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
                WHERE ([is_builtin_super_admin] = 1 OR [normalized_login_name] = @normalized_login_name)
                  AND [id] <> @user_id
            )
            OR EXISTS
            (
                SELECT 1 FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
                WHERE [id] = @user_id AND [is_builtin_super_admin] = 0
            )
            BEGIN
                SELECT -3;
                RETURN;
            END;

            SELECT CASE WHEN EXISTS
            (
                SELECT 1 FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
                WHERE [id] = @user_id AND [is_builtin_super_admin] = 1
            ) THEN 1 ELSE 0 END;
            """;

        await using var command = CreateCommand(connection, transaction, commandTimeoutSeconds, sql);
        AddNVarChar(command, "@lock_resource", 255, SeedLockResource);
        AddInt(command, "@lock_timeout", Math.Min(commandTimeoutSeconds * 1000, 30_000));
        AddNVarChar(command, "@migration_id", 100, MigrationCatalog.CurrentSchemaVersion);
        AddGuid(command, "@user_id", BuiltinCatalog.SuperAdminUserId);
        AddNVarChar(
            command,
            "@normalized_login_name",
            100,
            IdentityValueNormalizer.Normalize(BuiltinCatalog.SuperAdminLoginName));

        var value = Convert.ToInt32(
            await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false),
            CultureInfo.InvariantCulture);
        return value switch
        {
            -1 => throw new BuiltinSeedException(BuiltinSeedFailure.SeedLockUnavailable),
            -2 => throw new BuiltinSeedException(BuiltinSeedFailure.SchemaNotReady),
            -3 => throw new BuiltinSeedException(BuiltinSeedFailure.DataConflict),
            0 => false,
            1 => true,
            _ => throw new BuiltinSeedException(BuiltinSeedFailure.SeedExecutionFailed),
        };
    }

    private static async Task<bool> ApplySeedAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        string? initialPasswordHash,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            commandTimeoutSeconds,
            SeedSql.Value);
        AddCatalogParameters(command, initialPasswordHash);
        var changed = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        return Convert.ToInt32(changed, CultureInfo.InvariantCulture) > 0;
    }

    private static void AddCatalogParameters(SqlCommand command, string? initialPasswordHash)
    {
        AddGuid(command, "@system_department_id", BuiltinCatalog.SystemDepartmentId);
        AddNVarChar(command, "@system_department_code", 100, BuiltinCatalog.SystemDepartmentCode);
        AddNVarChar(command, "@system_department_name", 200, BuiltinCatalog.SystemDepartmentName);

        AddGuid(command, "@system_position_id", BuiltinCatalog.SystemPositionId);
        AddNVarChar(command, "@system_position_code", 100, BuiltinCatalog.SystemPositionCode);
        AddNVarChar(command, "@system_position_name", 200, BuiltinCatalog.SystemPositionName);
        AddGuid(command, "@manager_position_id", BuiltinCatalog.ManagerPositionId);
        AddNVarChar(command, "@manager_position_code", 100, BuiltinCatalog.ManagerPositionCode);
        AddNVarChar(command, "@manager_position_name", 200, BuiltinCatalog.ManagerPositionName);
        AddGuid(command, "@employee_position_id", BuiltinCatalog.EmployeePositionId);
        AddNVarChar(command, "@employee_position_code", 100, BuiltinCatalog.EmployeePositionCode);
        AddNVarChar(command, "@employee_position_name", 200, BuiltinCatalog.EmployeePositionName);

        AddGuid(command, "@super_admin_user_id", BuiltinCatalog.SuperAdminUserId);
        AddNVarChar(command, "@super_admin_login_name", 100, BuiltinCatalog.SuperAdminLoginName);
        AddNVarChar(
            command,
            "@super_admin_normalized_login_name",
            100,
            IdentityValueNormalizer.Normalize(BuiltinCatalog.SuperAdminLoginName));
        AddNVarChar(command, "@super_admin_display_name", 100, BuiltinCatalog.SuperAdminDisplayName);
        AddNVarChar(command, "@super_admin_email", 320, BuiltinCatalog.SuperAdminEmail);
        AddNullableNVarChar(command, "@super_admin_password_hash", 500, initialPasswordHash);

        AddGuid(command, "@super_admin_role_id", BuiltinCatalog.SuperAdminRoleId);
        AddNVarChar(command, "@super_admin_role_code", 100, BuiltinCatalog.SuperAdminRoleCode);
        AddNVarChar(
            command,
            "@super_admin_role_normalized_code",
            100,
            IdentityValueNormalizer.Normalize(BuiltinCatalog.SuperAdminRoleCode));
        AddNVarChar(command, "@super_admin_role_name", 200, BuiltinCatalog.SuperAdminRoleName);
        AddNVarChar(
            command,
            "@super_admin_role_normalized_name",
            200,
            IdentityValueNormalizer.Normalize(BuiltinCatalog.SuperAdminRoleName));

        AddNVarChar(
            command,
            "@permissions_json",
            -1,
            JsonSerializer.Serialize(BuiltinCatalog.Permissions));
        AddInt(command, "@permission_count", BuiltinCatalog.Permissions.Count);
        AddNVarChar(command, "@seed_version", 4000, BuiltinCatalog.SeedVersion);
        command.Parameters.Add(
            new SqlParameter("@now", SqlDbType.DateTime2)
            {
                Scale = 3,
                Value = DateTime.UtcNow,
            });
    }

    private static string LoadSeedSql()
    {
        var assembly = typeof(SqlServerBuiltinSeeder).Assembly;
        var resourceName = assembly
            .GetManifestResourceNames()
            .SingleOrDefault(name => name.EndsWith(SeedResourceSuffix, StringComparison.Ordinal));
        if (resourceName is null)
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.SeedExecutionFailed);
        }

        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            throw new BuiltinSeedException(BuiltinSeedFailure.SeedExecutionFailed);
        }

        using var reader = new StreamReader(
            stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static SqlCommand CreateCommand(
        SqlConnection connection,
        SqlTransaction transaction,
        int commandTimeoutSeconds,
        string commandText) =>
        new(commandText, connection, transaction)
        {
            CommandTimeout = commandTimeoutSeconds,
        };

    private static void AddGuid(SqlCommand command, string name, Guid value) =>
        command.Parameters.Add(new SqlParameter(name, SqlDbType.UniqueIdentifier) { Value = value });

    private static void AddInt(SqlCommand command, string name, int value) =>
        command.Parameters.Add(new SqlParameter(name, SqlDbType.Int) { Value = value });

    private static void AddNVarChar(
        SqlCommand command,
        string name,
        int size,
        string value) =>
        command.Parameters.Add(new SqlParameter(name, SqlDbType.NVarChar, size) { Value = value });

    private static void AddNullableNVarChar(
        SqlCommand command,
        string name,
        int size,
        string? value) =>
        command.Parameters.Add(
            new SqlParameter(name, SqlDbType.NVarChar, size)
            {
                Value = value is null ? DBNull.Value : value,
            });

    private static async Task RollbackWithoutMaskingAsync(SqlTransaction transaction)
    {
        try
        {
            await transaction.RollbackAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is SqlException or InvalidOperationException)
        {
            // Preserve the original failure.
        }
    }
}
