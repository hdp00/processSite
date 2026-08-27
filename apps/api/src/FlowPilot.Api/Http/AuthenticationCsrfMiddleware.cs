using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;

namespace FlowPilot.Api.Http;

public sealed class AuthenticationCsrfMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(
        HttpContext context,
        IProblemDetailsService problemDetailsService)
    {
        if (!RequiresValidation(context.Request)
            || HasTrustedSameOrigin(context.Request))
        {
            await next(context);
            return;
        }

        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status403Forbidden,
            Type = "/problems/csrf-validation-failed",
            Title = "请求来源校验失败",
            Detail = "请求必须来自与 FlowPilot API 相同的站点。",
            Instance = context.Request.Path,
        };
        problem.Extensions["code"] = "CSRF_VALIDATION_FAILED";
        problem.Extensions["traceId"] = Activity.Current?.TraceId.ToString()
            ?? context.TraceIdentifier;

        var written = await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            ProblemDetails = problem,
        });
        if (!written)
        {
            await context.Response.WriteAsJsonAsync(problem, context.RequestAborted);
        }
    }

    private static bool RequiresValidation(HttpRequest request) =>
        !HttpMethods.IsGet(request.Method)
        && !HttpMethods.IsHead(request.Method)
        && !HttpMethods.IsOptions(request.Method)
        && !HttpMethods.IsTrace(request.Method);

    private static bool HasTrustedSameOrigin(HttpRequest request)
    {
        var usesOrigin = request.Headers.TryGetValue("Origin", out var sourceValues);
        if (!usesOrigin
            && !request.Headers.TryGetValue("Referer", out sourceValues))
        {
            return false;
        }

        if (sourceValues.Count != 1
            || StringValues.IsNullOrEmpty(sourceValues)
            || !Uri.TryCreate(sourceValues[0], UriKind.Absolute, out var sourceUri)
            || !IsHttpScheme(sourceUri.Scheme)
            || !string.IsNullOrEmpty(sourceUri.UserInfo))
        {
            return false;
        }

        if (usesOrigin
            && (sourceUri.AbsolutePath != "/"
                || !string.IsNullOrEmpty(sourceUri.Query)
                || !string.IsNullOrEmpty(sourceUri.Fragment)))
        {
            return false;
        }

        if (!IsHttpScheme(request.Scheme)
            || !request.Host.HasValue
            || !Uri.TryCreate(
                $"{request.Scheme}://{request.Host.Value}",
                UriKind.Absolute,
                out var requestOrigin))
        {
            return false;
        }

        return Uri.Compare(
            sourceUri,
            requestOrigin,
            UriComponents.SchemeAndServer,
            UriFormat.SafeUnescaped,
            StringComparison.OrdinalIgnoreCase) == 0;
    }

    private static bool IsHttpScheme(string scheme) =>
        string.Equals(scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
        || string.Equals(scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
}
