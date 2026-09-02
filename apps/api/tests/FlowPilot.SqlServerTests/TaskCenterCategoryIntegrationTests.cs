using FlowPilot.Application.TaskCenter;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Persistence;
using FlowPilot.Infrastructure.ProcessInstances;
using FlowPilot.Infrastructure.TaskCenter;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

public sealed class TaskCenterCategoryIntegrationTests
{
    [Fact]
    public async Task SuperAdministratorCanOpenAnyInstanceWhileUnrelatedUserCannot()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var initiatorId = await scope.AddUserAsync("instance-initiator@example.test", cancellationToken);
        var outsiderId = await scope.AddUserAsync("instance-outsider@example.test", cancellationToken);
        var groupId = await scope.AddWorkflowGroupAsync(cancellationToken, ["review"]);
        var definition = await AddDefinitionAsync(scope, "超级管理员可见流程", DateTime.UtcNow, cancellationToken);
        var instanceId = AddApprovalInstance(
            scope,
            definition,
            "SUPER-VIEW-1",
            groupId,
            initiatorId,
            DateTime.UtcNow,
            initiatorUserId: initiatorId);
        await scope.Context.SaveChangesAsync(cancellationToken);
        scope.Context.ChangeTracker.Clear();
        var service = new SqlServerProcessInstanceQueryService(scope.Context);

        var superAdministratorResult = await service.GetAsync(
            instanceId,
            new ProcessInstanceQueryActor(
                scope.AdministratorUserId,
                IsSuperAdmin: true,
                CanReview: true,
                CanResubmit: true,
                CanClose: true,
                CanViewAllInstances: true),
            cancellationToken);
        Assert.NotNull(superAdministratorResult.Instance);
        Assert.Null(superAdministratorResult.Error);

