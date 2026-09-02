using FlowPilot.Application.Organization;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Organization;
using FlowPilot.Infrastructure.ProcessDefinitions;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class WorkflowGroupReferenceIntegrationTests
{
    [Fact]
    public async Task DeletingDraftDefinitionRemovesItsWorkflowGroupReference()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var memberId = await scope.AddUserAsync("group-reference@example.test", cancellationToken);
        var groupId = await scope.AddWorkflowGroupAsync(
            cancellationToken,
            ["start", "close"],
            [memberId]);
        var definitionService = new SqlServerProcessDefinitionCommandService(
            scope.Context,
            FlowPilotDatabaseOptions.Default,
            TimeProvider.System);
        var actor = new ProcessDefinitionMutationActor(
            scope.AdministratorUserId,
            scope.AdministratorUserId,
            "超级管理员");
        var suffix = Guid.NewGuid().ToString("N")[..8];

        var createResult = await definitionService.CreateAsync(
            new ProcessBasicConfigInput
            {
                Name = $"权限组引用-{suffix}",
                InstancePrefix = $"R{suffix}",
                Type = "approval",
                Description = "验证删除流程定义后权限组不再保留失效引用。",
                StarterGroupIds = [groupId],
                CloseGroupIds = [groupId],
            },
            actor,
            Guid.NewGuid().ToString("N"),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(createResult.Succeeded, createResult.Failure?.Detail);
        var definition = createResult.Value!.Response.Definition;

        var organizationService = CreateOrganizationService(scope);
        var referencedGroup = await organizationService.GetWorkflowGroupAsync(groupId, cancellationToken);
        Assert.NotNull(referencedGroup);
        Assert.Equal(
            definition.Id,
            Assert.Single(referencedGroup.ReferencedProcesses).Id);

        var deleteResult = await definitionService.DeleteDefinitionAsync(
            definition.Id,
            definition.Revision,
            actor,
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(deleteResult.Succeeded, deleteResult.Failure?.Detail);

        var groupAfterDelete = await organizationService.GetWorkflowGroupAsync(groupId, cancellationToken);
        Assert.NotNull(groupAfterDelete);
        Assert.Empty(groupAfterDelete.ReferencedProcesses);
    }

    private static SqlServerOrganizationService CreateOrganizationService(SqlServerRuntimeTestScope scope)
    {
        var configuration = SqlServerTestConfiguration.Load();
        configuration["ConnectionStrings:FlowPilot"] = scope.Context.Database.GetConnectionString();
        return new SqlServerOrganizationService(
            configuration,
            FlowPilotDatabaseOptions.FromConfiguration(configuration),
            scope.Context,
            TimeProvider.System);
    }
}
