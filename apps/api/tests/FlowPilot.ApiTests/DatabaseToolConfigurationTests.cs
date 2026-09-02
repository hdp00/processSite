extern alias DatabaseTool;

using FlowPilot.Infrastructure.Configuration;
using Microsoft.Extensions.Configuration;
using DatabaseToolConfigurationException = DatabaseTool::DatabaseToolConfigurationException;
using DatabaseToolConfigurationFiles = DatabaseTool::DatabaseToolConfigurationFiles;
using DatabaseToolConfigurationLoader = DatabaseTool::DatabaseToolConfigurationLoader;
using DatabaseToolConnectionStringValidator = DatabaseTool::DatabaseToolConnectionStringValidator;
using DevelopmentConfigurationLocator = DatabaseTool::DevelopmentConfigurationLocator;
using ToolArguments = DatabaseTool::ToolArguments;

namespace FlowPilot.ApiTests;

public sealed class DatabaseToolConfigurationTests
{
    [Theory]
    [InlineData("initialize", "Initialize")]
    [InlineData("verify", "Verify")]
    [InlineData("prepare-browser-tests", "PrepareBrowserTests")]
    [InlineData("cleanup-browser-tests", "CleanupBrowserTests")]
    public void Parse_AcceptsCommandsAndDotNetStyleConfigurationValues(
        string command,
        string expectedCommand)
    {
        var arguments = ToolArguments.Parse(
            [command, "--FlowPilot:Database:ExpectedCollation=CLI_COLLATION"]);

        Assert.Equal(expectedCommand, arguments.Command.ToString());
        Assert.Null(arguments.ErrorCode);
        Assert.Equal(
            "CLI_COLLATION",
            arguments.ConfigurationValues["FlowPilot:Database:ExpectedCollation"]);
    }

