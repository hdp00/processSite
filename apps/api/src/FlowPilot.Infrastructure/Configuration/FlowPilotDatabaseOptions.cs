using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.Configuration;

public sealed record FlowPilotDatabaseOptions
{
    public const string SectionName = "FlowPilot:Database";
    public const int DefaultApplicationCommandTimeoutSeconds = 30;
    public const int DefaultReadinessCommandTimeoutSeconds = 5;
    public const int DefaultSchemaProbeCommandTimeoutSeconds = 15;
    public const int DefaultMigrationPreflightCommandTimeoutSeconds = 15;
    public const int DefaultMigrationCommandTimeoutSeconds = 300;
    public const int MaximumCommandTimeoutSeconds = 3600;

    public FlowPilotDatabaseOptions(
        string? requiredSchemaVersion = null,
        string? requiredBuiltinSeedVersion = null,
        string? expectedCollation = null,
        int applicationCommandTimeoutSeconds = DefaultApplicationCommandTimeoutSeconds,
        int readinessCommandTimeoutSeconds = DefaultReadinessCommandTimeoutSeconds,
        int schemaProbeCommandTimeoutSeconds = DefaultSchemaProbeCommandTimeoutSeconds,
        int migrationPreflightCommandTimeoutSeconds = DefaultMigrationPreflightCommandTimeoutSeconds,
        int migrationCommandTimeoutSeconds = DefaultMigrationCommandTimeoutSeconds)
    {
        ValidateCommandTimeout(applicationCommandTimeoutSeconds, nameof(applicationCommandTimeoutSeconds));
        ValidateCommandTimeout(readinessCommandTimeoutSeconds, nameof(readinessCommandTimeoutSeconds));
        ValidateCommandTimeout(schemaProbeCommandTimeoutSeconds, nameof(schemaProbeCommandTimeoutSeconds));
        ValidateCommandTimeout(
            migrationPreflightCommandTimeoutSeconds,
            nameof(migrationPreflightCommandTimeoutSeconds));
        ValidateCommandTimeout(migrationCommandTimeoutSeconds, nameof(migrationCommandTimeoutSeconds));

        RequiredSchemaVersion = requiredSchemaVersion;
        RequiredBuiltinSeedVersion = requiredBuiltinSeedVersion;
        ExpectedCollation = expectedCollation;
        ApplicationCommandTimeoutSeconds = applicationCommandTimeoutSeconds;
        ReadinessCommandTimeoutSeconds = readinessCommandTimeoutSeconds;
        SchemaProbeCommandTimeoutSeconds = schemaProbeCommandTimeoutSeconds;
        MigrationPreflightCommandTimeoutSeconds = migrationPreflightCommandTimeoutSeconds;
        MigrationCommandTimeoutSeconds = migrationCommandTimeoutSeconds;
    }

    public string? RequiredSchemaVersion { get; }

    public string? RequiredBuiltinSeedVersion { get; }

    public string? ExpectedCollation { get; }

    public int ApplicationCommandTimeoutSeconds { get; }

    public int ReadinessCommandTimeoutSeconds { get; }

    public int SchemaProbeCommandTimeoutSeconds { get; }

    public int MigrationPreflightCommandTimeoutSeconds { get; }

    public int MigrationCommandTimeoutSeconds { get; }

    public static FlowPilotDatabaseOptions Default { get; } = new();

    public static FlowPilotDatabaseOptions FromConfiguration(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        return new FlowPilotDatabaseOptions(
            configuration[$"{SectionName}:RequiredSchemaVersion"],
            configuration[$"{SectionName}:RequiredBuiltinSeedVersion"],
            configuration[$"{SectionName}:ExpectedCollation"],
            ParseCommandTimeout(
                configuration,
                nameof(ApplicationCommandTimeoutSeconds),
                DefaultApplicationCommandTimeoutSeconds),
            ParseCommandTimeout(
                configuration,
                nameof(ReadinessCommandTimeoutSeconds),
                DefaultReadinessCommandTimeoutSeconds),
            ParseCommandTimeout(
                configuration,
                nameof(SchemaProbeCommandTimeoutSeconds),
                DefaultSchemaProbeCommandTimeoutSeconds),
            ParseCommandTimeout(
                configuration,
                nameof(MigrationPreflightCommandTimeoutSeconds),
                DefaultMigrationPreflightCommandTimeoutSeconds),
            ParseCommandTimeout(
                configuration,
                nameof(MigrationCommandTimeoutSeconds),
                DefaultMigrationCommandTimeoutSeconds));
    }

    private static int ParseCommandTimeout(
        IConfiguration configuration,
        string optionName,
        int defaultValue)
    {
        var configurationKey = $"{SectionName}:{optionName}";
        var configuredValue = configuration[configurationKey];
        if (string.IsNullOrWhiteSpace(configuredValue))
        {
            return defaultValue;
        }

        if (!int.TryParse(
                configuredValue.Trim(),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var parsedValue) ||
            parsedValue is < 1 or > MaximumCommandTimeoutSeconds)
        {
            throw new FlowPilotDatabaseOptionsConfigurationException(configurationKey);
        }

        return parsedValue;
    }

    private static void ValidateCommandTimeout(int value, string parameterName)
    {
        if (value is < 1 or > MaximumCommandTimeoutSeconds)
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                value,
                $"Command timeout must be between 1 and {MaximumCommandTimeoutSeconds} seconds.");
        }
    }
}

public sealed class FlowPilotDatabaseOptionsConfigurationException : InvalidOperationException
{
    public FlowPilotDatabaseOptionsConfigurationException(string configurationKey)
        : base($"Database options validation failed for '{configurationKey}'.")
    {
        ConfigurationKey = configurationKey;
    }

    public string ConfigurationKey { get; }
}
