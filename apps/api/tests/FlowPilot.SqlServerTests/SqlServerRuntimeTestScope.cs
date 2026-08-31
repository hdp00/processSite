using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

internal sealed class SqlServerRuntimeTestScope : IAsyncDisposable
{
    private readonly IDbContextTransaction _transaction;

    private SqlServerRuntimeTestScope(
        FlowPilotDbContext context,
        IDbContextTransaction transaction,
        Guid administratorUserId)
    {
        Context = context;
        _transaction = transaction;
        AdministratorUserId = administratorUserId;
    }

    public FlowPilotDbContext Context { get; }

    public Guid AdministratorUserId { get; }

    public static async Task<SqlServerRuntimeTestScope> CreateAsync(CancellationToken cancellationToken)
    {
        var configuration = SqlServerTestConfiguration.Load();
        var connectionString = SqlServerTestConfiguration.RequireOrSkip(
            configuration.GetConnectionString("FlowPilot"),
            $"ConnectionStrings:FlowPilot or {SqlServerTestConfiguration.ConnectionStringOverrideVariable}");
        var options = new DbContextOptionsBuilder<FlowPilotDbContext>()
            .UseSqlServer(
                connectionString,
                sqlServerOptions => sqlServerOptions.UseCompatibilityLevel(
                    FlowPilotDbContext.SqlServerCompatibilityLevel))
            .Options;
        var context = new FlowPilotDbContext(options);
        var transaction = await context.Database.BeginTransactionAsync(cancellationToken);
        var administratorUserId = await context.OrganizationUserReferences
            .Where(item => item.IsBuiltInSuperAdmin)
            .Select(item => item.Id)
            .SingleOrDefaultAsync(cancellationToken);
        Assert.NotEqual(Guid.Empty, administratorUserId);
        return new SqlServerRuntimeTestScope(context, transaction, administratorUserId);
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

    public async Task<Guid> AddWorkflowGroupAsync(CancellationToken cancellationToken)
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
        return id;
    }

    public async ValueTask DisposeAsync()
    {
        await _transaction.RollbackAsync();
        await _transaction.DisposeAsync();
        await Context.DisposeAsync();
    }
}
