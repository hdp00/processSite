namespace FlowPilot.Infrastructure.Configuration;

public enum ProductionConfigurationFailure
{
    MissingListenUrl,
    MissingEndpointUrl,
    InvalidListenUrl,
    MissingAllowedHosts,
    UnsafeAllowedHosts,
    MissingConnectionString,
    InvalidConnectionString,
    MissingEncryptSetting,
    EncryptMustBeDisabled,
    MissingTrustServerCertificateSetting,
    TrustServerCertificateMustBeEnabled,
    MissingExpectedCollation,
    InvalidDatabaseCommandTimeout,
    InvalidLdapConfiguration,
    InvalidSmtpConfiguration,
}
