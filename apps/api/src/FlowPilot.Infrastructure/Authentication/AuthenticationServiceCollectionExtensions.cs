using FlowPilot.Application.Authentication;
using Microsoft.Extensions.DependencyInjection;

namespace FlowPilot.Infrastructure.Authentication;

public static class AuthenticationServiceCollectionExtensions
{
    public static IServiceCollection AddFlowPilotAuthentication(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddMemoryCache();
        services.AddSingleton<LoginAttemptLimiter>();
        services.AddSingleton<IDomainAuthenticator, LdapDomainAuthenticator>();
        services.AddScoped<IAuthService, SqlServerAuthService>();
        return services;
    }
}
