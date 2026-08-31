using FlowPilot.Infrastructure.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Primitives;

namespace FlowPilot.UnitTests.Configuration;

public sealed class FlowPilotDatabaseOptionsTests
{
    [Fact]
    public void FromConfiguration_UsesSafeDefaultsWhenTimeoutsAreNotOverridden()
    {
        var options = FlowPilotDatabaseOptions.FromConfiguration(new TestConfiguration());

        Assert.Equal(30, options.ApplicationCommandTimeoutSeconds);
        Assert.Equal(5, options.ReadinessCommandTimeoutSeconds);
        Assert.Equal(15, options.SchemaProbeCommandTimeoutSeconds);
        Assert.Equal(15, options.MigrationPreflightCommandTimeoutSeconds);
        Assert.Equal(300, options.MigrationCommandTimeoutSeconds);
    }

    [Fact]
    public void FromConfiguration_ReadsExpectedCollationAndEveryCommandTimeoutOverride()
    {
        var configuration = new TestConfiguration
        {
            ["FlowPilot:Database:ExpectedCollation"] = "Chinese_PRC_CI_AS",
            ["FlowPilot:Database:ApplicationCommandTimeoutSeconds"] = "31",
            ["FlowPilot:Database:ReadinessCommandTimeoutSeconds"] = "6",
            ["FlowPilot:Database:SchemaProbeCommandTimeoutSeconds"] = "16",
            ["FlowPilot:Database:MigrationPreflightCommandTimeoutSeconds"] = "17",
            ["FlowPilot:Database:MigrationCommandTimeoutSeconds"] = "301",
        };

        var options = FlowPilotDatabaseOptions.FromConfiguration(configuration);

        Assert.Equal("Chinese_PRC_CI_AS", options.ExpectedCollation);
        Assert.Equal(31, options.ApplicationCommandTimeoutSeconds);
        Assert.Equal(6, options.ReadinessCommandTimeoutSeconds);
        Assert.Equal(16, options.SchemaProbeCommandTimeoutSeconds);
        Assert.Equal(17, options.MigrationPreflightCommandTimeoutSeconds);
        Assert.Equal(301, options.MigrationCommandTimeoutSeconds);
    }

    [Theory]
    [InlineData("ApplicationCommandTimeoutSeconds", "0")]
    [InlineData("ReadinessCommandTimeoutSeconds", "-1")]
    [InlineData("SchemaProbeCommandTimeoutSeconds", "not-a-number")]
    [InlineData("MigrationPreflightCommandTimeoutSeconds", "3601")]
    [InlineData("MigrationCommandTimeoutSeconds", "2147483648")]
    public void FromConfiguration_RejectsUnsafeCommandTimeoutWithoutEchoingItsValue(
        string optionName,
        string configuredValue)
    {
        var configurationKey = $"FlowPilot:Database:{optionName}";
        var configuration = new TestConfiguration
        {
            [configurationKey] = configuredValue,
        };

        var exception = Assert.Throws<FlowPilotDatabaseOptionsConfigurationException>(
            () => FlowPilotDatabaseOptions.FromConfiguration(configuration));

        Assert.Equal(configurationKey, exception.ConfigurationKey);
        Assert.DoesNotContain(configuredValue, exception.Message, StringComparison.Ordinal);
    }

    private sealed class TestConfiguration : IConfiguration
    {
        private readonly Dictionary<string, string?> _values = new(StringComparer.OrdinalIgnoreCase);

        public string? this[string key]
        {
            get => _values.GetValueOrDefault(key);
            set => _values[key] = value;
        }

        public IEnumerable<IConfigurationSection> GetChildren() => [];

        public IChangeToken GetReloadToken() =>
            new CancellationChangeToken(CancellationToken.None);

        public IConfigurationSection GetSection(string key) =>
            throw new NotSupportedException($"Sections are not used by this test configuration: {key}");
    }
}
