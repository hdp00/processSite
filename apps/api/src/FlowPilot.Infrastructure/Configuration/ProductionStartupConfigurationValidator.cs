using System.Globalization;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using MimeKit;

namespace FlowPilot.Infrastructure.Configuration;

public static class ProductionStartupConfigurationValidator
{
    private const string ConnectionStringKey = "ConnectionStrings:FlowPilot";
    private const string AllowedHostsKey = "FlowPilot:Http:AllowedHosts";
    private const string ExpectedCollationKey = "FlowPilot:Database:ExpectedCollation";
    private const string UrlsKey = "urls";
    private const string LoopbackHttpPrefix = "http://127.0.0.1:";

    public static void Validate(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        ValidateListenUrls(configuration);
        ValidateAllowedHosts(configuration);
        ValidateConnectionString(configuration);
        RequireValue(configuration, ExpectedCollationKey, ProductionConfigurationFailure.MissingExpectedCollation);
        ValidateDatabaseOptions(configuration);
        ValidateLdap(configuration);
        ValidateSmtp(configuration);
    }

    private static void ValidateLdap(IConfiguration configuration)
    {
        var urlText = configuration["FlowPilot:Ldap:Url"];
        var anyValue = !string.IsNullOrWhiteSpace(urlText)
            || !string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:BaseDn"])
            || !string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:UpnSuffix"]);
        if (!anyValue) return;
        if (!Uri.TryCreate(urlText, UriKind.Absolute, out var url)
            || url.Scheme != "ldaps"
            || string.IsNullOrWhiteSpace(url.Host)
            || url.Port is < 1 or > 65535
            || !string.IsNullOrEmpty(url.UserInfo)
            || url.AbsolutePath != "/"
            || !string.IsNullOrEmpty(url.Query)
            || !string.IsNullOrEmpty(url.Fragment)
            || string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:BaseDn"])
            || string.IsNullOrWhiteSpace(configuration["FlowPilot:Ldap:UpnSuffix"]))
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.InvalidLdapConfiguration,
                "FlowPilot:Ldap");
        }
    }

    private static void ValidateSmtp(IConfiguration configuration)
    {
        if (!configuration.GetValue("FlowPilot:Smtp:Enabled", false)) return;
        var security = configuration["FlowPilot:Smtp:Security"]?.Trim().ToLowerInvariant();
        var plainTextAllowed = configuration.GetValue("FlowPilot:Smtp:AllowPlainText", false);
        var port = configuration.GetValue("FlowPilot:Smtp:Port", 587);
        var userName = configuration["FlowPilot:Smtp:UserName"];
        var password = configuration["FlowPilot:Smtp:Password"];
        var testEmail = configuration["FlowPilot:Smtp:TestEMail"]?.Trim();
        if (string.IsNullOrWhiteSpace(configuration["FlowPilot:Smtp:Host"])
            || !MailboxAddress.TryParse(configuration["FlowPilot:Smtp:From"], out _)
            || !string.IsNullOrEmpty(testEmail) && !MailboxAddress.TryParse(testEmail, out _)
            || port is < 1 or > 65535
            || string.IsNullOrWhiteSpace(userName) != string.IsNullOrWhiteSpace(password)
            || security is not ("starttls" or "ssl" or "none")
            || security == "none" && !plainTextAllowed)
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.InvalidSmtpConfiguration,
                "FlowPilot:Smtp");
        }
    }

    private static void ValidateDatabaseOptions(IConfiguration configuration)
    {
        try
        {
            _ = FlowPilotDatabaseOptions.FromConfiguration(configuration);
        }
        catch (FlowPilotDatabaseOptionsConfigurationException exception)
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.InvalidDatabaseCommandTimeout,
                exception.ConfigurationKey);
        }
    }

    private static void ValidateAllowedHosts(IConfiguration configuration)
    {
        var value = configuration[AllowedHostsKey];
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.MissingAllowedHosts,
                AllowedHostsKey);
        }

        var allowedHosts = value.Split(
            ';',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (allowedHosts.Length == 0
            || allowedHosts.Any(host =>
                host.Length == 0
                || host.Contains('*', StringComparison.Ordinal)
                || host.Contains('/', StringComparison.Ordinal)
                || host.Contains('\\', StringComparison.Ordinal)
                || host.Contains('@', StringComparison.Ordinal)))
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.UnsafeAllowedHosts,
                AllowedHostsKey);
        }
    }

    private static void ValidateListenUrls(IConfiguration configuration)
    {
        var configuredUrlCount = 0;
        var urlsValue = configuration[UrlsKey];
        if (urlsValue is not null)
        {
            var urls = urlsValue.Split(';', StringSplitOptions.None);
            foreach (var url in urls)
            {
                ValidateListenUrl(url, UrlsKey);
                configuredUrlCount++;
            }
        }

        foreach (var endpoint in configuration.GetSection("Kestrel:Endpoints").GetChildren())
        {
            var endpointUrlKey = $"{endpoint.Path}:Url";
            var endpointUrl = endpoint["Url"];
            if (string.IsNullOrWhiteSpace(endpointUrl))
            {
                throw new ProductionConfigurationException(
                    ProductionConfigurationFailure.MissingEndpointUrl,
                    endpointUrlKey);
            }

            ValidateListenUrl(endpointUrl, endpointUrlKey);
            configuredUrlCount++;
        }

        if (configuredUrlCount == 0)
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.MissingListenUrl,
                UrlsKey);
        }
    }

    private static void ValidateListenUrl(string url, string configurationKey)
    {
        if (!url.StartsWith(LoopbackHttpPrefix, StringComparison.Ordinal))
        {
            ThrowInvalidListenUrl(configurationKey);
        }

        var portText = url[LoopbackHttpPrefix.Length..];
        if (portText.Length == 0 ||
            !portText.All(char.IsAsciiDigit) ||
            !int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var port) ||
            port is < 1 or > 65535)
        {
            ThrowInvalidListenUrl(configurationKey);
        }
    }

    private static void ThrowInvalidListenUrl(string configurationKey) =>
        throw new ProductionConfigurationException(
            ProductionConfigurationFailure.InvalidListenUrl,
            configurationKey);

    private static void ValidateConnectionString(IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FlowPilot");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.MissingConnectionString,
                ConnectionStringKey);
        }

        SqlConnectionStringBuilder builder;
        try
        {
            builder = new SqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException)
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.InvalidConnectionString,
                ConnectionStringKey);
        }

        if (!builder.ShouldSerialize("Encrypt"))
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.MissingEncryptSetting,
                ConnectionStringKey);
        }

        if (builder.Encrypt != SqlConnectionEncryptOption.Mandatory &&
            builder.Encrypt != SqlConnectionEncryptOption.Strict)
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.WeakEncryptSetting,
                ConnectionStringKey);
        }

        if (!builder.ShouldSerialize("TrustServerCertificate"))
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.MissingTrustServerCertificateSetting,
                ConnectionStringKey);
        }

        if (builder.TrustServerCertificate)
        {
            throw new ProductionConfigurationException(
                ProductionConfigurationFailure.TrustServerCertificateEnabled,
                ConnectionStringKey);
        }
    }

    private static void RequireValue(
        IConfiguration configuration,
        string configurationKey,
        ProductionConfigurationFailure failure)
    {
        if (string.IsNullOrWhiteSpace(configuration[configurationKey]))
        {
            throw new ProductionConfigurationException(failure, configurationKey);
        }
    }
}
