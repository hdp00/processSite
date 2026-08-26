namespace FlowPilot.Infrastructure.Configuration;

public sealed class ProductionConfigurationException : InvalidOperationException
{
    public ProductionConfigurationException(
        ProductionConfigurationFailure failure,
        string configurationKey)
        : base($"Production configuration validation failed for '{configurationKey}' ({failure}).")
    {
        Failure = failure;
        ConfigurationKey = configurationKey;
    }

    public ProductionConfigurationFailure Failure { get; }

    public string ConfigurationKey { get; }
}