        var outsiderResult = await service.GetAsync(
            instanceId,
            new ProcessInstanceQueryActor(
                outsiderId,
                IsSuperAdmin: false,
                CanReview: false,
                CanResubmit: false,
                CanClose: false,
                CanViewAllInstances: false),
            cancellationToken);
        Assert.Null(outsiderResult.Instance);
        Assert.Equal(ProcessInstanceQueryError.Forbidden, outsiderResult.Error);
    }

    [Fact]
    public async Task CategoriesCountAllMatchingInstancesAndIgnorePageAndDefinitionFilter()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var groupId = await scope.AddWorkflowGroupAsync(cancellationToken, ["review"]);
        var now = DateTime.UtcNow;
        var first = await AddDefinitionAsync(scope, "任务分类甲", now, cancellationToken);
        var second = await AddDefinitionAsync(scope, "任务分类乙", now.AddSeconds(1), cancellationToken);
        AddApprovalInstance(scope, first, "TASK-A1", groupId, scope.AdministratorUserId, now, twoTasks: true);
        AddApprovalInstance(scope, first, "TASK-A2", groupId, scope.AdministratorUserId, now.AddMinutes(1));
        AddApprovalInstance(scope, second, "TASK-B1", groupId, scope.AdministratorUserId, now.AddMinutes(2));
        await scope.Context.SaveChangesAsync(cancellationToken);
        scope.Context.ChangeTracker.Clear();

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:FlowPilot"] = scope.Context.Database.GetConnectionString(),
            })
            .Build();
        var service = new SqlServerTaskCenterQueryService(configuration, FlowPilotDatabaseOptions.Default);
        var actor = new TaskCenterActor(
            scope.AdministratorUserId,
            IsSuperAdmin: true,
            CanReview: true,
            CanResubmit: true,
            CanViewAllInstances: true);

        var firstPage = await service.ListTasksAsync(
            actor,
            new WorkflowTaskPageQuery(1, 1, "assigned", null, null),
            cancellationToken);
        Assert.Single(firstPage.Items);
        Assert.Equal(3, firstPage.Meta.Total);
        Assert.Equal(2, firstPage.Categories.Single(item => item.DefinitionId == first.DefinitionId).Count);
        Assert.Equal(1, firstPage.Categories.Single(item => item.DefinitionId == second.DefinitionId).Count);

        var filtered = await service.ListTasksAsync(
            actor,
            new WorkflowTaskPageQuery(1, 20, "assigned", null, second.DefinitionId),
            cancellationToken);
        var filteredItem = Assert.Single(filtered.Items);
        Assert.Equal(second.DefinitionId, filteredItem.Instance.DefinitionId);
        Assert.Equal(1, filtered.Meta.Total);
        Assert.Equal(2, filtered.Categories.Count);
        Assert.Equal(2, filtered.Categories.Single(item => item.DefinitionId == first.DefinitionId).Count);

        var allItems = await service.ListTasksAsync(
            actor,
            new WorkflowTaskPageQuery(1, 20, "assigned", null, null),
            cancellationToken);
        Assert.All(
            allItems.Items.SelectMany(item => item.Tasks),
            task => Assert.Equal("超级管理员", task.DefaultAssignee?.Name));
    }

    private static async Task<DefinitionSeed> AddDefinitionAsync(
        SqlServerRuntimeTestScope scope,
        string name,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var definitionId = Guid.NewGuid();
        var versionId = Guid.NewGuid();
        var definition = new RuntimeWorkflowDefinition
        {
            Id = definitionId,
            Code = $"TASK-{definitionId:N}",
            NormalizedCode = $"TASK-{definitionId:N}",
            Name = name,
            Type = "approval",
            NextVersionNumber = 2,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        };
        scope.Context.RuntimeWorkflowDefinitions.Add(definition);
        await scope.Context.SaveChangesAsync(cancellationToken);
        scope.Context.RuntimeWorkflowVersions.Add(new RuntimeWorkflowVersion
        {
            Id = versionId,
            DefinitionId = definitionId,
            VersionNumber = 1,
            VersionLabel = "V1",
            BasicJson = $"{{\"name\":\"{name}\"}}",
            SnapshotJson =
                """
                {
                  "systemFields": [],
                  "form": { "fields": [] },
                  "flow": {
                    "nodes": [
                      { "id": "node-a", "data": { "kind": "approval", "handlingMode": "approval", "editableFieldIds": [] } },
                      { "id": "node-b", "data": { "kind": "approval", "handlingMode": "approval", "editableFieldIds": [] } }
                    ],
                    "edges": []
                  }
                }
                """,
            InstanceCount = 0,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);
        definition.PublishedVersionId = versionId;
        await scope.Context.SaveChangesAsync(cancellationToken);
        return new DefinitionSeed(definitionId, versionId);
    }

    private static Guid AddApprovalInstance(
        SqlServerRuntimeTestScope scope,
        DefinitionSeed definition,
        string instanceNumber,
        Guid groupId,
        Guid defaultAssigneeId,
        DateTime now,
        bool twoTasks = false,
        Guid? initiatorUserId = null)
    {
        var instanceId = Guid.NewGuid();
        var initiator = initiatorUserId ?? scope.AdministratorUserId;
        scope.Context.WorkflowInstances.Add(new WorkflowInstanceEntity
        {
            Id = instanceId,
            InstanceNumber = instanceNumber,
            DefinitionId = definition.DefinitionId,
            VersionId = definition.VersionId,
            InitiatorUserId = initiator,
            ActualInitiatorUserId = initiator,
            Title = instanceNumber,
            Status = "reviewing",
            CurrentRound = 1,
            CurrentNodeSummary = twoTasks ? "审批节点甲、审批节点乙" : "审批节点甲",
            VerifiedEntryBaseUrl = "https://flowpilot.example/flowpilot",
            FormValuesJson = "{}",
            FieldRevisionsJson = "{}",
            CreatedAt = now,
            UpdatedAt = now,
            SubmittedAt = now,
            Revision = 1,
        });
        scope.Context.WorkflowTasks.Add(CreateTask(instanceId, definition.VersionId, groupId, defaultAssigneeId, "node-a", "审批节点甲", now));
        if (twoTasks)
        {
            scope.Context.WorkflowTasks.Add(CreateTask(instanceId, definition.VersionId, groupId, defaultAssigneeId, "node-b", "审批节点乙", now));
        }

        return instanceId;
    }

    private static WorkflowTaskEntity CreateTask(
        Guid instanceId,
        Guid versionId,
        Guid groupId,
        Guid defaultAssigneeId,
        string nodeId,
        string nodeName,
        DateTime now) => new()
        {
            Id = Guid.NewGuid(),
            TaskType = "approval",
            InstanceId = instanceId,
            VersionId = versionId,
            Round = 1,
            Status = "pending",
            ActivatedAt = now,
            Revision = 1,
            NodeId = nodeId,
            NodeNameSnapshot = nodeName,
            GroupId = groupId,
            DefaultAssigneeId = defaultAssigneeId,
        };

    private sealed record DefinitionSeed(Guid DefinitionId, Guid VersionId);
}
