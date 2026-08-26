using System.Diagnostics;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Http;

public static class ProblemDetailsConfiguration
{
    public static IServiceCollection AddFlowPilotProblemDetails(this IServiceCollection services)
    {
        services.AddProblemDetails(options =>
        {
            options.CustomizeProblemDetails = context =>
            {
                var problem = context.ProblemDetails;
                var status = problem.Status ?? context.HttpContext.Response.StatusCode;

                problem.Status = status;
                problem.Type ??= $"/problems/{GetProblemSlug(status)}";
                problem.Title ??= GetTitle(status);
                problem.Instance ??= context.HttpContext.Request.Path;
                problem.Extensions["code"] = GetProblemCode(status);
                problem.Extensions["traceId"] = Activity.Current?.TraceId.ToString()
                    ?? context.HttpContext.TraceIdentifier;
            };
        });

        services.AddExceptionHandler<UnhandledExceptionHandler>();
        return services;
    }

    private static string GetProblemSlug(int status) => status switch
    {
        StatusCodes.Status400BadRequest => "bad-request",
        StatusCodes.Status401Unauthorized => "unauthorized",
        StatusCodes.Status403Forbidden => "forbidden",
        StatusCodes.Status404NotFound => "not-found",
        StatusCodes.Status405MethodNotAllowed => "method-not-allowed",
        _ => "internal-server-error",
    };

    private static string GetProblemCode(int status) => status switch
    {
        StatusCodes.Status400BadRequest => "BAD_REQUEST",
        StatusCodes.Status401Unauthorized => "UNAUTHORIZED",
        StatusCodes.Status403Forbidden => "FORBIDDEN",
        StatusCodes.Status404NotFound => "NOT_FOUND",
        StatusCodes.Status405MethodNotAllowed => "METHOD_NOT_ALLOWED",
        _ => "INTERNAL_SERVER_ERROR",
    };

    private static string GetTitle(int status) => status switch
    {
        StatusCodes.Status400BadRequest => "请求无效",
        StatusCodes.Status401Unauthorized => "尚未登录",
        StatusCodes.Status403Forbidden => "没有操作权限",
        StatusCodes.Status404NotFound => "资源不存在",
        StatusCodes.Status405MethodNotAllowed => "请求方法不受支持",
        _ => "服务内部错误",
    };

    private sealed class UnhandledExceptionHandler(
        IProblemDetailsService problemDetailsService,
        ILogger<UnhandledExceptionHandler> logger) : IExceptionHandler
    {
        private static readonly Action<ILogger, Exception?> LogUnhandledRequest =
            LoggerMessage.Define(
                LogLevel.Error,
                new EventId(1000, nameof(UnhandledExceptionHandler)),
                "Unhandled request failure");

        public async ValueTask<bool> TryHandleAsync(
            HttpContext httpContext,
            Exception exception,
            CancellationToken cancellationToken)
        {
            LogUnhandledRequest(logger, exception);
            httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

            return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
            {
                HttpContext = httpContext,
                ProblemDetails = new ProblemDetails
                {
                    Status = StatusCodes.Status500InternalServerError,
                },
            });
        }
    }
}
