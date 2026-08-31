using System.DirectoryServices.Protocols;
using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace FlowPilot.Infrastructure.Authentication;

public enum DomainAuthenticationResult
{
    Success,
    InvalidCredentials,
    Unavailable,
}

public interface IDomainAuthenticator
{
    Task<DomainAuthenticationResult> AuthenticateAsync(
        string loginName,
        string password,
        CancellationToken cancellationToken = default);
}

public sealed class LdapDomainAuthenticator : IDomainAuthenticator
{
    private static readonly Action<ILogger, Exception?> LogUnavailable =
        LoggerMessage.Define(
            LogLevel.Warning,
            new EventId(1001, "LdapUnavailable"),
            "LDAP authentication service is unavailable.");
    private readonly IConfiguration _configuration;
    private readonly ILogger<LdapDomainAuthenticator> _logger;

    public LdapDomainAuthenticator(
        IConfiguration configuration,
        ILogger<LdapDomainAuthenticator> logger)
    {
        _configuration = configuration;
        _logger = logger;
    }

    public Task<DomainAuthenticationResult> AuthenticateAsync(
        string loginName,
        string password,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var settings = LdapSettings.Read(_configuration);
        if (settings is null)
        {
            return Task.FromResult(DomainAuthenticationResult.Unavailable);
        }

        try
        {
            var upn = loginName.Contains('@', StringComparison.Ordinal)
                ? loginName
                : $"{loginName}@{settings.UpnSuffix}";
            using var connection = new LdapConnection(
                new LdapDirectoryIdentifier(settings.Host, settings.Port, fullyQualifiedDnsHostName: false, connectionless: false),
                new NetworkCredential(upn, password),
                AuthType.Basic)
            {
                Timeout = TimeSpan.FromSeconds(settings.TimeoutSeconds),
            };
            connection.SessionOptions.ProtocolVersion = 3;
            connection.SessionOptions.SecureSocketLayer = settings.UseSsl;
            connection.Bind();

            var account = loginName.Split('@', 2)[0];
            var filter = $"(&({settings.AccountAttribute}={EscapeFilter(account)})({settings.UpnAttribute}={EscapeFilter(upn)}))";
            var request = new SearchRequest(
                settings.BaseDn,
                filter,
                SearchScope.Subtree,
                settings.AccountAttribute,
                settings.UpnAttribute)
            {
                TimeLimit = TimeSpan.FromSeconds(settings.TimeoutSeconds),
            };
            var response = (SearchResponse)connection.SendRequest(request, TimeSpan.FromSeconds(settings.TimeoutSeconds));
            if (response.Entries.Count != 1) return Task.FromResult(DomainAuthenticationResult.InvalidCredentials);

            var entry = response.Entries[0];
            var matchedAccount = ReadAttribute(entry, settings.AccountAttribute);
            var matchedUpn = ReadAttribute(entry, settings.UpnAttribute);
            var matched = string.Equals(matchedAccount, account, StringComparison.OrdinalIgnoreCase)
                && string.Equals(matchedUpn, upn, StringComparison.OrdinalIgnoreCase);
            return Task.FromResult(matched
                ? DomainAuthenticationResult.Success
                : DomainAuthenticationResult.InvalidCredentials);
        }
        catch (LdapException exception) when (exception.ErrorCode == 49)
        {
            return Task.FromResult(DomainAuthenticationResult.InvalidCredentials);
        }
        catch (Exception exception) when (exception is LdapException or DirectoryOperationException or TimeoutException)
        {
            LogUnavailable(_logger, exception);
            return Task.FromResult(DomainAuthenticationResult.Unavailable);
        }
    }

    private static string? ReadAttribute(SearchResultEntry entry, string name) =>
        entry.Attributes[name] is { Count: > 0 } attribute ? attribute[0]?.ToString() : null;

    private static string EscapeFilter(string value)
    {
        var result = new System.Text.StringBuilder(value.Length);
        foreach (var character in value)
        {
            result.Append(character switch
            {
                '\\' => "\\5c",
                '*' => "\\2a",
                '(' => "\\28",
                ')' => "\\29",
                '\0' => "\\00",
                _ => character.ToString(),
            });
        }
        return result.ToString();
    }

    private sealed record LdapSettings(
        string Host,
        int Port,
        bool UseSsl,
        string BaseDn,
        string UpnSuffix,
        string AccountAttribute,
        string UpnAttribute,
        int TimeoutSeconds)
    {
        public static LdapSettings? Read(IConfiguration configuration)
        {
            var urlText = configuration["FlowPilot:Ldap:Url"]?.Trim();
            var baseDn = configuration["FlowPilot:Ldap:BaseDn"]?.Trim();
            var upnSuffix = configuration["FlowPilot:Ldap:UpnSuffix"]?.Trim().TrimStart('@');
            if (!Uri.TryCreate(urlText, UriKind.Absolute, out var url)
                || url.Scheme is not ("ldap" or "ldaps")
                || url.Scheme == "ldap" && !configuration.GetValue("FlowPilot:Ldap:AllowPlainText", false)
                || string.IsNullOrWhiteSpace(url.Host)
                || url.Port is < 1 or > 65535
                || !string.IsNullOrEmpty(url.UserInfo)
                || url.AbsolutePath != "/"
                || !string.IsNullOrEmpty(url.Query)
                || !string.IsNullOrEmpty(url.Fragment)
                || string.IsNullOrWhiteSpace(baseDn)
                || string.IsNullOrWhiteSpace(upnSuffix))
            {
                return null;
            }

            var useSsl = url.Scheme == "ldaps";
            var port = url.IsDefaultPort ? useSsl ? 636 : 389 : url.Port;
            return new LdapSettings(
                url.Host,
                port,
                useSsl,
                baseDn,
                upnSuffix,
                SafeAttribute(configuration["FlowPilot:Ldap:AccountAttribute"], "sAMAccountName"),
                SafeAttribute(configuration["FlowPilot:Ldap:UpnAttribute"], "userPrincipalName"),
                Math.Clamp(configuration.GetValue("FlowPilot:Ldap:TimeoutSeconds", 10), 1, 60));
        }

        private static string SafeAttribute(string? value, string fallback) =>
            !string.IsNullOrWhiteSpace(value) && value.All(character => char.IsAsciiLetterOrDigit(character) || character == '-')
                ? value
                : fallback;
    }
}
