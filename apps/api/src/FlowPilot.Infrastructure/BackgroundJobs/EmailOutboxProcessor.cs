using System.Net;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Infrastructure.Persistence;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MimeKit;

namespace FlowPilot.Infrastructure.BackgroundJobs;

public sealed class EmailOutboxProcessor(
    FlowPilotDbContext dbContext,
    IConfiguration configuration,
    TimeProvider timeProvider,
    ILogger<EmailOutboxProcessor> logger) : IFlowPilotBackgroundProcessor
{
    private static readonly Action<ILogger, Guid, Exception?> LogSendFailure =
        LoggerMessage.Define<Guid>(
            LogLevel.Warning,
            new EventId(2101, "EmailSendFailure"),
            "Email outbox message {MessageId} failed.");
    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly IConfiguration _configuration = configuration;
    private readonly TimeProvider _timeProvider = timeProvider;
    private readonly ILogger<EmailOutboxProcessor> _logger = logger;

    public async Task RunOnceAsync(CancellationToken cancellationToken = default)
    {
        var settings = SmtpSettings.Read(_configuration);
        if (settings is null) return;

        await PrepareNotificationsAsync(cancellationToken).ConfigureAwait(false);
        for (var index = 0; index < settings.BatchSize; index++)
        {
            var message = await ClaimAsync(settings.MaxAttempts, cancellationToken).ConfigureAwait(false);
            if (message is null) break;
            await SendAsync(message, settings, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task PrepareNotificationsAsync(CancellationToken cancellationToken)
    {
        var tasks = await _dbContext.WorkflowTasks.AsNoTracking()
            .Where(item => item.TaskType == "approval" && item.Status == "pending" && item.NodeId != null)
            .OrderBy(item => item.ActivatedAt)
            .Take(100)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var instanceIds = tasks.Select(item => item.InstanceId).Distinct().ToArray();
        var instances = await _dbContext.WorkflowInstances.AsNoTracking()
            .Where(item => instanceIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, cancellationToken).ConfigureAwait(false);
        var versionIds = tasks.Select(item => item.VersionId).Distinct().ToArray();
        var versions = await _dbContext.RuntimeWorkflowVersions.AsNoTracking()
            .Where(item => versionIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, cancellationToken).ConfigureAwait(false);
        var definitionIds = instances.Values.Select(item => item.DefinitionId).Distinct().ToArray();
        var definitions = await _dbContext.RuntimeWorkflowDefinitions.AsNoTracking()
            .Where(item => definitionIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, cancellationToken).ConfigureAwait(false);

        foreach (var task in tasks)
        {
            var instance = instances[task.InstanceId];
            var version = versions[task.VersionId];
            var definition = definitions[instance.DefinitionId];
            var notification = ReadNotification(version.SnapshotJson, task.NodeId!);
            if (notification is null) continue;

            var recipientIds = new HashSet<Guid>(notification.ExtraUserIds);
            if (notification.NotifyReviewers)
            {
                if (task.AssigneeId.HasValue) recipientIds.Add(task.AssigneeId.Value);
                if (task.DefaultAssigneeId.HasValue) recipientIds.Add(task.DefaultAssigneeId.Value);
                if (task.GroupId.HasValue)
                {
                    recipientIds.UnionWith(await LoadEffectiveGroupMembersAsync(task.GroupId.Value, cancellationToken).ConfigureAwait(false));
                }
            }
            await AddMessagesAsync(
                recipientIds,
                "task-activated",
                task.Id,
                instance,
                definition,
                version,
                task,
                cancellationToken).ConfigureAwait(false);
        }
        await PrepareCompletionNotificationsAsync(cancellationToken).ConfigureAwait(false);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task PrepareCompletionNotificationsAsync(CancellationToken cancellationToken)
    {
        var instances = await _dbContext.WorkflowInstances.AsNoTracking()
            .Where(item => item.Status == "completed" && item.CompletedAt != null)
            .OrderBy(item => item.CompletedAt)
            .Take(100)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        if (instances.Length == 0) return;
        var versionIds = instances.Select(item => item.VersionId).Distinct().ToArray();
        var versions = await _dbContext.RuntimeWorkflowVersions.AsNoTracking()
            .Where(item => versionIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, cancellationToken).ConfigureAwait(false);
        var definitionIds = instances.Select(item => item.DefinitionId).Distinct().ToArray();
        var definitions = await _dbContext.RuntimeWorkflowDefinitions.AsNoTracking()
            .Where(item => definitionIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, cancellationToken).ConfigureAwait(false);
        foreach (var instance in instances)
        {
            var notification = ReadCompletionNotification(versions[instance.VersionId].SnapshotJson);
            if (notification is null) continue;
            var recipients = new HashSet<Guid>(notification.ExtraUserIds);
            if (notification.NotifyInitiator) recipients.Add(instance.InitiatorUserId);
            await AddCompletionMessagesAsync(
                recipients,
                instance,
                definitions[instance.DefinitionId],
                versions[instance.VersionId],
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task AddCompletionMessagesAsync(
        HashSet<Guid> recipientIds,
        WorkflowInstanceEntity instance,
        RuntimeWorkflowDefinition definition,
        RuntimeWorkflowVersion version,
        CancellationToken cancellationToken)
    {
        if (recipientIds.Count == 0) return;
        var users = await _dbContext.OrganizationUserReferences.AsNoTracking()
            .Where(item => recipientIds.Contains(item.Id) && item.IsEnabled && !item.IsBuiltInSuperAdmin && item.Email != "")
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var keys = users.Select(item => $"process-completed:{instance.Id:D}:{item.Id:D}").ToArray();
        var existing = (await _dbContext.RuntimeEmailOutboxMessages.AsNoTracking()
            .Where(item => keys.Contains(item.IdempotencyKey))
            .Select(item => item.IdempotencyKey).ToArrayAsync(cancellationToken).ConfigureAwait(false))
            .ToHashSet(StringComparer.Ordinal);
        var now = _timeProvider.GetUtcNow();
        foreach (var user in users.Where(item => !existing.Contains($"process-completed:{instance.Id:D}:{item.Id:D}")))
        {
            if (!MailboxAddress.TryParse(user.Email, out _)) continue;
            var targetPath = $"/processes/{instance.Id:D}";
            var baseUrl = instance.VerifiedEntryBaseUrl?.TrimEnd('/');
            var resolvedUrl = baseUrl is null ? null : $"{baseUrl}{targetPath}";
            _dbContext.RuntimeEmailOutboxMessages.Add(new RuntimeEmailOutboxMessage
            {
                Id = Guid.NewGuid(),
                Revision = 1,
                IdempotencyKey = $"process-completed:{instance.Id:D}:{user.Id:D}",
                EventType = "process-completed",
                InstanceId = instance.Id,
                TemplateKey = "process-completed",
                RecipientUserId = user.Id,
                RecipientEmailSnapshot = user.Email,
                Subject = SafeHeader($"[FlowPilot] {definition.Name} - 已完成"),
                TemplateDataJson = JsonSerializer.Serialize(new
                {
                    processName = definition.Name,
                    version = version.VersionLabel,
                    instanceNumber = instance.InstanceNumber,
                    instanceTitle = instance.Title,
                    nodeName = "流程结束",
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
        }
    }

    private async Task AddMessagesAsync(
        HashSet<Guid> recipientIds,
        string eventType,
        Guid eventId,
        WorkflowInstanceEntity instance,
        RuntimeWorkflowDefinition definition,
        RuntimeWorkflowVersion version,
        WorkflowTaskEntity task,
        CancellationToken cancellationToken)
    {
        if (recipientIds.Count == 0) return;
        var users = await _dbContext.OrganizationUserReferences.AsNoTracking()
            .Where(item => recipientIds.Contains(item.Id)
                && item.IsEnabled
                && !item.IsBuiltInSuperAdmin
                && item.Email != "")
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var keys = users.Select(item => $"{eventType}:{eventId:D}:{item.Id:D}").ToArray();
        var existingKeys = await _dbContext.RuntimeEmailOutboxMessages.AsNoTracking()
            .Where(item => keys.Contains(item.IdempotencyKey))
            .Select(item => item.IdempotencyKey)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var existing = existingKeys.ToHashSet(StringComparer.Ordinal);
        var now = _timeProvider.GetUtcNow();
        foreach (var user in users.Where(item => !existing.Contains($"{eventType}:{eventId:D}:{item.Id:D}")))
        {
            if (!MailboxAddress.TryParse(user.Email, out _)) continue;
            var targetPath = $"/processes/{instance.Id:D}?taskId={task.Id:D}";
            var baseUrl = instance.VerifiedEntryBaseUrl?.TrimEnd('/');
            var resolvedUrl = baseUrl is null ? null : $"{baseUrl}{targetPath}";
            _dbContext.RuntimeEmailOutboxMessages.Add(new RuntimeEmailOutboxMessage
            {
                Id = Guid.NewGuid(),
                Revision = 1,
                IdempotencyKey = $"{eventType}:{eventId:D}:{user.Id:D}",
                EventType = eventType,
                InstanceId = instance.Id,
                TaskId = task.Id,
                TemplateKey = "task-activated",
                RecipientUserId = user.Id,
                RecipientEmailSnapshot = user.Email,
                Subject = SafeHeader($"[FlowPilot] {definition.Name} - {instance.Title}"),
                TemplateDataJson = JsonSerializer.Serialize(new
                {
                    processName = definition.Name,
                    version = version.VersionLabel,
                    instanceNumber = instance.InstanceNumber,
                    instanceTitle = instance.Title,
                    nodeName = task.NodeNameSnapshot,
                    activatedAt = task.ActivatedAt,
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
        }
    }

    private async Task<Guid[]> LoadEffectiveGroupMembersAsync(Guid groupId, CancellationToken cancellationToken)
    {
        var direct = await _dbContext.RuntimeWorkflowGroupUsers.AsNoTracking()
            .Where(item => item.GroupId == groupId)
            .Select(item => item.UserId).ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var throughRoles = await _dbContext.RuntimeWorkflowGroupRoles.AsNoTracking()
            .Where(item => item.GroupId == groupId)
            .Join(_dbContext.RuntimeRoles.AsNoTracking().Where(item => item.IsEnabled), item => item.RoleId, role => role.Id, (_, role) => role.Id)
            .Join(_dbContext.RuntimeUserRoles.AsNoTracking(), roleId => roleId, item => item.RoleId, (_, item) => item.UserId)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        return direct.Concat(throughRoles).Distinct().ToArray();
    }

    private async Task<RuntimeEmailOutboxMessage?> ClaimAsync(
        int maxAttempts,
        CancellationToken cancellationToken)
    {
        var now = _timeProvider.GetUtcNow();
        var message = await _dbContext.RuntimeEmailOutboxMessages
            .Where(item => ((item.Status == "pending" || item.Status == "retry-wait")
                    && item.ScheduledAt <= now.UtcDateTime)
                || item.Status == "processing" && item.LeaseUntil <= now.UtcDateTime)
            .OrderBy(item => item.ScheduledAt).ThenBy(item => item.Id)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (message is null) return null;
        if (message.Status == "processing")
        {
            var expiredAttempt = await _dbContext.RuntimeEmailDeliveryAttempts
                .SingleOrDefaultAsync(item => item.OutboxId == message.Id
                    && item.AttemptNumber == message.AttemptCount
                    && item.Result == "processing", cancellationToken).ConfigureAwait(false);
            if (expiredAttempt is not null)
            {
                expiredAttempt.CompletedAt = now.UtcDateTime;
                expiredAttempt.Result = "failed";
                expiredAttempt.ErrorCategory = "LEASE_EXPIRED";
                expiredAttempt.ServerResponseSummary = "发送进程在租约到期前未完成。";
            }
            if (message.AttemptCount >= maxAttempts)
            {
                message.Status = "dead-letter";
                message.DeadLetteredAt = now.UtcDateTime;
                message.LeaseOwner = null;
                message.LeaseUntil = null;
                message.LastErrorCode = "LEASE_EXPIRED";
                message.LastErrorSummary = "发送进程多次在租约到期前未完成。";
                message.Revision++;
                await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
                return null;
            }
        }
        message.Status = "processing";
        message.LeaseOwner = Environment.MachineName;
        message.LeaseUntil = now.AddMinutes(2).UtcDateTime;
        message.AttemptCount++;
        message.Revision++;
        _dbContext.RuntimeEmailDeliveryAttempts.Add(new RuntimeEmailDeliveryAttempt
        {
            Id = Guid.NewGuid(),
            OutboxId = message.Id,
            AttemptNumber = message.AttemptCount,
            StartedAt = now.UtcDateTime,
            Result = "processing",
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return message;
    }

    private async Task SendAsync(RuntimeEmailOutboxMessage message, SmtpSettings settings, CancellationToken cancellationToken)
    {
        try
        {
            var mimeMessage = CreateMimeMessage(message, settings);
            using var client = new SmtpClient { Timeout = settings.TimeoutSeconds * 1000 };
            await client.ConnectAsync(settings.Host, settings.Port, settings.SocketOptions, cancellationToken).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(settings.UserName))
            {
                await client.AuthenticateAsync(settings.UserName, settings.Password!, cancellationToken).ConfigureAwait(false);
            }
            await client.SendAsync(mimeMessage, cancellationToken).ConfigureAwait(false);
            await client.DisconnectAsync(true, cancellationToken).ConfigureAwait(false);
            await CompleteAttemptAsync(message, succeeded: true, null, null, settings.MaxAttempts, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is SmtpCommandException or SmtpProtocolException or IOException or TimeoutException or MailKit.Security.AuthenticationException)
        {
            LogSendFailure(_logger, message.Id, exception);
            await CompleteAttemptAsync(
                message,
                succeeded: false,
                exception.GetType().Name,
                SafeSummary(exception.Message),
                settings.MaxAttempts,
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task CompleteAttemptAsync(
        RuntimeEmailOutboxMessage message,
        bool succeeded,
        string? errorCode,
        string? errorSummary,
        int maxAttempts,
        CancellationToken cancellationToken)
    {
        var now = _timeProvider.GetUtcNow();
        var attempt = await _dbContext.RuntimeEmailDeliveryAttempts
            .SingleAsync(item => item.OutboxId == message.Id && item.AttemptNumber == message.AttemptCount, cancellationToken)
            .ConfigureAwait(false);
        attempt.CompletedAt = now.UtcDateTime;
        attempt.Result = succeeded ? "succeeded" : "failed";
        attempt.ErrorCategory = errorCode;
        attempt.ServerResponseSummary = errorSummary;
        message.LeaseOwner = null;
        message.LeaseUntil = null;
        message.Revision++;
        if (succeeded)
        {
            message.Status = "sent";
            message.SentAt = now.UtcDateTime;
            message.LastErrorCode = null;
            message.LastErrorSummary = null;
        }
        else if (message.AttemptCount >= maxAttempts)
        {
            message.Status = "dead-letter";
            message.DeadLetteredAt = now.UtcDateTime;
            message.LastErrorCode = errorCode;
            message.LastErrorSummary = errorSummary;
            _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
            {
                Id = Guid.NewGuid(),
                ResourceType = "email-outbox",
                ResourceId = message.Id,
                Action = "dead-letter",
                OperatorUserId = message.RecipientUserId,
                EffectiveUserId = message.RecipientUserId,
                TraceId = $"email-{message.Id:N}",
                Result = "failure",
                OccurredAt = now.UtcDateTime,
            });
        }
        else
        {
            message.Status = "retry-wait";
            message.ScheduledAt = now.AddMinutes(RetryDelayMinutes(message.AttemptCount)).UtcDateTime;
            message.LastErrorCode = errorCode;
            message.LastErrorSummary = errorSummary;
        }
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    private static MimeMessage CreateMimeMessage(RuntimeEmailOutboxMessage message, SmtpSettings settings)
    {
        var data = JsonNode.Parse(message.TemplateDataJson) as JsonObject ?? new JsonObject();
        var recipientName = data["recipientName"]?.GetValue<string>() ?? string.Empty;
        var processName = data["processName"]?.GetValue<string>() ?? "流程";
        var instanceNumber = data["instanceNumber"]?.GetValue<string>() ?? string.Empty;
        var nodeName = data["nodeName"]?.GetValue<string>() ?? string.Empty;
        var link = message.ResolvedTargetUrl ?? string.Empty;
        var description = message.EventType == "process-completed"
            ? $"流程“{HtmlEncoder.Default.Encode(processName)}”（{HtmlEncoder.Default.Encode(instanceNumber)}）已完成。"
            : $"流程“{HtmlEncoder.Default.Encode(processName)}”（{HtmlEncoder.Default.Encode(instanceNumber)}）已进入“{HtmlEncoder.Default.Encode(nodeName)}”，请及时处理。";
        var textDescription = message.EventType == "process-completed"
            ? $"{processName}（{instanceNumber}）已完成。"
            : $"{processName}（{instanceNumber}）已进入“{nodeName}”，请及时处理。";
        var html = $"<p>{HtmlEncoder.Default.Encode(recipientName)}，您好：</p>" +
            $"<p>{description}</p>" +
            $"<p><a href=\"{HtmlEncoder.Default.Encode(link)}\">打开流程</a></p>";
        var result = new MimeMessage();
        result.From.Add(new MailboxAddress(settings.FromName, settings.FromAddress));
        result.To.Add(MailboxAddress.Parse(message.RecipientEmailSnapshot));
        result.Subject = SafeHeader(message.Subject);
        result.Body = new BodyBuilder { HtmlBody = html, TextBody = $"{recipientName}，您好：\n{textDescription}\n{link}" }.ToMessageBody();
        return result;
    }

    private static NotificationSettings? ReadNotification(string snapshotJson, string nodeId)
    {
        var snapshot = JsonNode.Parse(snapshotJson) as JsonObject;
        var nodes = snapshot?["flow"]?["nodes"] as JsonArray;
        var node = nodes?.OfType<JsonObject>().SingleOrDefault(item => item["id"]?.GetValue<string>() == nodeId);
        var email = node?["data"]?["emailNotification"] as JsonObject;
        if (email?["enabled"]?.GetValue<bool>() != true) return null;
        var extraUserIds = (email["extraUserIds"] as JsonArray ?? [])
            .Select(item => Guid.TryParse(item?.GetValue<string>(), out var id) ? id : Guid.Empty)
            .Where(item => item != Guid.Empty).ToArray();
        return new NotificationSettings(email["notifyReviewers"]?.GetValue<bool>() == true, extraUserIds);
    }

    private static CompletionNotificationSettings? ReadCompletionNotification(string snapshotJson)
    {
        var snapshot = JsonNode.Parse(snapshotJson) as JsonObject;
        var node = (snapshot?["flow"]?["nodes"] as JsonArray)?.OfType<JsonObject>()
            .FirstOrDefault(item => item["data"]?["kind"]?.GetValue<string>() == "end");
        var email = node?["data"]?["emailNotification"] as JsonObject;
        if (email?["enabled"]?.GetValue<bool>() != true) return null;
        var extraUserIds = (email["extraUserIds"] as JsonArray ?? [])
            .Select(item => Guid.TryParse(item?.GetValue<string>(), out var id) ? id : Guid.Empty)
            .Where(item => item != Guid.Empty).ToArray();
        return new CompletionNotificationSettings(email["notifyInitiator"]?.GetValue<bool>() == true, extraUserIds);
    }

    private static string SafeHeader(string value) => value.Replace('\r', ' ').Replace('\n', ' ').Trim();
    private static string SafeSummary(string value) => value.Length <= 1000 ? value : value[..1000];
    private static int RetryDelayMinutes(int attemptCount) => attemptCount switch
    {
        <= 1 => 1,
        2 => 5,
        3 => 15,
        4 => 60,
        _ => 360,
    };
    private sealed record NotificationSettings(bool NotifyReviewers, Guid[] ExtraUserIds);
    private sealed record CompletionNotificationSettings(bool NotifyInitiator, Guid[] ExtraUserIds);

    private sealed record SmtpSettings(
        string Host,
        int Port,
        SecureSocketOptions SocketOptions,
        string? UserName,
        string? Password,
        string FromAddress,
        string FromName,
        int MaxAttempts,
        int BatchSize,
        int TimeoutSeconds)
    {
        public static SmtpSettings? Read(IConfiguration configuration)
        {
            if (!configuration.GetValue("FlowPilot:Smtp:Enabled", false)) return null;
            var host = configuration["FlowPilot:Smtp:Host"]?.Trim();
            var from = configuration["FlowPilot:Smtp:From"]?.Trim();
            var userName = configuration["FlowPilot:Smtp:UserName"]?.Trim();
            var password = configuration["FlowPilot:Smtp:Password"];
            if (string.IsNullOrWhiteSpace(host)
                || !MailboxAddress.TryParse(from, out var mailbox)
                || string.IsNullOrWhiteSpace(userName) != string.IsNullOrWhiteSpace(password)) return null;
            var security = configuration["FlowPilot:Smtp:Security"]?.Trim().ToLowerInvariant() ?? "starttls";
            var socketOptions = security switch
            {
                "ssl" => SecureSocketOptions.SslOnConnect,
                "none" when configuration.GetValue("FlowPilot:Smtp:AllowPlainText", false) => SecureSocketOptions.None,
                "starttls" => SecureSocketOptions.StartTls,
                _ => SecureSocketOptions.None,
            };
            if (security is not ("ssl" or "starttls")
                && !(security == "none" && configuration.GetValue("FlowPilot:Smtp:AllowPlainText", false))) return null;
            var port = configuration.GetValue("FlowPilot:Smtp:Port", 587);
            if (port is < 1 or > 65535) return null;
            return new SmtpSettings(
                host,
                port,
                socketOptions,
                userName,
                password,
                mailbox.Address,
                configuration["FlowPilot:Smtp:FromName"]?.Trim() ?? "FlowPilot",
                Math.Clamp(configuration.GetValue("FlowPilot:Smtp:MaxAttempts", 6), 1, 20),
                Math.Clamp(configuration.GetValue("FlowPilot:Smtp:BatchSize", 10), 1, 100),
                Math.Clamp(configuration.GetValue("FlowPilot:Smtp:TimeoutSeconds", 30), 5, 120));
        }
    }
}
