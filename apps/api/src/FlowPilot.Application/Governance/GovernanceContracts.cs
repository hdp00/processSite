using System.Text.Json.Nodes;

namespace FlowPilot.Application.Governance;

public sealed record GovernancePageMetaDto(int Page, int PageSize, long Total, int TotalPages);

public sealed record GovernancePageDto<T>(IReadOnlyList<T> Items, GovernancePageMetaDto Meta);

public sealed record GovernanceUserRefDto(Guid Id, string Name);

public sealed record EmailDeliveryAttemptDto(
    Guid Id,
    int AttemptNumber,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    string Result,
    string? ErrorCode,
    string? ResponseSummary);

public sealed record EmailOutboxMessageDto(
    Guid Id,
    int Revision,
    string IdempotencyKey,
    string EventType,
    Guid AggregateId,
    Guid InstanceId,
    Guid? TaskId,
    int? ActivationSequence,
    GovernanceUserRefDto Recipient,
    string RecipientEmailSnapshot,
    string Subject,
    JsonObject TemplateData,
    string TargetPath,
    string? ResolvedTargetUrl,
    string Status,
    int AttemptCount,
    DateTimeOffset? NextAttemptAt,
    DateTimeOffset? LastAttemptAt,
    string? LastError,
    DateTimeOffset? SentAt,
    DateTimeOffset? DeadLetterAt,
    DateTimeOffset CreatedAt,
    IReadOnlyList<EmailDeliveryAttemptDto>? DeliveryAttempts = null);

public sealed record AuditEventDto(
    Guid Id,
    string Action,
    string AggregateType,
    Guid AggregateId,
    GovernanceUserRefDto Actor,
    GovernanceUserRefDto? Operator,
    DateTimeOffset OccurredAt,
    string Result,
    string TraceId,
    JsonObject? Details = null);

public sealed record EmailOutboxQuery(
    int Page,
    int PageSize,
    DateOnly DateFrom,
    DateOnly DateTo,
    string? Status,
    Guid? InstanceId,
    Guid? TaskId);

public sealed record AuditEventQuery(
    int Page,
    int PageSize,
    DateOnly DateFrom,
    DateOnly DateTo,
    string? Search,
    string? Category,
    string? Result,
    Guid? ActorId,
    string? Action,
    string? AggregateType,
    Guid? AggregateId,
    string? TraceId);

public enum GovernanceCommandError
{
    NotFound,
    RevisionMismatch,
    Conflict,
}

public sealed record GovernanceCommandFailure(
    GovernanceCommandError Error,
    string Code,
    string Title,
    string Detail,
    int? CurrentRevision = null);

public sealed record GovernanceCommandResult<T>(T? Value, GovernanceCommandFailure? Failure)
{
    public bool Succeeded => Failure is null;
}

public interface IGovernanceService
{
    Task<GovernancePageDto<EmailOutboxMessageDto>> ListEmailOutboxAsync(
        EmailOutboxQuery query,
        CancellationToken cancellationToken = default);

    Task<EmailOutboxMessageDto?> GetEmailOutboxAsync(
        Guid messageId,
        CancellationToken cancellationToken = default);

    Task<GovernanceCommandResult<EmailOutboxMessageDto>> RetryEmailAsync(
        Guid messageId,
        int expectedRevision,
        string idempotencyKey,
        Guid operatorUserId,
        Guid effectiveUserId,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<GovernancePageDto<AuditEventDto>> ListAuditEventsAsync(
        AuditEventQuery query,
        CancellationToken cancellationToken = default);

    Task<AuditEventDto?> GetAuditEventAsync(
        Guid auditEventId,
        CancellationToken cancellationToken = default);
}
