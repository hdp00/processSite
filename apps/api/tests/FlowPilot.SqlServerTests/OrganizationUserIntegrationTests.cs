using FlowPilot.Application.Organization;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Organization;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class OrganizationUserIntegrationTests
{
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

        var configuration = SqlServerTestConfiguration.Load();
        configuration["ConnectionStrings:FlowPilot"] = scope.Context.Database.GetConnectionString();
        var service = new SqlServerOrganizationService(
            configuration,
            FlowPilotDatabaseOptions.FromConfiguration(configuration),
            scope.Context,
            TimeProvider.System);
        var users = await service.ListUsersAsync(
            new OrganizationPageQuery(1, 200),
            cancellationToken);

        Assert.Equal(
            loginAt,
            Assert.Single(users.Items, item => item.Id == scope.AdministratorUserId).LastLoginAt);
        Assert.Null(Assert.Single(users.Items, item => item.Id == targetUserId).LastLoginAt);
    }
}
