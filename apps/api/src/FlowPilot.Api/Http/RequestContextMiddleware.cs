using System.Diagnostics;

namespace FlowPilot.Api.Http;

public sealed class RequestContextMiddleware(RequestDelegate next)
{
    private const string RequestIdHeader = "X-Request-Id";

    public async Task InvokeAsync(HttpContext context)
    {
        var traceId = Activity.Current?.TraceId.ToString();
        if (!string.IsNullOrEmpty(traceId))
        {
            context.TraceIdentifier = traceId;
        }

        context.Response.OnStarting(() =>
        {
            context.Response.Headers[RequestIdHeader] = context.TraceIdentifier;
            return Task.CompletedTask;
        });

        await next(context);
    }
}
