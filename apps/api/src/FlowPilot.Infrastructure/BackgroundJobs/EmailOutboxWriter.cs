using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using MimeKit;

namespace FlowPilot.Infrastructure.BackgroundJobs;

public sealed class EmailOutboxWriter(
    FlowPilotDbContext dbContext,
    IConfiguration? configuration = null)
{
    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly IConfiguration? _configuration = configuration;

    internal async Task EnqueueAsync(
        WorkflowInstanceEntity instance,
        RuntimeWorkflowDefinition definition,
        RuntimeWorkflowVersion version,
        JsonObject snapshot,
        IReadOnlyCollection<WorkflowTaskEntity> tasks,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var requests = new List<NotificationRequest>();
        if (definition.Type == "free")
        {
            if (ReadFreeEmailNotificationEnabled(version))
            {
                AddFreeCollaborationRequests(instance, tasks, requests);
            }
        }
        else if (definition.Type == "approval")
        {
            foreach (var task in tasks.Where(item => item.TaskType == "approval" && item.Status == "pending" && item.NodeId is not null))
            {
                var settings = ReadTaskNotification(snapshot, task.NodeId!);
                if (settings is null)
                {
                    continue;
                }

                var recipients = new HashSet<Guid>(settings.ExtraUserIds);
                if (settings.NotifyReviewers)
                {
                    var assignedUserId = task.DefaultAssigneeId ?? task.AssigneeId;
                    if (assignedUserId.HasValue)
                    {
                        recipients.Add(assignedUserId.Value);
                    }
                    else if (task.GroupId.HasValue)
                    {
                        recipients.UnionWith(await LoadEffectiveGroupMembersAsync(task.GroupId.Value, cancellationToken)
                            .ConfigureAwait(false));
                    }
                }

                requests.Add(new NotificationRequest(
                    "task-activated",
                    task.Id,
                    task,
                    recipients,
                    task.NodeNameSnapshot ?? "审批"));
            }

            if (instance.Status == "completed")
            {
                var settings = ReadCompletionNotification(snapshot);
                if (settings is not null)
                {
                    var recipients = new HashSet<Guid>(settings.ExtraUserIds);
                    if (settings.NotifyInitiator)
                    {
                        recipients.Add(instance.InitiatorUserId);
                    }

                    requests.Add(new NotificationRequest(
                        "process-completed",
                        instance.Id,
                        null,
                        recipients,
                        "流程结束"));
                }
            }

            if (instance.Status == "closed")
            {
                requests.Add(new NotificationRequest(
                    "approval-closed",
                    instance.Id,
                    null,
                    new HashSet<Guid> { instance.InitiatorUserId },
                    "事项关闭"));
            }
        }

        if (requests.Count == 0)
        {
            return;
        }

        var testEmail = TestEmailOverride.Read(_configuration);
        if (testEmail.Configured && testEmail.Address is null)
        {
            return;
        }

        var userIds = requests.SelectMany(item => item.RecipientIds).Distinct().ToArray();
        var users = await _dbContext.OrganizationUserReferences.AsNoTracking()
            .Where(item => userIds.Contains(item.Id)
                && item.IsEnabled
                && (!item.IsBuiltInSuperAdmin || testEmail.Address != null)
                && (testEmail.Address != null || item.Email != ""))
            .ToDictionaryAsync(item => item.Id, cancellationToken)
            .ConfigureAwait(false);
        var keys = requests.SelectMany(request => request.RecipientIds.Select(userId => request.Key(userId)))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var existingKeys = await _dbContext.RuntimeEmailOutboxMessages.AsNoTracking()
            .Where(item => keys.Contains(item.IdempotencyKey))
            .Select(item => item.IdempotencyKey)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var existing = existingKeys
            .Concat(_dbContext.RuntimeEmailOutboxMessages.Local.Select(item => item.IdempotencyKey))
            .ToHashSet(StringComparer.Ordinal);
        var notifiedTaskRecipients = new HashSet<Guid>();

        foreach (var request in requests.OrderBy(item => item.EventId))
        {
            foreach (var userId in request.RecipientIds)
            {
                if (request.Task is not null && !notifiedTaskRecipients.Add(userId))
                {
                    continue;
                }

                var key = request.Key(userId);
                if (existing.Contains(key) || !users.TryGetValue(userId, out var user))
                {
                    continue;
                }

                var recipientEmail = testEmail.Address ?? user.Email;
                if (!MailboxAddress.TryParse(recipientEmail, out _)) continue;

                var targetPath = request.Task is null
                    ? $"/processes/{instance.Id:D}"
                    : $"/processes/{instance.Id:D}?taskId={request.Task.Id:D}";
                var baseUrl = instance.VerifiedEntryBaseUrl?.TrimEnd('/');
                var resolvedUrl = baseUrl is null ? null : $"{baseUrl}{targetPath}";
                _dbContext.RuntimeEmailOutboxMessages.Add(new RuntimeEmailOutboxMessage
                {
                    Id = Guid.NewGuid(),
                    Revision = 1,
                    IdempotencyKey = key,
                    EventType = request.EventType,
                    InstanceId = instance.Id,
                    TaskId = request.Task?.Id,
                    TemplateKey = request.EventType,
                    RecipientUserId = user.Id,
                    RecipientEmailSnapshot = recipientEmail,
                    Subject = SafeHeader(request.EventType switch
                    {
                        "process-completed" => $"[FlowPilot] {definition.Name} - 已完成",
                        "approval-closed" => $"[FlowPilot] {definition.Name} - 已关闭",
                        "free-collaboration-closed" => $"[FlowPilot] {definition.Name} - 已关闭",
                        _ => $"[FlowPilot] {definition.Name} - {instance.Title}",
                    }),
                    TemplateDataJson = JsonSerializer.Serialize(new
                    {
                        processName = definition.Name,
                        version = version.VersionLabel,
                        instanceNumber = instance.InstanceNumber,
                        instanceTitle = instance.Title,
                        nodeName = request.NodeName,
                        activatedAt = request.Task?.ActivatedAt,
                        recipientName = user.DisplayName,
                    }),
                    TargetPath = targetPath,
                    LinkBaseUrl = baseUrl,
                    ResolvedTargetUrl = resolvedUrl,
                    Status = resolvedUrl is null ? "dead-letter" : "pending",
                    ScheduledAt = now.UtcDateTime,
                    AttemptCount = 0,
                    LastErrorCode = resolvedUrl is null ? "ENTRY_BASE_URL_MISSING" : null,
                    LastErrorSummary = resolvedUrl is null ? "流程实例没有可继承的已验证站点入口。" : null,
                    CreatedAt = now.UtcDateTime,
                    DeadLetteredAt = resolvedUrl is null ? now.UtcDateTime : null,
                });
                existing.Add(key);
            }
        }
    }

    private static void AddFreeCollaborationRequests(
        WorkflowInstanceEntity instance,
        IReadOnlyCollection<WorkflowTaskEntity> tasks,
        ICollection<NotificationRequest> requests)
    {
        foreach (var task in tasks.Where(item => item.TaskType == "free-collaboration"
            && item.Status == "pending"
            && item.AssigneeId.HasValue))
        {
            requests.Add(new NotificationRequest(
                "free-collaboration-assigned",
                task.Id,
                task,
                new HashSet<Guid> { task.AssigneeId!.Value },
                "自由协作受理"));
        }

        if (instance.Status != "closed")
        {
            return;
        }

        var closingTaskId = tasks
            .Where(item => item.TaskType == "free-collaboration")
            .Select(item => (Guid?)item.Id)
            .FirstOrDefault() ?? instance.Id;
        requests.Add(new NotificationRequest(
            "free-collaboration-closed",
            closingTaskId,
            null,
            new HashSet<Guid> { instance.InitiatorUserId },
            "事项关闭"));
    }

    private static bool ReadFreeEmailNotificationEnabled(RuntimeWorkflowVersion version)
    {
        try
        {
            var basic = JsonNode.Parse(version.BasicJson) as JsonObject;
            return basic?["emailNotificationEnabled"] is JsonValue value
                && value.TryGetValue<bool>(out var enabled)
                    ? enabled
                    : true;
        }
        catch (JsonException)
        {
            return true;
        }
    }

    private async Task<Guid[]> LoadEffectiveGroupMembersAsync(Guid groupId, CancellationToken cancellationToken)
    {
        var groupEnabled = await _dbContext.RuntimeWorkflowGroups.AsNoTracking()
            .AnyAsync(item => item.Id == groupId && item.IsEnabled, cancellationToken)
            .ConfigureAwait(false);
        if (!groupEnabled)
        {
            return [];
        }

        var direct = await _dbContext.RuntimeWorkflowGroupUsers.AsNoTracking()
            .Where(item => item.GroupId == groupId)
            .Select(item => item.UserId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var throughRoles = await _dbContext.RuntimeWorkflowGroupRoles.AsNoTracking()
            .Where(item => item.GroupId == groupId)
            .Join(
                _dbContext.RuntimeRoles.AsNoTracking().Where(item => item.IsEnabled),
                item => item.RoleId,
                role => role.Id,
                (_, role) => role.Id)
            .Join(
                _dbContext.RuntimeUserRoles.AsNoTracking(),
                roleId => roleId,
                item => item.RoleId,
                (_, item) => item.UserId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return direct.Concat(throughRoles).Distinct().ToArray();
    }

    private static TaskNotificationSettings? ReadTaskNotification(JsonObject snapshot, string nodeId)
    {
        var node = (snapshot["flow"]?["nodes"] as JsonArray)?.OfType<JsonObject>()
            .SingleOrDefault(item => item["id"]?.GetValue<string>() == nodeId);
        var email = node?["data"]?["emailNotification"] as JsonObject;
        return email?["enabled"]?.GetValue<bool>() == true
            ? new TaskNotificationSettings(
                email["notifyReviewers"]?.GetValue<bool>() == true,
                ReadUserIds(email))
            : null;
    }

    private static CompletionNotificationSettings? ReadCompletionNotification(JsonObject snapshot)
    {
        var node = (snapshot["flow"]?["nodes"] as JsonArray)?.OfType<JsonObject>()
            .FirstOrDefault(item => item["data"]?["kind"]?.GetValue<string>() == "end");
        var email = node?["data"]?["emailNotification"] as JsonObject;
        return email?["enabled"]?.GetValue<bool>() == true
            ? new CompletionNotificationSettings(
                email["notifyInitiator"]?.GetValue<bool>() == true,
                ReadUserIds(email))
            : null;
    }

    private static Guid[] ReadUserIds(JsonObject email) =>
        (email["extraUserIds"] as JsonArray ?? [])
            .Select(item => Guid.TryParse(item?.GetValue<string>(), out var id) ? id : Guid.Empty)
            .Where(item => item != Guid.Empty)
            .Distinct()
            .ToArray();

    private static string SafeHeader(string value) => value.Replace('\r', ' ').Replace('\n', ' ').Trim();

    private sealed record NotificationRequest(
        string EventType,
        Guid EventId,
        WorkflowTaskEntity? Task,
        IReadOnlySet<Guid> RecipientIds,
        string NodeName)
    {
        public string Key(Guid userId) => $"{EventType}:{EventId:D}:{userId:D}";
    }

    private sealed record TaskNotificationSettings(bool NotifyReviewers, Guid[] ExtraUserIds);
    private sealed record CompletionNotificationSettings(bool NotifyInitiator, Guid[] ExtraUserIds);
}
