using FlowPilot.Application.Authentication;
using FlowPilot.Application.Health;
using FlowPilot.Contracts.Health;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
[Route("health")]
public sealed class HealthController(
    IDatabaseReadinessCheck databaseReadinessCheck,
    IOperationalHealthService operationalHealthService,
    IAuthService authService,
    TimeProvider timeProvider) : ControllerBase
{
    private static readonly string ApplicationVersion =
        typeof(HealthController).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    [HttpGet("live")]
    [ProducesResponseType<LivenessDto>(StatusCodes.Status200OK)]
    public ActionResult<LivenessDto> GetLiveness()
    {
        return Ok(new LivenessDto(
            HealthStatuses.Ok,
            timeProvider.GetUtcNow()));
    }

    [HttpGet("ready")]
    [ProducesResponseType<ReadinessDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ReadinessDto>(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<ReadinessDto>> GetReadiness(CancellationToken cancellationToken)
    {
        var result = await databaseReadinessCheck.CheckAsync(cancellationToken);
        var response = new ReadinessDto(
            result.IsReady ? HealthStatuses.Ok : HealthStatuses.Unavailable,
            timeProvider.GetUtcNow(),
            ApplicationVersion,
            result.IsReady ? null : result.Code);

        return result.IsReady
            ? Ok(response)
            : StatusCode(StatusCodes.Status503ServiceUnavailable, response);
    }

    [HttpGet("details")]
    [ProducesResponseType<OperationalHealthDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<OperationalHealthDto>> GetDetails(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var token);
        var session = (await authService.GetCurrentSessionAsync(token, cancellationToken).ConfigureAwait(false)).Session;
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }
        if (!session.SuperAdmin && !session.Permissions.Contains("system-monitor:查看", StringComparer.Ordinal))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有查看运行状态的权限。");
        }
        return Ok(await operationalHealthService.GetAsync(ApplicationVersion, cancellationToken).ConfigureAwait(false));
    }

    private ObjectResult ProblemResponse(int status, string code, string title, string detail)
    {
        var problem = new ProblemDetails { Status = status, Title = title, Detail = detail, Instance = Request.Path };
        problem.Extensions["code"] = code;
        problem.Extensions["traceId"] = HttpContext.TraceIdentifier;
        return StatusCode(status, problem);
    }
}
