using FlowPilot.Application.Health;
using FlowPilot.Contracts.Health;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
[Route("health")]
public sealed class HealthController(
    IDatabaseReadinessCheck databaseReadinessCheck,
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
}
