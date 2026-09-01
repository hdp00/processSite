using System.Text.Encodings.Web;
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
        if (settings is null)
        {
            return;
        }

        for (var index = 0; index < settings.BatchSize; index++)
        {
            var message = await ClaimAsync(settings.MaxAttempts, cancellationToken).ConfigureAwait(false);
            if (message is null)
            {
                break;
            }

            await SendAsync(message, settings, cancellationToken).ConfigureAwait(false);
        }
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
            .OrderBy(item => item.ScheduledAt)
            .ThenBy(item => item.Id)
            .FirstOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        if (message is null)
        {
            return null;
        }

        if (message.Status == "processing")
        {
            await FinishExpiredAttemptAsync(message, now, cancellationToken).ConfigureAwait(false);
            if (message.AttemptCount >= maxAttempts)
            {
                message.Revision++;
                MarkDeadLetter(message, "LEASE_EXPIRED", "发送进程多次在租约到期前未完成。", now);
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

    private async Task FinishExpiredAttemptAsync(
        RuntimeEmailOutboxMessage message,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var attempt = await _dbContext.RuntimeEmailDeliveryAttempts
            .SingleOrDefaultAsync(item => item.OutboxId == message.Id
                && item.AttemptNumber == message.AttemptCount
                && item.Result == "processing", cancellationToken)
            .ConfigureAwait(false);
        if (attempt is null)
        {
            return;
        }

        attempt.CompletedAt = now.UtcDateTime;
        attempt.Result = "failed";
        attempt.ErrorCategory = "LEASE_EXPIRED";
        attempt.ServerResponseSummary = "发送进程在租约到期前未完成。";
    }

    private async Task SendAsync(
        RuntimeEmailOutboxMessage message,
        SmtpSettings settings,
        CancellationToken cancellationToken)
    {
        try
        {
            var mimeMessage = CreateMimeMessage(message, settings);
            using var client = new SmtpClient { Timeout = settings.TimeoutSeconds * 1000 };
            await client.ConnectAsync(settings.Host, settings.Port, settings.SocketOptions, cancellationToken)
                .ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(settings.UserName))
            {
                await client.AuthenticateAsync(settings.UserName, settings.Password!, cancellationToken)
                    .ConfigureAwait(false);
            }

            await client.SendAsync(mimeMessage, cancellationToken).ConfigureAwait(false);
            await client.DisconnectAsync(true, cancellationToken).ConfigureAwait(false);
            await CompleteAttemptAsync(message, true, null, null, settings.MaxAttempts, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is SmtpCommandException
            or SmtpProtocolException
            or IOException
            or TimeoutException
            or MailKit.Security.AuthenticationException)
        {
            LogSendFailure(_logger, message.Id, exception);
            await CompleteAttemptAsync(
                message,
                false,
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
            .SingleAsync(item => item.OutboxId == message.Id
                && item.AttemptNumber == message.AttemptCount, cancellationToken)
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
            MarkDeadLetter(message, errorCode, errorSummary, now);
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

    private void MarkDeadLetter(
        RuntimeEmailOutboxMessage message,
        string? errorCode,
        string? errorSummary,
        DateTimeOffset now)
    {
        message.Status = "dead-letter";
        message.DeadLetteredAt = now.UtcDateTime;
        message.LeaseOwner = null;
        message.LeaseUntil = null;
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

    private static MimeMessage CreateMimeMessage(RuntimeEmailOutboxMessage message, SmtpSettings settings)
    {
        var data = JsonNode.Parse(message.TemplateDataJson) as JsonObject ?? new JsonObject();
        var recipientName = data["recipientName"]?.GetValue<string>() ?? string.Empty;
        var processName = data["processName"]?.GetValue<string>() ?? "流程";
        var instanceNumber = data["instanceNumber"]?.GetValue<string>() ?? string.Empty;
        var nodeName = data["nodeName"]?.GetValue<string>() ?? string.Empty;
        var link = message.ResolvedTargetUrl ?? string.Empty;
        var encodedProcessName = HtmlEncoder.Default.Encode(processName);
        var encodedInstanceNumber = HtmlEncoder.Default.Encode(instanceNumber);
        var encodedNodeName = HtmlEncoder.Default.Encode(nodeName);
        var description = message.EventType switch
        {
            "process-completed" => $"流程“{encodedProcessName}”（{encodedInstanceNumber}）已完成。",
            "free-collaboration-closed" => $"自由协作事项“{encodedProcessName}”（{encodedInstanceNumber}）已关闭。",
            "free-collaboration-assigned" => $"自由协作事项“{encodedProcessName}”（{encodedInstanceNumber}）已交由您受理，请及时处理。",
            _ => $"流程“{encodedProcessName}”（{encodedInstanceNumber}）已进入“{encodedNodeName}”，请及时处理。",
        };
        var textDescription = message.EventType switch
        {
            "process-completed" => $"{processName}（{instanceNumber}）已完成。",
            "free-collaboration-closed" => $"自由协作事项 {processName}（{instanceNumber}）已关闭。",
            "free-collaboration-assigned" => $"自由协作事项 {processName}（{instanceNumber}）已交由您受理，请及时处理。",
            _ => $"{processName}（{instanceNumber}）已进入“{nodeName}”，请及时处理。",
        };
        var result = new MimeMessage();
        result.From.Add(new MailboxAddress(settings.FromName, settings.FromAddress));
        result.To.Add(MailboxAddress.Parse(settings.TestEmail ?? message.RecipientEmailSnapshot));
        result.Subject = SafeHeader(message.Subject);
        result.Body = new BodyBuilder
        {
            HtmlBody = $"<p>{HtmlEncoder.Default.Encode(recipientName)}，您好：</p><p>{description}</p><p><a href=\"{HtmlEncoder.Default.Encode(link)}\">打开流程</a></p>",
            TextBody = $"{recipientName}，您好：\n{textDescription}\n{link}",
        }.ToMessageBody();
        return result;
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

    private sealed record SmtpSettings(
        string Host,
        int Port,
        SecureSocketOptions SocketOptions,
        string? UserName,
        string? Password,
        string FromAddress,
        string FromName,
        string? TestEmail,
        int MaxAttempts,
        int BatchSize,
        int TimeoutSeconds)
    {
        public static SmtpSettings? Read(IConfiguration configuration)
        {
            if (!configuration.GetValue("FlowPilot:Smtp:Enabled", false))
            {
                return null;
            }

            var host = configuration["FlowPilot:Smtp:Host"]?.Trim();
            var from = configuration["FlowPilot:Smtp:From"]?.Trim();
            var userName = configuration["FlowPilot:Smtp:UserName"]?.Trim();
            var password = configuration["FlowPilot:Smtp:Password"];
            var testEmail = TestEmailOverride.Read(configuration);
            if (string.IsNullOrWhiteSpace(host)
                || !MailboxAddress.TryParse(from, out var mailbox)
                || testEmail.Configured && testEmail.Address is null
                || string.IsNullOrWhiteSpace(userName) != string.IsNullOrWhiteSpace(password))
            {
                return null;
            }

            var security = configuration["FlowPilot:Smtp:Security"]?.Trim().ToLowerInvariant() ?? "starttls";
            var socketOptions = security switch
            {
                "ssl" => SecureSocketOptions.SslOnConnect,
                "none" when configuration.GetValue("FlowPilot:Smtp:AllowPlainText", false) => SecureSocketOptions.None,
                "starttls" => SecureSocketOptions.StartTls,
                _ => SecureSocketOptions.None,
            };
            if (security is not ("ssl" or "starttls")
                && !(security == "none" && configuration.GetValue("FlowPilot:Smtp:AllowPlainText", false)))
            {
                return null;
            }

            var port = configuration.GetValue("FlowPilot:Smtp:Port", 587);
            if (port is < 1 or > 65535)
            {
                return null;
            }

            return new SmtpSettings(
                host,
                port,
                socketOptions,
                userName,
                password,
                mailbox.Address,
                configuration["FlowPilot:Smtp:FromName"]?.Trim() ?? "FlowPilot",
                testEmail.Address,
                Math.Clamp(configuration.GetValue("FlowPilot:Smtp:MaxAttempts", 6), 1, 20),
                Math.Clamp(configuration.GetValue("FlowPilot:Smtp:BatchSize", 10), 1, 100),
                Math.Clamp(configuration.GetValue("FlowPilot:Smtp:TimeoutSeconds", 30), 5, 120));
        }
    }
}
