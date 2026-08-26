namespace FlowPilot.Api.Http;

public sealed class AllowedHostMiddleware
{
    private const string AllowedHostsKey = "FlowPilot:Http:AllowedHosts";

    private readonly RequestDelegate _next;
    private readonly HashSet<string> _allowedHosts;

    public AllowedHostMiddleware(RequestDelegate next, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(next);
        ArgumentNullException.ThrowIfNull(configuration);

        _next = next;
        _allowedHosts = (configuration[AllowedHostsKey] ?? string.Empty)
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var requestHost = context.Request.Host;
        if (string.IsNullOrEmpty(requestHost.Value)
            || (!_allowedHosts.Contains(requestHost.Value)
                && !_allowedHosts.Contains(requestHost.Host)))
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        await _next(context);
    }
}
