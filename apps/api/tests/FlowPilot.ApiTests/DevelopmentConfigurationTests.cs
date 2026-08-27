using FlowPilot.Api.Configuration;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.ApiTests;

public sealed class DevelopmentConfigurationTests
{
    [Fact]
    public void AddFlowPilotDevelopmentConfiguration_LoadsOptionalLocalFile()
    {
        var contentRoot = CreateTemporaryContentRoot();
        try
        {
            WriteLocalConfiguration(contentRoot, "local-value");
            var configuration = new ConfigurationManager
            {
                ["FlowPilot:DevelopmentTest:Priority"] = "default-value",
            };

            configuration.AddFlowPilotDevelopmentConfiguration(contentRoot, []);

            Assert.Equal("local-value", configuration["FlowPilot:DevelopmentTest:Priority"]);
        }
        finally
        {
            DeleteTemporaryLayout(contentRoot);
        }
    }

    [Fact]
    public void AddFlowPilotDevelopmentConfiguration_AllowsEnvironmentAndCommandLineOverrides()
    {
        const string environmentVariable = "FlowPilot__DevelopmentTest__Priority";
        var contentRoot = CreateTemporaryContentRoot();
        var originalEnvironmentValue = Environment.GetEnvironmentVariable(environmentVariable);
        try
        {
            WriteLocalConfiguration(contentRoot, "local-value");
            Environment.SetEnvironmentVariable(environmentVariable, "environment-value");
            var configuration = new ConfigurationManager();

            configuration.AddFlowPilotDevelopmentConfiguration(
                contentRoot,
                ["--FlowPilot:DevelopmentTest:Priority=command-line-value"]);

            Assert.Equal("command-line-value", configuration["FlowPilot:DevelopmentTest:Priority"]);
        }
        finally
        {
            Environment.SetEnvironmentVariable(environmentVariable, originalEnvironmentValue);
            DeleteTemporaryLayout(contentRoot);
        }
    }

    [Fact]
    public void AddFlowPilotDevelopmentConfiguration_PreservesEnvironmentOverrideWithoutCommandLineValue()
    {
        const string environmentVariable = "FlowPilot__DevelopmentTest__EnvironmentOnly";
        var contentRoot = CreateTemporaryContentRoot();
        var originalEnvironmentValue = Environment.GetEnvironmentVariable(environmentVariable);
        try
        {
            File.WriteAllText(
                GetLocalConfigurationFile(contentRoot),
                """
                {
                  "FlowPilot": {
                    "DevelopmentTest": {
                      "EnvironmentOnly": "local-value"
                    }
                  }
                }
                """);
            Environment.SetEnvironmentVariable(environmentVariable, "environment-value");
            var configuration = new ConfigurationManager();

            configuration.AddFlowPilotDevelopmentConfiguration(contentRoot, []);

            Assert.Equal("environment-value", configuration["FlowPilot:DevelopmentTest:EnvironmentOnly"]);
        }
        finally
        {
            Environment.SetEnvironmentVariable(environmentVariable, originalEnvironmentValue);
            DeleteTemporaryLayout(contentRoot);
        }
    }

    [Fact]
    public void AddFlowPilotDevelopmentConfiguration_AllowsMissingLocalFile()
    {
        var contentRoot = CreateTemporaryContentRoot();
        try
        {
            var configuration = new ConfigurationManager
            {
                ["FlowPilot:DevelopmentTest:Existing"] = "existing-value",
            };

            configuration.AddFlowPilotDevelopmentConfiguration(contentRoot, []);

            Assert.Equal("existing-value", configuration["FlowPilot:DevelopmentTest:Existing"]);
        }
        finally
        {
            DeleteTemporaryLayout(contentRoot);
        }
    }

    private static string CreateTemporaryContentRoot()
    {
        var testRoot = Path.Combine(
            Path.GetTempPath(),
            "flowpilot-development-configuration-tests",
            Guid.NewGuid().ToString("N"));
        var contentRoot = Path.Combine(testRoot, "src", "FlowPilot.Api");
        Directory.CreateDirectory(contentRoot);
        Directory.CreateDirectory(Path.Combine(testRoot, "config"));
        return contentRoot;
    }

    private static void DeleteTemporaryLayout(string contentRoot) =>
        Directory.Delete(
            Path.GetFullPath(Path.Combine(contentRoot, "..", "..")),
            recursive: true);

    private static string GetLocalConfigurationFile(string contentRoot) =>
        Path.GetFullPath(
            Path.Combine(
                contentRoot,
                "..",
                "..",
                "config",
                FlowPilotConfigurationExtensions.DevelopmentLocalFileName));

    private static void WriteLocalConfiguration(string contentRoot, string priorityValue)
    {
        File.WriteAllText(
            GetLocalConfigurationFile(contentRoot),
            $$"""
            {
              "FlowPilot": {
                "DevelopmentTest": {
                  "Priority": "{{priorityValue}}"
                }
              }
            }
            """);
    }
}
