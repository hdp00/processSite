using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using FlowPilot.Infrastructure.ProcessInstances;

namespace FlowPilot.SqlServerTests;

public sealed class ProcessInstanceApprovalAssigneeIntegrationTests
{
    [Fact]
    public async Task EditableApprovalDetailReturnsNamedCandidatesWithoutManagementDirectory()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var initiatorId = await scope.AddUserAsync("approval-initiator@example.test", cancellationToken);
        var firstCandidateId = await scope.AddUserAsync("approval-candidate-a@example.test", cancellationToken);
        var secondCandidateId = await scope.AddUserAsync("approval-candidate-b@example.test", cancellationToken);
        var groupId = await scope.AddWorkflowGroupAsync(
            cancellationToken,
            ["review"],
            [firstCandidateId, secondCandidateId]);
        var now = DateTime.UtcNow;
        var definitionId = Guid.NewGuid();
        var versionId = Guid.NewGuid();
        var instanceId = Guid.NewGuid();

        var definition = new RuntimeWorkflowDefinition
        {
            Id = definitionId,
            Code = $"APPROVAL-{definitionId:N}",
            NormalizedCode = $"APPROVAL-{definitionId:N}",
            Name = "审核人员显示测试",
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
            BasicJson = "{}",
            SnapshotJson =
                """
                {
                  "form": { "fields": [] },
                  "flow": {
                    "nodes": [
                      { "id": "approval-node", "data": { "kind": "approval", "handlingMode": "approval", "editableFieldIds": [] } }
                    ],
                    "edges": []
                  }
                }
                """,
            InstanceCount = 1,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);
        definition.PublishedVersionId = versionId;
        scope.Context.WorkflowInstances.Add(new WorkflowInstanceEntity
        {
            Id = instanceId,
            InstanceNumber = "PDF-26090003",
            DefinitionId = definitionId,
            VersionId = versionId,
            InitiatorUserId = initiatorId,
            ActualInitiatorUserId = initiatorId,
            Title = "审核人员显示测试",
            Status = "reviewing",
            CurrentRound = 1,
            CurrentNodeSummary = "审核节点",
            VerifiedEntryBaseUrl = "https://flowpilot.example/flowpilot",
            FormValuesJson = "{}",
            FieldRevisionsJson = "{}",
            CreatedAt = now,
            UpdatedAt = now,
            SubmittedAt = now,
            Revision = 1,
        });
        scope.Context.WorkflowTasks.Add(new WorkflowTaskEntity
        {
            Id = Guid.NewGuid(),
            TaskType = "approval",
            InstanceId = instanceId,
            VersionId = versionId,
            Round = 1,
            Status = "pending",
            ActivatedAt = now,
            Revision = 1,
            NodeId = "approval-node",
            NodeNameSnapshot = "审核节点",
            GroupId = groupId,
            DefaultAssigneeId = firstCandidateId,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);
        scope.Context.ChangeTracker.Clear();

        var result = await new SqlServerProcessInstanceQueryService(scope.Context).GetAsync(
            instanceId,
            new ProcessInstanceQueryActor(
                initiatorId,
                IsSuperAdmin: false,
                CanReview: false,
                CanResubmit: true,
                CanClose: false,
                CanViewAllInstances: false),
            cancellationToken);

        Assert.Null(result.Error);
        var detail = Assert.IsType<ProcessInstanceDetailDto>(result.Instance);
        var candidates = Assert.IsAssignableFrom<IReadOnlyList<FlowPilot.Application.TaskCenter.TaskCenterUserRefDto>>(
            detail.ApprovalAssigneeCandidatesByNode!["approval-node"]);
        Assert.Equal(
            new[] { firstCandidateId, secondCandidateId }.Order().ToArray(),
            candidates.Select(candidate => candidate.Id).Order().ToArray());
        Assert.All(candidates, candidate => Assert.StartsWith("测试用户-", candidate.Name));
    }
}
