using System.Diagnostics;
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

    [HttpPost("logout")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> Logout(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        try
        {
            await authService.LogoutAsync(sessionToken, cancellationToken);
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
