using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.Governance;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Governance;

public sealed class SqlServerGovernanceService(
    FlowPilotDbContext dbContext,
    TimeProvider timeProvider) : IGovernanceService
{
    private const string RetryEmailRouteScope = "POST /email-outbox/{messageId}/retry";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly string[] RetryAuditFields = ["status", "scheduledAt"];
    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly TimeProvider _timeProvider = timeProvider;

    public async Task<GovernancePageDto<EmailOutboxMessageDto>> ListEmailOutboxAsync(
        EmailOutboxQuery query,
        CancellationToken cancellationToken = default)
    {
        var (from, toExclusive) = DateRange(query.DateFrom, query.DateTo);
        var source = _dbContext.RuntimeEmailOutboxMessages
            .AsNoTracking()
            .Where(item => item.CreatedAt >= from && item.CreatedAt < toExclusive);
        if (query.Status is not null) source = source.Where(item => item.Status == query.Status);
        if (query.InstanceId.HasValue) source = source.Where(item => item.InstanceId == query.InstanceId.Value);
        if (query.TaskId.HasValue) source = source.Where(item => item.TaskId == query.TaskId.Value);

        var total = await source.LongCountAsync(cancellationToken).ConfigureAwait(false);
        var rows = await source
            .OrderByDescending(item => item.CreatedAt)
            .ThenBy(item => item.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var users = await LoadUsersAsync(rows.Select(item => item.RecipientUserId), cancellationToken)
            .ConfigureAwait(false);
        var lastAttempts = await LoadLastAttemptsAsync(rows.Select(item => item.Id), cancellationToken)
            .ConfigureAwait(false);
        var items = rows.Select(row => MapEmail(
            row,
            users.GetValueOrDefault(row.RecipientUserId, "未知用户"),
            lastAttempts.GetValueOrDefault(row.Id),
            null)).ToArray();
        return Page(items, query.Page, query.PageSize, total);
    }

    public async Task<EmailOutboxMessageDto?> GetEmailOutboxAsync(
        Guid messageId,
        CancellationToken cancellationToken = default)
    {
        var row = await _dbContext.RuntimeEmailOutboxMessages
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == messageId, cancellationToken)
            .ConfigureAwait(false);
        if (row is null) return null;

        var userName = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(user => user.Id == row.RecipientUserId)
            .Select(user => user.DisplayName)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false) ?? "未知用户";
        var attemptRows = await _dbContext.RuntimeEmailDeliveryAttempts
            .AsNoTracking()
            .Where(item => item.OutboxId == messageId)
            .OrderBy(item => item.AttemptNumber)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var attempts = attemptRows.Select(item => new EmailDeliveryAttemptDto(
                item.Id,
                item.AttemptNumber,
                AsUtc(item.StartedAt),
                item.CompletedAt.HasValue ? AsUtc(item.CompletedAt.Value) : null,
                item.Result,
                item.ErrorCategory,
                item.ServerResponseSummary))
            .ToArray();
        return MapEmail(row, userName, attemptRows.LastOrDefault(), attempts);
    }

    public async Task<GovernanceCommandResult<EmailOutboxMessageDto>> RetryEmailAsync(
        Guid messageId,
        int expectedRevision,
        string idempotencyKey,
        Guid operatorUserId,
        Guid effectiveUserId,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        var requestHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{messageId:D}:{expectedRevision}")));
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var existing = await _dbContext.IdempotencyRecords
            .SingleOrDefaultAsync(item => item.ActorId == effectiveUserId
                && item.RouteScope == RetryEmailRouteScope
                && item.IdempotencyKey == idempotencyKey, cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
            {
                return Failed(
                    "IDEMPOTENCY_KEY_REUSED",
                    "幂等键已被使用",
                    "同一个 Idempotency-Key 不能用于不同的邮件重试请求。",
                    GovernanceCommandError.Conflict);
            }
            return new GovernanceCommandResult<EmailOutboxMessageDto>(
                await GetEmailOutboxAsync(messageId, cancellationToken).ConfigureAwait(false),
                null);
        }

        var message = await _dbContext.RuntimeEmailOutboxMessages
            .SingleOrDefaultAsync(item => item.Id == messageId, cancellationToken)
            .ConfigureAwait(false);
        if (message is null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed("EMAIL_OUTBOX_NOT_FOUND", "邮件记录不存在", "未找到指定的邮件投递记录。", GovernanceCommandError.NotFound);
        }

        if (message.Revision != expectedRevision)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return new GovernanceCommandResult<EmailOutboxMessageDto>(null, new GovernanceCommandFailure(
                GovernanceCommandError.RevisionMismatch,
                "REVISION_MISMATCH",
                "邮件记录已被修改",
                "请刷新后重试。",
                message.Revision));
        }

        if (message.Status is not ("retry-wait" or "dead-letter"))
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed(
                "EMAIL_RETRY_NOT_ALLOWED",
                "当前邮件不能重试",
                message.Status == "sent" ? "邮件已经发送成功，无需重试。" : "只有等待重试或死信邮件可以手工重试。",
                GovernanceCommandError.Conflict);
        }

        var now = _timeProvider.GetUtcNow();
        message.Status = "pending";
        message.ScheduledAt = now.UtcDateTime;
        message.LeaseOwner = null;
        message.LeaseUntil = null;
        message.LastErrorCode = null;
        message.LastErrorSummary = null;
        message.DeadLetteredAt = null;
        message.Revision++;
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "email-outbox",
            ResourceId = messageId,
            Action = "retry",
            FieldIdentifiersJson = JsonSerializer.Serialize(RetryAuditFields, JsonOptions),
            OperatorUserId = operatorUserId,
            EffectiveUserId = effectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
        _dbContext.IdempotencyRecords.Add(new IdempotencyRecordEntity
        {
            Id = Guid.NewGuid(),
            ActorId = effectiveUserId,
            RouteScope = RetryEmailRouteScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = 202,
            ReplayHeadersJson = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                ["ETag"] = $"\"{message.Revision}\"",
            }),
            ResponseBodyJson = JsonSerializer.Serialize(new { messageId }),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddHours(24).UtcDateTime,
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return new GovernanceCommandResult<EmailOutboxMessageDto>(
            await GetEmailOutboxAsync(messageId, cancellationToken).ConfigureAwait(false),
            null);
    }

    public async Task<GovernancePageDto<AuditEventDto>> ListAuditEventsAsync(
        AuditEventQuery query,
        CancellationToken cancellationToken = default)
    {
        var (from, toExclusive) = DateRange(query.DateFrom, query.DateTo);
        var source = _dbContext.RuntimeAuditEvents
            .AsNoTracking()
            .Where(item => item.OccurredAt >= from && item.OccurredAt < toExclusive);
        if (query.Result is not null) source = source.Where(item => item.Result == query.Result);
        if (query.ActorId.HasValue) source = source.Where(item => item.EffectiveUserId == query.ActorId.Value);
        if (query.Action is not null) source = source.Where(item => item.Action == query.Action);
        if (query.AggregateType is not null) source = source.Where(item => item.ResourceType == query.AggregateType);
        if (query.AggregateId.HasValue) source = source.Where(item => item.ResourceId == query.AggregateId.Value);
        if (query.TraceId is not null) source = source.Where(item => item.TraceId == query.TraceId);
        if (query.Category is not null) source = ApplyCategory(source, query.Category);
        if (query.Search is not null)
        {
            var search = query.Search;
            var matchingUserIds = _dbContext.OrganizationUserReferences
                .Where(user => user.DisplayName.Contains(search) || user.LoginName.Contains(search))
                .Select(user => user.Id);
            source = source.Where(item => item.Action.Contains(search)
                || item.TraceId.Contains(search)
                || matchingUserIds.Contains(item.EffectiveUserId)
                || matchingUserIds.Contains(item.OperatorUserId));
        }

        var total = await source.LongCountAsync(cancellationToken).ConfigureAwait(false);
        var rows = await source
            .OrderByDescending(item => item.OccurredAt)
            .ThenBy(item => item.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var users = await LoadUsersAsync(
            rows.SelectMany(item => new[] { item.EffectiveUserId, item.OperatorUserId }),
            cancellationToken).ConfigureAwait(false);
        var items = rows.Select(row => MapAudit(row, users)).ToArray();
        return Page(items, query.Page, query.PageSize, total);
    }

    public async Task<AuditEventDto?> GetAuditEventAsync(
        Guid auditEventId,
        CancellationToken cancellationToken = default)
    {
        var row = await _dbContext.RuntimeAuditEvents
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == auditEventId, cancellationToken)
            .ConfigureAwait(false);
        if (row is null) return null;
        var users = await LoadUsersAsync(
            new[] { row.EffectiveUserId, row.OperatorUserId },
            cancellationToken).ConfigureAwait(false);
        return MapAudit(row, users);
    }

    private static IQueryable<RuntimeAuditEvent> ApplyCategory(
        IQueryable<RuntimeAuditEvent> source,
        string category) => category switch
        {
            "authentication" => source.Where(item => item.ResourceType == "session" || item.ResourceType == "authentication"),
            "definition" => source.Where(item => item.ResourceType == "process-definition" || item.ResourceType == "process-version"),
            "task" => source.Where(item => item.ResourceType == "workflow-task" || item.ResourceType == "free-timeline-entry"),
            "identity" => source.Where(item => item.ResourceType == "user" || item.ResourceType == "role"
                || item.ResourceType == "department" || item.ResourceType == "position"
                || item.ResourceType == "workflow-permission-group"),
            _ => source.Where(item => item.ResourceType == "process-instance" || item.ResourceType == "attachment"),
        };

    private async Task<Dictionary<Guid, string>> LoadUsersAsync(
        IEnumerable<Guid> userIds,
        CancellationToken cancellationToken)
    {
        var ids = userIds.Distinct().ToArray();
        return await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(user => ids.Contains(user.Id))
            .ToDictionaryAsync(user => user.Id, user => user.DisplayName, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<Dictionary<Guid, RuntimeEmailDeliveryAttempt>> LoadLastAttemptsAsync(
        IEnumerable<Guid> outboxIds,
        CancellationToken cancellationToken)
    {
        var ids = outboxIds.Distinct().ToArray();
        var attempts = await _dbContext.RuntimeEmailDeliveryAttempts
            .AsNoTracking()
            .Where(item => ids.Contains(item.OutboxId))
            .OrderByDescending(item => item.AttemptNumber)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return attempts.GroupBy(item => item.OutboxId).ToDictionary(group => group.Key, group => group.First());
    }

    private static EmailOutboxMessageDto MapEmail(
        RuntimeEmailOutboxMessage row,
        string recipientName,
        RuntimeEmailDeliveryAttempt? lastAttempt,
        IReadOnlyList<EmailDeliveryAttemptDto>? attempts)
    {
        var templateData = JsonNode.Parse(row.TemplateDataJson) as JsonObject ?? new JsonObject();
        return new EmailOutboxMessageDto(
            row.Id,
            row.Revision,
            row.IdempotencyKey,
            row.EventType,
            row.TaskId ?? row.InstanceId,
            row.InstanceId,
            row.TaskId,
            ReadActivationSequence(templateData),
            new GovernanceUserRefDto(row.RecipientUserId, recipientName),
            row.RecipientEmailSnapshot,
            row.Subject,
            templateData,
            row.TargetPath,
            row.ResolvedTargetUrl,
            row.Status,
            row.AttemptCount,
            row.Status is "pending" or "retry-wait" ? AsUtc(row.ScheduledAt) : null,
            lastAttempt is null ? null : AsUtc(lastAttempt.StartedAt),
            row.LastErrorSummary,
            row.SentAt.HasValue ? AsUtc(row.SentAt.Value) : null,
            row.DeadLetteredAt.HasValue ? AsUtc(row.DeadLetteredAt.Value) : null,
            AsUtc(row.CreatedAt),
            attempts);
    }

    private static AuditEventDto MapAudit(
        RuntimeAuditEvent row,
        IReadOnlyDictionary<Guid, string> users)
    {
        var actor = new GovernanceUserRefDto(
            row.EffectiveUserId,
            users.GetValueOrDefault(row.EffectiveUserId, "未知用户"));
        var operatorUser = row.OperatorUserId == row.EffectiveUserId
            ? null
            : new GovernanceUserRefDto(
                row.OperatorUserId,
                users.GetValueOrDefault(row.OperatorUserId, "未知用户"));
        var fields = string.IsNullOrWhiteSpace(row.FieldIdentifiersJson)
            ? null
            : JsonNode.Parse(row.FieldIdentifiersJson);
        var details = fields is null ? null : new JsonObject { ["fieldIdentifiers"] = fields };
        return new AuditEventDto(
            row.Id,
            row.Action,
            row.ResourceType,
            row.ResourceId,
            actor,
            operatorUser,
            AsUtc(row.OccurredAt),
            row.Result,
            row.TraceId,
            details);
    }

    private static GovernancePageDto<T> Page<T>(
        IReadOnlyList<T> items,
        int page,
        int pageSize,
        long total) => new(
            items,
            new GovernancePageMetaDto(
                page,
                pageSize,
                total,
                total == 0 ? 0 : (int)Math.Ceiling(total / (double)pageSize)));

    private static GovernanceCommandResult<EmailOutboxMessageDto> Failed(
        string code,
        string title,
        string detail,
        GovernanceCommandError error) => new(null, new GovernanceCommandFailure(error, code, title, detail));

    private static (DateTime From, DateTime ToExclusive) DateRange(DateOnly from, DateOnly to) =>
        (DateTime.SpecifyKind(from.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc),
            DateTime.SpecifyKind(to.AddDays(1).ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc));

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static int? ReadActivationSequence(JsonObject templateData) =>
        templateData["activationSequence"] is JsonValue value && value.TryGetValue<int>(out var sequence)
            ? sequence
            : null;
}