    [Theory]
    [InlineData("--configuration=secret.json")]
    [InlineData("--Configuration=secret.json")]
    [InlineData("--configuration")]
    [InlineData("--configuration", "secret.json")]
    public void Parse_RejectsConfigurationPathOverride(params string[] pathArguments)
    {
        var arguments = ToolArguments.Parse(["verify", .. pathArguments]);

        Assert.Equal("DATABASE_ARGUMENT_INVALID", arguments.ErrorCode);
        Assert.Empty(arguments.ConfigurationValues);
        Assert.DoesNotContain(
            "secret.json",
            arguments.ErrorCode ?? string.Empty,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Find_ReturnsFixedDefaultAndLocalConfigurationPaths()
    {
        var apiRoot = CreateTemporaryApiRoot();
        try
        {
            File.WriteAllText(Path.Combine(apiRoot, "FlowPilot.slnx"), string.Empty);
            File.WriteAllText(
                Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json"),
                "{}");

            var files = DevelopmentConfigurationLocator.FindFromApplicationBaseDirectory(
                Path.Combine(apiRoot, "tools", "FlowPilot.DatabaseTool", "bin", "Debug", "net10.0"));

            Assert.Equal(
                Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json"),
                files.DefaultConfigurationFile);
            Assert.Equal(
                Path.Combine(apiRoot, "config", "appsettings.Development.local.json"),
                files.LocalConfigurationFile);
        }
        finally
        {
            Directory.Delete(apiRoot, recursive: true);
        }
    }

    [Fact]
    public void Find_RejectsSolutionOutsideTheToolAssemblyLayout()
    {
        var apiRoot = CreateTemporaryApiRoot();
        try
        {
            File.WriteAllText(Path.Combine(apiRoot, "FlowPilot.slnx"), string.Empty);
            File.WriteAllText(
                Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json"),
                "{}");
            var unrelatedApplicationDirectory = Path.Combine(apiRoot, "unrelated", "bin");
            Directory.CreateDirectory(unrelatedApplicationDirectory);

            var exception = Assert.Throws<DatabaseToolConfigurationException>(
                () => DevelopmentConfigurationLocator.FindFromApplicationBaseDirectory(
                    unrelatedApplicationDirectory));

            Assert.Equal("RepositoryRootNotFound", exception.Failure.ToString());
        }
        finally
        {
            Directory.Delete(apiRoot, recursive: true);
        }
    }

    [Fact]
    public void Load_AppliesDefaultThenLocalThenEnvironmentThenCommandLine()
    {
        const string environmentVariable = "FlowPilot__DatabaseToolTest__Priority";
        var originalEnvironmentValue = Environment.GetEnvironmentVariable(environmentVariable);
        var apiRoot = CreateTemporaryApiRoot();
        try
        {
            var files = WriteConfigurationFiles(apiRoot);
            Environment.SetEnvironmentVariable(environmentVariable, "environment-value");

            var configuration = DatabaseToolConfigurationLoader.Load(
                files,
                new Dictionary<string, string?>
                {
                    ["FlowPilot:DatabaseToolTest:Priority"] = "command-line-value",
                });

            Assert.Equal("command-line-value", configuration["FlowPilot:DatabaseToolTest:Priority"]);
            Assert.Equal("default-only", configuration["FlowPilot:DatabaseToolTest:DefaultOnly"]);
            Assert.Equal("local-only", configuration["FlowPilot:DatabaseToolTest:LocalOnly"]);
        }
        finally
        {
            Environment.SetEnvironmentVariable(environmentVariable, originalEnvironmentValue);
            Directory.Delete(apiRoot, recursive: true);
        }
    }

    [Theory]
    [InlineData(false, true, "DefaultConfigurationMissing")]
    [InlineData(true, false, "LocalConfigurationMissing")]
    public void Load_RequiresBothFixedConfigurationFiles(
        bool createDefault,
        bool createLocal,
        string expectedFailure)
    {
        var apiRoot = CreateTemporaryApiRoot();
        try
        {
            var files = CreateConfigurationFiles(apiRoot);
            if (createDefault)
            {
                File.WriteAllText(files.DefaultConfigurationFile, "{}");
            }

            if (createLocal)
            {
                File.WriteAllText(files.LocalConfigurationFile, "{}");
            }

            var exception = Assert.Throws<DatabaseToolConfigurationException>(
                () => DatabaseToolConfigurationLoader.Load(
                    files,
                    new Dictionary<string, string?>()));

            Assert.Equal(expectedFailure, exception.Failure.ToString());
        }
        finally
        {
            Directory.Delete(apiRoot, recursive: true);
        }
    }

    [Fact]
    public void Load_RejectsMalformedJsonWithStableFailure()
    {
        var apiRoot = CreateTemporaryApiRoot();
        try
        {
            var files = CreateConfigurationFiles(apiRoot);
            File.WriteAllText(files.DefaultConfigurationFile, "{}");
            File.WriteAllText(files.LocalConfigurationFile, "{");

            var exception = Assert.Throws<DatabaseToolConfigurationException>(
                () => DatabaseToolConfigurationLoader.Load(
                    files,
                    new Dictionary<string, string?>()));

            Assert.Equal("ConfigurationFileInvalid", exception.Failure.ToString());
        }
        finally
        {
            Directory.Delete(apiRoot, recursive: true);
        }
    }

    [Theory]
    [InlineData("not-a-connection-string")]
    [InlineData("Server=127.0.0.1;User ID=dev;Password=secret")]
    public void ConnectionStringValidator_RejectsMalformedOrUnnamedDatabase(string connectionString)
    {
        Assert.False(DatabaseToolConnectionStringValidator.IsValid(connectionString));
    }

    [Fact]
    public void ConnectionStringValidator_AcceptsNamedDatabase()
    {
        Assert.True(DatabaseToolConnectionStringValidator.IsValid(
            "Server=127.0.0.1;Database=FlowPilot_Development;User ID=dev;Password=secret"));
    }

    [Fact]
    public void BrowserTestConnections_UseASeparateSafelyNamedDatabase()
    {
        var configuration = CreateBrowserTestConfiguration("PlaywrightTests_3100");

        var result = BrowserTestDatabaseConnectionStrings.FromConfiguration(configuration);

        Assert.Equal("FlowPilot_PlaywrightTests_3100", result.DatabaseName);
        Assert.Equal(
            result.DatabaseName,
            new Microsoft.Data.SqlClient.SqlConnectionStringBuilder(
                result.RuntimeConnectionString).InitialCatalog);
        Assert.Equal(
            "master",
            new Microsoft.Data.SqlClient.SqlConnectionStringBuilder(
                result.MigrationMasterConnectionString).InitialCatalog);
    }

    [Theory]
    [InlineData("")]
    [InlineData("FlowPilot")]
    [InlineData("PlaywrightTests_port")]
    [InlineData("PlaywrightTests_3100_extra")]
    public void BrowserTestConnections_RejectUnsafeSuffix(string suffix)
    {
        var configuration = CreateBrowserTestConfiguration(suffix);

        Assert.Throws<InvalidOperationException>(
            () => BrowserTestDatabaseConnectionStrings.FromConfiguration(configuration));
    }

    private static ConfigurationManager CreateBrowserTestConfiguration(string suffix)
    {
        var configuration = new ConfigurationManager();
        configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:FlowPilot"] =
                "Server=127.0.0.1;Database=FlowPilot;User ID=runtime;Password=secret",
            ["ConnectionStrings:FlowPilotMigration"] =
                "Server=127.0.0.1;Database=FlowPilot;User ID=migration;Password=secret",
            [BrowserTestDatabaseConnectionStrings.SuffixConfigurationKey] = suffix,
        });
        return configuration;
    }

    private static string CreateTemporaryApiRoot()
    {
        var apiRoot = Path.Combine(
            Path.GetTempPath(),
            "flowpilot-database-tool-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(apiRoot, "src", "FlowPilot.Api"));
        Directory.CreateDirectory(Path.Combine(apiRoot, "config"));
        Directory.CreateDirectory(Path.Combine(apiRoot, "tools", "FlowPilot.DatabaseTool"));
        return apiRoot;
    }

    private static DatabaseToolConfigurationFiles WriteConfigurationFiles(string apiRoot)
    {
        var files = CreateConfigurationFiles(apiRoot);
        File.WriteAllText(
            files.DefaultConfigurationFile,
            """
            {
              "FlowPilot": {
                "DatabaseToolTest": {
                  "Priority": "default-value",
                  "DefaultOnly": "default-only"
                }
              }
            }
            """);
        File.WriteAllText(
            files.LocalConfigurationFile,
            """
            {
              "FlowPilot": {
                "DatabaseToolTest": {
                  "Priority": "local-value",
                  "LocalOnly": "local-only"
                }
              }
            }
            """);
        return files;
    }

    private static DatabaseToolConfigurationFiles CreateConfigurationFiles(string apiRoot) =>
        new(
            Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json"),
            Path.Combine(apiRoot, "config", "appsettings.Development.local.json"));
}
