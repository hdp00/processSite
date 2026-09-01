using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.BackgroundJobs;
using FlowPilot.Infrastructure.Persistence;
using FlowPilot.Infrastructure.ProcessInstances;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class ProcessInstanceFreeAccessIntegrationTests
{
    [Fact]
    public async Task ReviewGroupMemberCanTransferWithoutLoadingManagementDirectory()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var seed = await SeedFreeFlowAsync(scope, cancellationToken);

        var service = new SqlServerProcessInstanceQueryService(scope.Context);
        var result = await service.GetAsync(
            seed.InstanceId,
            new ProcessInstanceQueryActor(
                seed.GroupMemberId,
                IsSuperAdmin: false,
                CanReview: false,
                CanResubmit: false,
                CanClose: false,
                CanViewAllInstances: false),
            cancellationToken);

        Assert.Null(result.Error);
        var detail = Assert.IsType<ProcessInstanceDetailDto>(result.Instance);
        Assert.True(detail.CanTransferFree);
        Assert.False(detail.CanClose);
        Assert.Equal(
            new[] { seed.CurrentAssigneeId, seed.GroupMemberId }.Order().ToArray(),
            detail.FreeAssigneeCandidates!.Select(item => item.Id).Order().ToArray());

        var closerResult = await service.GetAsync(
            seed.InstanceId,
            new ProcessInstanceQueryActor(
                seed.StarterMemberId,
                IsSuperAdmin: false,
                CanReview: false,
                CanResubmit: false,
                CanClose: true,
                CanViewAllInstances: false),
            cancellationToken);
        Assert.True(Assert.IsType<ProcessInstanceDetailDto>(closerResult.Instance).CanClose);
    }

    [Theory]
    [InlineData(null, false, false)]
    [InlineData("<p>交接时补充处理说明</p>", true, false)]
    [InlineData(null, false, true)]
    public async Task TransferSupportsWithOrWithoutReply(
        string? content,
        bool expectsReply,
        bool useStarterMember)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var seed = await SeedFreeFlowAsync(scope, cancellationToken);
        var service = new SqlServerProcessInstanceCommandService(
            scope.Context,
            TimeProvider.System,
            new EmailOutboxWriter(scope.Context));

        var idempotencyKey = Guid.NewGuid().ToString();
        var request = new TransferFreeCollaborationRequest
        {
            NextAssigneeId = seed.GroupMemberId,
            Content = content,
        };
        var actorId = useStarterMember ? seed.StarterMemberId : seed.GroupMemberId;
        var actor = new ProcessInstanceActor(
            actorId,
            actorId,
            IsSuperAdmin: false,
            CanCopyCompletedInstance: false,
            CanReview: false,
            CanClose: false,
            EffectiveUserName: useStarterMember ? "发起权限组成员" : "受理权限组成员",
            EffectiveUserDepartmentPath: string.Empty);
        var result = await service.TransferFreeAsync(
            seed.InstanceId,
            request,
            actor,
            expectedRevision: 1,
            idempotencyKey,
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);

        Assert.True(result.Succeeded, result.Failure?.Detail);
        var replay = await service.TransferFreeAsync(
            seed.InstanceId,
            request,
            actor,
            expectedRevision: 1,
            idempotencyKey,
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(replay.Succeeded, replay.Failure?.Detail);
        Assert.True(replay.Value!.Replayed);

        scope.Context.ChangeTracker.Clear();
        var instance = await scope.Context.WorkflowInstances.SingleAsync(
            item => item.Id == seed.InstanceId,
            cancellationToken);
        var tasks = await scope.Context.WorkflowTasks
            .Where(item => item.InstanceId == seed.InstanceId)
            .OrderBy(item => item.ActivatedAt)
            .ToArrayAsync(cancellationToken);
        var timeline = await scope.Context.FreeTimelineEntries
            .Where(item => item.InstanceId == seed.InstanceId)
            .ToArrayAsync(cancellationToken);
        var notifications = await scope.Context.RuntimeEmailOutboxMessages
            .Where(item => item.InstanceId == seed.InstanceId
                && item.EventType == "free-collaboration-assigned")
            .ToArrayAsync(cancellationToken);

        Assert.Equal(seed.GroupMemberId, instance.CurrentAssigneeId);
        Assert.Equal(2, tasks.Length);
        Assert.Equal("completed", tasks[0].Status);
        Assert.Equal(seed.CurrentAssigneeId, tasks[0].AssigneeId);
        Assert.Equal("pending", tasks[1].Status);
        Assert.Equal(seed.GroupMemberId, tasks[1].AssigneeId);
        var transfer = Assert.Single(timeline, item => item.EntryType == "transferred");
        Assert.Equal(seed.CurrentAssigneeId, transfer.PreviousAssigneeId);
        Assert.Equal(seed.GroupMemberId, transfer.AssigneeId);
        Assert.Equal(expectsReply ? 1 : 0, timeline.Count(item => item.EntryType == "reply"));
        var notification = Assert.Single(notifications);
        Assert.Equal(seed.GroupMemberId, notification.RecipientUserId);
    }

    [Fact]
    public async Task ReplyAndEditKeepCurrentTaskAndAssignee()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var seed = await SeedFreeFlowAsync(scope, cancellationToken);
        var service = new SqlServerProcessInstanceCommandService(
            scope.Context,
            TimeProvider.System,
            new EmailOutboxWriter(scope.Context));

        var result = await service.AddFreeReplyAsync(
            seed.InstanceId,
            new CreateFreeReplyRequest { Content = "<p>仅回复，不变更受理人</p>" },
            new ProcessInstanceActor(
                seed.CurrentAssigneeId,
                seed.CurrentAssigneeId,
                IsSuperAdmin: false,
                CanCopyCompletedInstance: false,
                CanReview: false,
                CanClose: false,
                EffectiveUserName: "当前受理人",
                EffectiveUserDepartmentPath: string.Empty),
            expectedRevision: 1,
            idempotencyKey: Guid.NewGuid().ToString(),
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);

        Assert.True(result.Succeeded, result.Failure?.Detail);
        scope.Context.ChangeTracker.Clear();

        var edited = await service.EditFreeReplyAsync(
            seed.InstanceId,
            result.Value!.EntryId,
            new EditFreeReplyRequest { Content = "<p>修改后的回复内容</p>" },
            new ProcessInstanceActor(
                seed.CurrentAssigneeId,
                seed.CurrentAssigneeId,
                IsSuperAdmin: false,
                CanCopyCompletedInstance: false,
                CanReview: false,
                CanClose: false,
                EffectiveUserName: "当前受理人",
                EffectiveUserDepartmentPath: string.Empty),
            expectedRevision: result.Value.Revision,
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(edited.Succeeded, edited.Failure?.Detail);

        scope.Context.ChangeTracker.Clear();
        var instance = await scope.Context.WorkflowInstances.SingleAsync(
            item => item.Id == seed.InstanceId,
            cancellationToken);
        var task = await scope.Context.WorkflowTasks.SingleAsync(
            item => item.InstanceId == seed.InstanceId,
            cancellationToken);
        var timeline = await scope.Context.FreeTimelineEntries
            .Where(item => item.InstanceId == seed.InstanceId)
            .ToArrayAsync(cancellationToken);

        Assert.Equal(seed.CurrentAssigneeId, instance.CurrentAssigneeId);
        Assert.Equal("pending", task.Status);
        Assert.Equal(seed.CurrentAssigneeId, task.AssigneeId);
        var reply = Assert.Single(timeline, item => item.EntryType == "reply");
        Assert.Equal("<p>修改后的回复内容</p>", reply.Content);
        Assert.NotNull(reply.EditedAt);
        Assert.Single(timeline, item => item.EntryType == "reply-edited");
        Assert.DoesNotContain(timeline, item => item.EntryType == "transferred");
    }

    [Fact]
    public async Task InitiatorCanUpdateFreeInitialFormWithoutChangingCurrentTask()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var seed = await SeedFreeFlowAsync(scope, cancellationToken);
        var service = new SqlServerProcessInstanceCommandService(
            scope.Context,
            TimeProvider.System,
            new EmailOutboxWriter(scope.Context));
        var initiator = new ProcessInstanceActor(
            seed.InitiatorId,
            seed.InitiatorId,
            IsSuperAdmin: false,
            CanCopyCompletedInstance: false,
            CanReview: false,
            CanClose: false,
            EffectiveUserName: "流程发起人",
            EffectiveUserDepartmentPath: string.Empty);

        var result = await service.UpdateFreeInitialFormAsync(
            seed.InstanceId,
            new UpdateProcessInstanceSubmissionRequest
            {
                FormValues = new JsonObject { ["title"] = "修改后的自由协作标题" },
            },
            initiator,
            expectedRevision: 1,
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);

        Assert.True(result.Succeeded, result.Failure?.Detail);
        scope.Context.ChangeTracker.Clear();
        var instance = await scope.Context.WorkflowInstances.SingleAsync(
            item => item.Id == seed.InstanceId,
            cancellationToken);
        var task = await scope.Context.WorkflowTasks.SingleAsync(
            item => item.InstanceId == seed.InstanceId,
            cancellationToken);
        var formEdited = await scope.Context.FreeTimelineEntries.SingleAsync(
            item => item.InstanceId == seed.InstanceId && item.EntryType == "form-edited",
            cancellationToken);

        Assert.Equal("修改后的自由协作标题", instance.Title);
        Assert.Equal(seed.CurrentAssigneeId, instance.CurrentAssigneeId);
        Assert.Equal("pending", task.Status);
        Assert.Contains("title", formEdited.FieldChangesJson);
    }

    [Fact]
    public async Task CloseAndReopenKeepTaskTimelineAndNotificationsConsistent()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var seed = await SeedFreeFlowAsync(scope, cancellationToken);
        var service = new SqlServerProcessInstanceCommandService(
            scope.Context,
            TimeProvider.System,
            new EmailOutboxWriter(scope.Context));
        var initiator = new ProcessInstanceActor(
            seed.InitiatorId,
            seed.InitiatorId,
            IsSuperAdmin: false,
            CanCopyCompletedInstance: false,
            CanReview: false,
            CanClose: true,
            EffectiveUserName: "流程发起人",
            EffectiveUserDepartmentPath: string.Empty);

        var closed = await service.CloseFreeAsync(
            seed.InstanceId,
            new CloseInstanceRequest { Reason = "事项处理完成" },
            initiator,
            expectedRevision: 1,
            idempotencyKey: Guid.NewGuid().ToString(),
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(closed.Succeeded, closed.Failure?.Detail);
        scope.Context.ChangeTracker.Clear();

        var reopened = await service.ReopenFreeAsync(
            seed.InstanceId,
            new ReopenFreeCollaborationRequest
            {
                Reason = "需要继续补充",
                AssigneeId = seed.GroupMemberId,
            },
            initiator,
            expectedRevision: closed.Value!.Revision,
            idempotencyKey: Guid.NewGuid().ToString(),
            traceId: Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(reopened.Succeeded, reopened.Failure?.Detail);

        scope.Context.ChangeTracker.Clear();
        var instance = await scope.Context.WorkflowInstances.SingleAsync(
            item => item.Id == seed.InstanceId,
            cancellationToken);
        var tasks = await scope.Context.WorkflowTasks
            .Where(item => item.InstanceId == seed.InstanceId)
            .OrderBy(item => item.ActivatedAt)
            .ToArrayAsync(cancellationToken);
        var timelineTypes = await scope.Context.FreeTimelineEntries
            .Where(item => item.InstanceId == seed.InstanceId)
            .OrderBy(item => item.OccurredAt)
            .Select(item => item.EntryType)
            .ToArrayAsync(cancellationToken);
        var notifications = await scope.Context.RuntimeEmailOutboxMessages
            .Where(item => item.InstanceId == seed.InstanceId)
            .Select(item => new { item.EventType, item.RecipientUserId })
            .ToArrayAsync(cancellationToken);

        Assert.Equal("in-progress", instance.Status);
        Assert.Equal(seed.GroupMemberId, instance.CurrentAssigneeId);
        Assert.Equal(2, tasks.Length);
        Assert.Equal("cancelled", tasks[0].Status);
        Assert.Equal("pending", tasks[1].Status);
        Assert.Equal(["closed", "reopened"], timelineTypes);
        Assert.Contains(notifications, item =>
            item.EventType == "free-collaboration-closed"
            && item.RecipientUserId == seed.InitiatorId);
        Assert.Contains(notifications, item =>
            item.EventType == "free-collaboration-assigned"
            && item.RecipientUserId == seed.GroupMemberId);
    }

    [Fact]
    public async Task TransferRejectsUnauthorizedUnchangedInvalidAndStaleRequestsWithoutMutation()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var seed = await SeedFreeFlowAsync(scope, cancellationToken);
        var service = new SqlServerProcessInstanceCommandService(
            scope.Context,
            TimeProvider.System,
            new EmailOutboxWriter(scope.Context));
        var outsider = Actor(seed.OutsiderId, "无关用户");
        var groupMember = Actor(seed.GroupMemberId, "受理权限组成员");

        var unauthorized = await service.TransferFreeAsync(
            seed.InstanceId,
            new TransferFreeCollaborationRequest { NextAssigneeId = seed.GroupMemberId },
            outsider,
            1,
            Guid.NewGuid().ToString(),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        var unchanged = await service.TransferFreeAsync(
            seed.InstanceId,
            new TransferFreeCollaborationRequest { NextAssigneeId = seed.CurrentAssigneeId },
            groupMember,
            1,
            Guid.NewGuid().ToString(),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        var invalid = await service.TransferFreeAsync(
            seed.InstanceId,
            new TransferFreeCollaborationRequest { NextAssigneeId = seed.OutsiderId },
            groupMember,
            1,
            Guid.NewGuid().ToString(),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        var stale = await service.TransferFreeAsync(
            seed.InstanceId,
            new TransferFreeCollaborationRequest { NextAssigneeId = seed.GroupMemberId },
            groupMember,
            0,
            Guid.NewGuid().ToString(),
            Guid.NewGuid().ToString("N"),
            cancellationToken);

        Assert.Equal("FREE_TRANSFER_FORBIDDEN", unauthorized.Failure?.Code);
        Assert.Equal("ASSIGNEE_UNCHANGED", unchanged.Failure?.Code);
        Assert.Equal("ASSIGNEE_INVALID", invalid.Failure?.Code);
        Assert.Equal("REVISION_MISMATCH", stale.Failure?.Code);
        scope.Context.ChangeTracker.Clear();
        var instance = await scope.Context.WorkflowInstances.SingleAsync(
            item => item.Id == seed.InstanceId,
            cancellationToken);
        Assert.Equal(1, instance.Revision);
        Assert.Equal(seed.CurrentAssigneeId, instance.CurrentAssigneeId);
        Assert.Single(await scope.Context.WorkflowTasks
            .Where(item => item.InstanceId == seed.InstanceId && item.Status == "pending")
            .ToArrayAsync(cancellationToken));
    }

    private static async Task<FreeFlowSeed> SeedFreeFlowAsync(
        SqlServerRuntimeTestScope scope,
        CancellationToken cancellationToken)
    {
        var runId = Guid.NewGuid().ToString("N");
        var initiatorId = await scope.AddUserAsync($"free-initiator-{runId}@example.test", cancellationToken);
        var starterMemberId = await scope.AddUserAsync($"free-starter-member-{runId}@example.test", cancellationToken);
        var groupMemberId = await scope.AddUserAsync($"free-group-member-{runId}@example.test", cancellationToken);
        var currentAssigneeId = await scope.AddUserAsync($"free-current-assignee-{runId}@example.test", cancellationToken);
        var outsiderId = await scope.AddUserAsync($"free-outsider-{runId}@example.test", cancellationToken);
        var starterGroupId = await scope.AddWorkflowGroupAsync(
            cancellationToken,
            ["start", "close"],
            [initiatorId, starterMemberId]);
        var assigneeGroupId = await scope.AddWorkflowGroupAsync(
            cancellationToken,
            ["review"],
            [groupMemberId, currentAssigneeId]);

        var now = DateTime.UtcNow;
        var definitionId = Guid.NewGuid();
        var versionId = Guid.NewGuid();
        var instanceId = Guid.NewGuid();
        scope.Context.RuntimeWorkflowDefinitions.Add(new RuntimeWorkflowDefinition
        {
            Id = definitionId,
            Code = $"FREE-{definitionId:N}",
            NormalizedCode = $"FREE-{definitionId:N}",
            Name = "自由协作权限测试",
            Type = "free",
            NextVersionNumber = 2,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);

        scope.Context.RuntimeWorkflowVersions.Add(new RuntimeWorkflowVersion
        {
            Id = versionId,
            DefinitionId = definitionId,
            VersionNumber = 1,
            VersionLabel = "V1",
            BasicJson = "{}",
            SnapshotJson = "{\"form\":{\"fields\":[{\"id\":\"title\",\"type\":\"text\",\"label\":\"标题\",\"required\":true,\"inputStage\":\"initiator\"}]},\"flow\":{\"nodes\":[]}}",
            InstanceCount = 1,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        });
        scope.Context.RuntimeWorkflowGroupReferences.AddRange(
            new RuntimeWorkflowGroupReference
            {
                Id = Guid.NewGuid(),
                VersionId = versionId,
                GroupId = starterGroupId,
                Purpose = "start",
            },
            new RuntimeWorkflowGroupReference
            {
                Id = Guid.NewGuid(),
                VersionId = versionId,
                GroupId = assigneeGroupId,
                Purpose = "review",
            },
            new RuntimeWorkflowGroupReference
            {
                Id = Guid.NewGuid(),
                VersionId = versionId,
                GroupId = starterGroupId,
                Purpose = "close",
            });
        await scope.Context.SaveChangesAsync(cancellationToken);

        scope.Context.WorkflowInstances.Add(new WorkflowInstanceEntity
        {
            Id = instanceId,
            InstanceNumber = "FREE26090001",
            DefinitionId = definitionId,
            VersionId = versionId,
            InitiatorUserId = initiatorId,
            ActualInitiatorUserId = initiatorId,
            Title = "确认变更受理人权限",
            Status = "in-progress",
            CurrentRound = 1,
            CurrentAssigneeId = currentAssigneeId,
            VerifiedEntryBaseUrl = "https://flowpilot.example/flowpilot",
            FormValuesJson = "{\"title\":\"确认变更受理人权限\"}",
            FieldRevisionsJson = "{}",
            CreatedAt = now,
            UpdatedAt = now,
            SubmittedAt = now,
            Revision = 1,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);

        scope.Context.FreeParticipants.AddRange(
            Participant(instanceId, initiatorId, now),
            Participant(instanceId, currentAssigneeId, now));
        scope.Context.WorkflowTasks.Add(new WorkflowTaskEntity
        {
            Id = Guid.NewGuid(),
            TaskType = "free-collaboration",
            InstanceId = instanceId,
            VersionId = versionId,
            AssigneeId = currentAssigneeId,
            Round = 1,
            Status = "pending",
            ActivatedAt = now,
            Revision = 1,
        });
        await scope.Context.SaveChangesAsync(cancellationToken);
        scope.Context.ChangeTracker.Clear();
        return new FreeFlowSeed(
            instanceId,
            initiatorId,
            starterMemberId,
            groupMemberId,
            currentAssigneeId,
            outsiderId);
    }

    private static FreeParticipantEntity Participant(Guid instanceId, Guid userId, DateTime now) => new()
    {
        InstanceId = instanceId,
        UserId = userId,
        SourceFlags = 1,
        FirstParticipatedAt = now,
        LastParticipatedAt = now,
    };

    private static ProcessInstanceActor Actor(Guid userId, string name) => new(
        userId,
        userId,
        IsSuperAdmin: false,
        CanCopyCompletedInstance: false,
        CanReview: false,
        CanClose: false,
        EffectiveUserName: name,
        EffectiveUserDepartmentPath: string.Empty);

    private sealed record FreeFlowSeed(
        Guid InstanceId,
        Guid InitiatorId,
        Guid StarterMemberId,
        Guid GroupMemberId,
        Guid CurrentAssigneeId,
        Guid OutsiderId);
}
