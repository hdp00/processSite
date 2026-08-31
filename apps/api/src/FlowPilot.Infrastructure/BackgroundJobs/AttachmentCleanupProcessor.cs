using FlowPilot.Infrastructure.Attachments;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace FlowPilot.Infrastructure.BackgroundJobs;

public sealed class AttachmentCleanupProcessor(
    FlowPilotDbContext dbContext,
    AttachmentFileStorage fileStorage,
    IConfiguration configuration,
    TimeProvider timeProvider,
    ILogger<AttachmentCleanupProcessor> logger) : IFlowPilotBackgroundProcessor
{
    private static readonly Action<ILogger, Guid, Exception?> LogDeleteFailure =
        LoggerMessage.Define<Guid>(
            LogLevel.Warning,
            new EventId(2001, "AttachmentCleanupFailure"),
            "Failed to clean attachment {AttachmentId}.");
    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly AttachmentFileStorage _fileStorage = fileStorage;
    private readonly IConfiguration _configuration = configuration;
    private readonly TimeProvider _timeProvider = timeProvider;
    private readonly ILogger<AttachmentCleanupProcessor> _logger = logger;

    public async Task RunOnceAsync(CancellationToken cancellationToken = default)
    {
        var now = _timeProvider.GetUtcNow();
        var stagedLifetime = TimeSpan.FromHours(Math.Clamp(
            _configuration.GetValue("FlowPilot:BackgroundJobs:StagedAttachmentLifetimeHours", 24), 1, 168));
        var stagedBefore = now.Subtract(stagedLifetime).UtcDateTime;
        var candidates = await _dbContext.RuntimeAttachments
            .Where(item => (item.State == "staged" && item.StagedAt <= stagedBefore)
                || (item.State == "cleanup-pending" && item.CleanupAfter <= now.UtcDateTime))
            .Where(item => !_dbContext.AttachmentReferences.Any(reference => reference.AttachmentId == item.Id))
            .OrderBy(item => item.CreatedAt)
            .Take(50)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);

        foreach (var attachment in candidates)
        {
            try
            {
                _fileStorage.DeleteIfExists(attachment.StorageKey);
                attachment.State = "deleted";
                attachment.LastError = null;
                attachment.CleanupAfter = null;
                attachment.Revision++;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                attachment.State = "cleanup-pending";
                attachment.LastError = SafeSummary(exception.Message);
                attachment.CleanupAfter = now.AddHours(1).UtcDateTime;
                attachment.Revision++;
                LogDeleteFailure(_logger, attachment.Id, exception);
            }
        }

        if (candidates.Length > 0)
        {
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        var sentRetentionDays = Math.Clamp(
            _configuration.GetValue("FlowPilot:BackgroundJobs:SentEmailRetentionDays", 180),
            30,
            3650);
        var sentBefore = now.AddDays(-sentRetentionDays).UtcDateTime;
        await _dbContext.RuntimeEmailOutboxMessages
            .Where(item => item.Status == "sent" && item.SentAt < sentBefore)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        await _dbContext.IdempotencyRecords
            .Where(item => item.ExpiresAt < now.UtcDateTime)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        var expiredSessionRetention = now.AddDays(-7).UtcDateTime;
        await _dbContext.RuntimeSessions
            .Where(item => (item.AbsoluteExpiresAt < expiredSessionRetention || item.IdleExpiresAt < expiredSessionRetention)
                || item.RevokedAt < expiredSessionRetention)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private static string SafeSummary(string value) => value.Length <= 1000 ? value : value[..1000];
}
