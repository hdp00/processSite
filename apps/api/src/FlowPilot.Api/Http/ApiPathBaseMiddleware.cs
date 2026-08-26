namespace FlowPilot.Api.Http;

public sealed class ApiPathBaseMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        if (!string.Equals(context.Request.PathBase.Value, ApiConstants.PathBase, StringComparison.Ordinal))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        await next(context);
    }
}
