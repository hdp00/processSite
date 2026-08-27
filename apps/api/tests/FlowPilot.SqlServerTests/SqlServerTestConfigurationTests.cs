using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

public sealed class SqlServerTestConfigurationTests
{
    [Fact]
    public void DeclaredEnvironmentOverridesReplaceTheSharedDatabaseConfiguration()
    {
        var configuration = new ConfigurationManager();
        configuration.AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["ConnectionStrings:FlowPilot"] = "configured-connection",
                ["FlowPilot:Database:RequiredSchemaVersion"] = "configured-version",
                ["FlowPilot:Database:ExpectedCollation"] = "configured-collation",
            });
        var environment = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            [SqlServerTestConfiguration.ConnectionStringOverrideVariable] = "override-connection",
            [SqlServerTestConfiguration.RequiredSchemaVersionOverrideVariable] = "override-version",
            [SqlServerTestConfiguration.ExpectedCollationOverrideVariable] = "override-collation",
        };

        SqlServerTestConfiguration.AddDeclaredEnvironmentOverrides(
            configuration,
            variable => environment.GetValueOrDefault(variable));

        Assert.Equal("override-connection", configuration.GetConnectionString("FlowPilot"));
        Assert.Equal("override-version", configuration["FlowPilot:Database:RequiredSchemaVersion"]);
        Assert.Equal("override-collation", configuration["FlowPilot:Database:ExpectedCollation"]);
    }

    [Fact]
    public void MissingDeclaredEnvironmentOverridesPreserveTheSharedDatabaseConfiguration()
    {
        var configuration = new ConfigurationManager();
        configuration.AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["ConnectionStrings:FlowPilot"] = "configured-connection",
                ["FlowPilot:Database:RequiredSchemaVersion"] = "configured-version",
                ["FlowPilot:Database:ExpectedCollation"] = "configured-collation",
            });

        SqlServerTestConfiguration.AddDeclaredEnvironmentOverrides(configuration, _ => null);

        Assert.Equal("configured-connection", configuration.GetConnectionString("FlowPilot"));
        Assert.Equal("configured-version", configuration["FlowPilot:Database:RequiredSchemaVersion"]);
        Assert.Equal("configured-collation", configuration["FlowPilot:Database:ExpectedCollation"]);
    }
}
