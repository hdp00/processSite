using System.Data;
using FlowPilot.Database.Migrations;
using FlowPilot.Database.Seeding;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

internal sealed class SqlServerRuntimeTestScope : IAsyncDisposable
{
    private readonly IDbContextTransaction? _transaction;
    private readonly string? _isolatedDatabaseName;
    private readonly string? _masterConnectionString;

    private SqlServerRuntimeTestScope(
        FlowPilotDbContext context,
        IDbContextTransaction? transaction,
        Guid administratorUserId,
        string? isolatedDatabaseName = null,
        string? masterConnectionString = null)
    {
        Context = context;
        _transaction = transaction;
        AdministratorUserId = administratorUserId;
        _isolatedDatabaseName = isolatedDatabaseName;
        _masterConnectionString = masterConnectionString;
    }

    public FlowPilotDbContext Context { get; }

    public Guid AdministratorUserId { get; }

    public static async Task<SqlServerRuntimeTestScope> CreateAsync(CancellationToken cancellationToken)
    {
        var (context, administratorUserId) = await CreateContextAsync(cancellationToken);
        var transaction = await context.Database.BeginTransactionAsync(cancellationToken);
        return new SqlServerRuntimeTestScope(context, transaction, administratorUserId);
    }

    public static async Task<SqlServerRuntimeTestScope> CreateIsolatedAsync(CancellationToken cancellationToken)
    {
        var configuration = SqlServerTestConfiguration.Load();
        var runtimeConnectionString = SqlServerTestConfiguration.RequireOrSkip(
            configuration.GetConnectionString("FlowPilot"),
            $"ConnectionStrings:FlowPilot or {SqlServerTestConfiguration.ConnectionStringOverrideVariable}");
        var expectedCollation = SqlServerTestConfiguration.RequireOrSkip(
            configuration["FlowPilot:Database:ExpectedCollation"],
            "FlowPilot:Database:ExpectedCollation");
        var databaseBuilder = new SqlConnectionStringBuilder(runtimeConnectionString);
        var baseName = string.IsNullOrWhiteSpace(databaseBuilder.InitialCatalog)
            ? "FlowPilot"
            : databaseBuilder.InitialCatalog;
        var suffix = $"_WorkflowTests_{Guid.NewGuid():N}";
        var databaseName = (baseName.Length + suffix.Length <= 128 ? baseName : baseName[..(128 - suffix.Length)]) + suffix;
        databaseBuilder.InitialCatalog = databaseName;
        var masterBuilder = new SqlConnectionStringBuilder(runtimeConnectionString) { InitialCatalog = "master" };

        await using (var connection = new SqlConnection(masterBuilder.ConnectionString))
        {
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText =
                "DECLARE @sql nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(@databaseName); EXEC sys.sp_executesql @sql;";
            command.Parameters.Add(new SqlParameter("@databaseName", SqlDbType.NVarChar, 128) { Value = databaseName });
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        try
        {
            var request = new DatabaseMigrationRequest(databaseBuilder.ConnectionString, expectedCollation, "workflow-lifecycle-tests");
            await new SqlServerDatabaseMigrator().ApplyAsync(request, cancellationToken);
            await SqlServerBuiltinSeeder.SeedAsync(
                databaseBuilder.ConnectionString,
                $"FlowPilot-Test-{Guid.NewGuid():N}!",
                300,
                cancellationToken);
            var (context, administratorUserId) = await CreateContextAsync(databaseBuilder.ConnectionString, cancellationToken);
            return new SqlServerRuntimeTestScope(
                context,
                null,
                administratorUserId,
                databaseName,
                masterBuilder.ConnectionString);
        }
        catch
        {
            await DropDatabaseAsync(masterBuilder.ConnectionString, databaseName, cancellationToken);
            throw;
        }
    }

    private static async Task<(FlowPilotDbContext Context, Guid AdministratorUserId)> CreateContextAsync(
        CancellationToken cancellationToken)
    {
        var configuration = SqlServerTestConfiguration.Load();
        var connectionString = SqlServerTestConfiguration.RequireOrSkip(
            configuration.GetConnectionString("FlowPilot"),
            $"ConnectionStrings:FlowPilot or {SqlServerTestConfiguration.ConnectionStringOverrideVariable}");
        return await CreateContextAsync(connectionString, cancellationToken);
    }

    private static async Task<(FlowPilotDbContext Context, Guid AdministratorUserId)> CreateContextAsync(
        string connectionString,
        CancellationToken cancellationToken)
    {
        var options = new DbContextOptionsBuilder<FlowPilotDbContext>()
            .UseSqlServer(
                connectionString,
                sqlServerOptions => sqlServerOptions.UseCompatibilityLevel(
                    FlowPilotDbContext.SqlServerCompatibilityLevel))
            .Options;
        var context = new FlowPilotDbContext(options);
        var administratorUserId = await context.OrganizationUserReferences
            .Where(item => item.IsBuiltInSuperAdmin)
            .Select(item => item.Id)
            .SingleOrDefaultAsync(cancellationToken);
        Assert.NotEqual(Guid.Empty, administratorUserId);
        return (context, administratorUserId);
    }

    private static async Task DropDatabaseAsync(
        string masterConnectionString,
        string databaseName,
        CancellationToken cancellationToken)
    {
        if (!databaseName.Contains("_WorkflowTests_", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Refusing to drop a database outside the isolated workflow-test naming convention.");
        }

        await using var connection = new SqlConnection(masterConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            "IF DB_ID(@databaseName) IS NOT NULL BEGIN DECLARE @sql nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@databaseName) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ' + QUOTENAME(@databaseName); EXEC sys.sp_executesql @sql; END;";
        command.Parameters.Add(new SqlParameter("@databaseName", SqlDbType.NVarChar, 128) { Value = databaseName });
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<Guid> AddUserAsync(string email, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid();
        var suffix = id.ToString("N");
        var now = DateTime.UtcNow;
        await Context.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO [flowpilot].[users]
            (
                [id], [login_name], [normalized_login_name], [display_name], [email],
                [authentication_mode], [password_hash], [department_id], [position_id],
                [is_enabled], [is_builtin_super_admin], [revision], [created_at], [updated_at],
                [created_by], [updated_by]
            )
            VALUES
            (
                {id}, {"test-" + suffix}, {"TEST-" + suffix}, {"测试用户-" + suffix[..8]}, {email},
                {"domain"}, NULL, NULL, NULL, 1, 0, 1, {now}, {now},
                {AdministratorUserId}, {AdministratorUserId}
            );
            """,
            cancellationToken);
        return id;
    }

    public async Task<Guid> AddWorkflowGroupAsync(
        CancellationToken cancellationToken,
        IReadOnlyCollection<string>? purposes = null,
        IReadOnlyCollection<Guid>? memberIds = null)
    {
        var id = Guid.NewGuid();
        var suffix = id.ToString("N");
        var now = DateTime.UtcNow;
        await Context.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO [flowpilot].[workflow_permission_groups]
                ([id], [code], [normalized_code], [name], [description], [is_enabled], [revision],
                 [created_at], [updated_at], [created_by], [updated_by])
            VALUES
                ({id}, {"test-" + suffix}, {"TEST-" + suffix}, {"测试权限组-" + suffix[..8]}, NULL,
                 1, 1, {now}, {now}, {AdministratorUserId}, {AdministratorUserId});
            """,
            cancellationToken);
        foreach (var purpose in purposes ?? [])
        {
            await Context.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO [flowpilot].[workflow_permission_group_purposes] ([group_id], [purpose]) VALUES ({id}, {purpose});",
                cancellationToken);
        }

        foreach (var memberId in memberIds ?? [])
        {
            await Context.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO [flowpilot].[workflow_group_users] ([group_id], [user_id], [added_by], [added_at]) VALUES ({id}, {memberId}, {AdministratorUserId}, {now});",
                cancellationToken);
        }

        return id;
    }

    public async ValueTask DisposeAsync()
    {
        if (_transaction is not null)
        {
            await _transaction.RollbackAsync();
            await _transaction.DisposeAsync();
        }

        await Context.DisposeAsync();
        if (_isolatedDatabaseName is not null && _masterConnectionString is not null)
        {
            await DropDatabaseAsync(_masterConnectionString, _isolatedDatabaseName, CancellationToken.None);
        }
    }
}
