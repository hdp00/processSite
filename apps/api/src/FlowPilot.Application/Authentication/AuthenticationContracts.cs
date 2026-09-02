using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace FlowPilot.Application.Authentication;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record LoginRequest(
    [Required, StringLength(100, MinimumLength = 1)] string LoginName,
    [Required, StringLength(200, MinimumLength = 1)] string Password);

public sealed record SessionDto(
    UserDto User,
    UserDto OperatorUser,
    IReadOnlyList<Guid> RoleIds,
    IReadOnlyList<string> Permissions,
    bool SuperAdmin,
    bool OperatorSuperAdmin,
    ImpersonationContextDto? Impersonation,
    DateTimeOffset ExpiresAt);

public sealed record ImpersonationContextDto(
    Guid Id,
    Guid OperatorUserId,
    Guid TargetUserId,
    string Reason,
    DateTimeOffset StartedAt,
    DateTimeOffset ExpiresAt);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record StartImpersonationRequest(
    Guid TargetUserId,
    [Required, StringLength(500, MinimumLength = 1)] string Reason);

public sealed record AuthenticationPageMetaDto(
    int Page,
    int PageSize,
    int Total,
    int TotalPages);

public sealed record ImpersonationCandidatePageDto(
    IReadOnlyList<UserDto> Items,
    AuthenticationPageMetaDto Meta);

public sealed record UserDto(
    Guid Id,
    int Revision,
    string LoginName,
    string Name,
    string Email,
    string AuthenticationMode,
    string Status,
    DepartmentRefDto? Department,
    PositionRefDto? Position,
    IReadOnlyList<RoleRefDto> Roles,
    bool SuperAdmin,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? LastLoginAt,
    bool HasLocalPassword);

public sealed record DepartmentRefDto(Guid Id, string Name, string Path);

public sealed record PositionRefDto(Guid Id, string Name);

public sealed record RoleRefDto(Guid Id, string Name);

public enum AuthenticationFailure
{
    BadRequest,
    InvalidCredentials,
    AuthenticationRequired,
    DomainAuthenticationUnavailable,
    RateLimited,
}

public enum ImpersonationFailure
{
    AuthenticationRequired,
    NotAllowed,
    TargetNotFound,
    TargetInvalid,
    AlreadyActive,
    InvalidSessionState,
    IdempotencyKeyReused,
    IdempotencyRequestInProgress,
}

public sealed record LoginResult(
    SessionDto? Session,
    string? SessionToken,
    AuthenticationFailure? Failure,
    int? RetryAfterSeconds = null)
{
    public static LoginResult Success(SessionDto session, string sessionToken) =>
        new(session, sessionToken, null);

    public static LoginResult Failed(
        AuthenticationFailure failure,
        int? retryAfterSeconds = null) =>
        new(null, null, failure, retryAfterSeconds);
}

public sealed record CurrentSessionResult(
    SessionDto? Session,
    AuthenticationFailure? Failure)
{
    public static CurrentSessionResult Success(SessionDto session) => new(session, null);

    public static CurrentSessionResult AuthenticationRequired() =>
        new(null, AuthenticationFailure.AuthenticationRequired);
}

public sealed record ImpersonationCandidateResult(
    ImpersonationCandidatePageDto? Page,
    ImpersonationFailure? Failure)
{
    public static ImpersonationCandidateResult Success(ImpersonationCandidatePageDto page) =>
        new(page, null);

    public static ImpersonationCandidateResult Failed(ImpersonationFailure failure) =>
        new(null, failure);
}

public sealed record ImpersonationCommandResult(
    SessionDto? Session,
    ImpersonationFailure? Failure)
{
    public static ImpersonationCommandResult Success(SessionDto session) =>
        new(session, null);

    public static ImpersonationCommandResult Failed(ImpersonationFailure failure) =>
        new(null, failure);
}

public interface IAuthService
{
    Task<LoginResult> LoginAsync(
        string loginName,
        string password,
        string sourceIp,
        CancellationToken cancellationToken = default);

    Task<CurrentSessionResult> GetCurrentSessionAsync(
        string? sessionToken,
        CancellationToken cancellationToken = default);

    Task<ImpersonationCandidateResult> ListImpersonationCandidatesAsync(
        string? sessionToken,
        int page,
        int pageSize,
        string? query,
        CancellationToken cancellationToken = default);

    Task<ImpersonationCommandResult> StartImpersonationAsync(
        string? sessionToken,
        Guid targetUserId,
        string reason,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task<ImpersonationCommandResult> StopImpersonationAsync(
        string? sessionToken,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default);

    Task LogoutAsync(
        string? sessionToken,
        string traceId,
        CancellationToken cancellationToken = default);
}
