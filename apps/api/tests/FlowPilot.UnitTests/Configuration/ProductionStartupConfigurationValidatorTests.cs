using FlowPilot.Infrastructure.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Primitives;

namespace FlowPilot.UnitTests.Configuration;

public sealed class ProductionStartupConfigurationValidatorTests
{
    private const string SensitiveConnectionString =
        "Server=sql.internal;Database=FlowPilot;User ID=flowpilot_user;Password=never-log-this;Encrypt=Strict;TrustServerCertificate=false";

    [Theory]
    [InlineData("true")]
    [InlineData("Mandatory")]
    [InlineData("Strict")]
    public void Validate_AcceptsStrongEncryptionValues(string encryptValue)
    {
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] =
            $"Server=sql.internal;Database=FlowPilot;Integrated Security=true;Encrypt={encryptValue};TrustServerCertificate=false";

        ProductionStartupConfigurationValidator.Validate(configuration);
    }

    [Fact]
    public void Validate_AcceptsEveryConfiguredLoopbackEndpoint()
    {
        var configuration = CreateValidConfiguration();
        configuration["Kestrel:Endpoints:Public:Url"] = "http://127.0.0.1:5101";
        configuration["Kestrel:Endpoints:Management:Url"] = "http://127.0.0.1:5102";

        ProductionStartupConfigurationValidator.Validate(configuration);
    }

    [Theory]
    [InlineData("https://127.0.0.1:5100")]
    [InlineData("http://localhost:5100")]
    [InlineData("http://0.0.0.0:5100")]
    [InlineData("http://[::1]:5100")]
    [InlineData("http://127.0.0.1")]
    [InlineData("http://127.0.0.1:0")]
    [InlineData("http://127.0.0.1:65536")]
    [InlineData("http://127.0.0.1:5100/")]
    [InlineData("http://127.0.0.1:5100@evil.example")]
    [InlineData("http://127.0.0.1:5100;http://evil.example:5100")]
    public void Validate_RejectsInvalidOrNonLoopbackUrls(string url)
    {
        var configuration = CreateValidConfiguration();
        configuration["urls"] = url;

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.InvalidListenUrl,
            "urls");
    }

    [Fact]
    public void Validate_RejectsAnUnsafeEndpointWhenUrlsIsSafe()
    {
        var configuration = CreateValidConfiguration();
        configuration["Kestrel:Endpoints:Unsafe:Url"] = "http://*:5101";

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.InvalidListenUrl,
            "Kestrel:Endpoints:Unsafe:Url");
    }

    [Fact]
    public void Validate_RejectsEndpointWithoutUrl()
    {
        var configuration = CreateValidConfiguration();
        configuration["Kestrel:Endpoints:Incomplete:Protocols"] = "Http1";

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.MissingEndpointUrl,
            "Kestrel:Endpoints:Incomplete:Url");
    }

    [Fact]
    public void Validate_RejectsMissingListenConfiguration()
    {
        var configuration = CreateValidConfiguration();
        configuration["urls"] = null;

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.MissingListenUrl,
            "urls");
    }

    [Theory]
    [InlineData(null, ProductionConfigurationFailure.MissingAllowedHosts)]
    [InlineData("", ProductionConfigurationFailure.MissingAllowedHosts)]
    [InlineData("*", ProductionConfigurationFailure.UnsafeAllowedHosts)]
    [InlineData("*.example.com", ProductionConfigurationFailure.UnsafeAllowedHosts)]
    [InlineData("trusted.example@evil.example", ProductionConfigurationFailure.UnsafeAllowedHosts)]
    [InlineData("https://trusted.example", ProductionConfigurationFailure.UnsafeAllowedHosts)]
    public void Validate_RejectsMissingOrUnsafeAllowedHosts(
        string? allowedHosts,
        ProductionConfigurationFailure failure)
    {
        var configuration = CreateValidConfiguration();
        configuration["FlowPilot:Http:AllowedHosts"] = allowedHosts;

        AssertFailure(configuration, failure, "FlowPilot:Http:AllowedHosts");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Validate_RejectsMissingConnectionString(string? connectionString)
    {
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] = connectionString;

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.MissingConnectionString,
            "ConnectionStrings:FlowPilot");
    }

    [Fact]
    public void Validate_RejectsInvalidConnectionStringWithoutDisclosingIt()
    {
        const string invalidConnectionString = "Password=never-log-this;Not=A=Valid=Pair";
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] = invalidConnectionString;

        var exception = AssertFailure(
            configuration,
            ProductionConfigurationFailure.InvalidConnectionString,
            "ConnectionStrings:FlowPilot");

        Assert.DoesNotContain(invalidConnectionString, exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("never-log-this", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Validate_RejectsMissingEncryptSettingWithoutDisclosingConnectionString()
    {
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] =
            "Server=sql.internal;Database=FlowPilot;Password=never-log-this;TrustServerCertificate=false";

        var exception = AssertFailure(
            configuration,
            ProductionConfigurationFailure.MissingEncryptSetting,
            "ConnectionStrings:FlowPilot");

        Assert.DoesNotContain("never-log-this", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("false")]
    [InlineData("Optional")]
    public void Validate_RejectsWeakEncryptSetting(string encryptValue)
    {
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] =
            $"Server=sql.internal;Database=FlowPilot;Integrated Security=true;Encrypt={encryptValue};TrustServerCertificate=false";

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.WeakEncryptSetting,
            "ConnectionStrings:FlowPilot");
    }

    [Fact]
    public void Validate_RejectsMissingTrustServerCertificateSetting()
    {
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] =
            "Server=sql.internal;Database=FlowPilot;Integrated Security=true;Encrypt=Strict";

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.MissingTrustServerCertificateSetting,
            "ConnectionStrings:FlowPilot");
    }

    [Fact]
    public void Validate_RejectsEnabledTrustServerCertificate()
    {
        var configuration = CreateValidConfiguration();
        configuration["ConnectionStrings:FlowPilot"] =
            "Server=sql.internal;Database=FlowPilot;Integrated Security=true;Encrypt=Strict;TrustServerCertificate=true";

        AssertFailure(
            configuration,
            ProductionConfigurationFailure.TrustServerCertificateEnabled,
            "ConnectionStrings:FlowPilot");
    }

    [Theory]
    [InlineData("FlowPilot:Database:RequiredSchemaVersion", ProductionConfigurationFailure.MissingRequiredSchemaVersion)]
    [InlineData("FlowPilot:Database:RequiredBuiltinSeedVersion", ProductionConfigurationFailure.MissingRequiredBuiltinSeedVersion)]
    [InlineData("FlowPilot:Database:ExpectedCollation", ProductionConfigurationFailure.MissingExpectedCollation)]
    public void Validate_RejectsMissingDatabaseRequirement(
        string configurationKey,
        ProductionConfigurationFailure failure)
    {
        var configuration = CreateValidConfiguration();
        configuration[configurationKey] = " ";

        AssertFailure(configuration, failure, configurationKey);
    }

    [Theory]
    [InlineData("FlowPilot:Database:ApplicationCommandTimeoutSeconds", "0")]
    [InlineData("FlowPilot:Database:ReadinessCommandTimeoutSeconds", "not-a-number")]
    [InlineData("FlowPilot:Database:SchemaProbeCommandTimeoutSeconds", "3601")]
    [InlineData("FlowPilot:Database:MigrationPreflightCommandTimeoutSeconds", "-1")]
    [InlineData("FlowPilot:Database:MigrationCommandTimeoutSeconds", "2147483648")]
    public void Validate_RejectsInvalidDatabaseCommandTimeout(
        string configurationKey,
        string configuredValue)
    {
        var configuration = CreateValidConfiguration();
        configuration[configurationKey] = configuredValue;

        var exception = AssertFailure(
            configuration,
            ProductionConfigurationFailure.InvalidDatabaseCommandTimeout,
            configurationKey);

        Assert.DoesNotContain(configuredValue, exception.Message, StringComparison.Ordinal);
    }

    private static ProductionConfigurationException AssertFailure(
        IConfiguration configuration,
        ProductionConfigurationFailure expectedFailure,
        string expectedConfigurationKey)
    {
        var exception = Assert.Throws<ProductionConfigurationException>(
            () => ProductionStartupConfigurationValidator.Validate(configuration));

        Assert.Equal(expectedFailure, exception.Failure);
        Assert.Equal(expectedConfigurationKey, exception.ConfigurationKey);
        Assert.DoesNotContain(SensitiveConnectionString, exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("never-log-this", exception.Message, StringComparison.Ordinal);
        return exception;
    }

    private static TestConfiguration CreateValidConfiguration()
    {
        var configuration = new TestConfiguration();
        configuration["urls"] = "http://127.0.0.1:5100";
        configuration["FlowPilot:Http:AllowedHosts"] = "flowpilot.internal.example";
        configuration["ConnectionStrings:FlowPilot"] = SensitiveConnectionString;
        configuration["FlowPilot:Database:RequiredSchemaVersion"] = "202608260001";
        configuration["FlowPilot:Database:RequiredBuiltinSeedVersion"] = "202608260001";
        configuration["FlowPilot:Database:ExpectedCollation"] = "Chinese_PRC_100_CI_AS_SC";

        return configuration;
    }

    private sealed class TestConfiguration : IConfiguration
    {
        private readonly Dictionary<string, string?> _values = new(StringComparer.OrdinalIgnoreCase);

        public string? this[string key]
        {
            get => _values.GetValueOrDefault(key);
            set => _values[key] = value;
        }

        public IEnumerable<IConfigurationSection> GetChildren() => GetChildren(string.Empty);

        public IChangeToken GetReloadToken() => new CancellationChangeToken(CancellationToken.None);

        public IConfigurationSection GetSection(string key) => new TestConfigurationSection(this, key);

        private IEnumerable<IConfigurationSection> GetChildren(string path)
        {
            var prefix = path.Length == 0 ? string.Empty : $"{path}:";
            return _values.Keys
                .Where(key => key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                .Select(key => key[prefix.Length..])
                .Where(remainder => remainder.Length > 0)
                .Select(remainder => remainder.Split(':', 2)[0])
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(key => GetSection(path.Length == 0 ? key : $"{path}:{key}"));
        }

        private sealed class TestConfigurationSection : IConfigurationSection
        {
            private readonly TestConfiguration _configuration;

            public TestConfigurationSection(TestConfiguration configuration, string path)
            {
                _configuration = configuration;
                Path = path;
                Key = path.Split(':')[^1];
            }

            public string? this[string key]
            {
                get => _configuration[$"{Path}:{key}"];
                set => _configuration[$"{Path}:{key}"] = value;
            }

            public string Key { get; }

            public string Path { get; }

            public string? Value
            {
                get => _configuration[Path];
                set => _configuration[Path] = value;
            }

            public IEnumerable<IConfigurationSection> GetChildren() => _configuration.GetChildren(Path);

            public IChangeToken GetReloadToken() => _configuration.GetReloadToken();

            public IConfigurationSection GetSection(string key) =>
                _configuration.GetSection($"{Path}:{key}");
        }
    }
}
