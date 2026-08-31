using System.Text.Json.Nodes;
using FlowPilot.Infrastructure.BackgroundJobs;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class EmailOutboxWriterIntegrationTests
{
    [Fact]
    public async Task TaskActivationFreezesRecipientAndDeduplicatesParallelNodes()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateAsync(cancellationToken);
        var recipientId = await scope.AddUserAsync("before@example.test", cancellationToken);
        var groupId = await scope.AddWorkflowGroupAsync(cancellationToken);
        var now = new DateTimeOffset(2026, 8, 31, 2, 0, 0, TimeSpan.Zero);
        var snapshot = JsonNode.Parse(
            $$"""
            {
              "flow": {
                "nodes": [
                  { "id": "review-a", "data": { "kind": "approval", "emailNotification": {
                    "enabled": true, "notifyReviewers": false, "extraUserIds": ["{{recipientId}}"] } } },
                  { "id": "review-b", "data": { "kind": "approval", "emailNotification": {
                    "enabled": true, "notifyReviewers": false, "extraUserIds": ["{{recipientId}}"] } } }
                ]
              }
            }
            """)!.AsObject();
        var seed = await AddRuntimeAsync(scope, snapshot, "reviewing", now, cancellationToken);
        var firstTask = CreateTask(seed.Instance.Id, seed.Version.Id, groupId, "review-a", now);
        var secondTask = CreateTask(seed.Instance.Id, seed.Version.Id, groupId, "review-b", now);
        scope.Context.WorkflowTasks.AddRange(firstTask, secondTask);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var writer = new EmailOutboxWriter(scope.Context);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [firstTask, secondTask],
            now,
            cancellationToken);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [firstTask, secondTask],
            now,
            cancellationToken);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var messages = await scope.Context.RuntimeEmailOutboxMessages
            .Where(item => item.InstanceId == seed.Instance.Id)
            .ToArrayAsync(cancellationToken);
        var message = Assert.Single(messages);
        Assert.Equal("task-activated", message.EventType);
        Assert.Equal(recipientId, message.RecipientUserId);
        Assert.Equal("before@example.test", message.RecipientEmailSnapshot);
        Assert.Equal("pending", message.Status);
        Assert.StartsWith("https://flowpilot.example/flowpilot/processes/", message.ResolvedTargetUrl);

        await scope.Context.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE [flowpilot].[users] SET [email] = {"after@example.test"} WHERE [id] = {recipientId};",
            cancellationToken);
        scope.Context.ChangeTracker.Clear();

        Assert.Equal(
            "before@example.test",
            await scope.Context.RuntimeEmailOutboxMessages
                .Where(item => item.Id == message.Id)
                .Select(item => item.RecipientEmailSnapshot)
                .SingleAsync(cancellationToken));
    }

    [Fact]
    public async Task CompletionWithoutVerifiedEntryCreatesAnImmediateDeadLetter()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateAsync(cancellationToken);
        var recipientId = await scope.AddUserAsync("completion@example.test", cancellationToken);
        var now = new DateTimeOffset(2026, 8, 31, 3, 0, 0, TimeSpan.Zero);
        var snapshot = JsonNode.Parse(
            $$"""
            { "flow": { "nodes": [
              { "id": "end", "data": { "kind": "end", "emailNotification": {
                "enabled": true, "notifyInitiator": false, "extraUserIds": ["{{recipientId}}"] } } }
            ] } }
            """)!.AsObject();
        var seed = await AddRuntimeAsync(scope, snapshot, "completed", now, cancellationToken);
        seed.Instance.VerifiedEntryBaseUrl = null;
        seed.Instance.CompletedAt = now.UtcDateTime;
        await scope.Context.SaveChangesAsync(cancellationToken);

        var writer = new EmailOutboxWriter(scope.Context);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [],
            now,
            cancellationToken);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var message = await scope.Context.RuntimeEmailOutboxMessages
            .SingleAsync(item => item.InstanceId == seed.Instance.Id, cancellationToken);
        Assert.Equal("dead-letter", message.Status);
        Assert.Equal("ENTRY_BASE_URL_MISSING", message.LastErrorCode);
        Assert.Equal(now.UtcDateTime, message.DeadLetteredAt);
    }

    [Fact]
    public async Task FreeCollaborationNotifiesOnlyTheCurrentlySelectedAssignee()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateAsync(cancellationToken);
        var firstAssigneeId = await scope.AddUserAsync("first-assignee@example.test", cancellationToken);
        var nextAssigneeId = await scope.AddUserAsync("next-assignee@example.test", cancellationToken);
        var now = new DateTimeOffset(2026, 8, 31, 4, 0, 0, TimeSpan.Zero);
        var snapshot = new JsonObject();
        var seed = await AddRuntimeAsync(
            scope,
            snapshot,
            "in-progress",
            now,
            cancellationToken,
            "free");
        seed.Instance.CurrentAssigneeId = firstAssigneeId;
        var firstTask = CreateFreeTask(seed.Instance.Id, seed.Version.Id, firstAssigneeId, now);
        scope.Context.WorkflowTasks.Add(firstTask);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var writer = new EmailOutboxWriter(scope.Context);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [firstTask],
            now,
            cancellationToken);

        firstTask.Status = "completed";
        firstTask.CompletedAt = now.AddMinutes(1).UtcDateTime;
        seed.Instance.CurrentAssigneeId = nextAssigneeId;
        var nextTask = CreateFreeTask(
            seed.Instance.Id,
            seed.Version.Id,
            nextAssigneeId,
            now.AddMinutes(1));
        scope.Context.WorkflowTasks.Add(nextTask);
        await scope.Context.SaveChangesAsync(cancellationToken);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [nextTask],
            now.AddMinutes(1),
            cancellationToken);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var messages = await scope.Context.RuntimeEmailOutboxMessages
            .Where(item => item.InstanceId == seed.Instance.Id)
            .OrderBy(item => item.CreatedAt)
            .ToArrayAsync(cancellationToken);
        Assert.Collection(
            messages,
            first =>
            {
                Assert.Equal("free-collaboration-assigned", first.EventType);
                Assert.Equal(firstTask.Id, first.TaskId);
                Assert.Equal(firstAssigneeId, first.RecipientUserId);
            },
            next =>
            {
                Assert.Equal("free-collaboration-assigned", next.EventType);
                Assert.Equal(nextTask.Id, next.TaskId);
                Assert.Equal(nextAssigneeId, next.RecipientUserId);
            });
    }

    [Fact]
    public async Task FreeCollaborationCloseNotifiesInitiatorForEachCloseEvent()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateAsync(cancellationToken);
        var initiatorId = await scope.AddUserAsync("initiator@example.test", cancellationToken);
        var now = new DateTimeOffset(2026, 8, 31, 5, 0, 0, TimeSpan.Zero);
        var snapshot = new JsonObject();
        var seed = await AddRuntimeAsync(
            scope,
            snapshot,
            "closed",
            now,
            cancellationToken,
            "free",
            initiatorId);
        var firstClosingTask = CreateFreeTask(seed.Instance.Id, seed.Version.Id, initiatorId, now);
        firstClosingTask.Status = "cancelled";
        firstClosingTask.CompletedAt = now.UtcDateTime;
        var secondClosingTask = CreateFreeTask(seed.Instance.Id, seed.Version.Id, initiatorId, now.AddMinutes(1));
        secondClosingTask.Status = "cancelled";
        secondClosingTask.CompletedAt = now.AddMinutes(1).UtcDateTime;
        scope.Context.WorkflowTasks.AddRange(firstClosingTask, secondClosingTask);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var writer = new EmailOutboxWriter(scope.Context);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [firstClosingTask],
            now,
            cancellationToken);
        await writer.EnqueueAsync(
            seed.Instance,
            seed.Definition,
            seed.Version,
            snapshot,
            [secondClosingTask],
            now.AddMinutes(1),
            cancellationToken);
        await scope.Context.SaveChangesAsync(cancellationToken);

        var messages = await scope.Context.RuntimeEmailOutboxMessages
            .Where(item => item.InstanceId == seed.Instance.Id)
            .OrderBy(item => item.CreatedAt)
            .ToArrayAsync(cancellationToken);
        Assert.Equal(2, messages.Length);
        Assert.All(messages, message =>
        {
            Assert.Equal("free-collaboration-closed", message.EventType);
            Assert.Null(message.TaskId);
            Assert.Equal(initiatorId, message.RecipientUserId);
            Assert.Contains("已关闭", message.Subject, StringComparison.Ordinal);
        });
        Assert.Equal(2, messages.Select(message => message.IdempotencyKey).Distinct().Count());
    }

    private static WorkflowTaskEntity CreateTask(
        Guid instanceId,
        Guid versionId,
        Guid groupId,
        string nodeId,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            TaskType = "approval",
            InstanceId = instanceId,
            VersionId = versionId,
            Round = 1,
            Status = "pending",
            ActivatedAt = now.UtcDateTime,
            Revision = 1,
            NodeId = nodeId,
            NodeNameSnapshot = nodeId,
            GroupId = groupId,
        };

    private static WorkflowTaskEntity CreateFreeTask(
        Guid instanceId,
        Guid versionId,
        Guid assigneeId,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            TaskType = "free-collaboration",
            InstanceId = instanceId,
            VersionId = versionId,
            AssigneeId = assigneeId,
            Round = 1,
            Status = "pending",
            ActivatedAt = now.UtcDateTime,
            Revision = 1,
        };

    private static async Task<RuntimeSeed> AddRuntimeAsync(
        SqlServerRuntimeTestScope scope,
        JsonObject snapshot,
        string status,
        DateTimeOffset now,
        CancellationToken cancellationToken,
        string definitionType = "approval",
        Guid? initiatorUserId = null)
    {
        var definition = new RuntimeWorkflowDefinition
        {
            Id = Guid.NewGuid(),
            Code = $"TEST-{Guid.NewGuid():N}",
            NormalizedCode = $"TEST-{Guid.NewGuid():N}",
            Name = "邮件测试流程",
            Type = definitionType,
            NextVersionNumber = 2,
            Revision = 1,
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        };
        scope.Context.RuntimeWorkflowDefinitions.Add(definition);
        await scope.Context.SaveChangesAsync(cancellationToken);
        var version = new RuntimeWorkflowVersion
        {
            Id = Guid.NewGuid(),
            DefinitionId = definition.Id,
            VersionNumber = 1,
            VersionLabel = "V1",
            BasicJson = "{}",
            SnapshotJson = snapshot.ToJsonString(),
            InstanceCount = 1,
            Revision = 1,
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        };
        scope.Context.RuntimeWorkflowVersions.Add(version);
        await scope.Context.SaveChangesAsync(cancellationToken);
        definition.PublishedVersionId = version.Id;
        var instance = new WorkflowInstanceEntity
        {
            Id = Guid.NewGuid(),
            InstanceNumber = $"MAIL{Guid.NewGuid():N}"[..20],
            DefinitionId = definition.Id,
            VersionId = version.Id,
            InitiatorUserId = initiatorUserId ?? scope.AdministratorUserId,
            ActualInitiatorUserId = initiatorUserId ?? scope.AdministratorUserId,
            Title = "邮件测试实例",
            Status = status,
            CurrentRound = 1,
            CurrentNodeSummary = status == "completed" ? "流程结束" : "审核",
            VerifiedEntryBaseUrl = "https://flowpilot.example/flowpilot",
            FormValuesJson = "{\"title\":\"邮件测试实例\"}",
            FieldRevisionsJson = "{}",
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            Revision = 1,
        };
        scope.Context.WorkflowInstances.Add(instance);
        await scope.Context.SaveChangesAsync(cancellationToken);
        return new RuntimeSeed(definition, version, instance);
    }

    private sealed record RuntimeSeed(
        RuntimeWorkflowDefinition Definition,
        RuntimeWorkflowVersion Version,
        WorkflowInstanceEntity Instance);
}
