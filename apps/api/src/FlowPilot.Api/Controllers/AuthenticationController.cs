using System.Diagnostics;
using System.ComponentModel.DataAnnotations;
using FlowPilot.Application.Authentication;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
[Route("auth")]
public sealed class AuthenticationController(
    IAuthService authService,
    IConfiguration configuration) : ControllerBase
{
    private const string CookieSecureConfigurationKey =
        "FlowPilot:Authentication:CookieSecure";

    [HttpPost("login")]
    [ProducesResponseType<SessionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<SessionDto>> Login(
        [FromBody] LoginRequest request,
        CancellationToken cancellationToken)
    {
        var sourceIp = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var result = await authService.LoginAsync(
            request.LoginName,
            request.Password,
            sourceIp,
            cancellationToken);

        if (result.Session is not null && result.SessionToken is not null)
        {
            Response.Cookies.Append(
                ApiConstants.SessionCookieName,
                result.SessionToken,
                CreateCookieOptions());
            return Ok(result.Session);
        }

        return result.Failure switch
        {
            AuthenticationFailure.BadRequest => AuthenticationProblem(
                StatusCodes.Status400BadRequest,
                "BAD_REQUEST",
                "登录请求无效",
                "登录账号和密码不能为空。"),
            AuthenticationFailure.InvalidCredentials => AuthenticationProblem(
                StatusCodes.Status401Unauthorized,
                "INVALID_CREDENTIALS",
                "登录失败",
                "账号或密码错误。"),
            AuthenticationFailure.DomainAuthenticationUnavailable => AuthenticationProblem(
                StatusCodes.Status503ServiceUnavailable,
                "DOMAIN_AUTHENTICATION_UNAVAILABLE",
                "域认证暂不可用",
                "当前后端尚未启用域认证，请使用密码登录账号或联系管理员。"),
            AuthenticationFailure.RateLimited => RateLimitedProblem(result.RetryAfterSeconds),
            _ => throw new InvalidOperationException("Authentication service returned no result."),
        };
    }

    [HttpGet("me")]
    [ProducesResponseType<SessionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<SessionDto>> Me(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.GetCurrentSessionAsync(sessionToken, cancellationToken);
        return result.Session is not null
            ? Ok(result.Session)
            : AuthenticationProblem(
                StatusCodes.Status401Unauthorized,
                "AUTHENTICATION_REQUIRED",
                "尚未登录",
                "当前会话不存在或已失效，请重新登录。");
    }

    [HttpGet("impersonation/candidates")]
    [ProducesResponseType<ImpersonationCandidatePageDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<ImpersonationCandidatePageDto>> ListImpersonationCandidates(
        [FromQuery] ImpersonationCandidateParameters parameters,
        CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.ListImpersonationCandidatesAsync(
            sessionToken,
            parameters.Page,
            parameters.PageSize,
            parameters.Q,
            cancellationToken);
        return result.Page is not null
            ? Ok(result.Page)
            : ImpersonationProblem(result.Failure);
    }

    [HttpPost("impersonation")]
    [ProducesResponseType<SessionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<SessionDto>> StartImpersonation(
        [FromBody] StartImpersonationRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.StartImpersonationAsync(
            sessionToken,
            request.TargetUserId,
            request.Reason,
            idempotencyKey,
            CurrentTraceId(),
            cancellationToken);
        return result.Session is not null
            ? Ok(result.Session)
            : ImpersonationProblem(result.Failure);
    }

    [HttpDelete("impersonation")]
    [ProducesResponseType<SessionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<SessionDto>> StopImpersonation(
        CancellationToken cancellationToken)
    {
        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.StopImpersonationAsync(
            sessionToken,
            idempotencyKey,
            CurrentTraceId(),
            cancellationToken);
        return result.Session is not null
            ? Ok(result.Session)
            : ImpersonationProblem(result.Failure);
    }

    [HttpPost("logout")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> Logout(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        try
        {
            await authService.LogoutAsync(sessionToken, CurrentTraceId(), cancellationToken);
        }
        finally
        {
            Response.Cookies.Delete(
                ApiConstants.SessionCookieName,
                CreateCookieOptions());
        }

        return NoContent();
    }

    private ObjectResult RateLimitedProblem(int? retryAfterSeconds)
    {
        var retryAfter = Math.Max(1, retryAfterSeconds ?? 300);
        Response.Headers["Retry-After"] = retryAfter.ToString(
            System.Globalization.CultureInfo.InvariantCulture);
        return AuthenticationProblem(
            StatusCodes.Status429TooManyRequests,
            "RATE_LIMITED",
            "登录尝试过于频繁",
            $"请在 {retryAfter} 秒后重试。");
    }

    private ObjectResult AuthenticationProblem(
        int status,
        string code,
        string title,
        string detail)
    {
        var problem = new ProblemDetails
        {
            Status = status,
            Type = $"/problems/{ToProblemSlug(code)}",
            Title = title,
            Detail = detail,
            Instance = Request.Path,
        };
        problem.Extensions["code"] = code;
        problem.Extensions["traceId"] = Activity.Current?.TraceId.ToString()
            ?? HttpContext.TraceIdentifier;
        return StatusCode(status, problem);
    }

    private ObjectResult ImpersonationProblem(ImpersonationFailure? failure) => failure switch
    {
        ImpersonationFailure.AuthenticationRequired => AuthenticationProblem(
            StatusCodes.Status401Unauthorized,
            "AUTHENTICATION_REQUIRED",
            "尚未登录",
            "当前会话不存在或已失效，请重新登录。"),
        ImpersonationFailure.NotAllowed => AuthenticationProblem(
            StatusCodes.Status403Forbidden,
            "IMPERSONATION_NOT_ALLOWED",
            "不允许模拟身份",
            "只有真实登录的系统内置超级管理员可以模拟身份。"),
        ImpersonationFailure.TargetNotFound => AuthenticationProblem(
            StatusCodes.Status404NotFound,
            "IMPERSONATION_TARGET_NOT_FOUND",
            "模拟用户不存在",
            "目标用户不存在或已经被删除。"),
        ImpersonationFailure.TargetInvalid => AuthenticationProblem(
            StatusCodes.Status422UnprocessableEntity,
            "IMPERSONATION_TARGET_INVALID",
            "模拟用户无效",
            "请选择一个启用的非内置用户。"),
        ImpersonationFailure.AlreadyActive => AuthenticationProblem(
            StatusCodes.Status409Conflict,
            "IMPERSONATION_ALREADY_ACTIVE",
            "模拟身份已经生效",
            "请先退出当前模拟身份。"),
        ImpersonationFailure.InvalidSessionState => AuthenticationProblem(
            StatusCodes.Status409Conflict,
            "IMPERSONATION_SESSION_INVALID",
            "模拟会话状态异常",
            "当前模拟身份状态已发生变化，请刷新页面后重试。"),
        ImpersonationFailure.IdempotencyKeyReused => AuthenticationProblem(
            StatusCodes.Status409Conflict,
            "IDEMPOTENCY_KEY_REUSED",
            "幂等键已被使用",
            "同一个 Idempotency-Key 不能用于不同的模拟身份请求。"),
        ImpersonationFailure.IdempotencyRequestInProgress => AuthenticationProblem(
            StatusCodes.Status409Conflict,
            "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            "请求正在处理中",
            "相同的模拟身份请求正在处理中，请稍后重试。"),
        _ => throw new InvalidOperationException("Authentication service returned no impersonation result."),
    };

    private bool TryGetIdempotencyKey(out string key, out ObjectResult? problem)
    {
        var values = Request.Headers["Idempotency-Key"];
        if (values.Count != 1 || string.IsNullOrWhiteSpace(values[0]))
        {
            key = string.Empty;
            problem = AuthenticationProblem(
                StatusCodes.Status400BadRequest,
                "BAD_REQUEST",
                "缺少幂等键",
                "请求必须携带一个 Idempotency-Key。");
            return false;
        }

        key = values[0]!.Trim();
        if (key.Length is < 16 or > 100)
        {
            problem = AuthenticationProblem(
                StatusCodes.Status400BadRequest,
                "BAD_REQUEST",
                "幂等键格式无效",
                "Idempotency-Key 的长度必须为 16 到 100 个字符。");
            return false;
        }

        problem = null;
        return true;
    }

    private string CurrentTraceId() =>
        Activity.Current?.TraceId.ToString() ?? HttpContext.TraceIdentifier;

    private CookieOptions CreateCookieOptions() => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Secure = configuration.GetValue<bool>(CookieSecureConfigurationKey),
        Path = ApiConstants.SessionCookiePath,
        IsEssential = true,
    };

    private static string ToProblemSlug(string code) =>
        code.ToLowerInvariant().Replace('_', '-');
}

public sealed class ImpersonationCandidateParameters
{
    [Range(1, int.MaxValue)]
    public int Page { get; init; } = 1;

    [Range(1, 100)]
    public int PageSize { get; init; } = 20;

    [StringLength(100)]
    public string? Q { get; init; }
}
