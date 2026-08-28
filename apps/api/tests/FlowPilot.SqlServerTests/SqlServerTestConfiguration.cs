using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

internal static class SqlServerTestConfiguration
{
    private const string RequiredVariable = "FLOWPILOT_SQLSERVER_TEST_REQUIRED";
    private const string LocalFileName = "appsettings.Development.local.json";

    public const string ConnectionStringOverrideVariable =
        "FLOWPILOT_SQLSERVER_TEST_CONNECTION_STRING";

    public const string RequiredSchemaVersionOverrideVariable =
        "FLOWPILOT_SQLSERVER_TEST_REQUIRED_SCHEMA_VERSION";

    public const string ExpectedCollationOverrideVariable =
        "FLOWPILOT_SQLSERVER_TEST_EXPECTED_COLLATION";

    private static readonly IReadOnlyList<EnvironmentOverride> DeclaredEnvironmentOverrides =
    [
        new(ConnectionStringOverrideVariable, "ConnectionStrings:FlowPilot"),
        new(RequiredSchemaVersionOverrideVariable, "FlowPilot:Database:RequiredSchemaVersion"),
        new(ExpectedCollationOverrideVariable, "FlowPilot:Database:ExpectedCollation"),
    ];

    public static ConfigurationManager Load()
    {
        var apiRoot = FindApiRoot();
        var configuration = new ConfigurationManager();
        configuration
            .AddJsonFile(
                Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json"),
                optional: false,
                reloadOnChange: false)
            .AddJsonFile(
                Path.Combine(apiRoot, "config", LocalFileName),
                optional: true,
                reloadOnChange: false)
            .AddEnvironmentVariables();
        AddDeclaredEnvironmentOverrides(configuration, Environment.GetEnvironmentVariable);
        return configuration;
    }

    internal static void AddDeclaredEnvironmentOverrides(
        IConfigurationBuilder configuration,
        Func<string, string?> getEnvironmentVariable)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(getEnvironmentVariable);

        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var environmentOverride in DeclaredEnvironmentOverrides)
        {
            var value = getEnvironmentVariable(environmentOverride.VariableName);
            if (value is not null)
            {
                values[environmentOverride.ConfigurationKey] = value;
            }
        }

        configuration.AddInMemoryCollection(values);
    }

    public static string RequireOrSkip(string? value, string configurationKey)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        var message =
            $"Missing {configurationKey}. Configure apps/api/config/{LocalFileName} to run SQL Server integration tests.";
        if (IsRequired())
        {
            Assert.Fail(message);
        }

        Assert.Skip(message);
        ThrowUnreachable();
        return string.Empty;
    }

    private static bool IsRequired() =>
        bool.TryParse(Environment.GetEnvironmentVariable(RequiredVariable), out var required) && required;

    private static string FindApiRoot()
    {
        foreach (var startDirectory in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            var directory = new DirectoryInfo(Path.GetFullPath(startDirectory));
            for (var depth = 0; directory is not null && depth <= 8; depth++, directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "FlowPilot.slnx")) &&
                    Directory.Exists(Path.Combine(directory.FullName, "src", "FlowPilot.Api")))
                {
                    return directory.FullName;
                }

                var apiRoot = Path.Combine(directory.FullName, "apps", "api");
                if (File.Exists(Path.Combine(apiRoot, "FlowPilot.slnx")))
                {
                    return apiRoot;
                }
            }
        }

        throw new InvalidOperationException("FlowPilot API root was not found.");
    }

    [DoesNotReturn]
    private static void ThrowUnreachable() =>
        throw new InvalidOperationException("The test runner did not stop after a skip or failure.");

    private sealed record EnvironmentOverride(string VariableName, string ConfigurationKey);
}
