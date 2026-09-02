using FlowPilot.Application.Organization;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Organization;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class OrganizationUserIntegrationTests
{
    [Fact]
    public async Task UserCanBeCreatedAndRenamedWithoutOptionalOrganizationOrRoles()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var service = CreateService(scope);
        var actor = new WorkflowGroupMutationActor(
            scope.AdministratorUserId,
            scope.AdministratorUserId);
        var suffix = Guid.NewGuid().ToString("N")[..8];

        var createResult = await service.CreateUserAsync(
            new CreateUserRequest
            {
                LoginName = $"optional-{suffix}",
                Name = "无组织用户",
                Email = "",
                DepartmentId = null,
                PositionId = null,
                RoleIds = [],
                AuthenticationMode = "password",
                InitialPassword = "Test-Password-1!",
                Status = "enabled",
            },
            actor,
            Guid.NewGuid().ToString("N"),
            Guid.NewGuid().ToString("N"),
            cancellationToken);

        var created = AssertSuccessful(createResult);
        Assert.Equal("", created.Email);
        Assert.Null(created.Department);
        Assert.Null(created.Position);
        Assert.Empty(created.Roles);

        var updateResult = await service.UpdateUserAsync(
            created.Id,
            new UpdateUserRequest
            {
                LoginName = $"renamed-{suffix}",
                Email = "",
                DepartmentId = null,
                PositionId = null,
                RoleIds = [],
            },
            created.Revision,
            actor,
            Guid.NewGuid().ToString("N"),
            cancellationToken);

        var updated = AssertSuccessful(updateResult);
        Assert.Equal($"renamed-{suffix}", updated.LoginName);
        Assert.Equal("", updated.Email);
        Assert.Null(updated.Department);
        Assert.Null(updated.Position);
        Assert.Empty(updated.Roles);
        Assert.True(updated.Revision > created.Revision);

        var staleUpdate = await service.UpdateUserAsync(
            created.Id,
            new UpdateUserRequest { Name = "不应被旧版本覆盖" },
            created.Revision,
            actor,
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.Equal(OrganizationCommandError.RevisionMismatch, staleUpdate.Failure?.Error);

        var persisted = await service.GetUserAsync(created.Id, cancellationToken);
        Assert.NotNull(persisted);
        Assert.Equal(updated.LoginName, persisted.LoginName);
        Assert.Equal(updated.Name, persisted.Name);
        Assert.Null(persisted.Department);
        Assert.Null(persisted.Position);
        Assert.Empty(persisted.Roles);
    }

    [Fact]
    public async Task UserListReturnsLatestOperatorLoginWithoutCountingImpersonatedTarget()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var targetUserId = await scope.AddUserAsync("impersonated@example.test", cancellationToken);
        var loginAt = new DateTimeOffset(2026, 9, 1, 1, 30, 0, TimeSpan.Zero);
        scope.Context.RuntimeSessions.Add(new RuntimeSessionEntity
        {
            Id = Guid.NewGuid(),
            TokenHash = Enumerable.Repeat((byte)7, 32).ToArray(),
            OperatorUserId = scope.AdministratorUserId,
            EffectiveUserId = targetUserId,
            PermissionSnapshotVersion = 1,
            CreatedAt = loginAt.UtcDateTime,
            LastAccessedAt = loginAt.UtcDateTime,
            IdleExpiresAt = loginAt.AddHours(8).UtcDateTime,
            AbsoluteExpiresAt = loginAt.AddHours(24).UtcDateTime,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);

        var service = CreateService(scope);
        var users = await service.ListUsersAsync(
            new OrganizationPageQuery(1, 200),
            cancellationToken);

        Assert.Equal(
            loginAt,
            Assert.Single(users.Items, item => item.Id == scope.AdministratorUserId).LastLoginAt);
        Assert.Null(Assert.Single(users.Items, item => item.Id == targetUserId).LastLoginAt);
    }

    private static SqlServerOrganizationService CreateService(SqlServerRuntimeTestScope scope)
    {
        var configuration = SqlServerTestConfiguration.Load();
        configuration["ConnectionStrings:FlowPilot"] = scope.Context.Database.GetConnectionString();
        return new SqlServerOrganizationService(
            configuration,
            FlowPilotDatabaseOptions.FromConfiguration(configuration),
            scope.Context,
            TimeProvider.System);
    }

    private static T AssertSuccessful<T>(OrganizationCommandResult<T> result)
    {
        Assert.Null(result.Failure);
        Assert.NotNull(result.Value);
        return result.Value.Data;
    }
}
