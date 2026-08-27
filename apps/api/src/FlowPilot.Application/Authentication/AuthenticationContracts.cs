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
    DateTimeOffset ExpiresAt);

public sealed record UserDto(
    Guid Id,
    int Revision,
    string LoginName,
    string Name,
    string Email,
    string AuthenticationMode,
    string Status,
    DepartmentRefDto Department,
    PositionRefDto Position,
    IReadOnlyList<RoleRefDto> Roles,
    bool SuperAdmin,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

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

    Task LogoutAsync(
        string? sessionToken,
        CancellationToken cancellationToken = default);
}
