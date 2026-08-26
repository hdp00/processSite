using FlowPilot.Application.Health;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FlowPilot.ApiTests.Support;

public sealed class FlowPilotApiFactory : WebApplicationFactory<Program>
{
    public DatabaseReadinessResult ReadinessResult { get; set; } = DatabaseReadinessResult.Ready;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IDatabaseReadinessCheck>();
            services.AddSingleton<IDatabaseReadinessCheck>(
                new StubDatabaseReadinessCheck(() => ReadinessResult));
        });
    }

    private sealed class StubDatabaseReadinessCheck(
        Func<DatabaseReadinessResult> resultFactory) : IDatabaseReadinessCheck
    {
        public Task<DatabaseReadinessResult> CheckAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(resultFactory());
        }
    }
}
