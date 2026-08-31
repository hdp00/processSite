using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Attachments;
using FlowPilot.Infrastructure.BackgroundJobs;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.Health;

public sealed class OperationalHealthService(
    IDatabaseReadinessCheck databaseReadiness,
    FlowPilotDbContext dbContext,
    AttachmentFileStorage attachmentStorage,
    BackgroundJobHealthState backgroundJobHealth,
    IConfiguration configuration,
    TimeProvider timeProvider) : IOperationalHealthService
{
    public async Task<OperationalHealthDto> GetAsync(
        string applicationVersion,
        CancellationToken cancellationToken = default)
    {
        var checkedAt = timeProvider.GetUtcNow();
        var database = await databaseReadiness.CheckAsync(cancellationToken).ConfigureAwait(false);
        var checks = new List<OperationalHealthCheckDto>
        {
            Check("database", database.IsReady, database.Code, checkedAt),
            Check("schema", database.IsReady, database.Code, checkedAt),
            ConfigurationCheck("domain-auth", HasLdapConfiguration(configuration), "LDAP_NOT_CONFIGURED", checkedAt),
            ConfigurationCheck("smtp", HasSmtpConfiguration(configuration), "SMTP_DISABLED_OR_INCOMPLETE", checkedAt),
            AttachmentCheck(attachmentStorage.RootDirectory, checkedAt),
        };

        if (database.IsReady)
        {
            var deadLetters = await dbContext.RuntimeEmailOutboxMessages.AsNoTracking()
                .CountAsync(item => item.Status == "dead-letter", cancellationToken).ConfigureAwait(false);
            var cleanupPending = await dbContext.RuntimeAttachments.AsNoTracking()
                .CountAsync(item => item.State == "cleanup-pending", cancellationToken).ConfigureAwait(false);
            checks.Add(new OperationalHealthCheckDto(
                "attachment-cleanup",
                cleanupPending == 0 ? "ok" : "degraded",
                checkedAt,
                cleanupPending == 0 ? null : "ATTACHMENT_CLEANUP_PENDING",
                null,
                new Dictionary<string, object?> { ["pendingCount"] = cleanupPending }));
            checks.Add(new OperationalHealthCheckDto(
                "email-outbox",
                deadLetters == 0 ? "ok" : "degraded",
                checkedAt,
                deadLetters == 0 ? null : "EMAIL_DEAD_LETTERS_PRESENT",
                null,
                new Dictionary<string, object?> { ["deadLetterCount"] = deadLetters }));
        }
        else
        {
            checks.Add(Check("attachment-cleanup", false, "DATABASE_UNAVAILABLE", checkedAt));
            checks.Add(Check("email-outbox", false, "DATABASE_UNAVAILABLE", checkedAt));
        }
        var scheduler = backgroundJobHealth.Read();
        checks.Add(new OperationalHealthCheckDto(
            "scheduler",
            scheduler.HasCurrentFailure ? "degraded" : "ok",
            checkedAt,
            scheduler.HasCurrentFailure ? "BACKGROUND_JOB_CYCLE_FAILED" : null,
            Metrics: new Dictionary<string, object?>
            {
                ["lastSucceededAt"] = scheduler.LastSucceededAt,
                ["lastFailedAt"] = scheduler.LastFailedAt,
            }));

        var status = checks.Any(item => item.Status == "unavailable")
            ? "unavailable"
            : checks.Any(item => item.Status == "degraded") ? "degraded" : "ok";
        return new OperationalHealthDto(status, checkedAt, applicationVersion, checks);
    }

    private static OperationalHealthCheckDto Check(string name, bool ok, string code, DateTimeOffset checkedAt) =>
        new(name, ok ? "ok" : "unavailable", checkedAt, ok ? null : code);

    private static OperationalHealthCheckDto ConfigurationCheck(string name, bool configured, string code, DateTimeOffset checkedAt) =>
        new(name, configured ? "ok" : "degraded", checkedAt, configured ? null : code);

    private static OperationalHealthCheckDto AttachmentCheck(string rootDirectory, DateTimeOffset checkedAt)
    {
        try
        {
            var root = Path.GetPathRoot(rootDirectory)!;
            var freeBytes = new DriveInfo(root).AvailableFreeSpace;
            return new OperationalHealthCheckDto(
                "attachment-storage",
                "ok",
                checkedAt,
                Metrics: new Dictionary<string, object?> { ["freeBytes"] = freeBytes });
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return new OperationalHealthCheckDto("attachment-storage", "unavailable", checkedAt, "ATTACHMENT_STORAGE_UNAVAILABLE");
        }
    }

    private static bool HasLdapConfiguration(IConfiguration configuration) =>
        !string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:Url"])
        && !string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:BaseDn"])
        && !string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:UpnSuffix"]);

    private static bool HasSmtpConfiguration(IConfiguration configuration) =>
        configuration.GetValue("FlowPilot:Smtp:Enabled", false)
        && !string.IsNullOrWhiteSpace(configuration["FlowPilot:Smtp:Host"])
        && !string.IsNullOrWhiteSpace(configuration["FlowPilot:Smtp:From"]);
}
