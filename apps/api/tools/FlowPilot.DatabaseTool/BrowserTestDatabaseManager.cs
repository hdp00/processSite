using System.Data;
using FlowPilot.Database.Migrations;
using FlowPilot.Database.Seeding;
using FlowPilot.Infrastructure.Configuration;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

internal sealed class BrowserTestDatabaseManager(
    IConfiguration configuration,
    FlowPilotDatabaseOptions databaseOptions)
{
    private readonly BrowserTestDatabaseConnectionStrings _connectionStrings =
        BrowserTestDatabaseConnectionStrings.FromConfiguration(configuration);

    public async Task PrepareAsync(CancellationToken cancellationToken)
    {
        await DropAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await CreateAsync(cancellationToken).ConfigureAwait(false);
            await new SqlServerDatabaseMigrator(databaseOptions)
                .ApplyAsync(
                    new DatabaseMigrationRequest(
                        _connectionStrings.MigrationConnectionString,
                        databaseOptions.ExpectedCollation,
                        "playwright-tests"),
                    cancellationToken)
                .ConfigureAwait(false);
            await SqlServerBuiltinSeeder.SeedAsync(
                    _connectionStrings.MigrationConnectionString,
                    configuration["FlowPilot:Bootstrap:SuperAdminPassword"],
                    databaseOptions.MigrationCommandTimeoutSeconds,
                    cancellationToken)
                .ConfigureAwait(false);
            await GrantRuntimeAccessAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await DropAsync(CancellationToken.None).ConfigureAwait(false);
            throw;
        }
    }

    public async Task DropAsync(CancellationToken cancellationToken)
    {
        EnsureSafeDatabaseName();
        SqlConnection.ClearAllPools();

        await using var connection = new SqlConnection(
            _connectionStrings.MigrationMasterConnectionString);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandTimeout = databaseOptions.MigrationCommandTimeoutSeconds;
        command.CommandText =
            "IF DB_ID(@databaseName) IS NOT NULL BEGIN " +
            "DECLARE @sql nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@databaseName) + " +
            "N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ' + QUOTENAME(@databaseName); " +
            "EXEC sys.sp_executesql @sql; END;";
        command.Parameters.Add(new SqlParameter("@databaseName", SqlDbType.NVarChar, 128)
        {
            Value = _connectionStrings.DatabaseName,
        });
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task CreateAsync(CancellationToken cancellationToken)
    {
        EnsureSafeDatabaseName();
        var expectedCollation = databaseOptions.ExpectedCollation;
        if (string.IsNullOrWhiteSpace(expectedCollation))
        {
            throw new InvalidOperationException("FlowPilot:Database:ExpectedCollation 未配置。");
        }

        await using var connection = new SqlConnection(
            _connectionStrings.MigrationMasterConnectionString);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandTimeout = databaseOptions.MigrationCommandTimeoutSeconds;
        command.CommandText =
            "IF NOT EXISTS (SELECT 1 FROM sys.fn_helpcollations() WHERE [name] = @collation) " +
            "THROW 51000, N'Configured collation is not supported by this SQL Server.', 1; " +
            "DECLARE @sql nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(@databaseName) + " +
            "N' COLLATE ' + @collation; EXEC sys.sp_executesql @sql;";
        command.Parameters.Add(new SqlParameter("@databaseName", SqlDbType.NVarChar, 128)
        {
            Value = _connectionStrings.DatabaseName,
        });
        command.Parameters.Add(new SqlParameter("@collation", SqlDbType.NVarChar, 128)
        {
            Value = expectedCollation,
        });
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task GrantRuntimeAccessAsync(CancellationToken cancellationToken)
    {
        var runtime = new SqlConnectionStringBuilder(_connectionStrings.RuntimeConnectionString);
        var migration = new SqlConnectionStringBuilder(_connectionStrings.MigrationConnectionString);
        if (runtime.IntegratedSecurity ||
            string.IsNullOrWhiteSpace(runtime.UserID) ||
            string.Equals(runtime.UserID, migration.UserID, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        await using var connection = new SqlConnection(
            _connectionStrings.MigrationConnectionString);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandTimeout = databaseOptions.MigrationCommandTimeoutSeconds;
        command.CommandText =
            "IF SUSER_ID(@loginName) IS NULL THROW 51000, N'Runtime SQL login does not exist.', 1; " +
            "DECLARE @member sysname = QUOTENAME(@loginName); " +
            "IF DATABASE_PRINCIPAL_ID(@loginName) IS NULL " +
            "EXEC (N'CREATE USER ' + @member + N' FOR LOGIN ' + @member); " +
            "EXEC (N'ALTER ROLE [db_datareader] ADD MEMBER ' + @member); " +
            "EXEC (N'ALTER ROLE [db_datawriter] ADD MEMBER ' + @member); " +
            "EXEC (N'GRANT VIEW DEFINITION TO ' + @member);";
        command.Parameters.Add(new SqlParameter("@loginName", SqlDbType.NVarChar, 128)
        {
            Value = runtime.UserID,
        });
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private void EnsureSafeDatabaseName()
    {
        var suffix = BrowserTestDatabaseConnectionStrings.RequireSafeSuffix(
            configuration[BrowserTestDatabaseConnectionStrings.SuffixConfigurationKey]);
        if (!_connectionStrings.DatabaseName.EndsWith($"_{suffix}", StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "拒绝操作不符合浏览器测试命名约定的数据库。");
        }
    }
}
