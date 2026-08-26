using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlowPilot.Api;
using FlowPilot.Api.Configuration;
using FlowPilot.Api.Http;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Deployment;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.HttpOverrides;
using Serilog;
using Serilog.Formatting.Json;

var builder = WebApplication.CreateBuilder(args);

DeploymentPaths? deploymentPaths = null;
if (builder.Environment.IsProduction())
{
    deploymentPaths = new DeploymentPathResolver().Resolve();
    builder.Configuration.AddFlowPilotProductionConfiguration(deploymentPaths);
    ProductionStartupConfigurationValidator.Validate(builder.Configuration);
}

var logsDirectory = deploymentPaths?.LogsDirectory
    ?? Path.Combine(AppContext.BaseDirectory, "Logs");
Directory.CreateDirectory(logsDirectory);

builder.Host.UseWindowsService(options => options.ServiceName = "FlowPilot API");
builder.Host.UseSerilog((_, _, loggerConfiguration) =>
{
    loggerConfiguration
        .Enrich.FromLogContext()
        .WriteTo.File(
            new JsonFormatter(renderMessage: true),
            Path.Combine(logsDirectory, "flowpilot-api-.json"),
            rollingInterval: RollingInterval.Day,
            fileSizeLimitBytes: builder.Configuration.GetValue<long>(
                "FlowPilot:Logging:FileSizeLimitBytes",
                52_428_800),
            rollOnFileSizeLimit: true,
            retainedFileCountLimit: builder.Configuration.GetValue<int>(
                "FlowPilot:Logging:RetainedFileCountLimit",
                30),
            shared: false,
            flushToDiskInterval: TimeSpan.FromSeconds(1));
});

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor
        | ForwardedHeaders.XForwardedHost
        | ForwardedHeaders.XForwardedProto;
    options.ForwardLimit = 1;
    options.KnownProxies.Clear();
    options.KnownProxies.Add(IPAddress.Loopback);
    options.KnownProxies.Add(IPAddress.IPv6Loopback);
});

builder.Services
    .AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.Converters.Add(
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });
builder.Services.AddOpenApi();
builder.Services.AddFlowPilotProblemDetails();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IDeploymentPathResolver, DeploymentPathResolver>();
if (deploymentPaths is not null)
{
    builder.Services.AddSingleton(deploymentPaths);
}

builder.Services.AddFlowPilotPersistence(builder.Configuration);

var app = builder.Build();

app.UseForwardedHeaders();
app.UseMiddleware<RequestContextMiddleware>();
app.UseSerilogRequestLogging();
app.UseExceptionHandler();
app.UseStatusCodePages(async statusCodeContext =>
{
    var problemDetailsService = statusCodeContext.HttpContext.RequestServices
        .GetRequiredService<IProblemDetailsService>();
    await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
    {
        HttpContext = statusCodeContext.HttpContext,
    });
});
app.UseMiddleware<AllowedHostMiddleware>();
app.UsePathBase(ApiConstants.PathBase);
app.UseMiddleware<ApiPathBaseMiddleware>();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapControllers();
app.Run();

public partial class Program;
