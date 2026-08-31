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
    WeakEncryptSetting,
    MissingTrustServerCertificateSetting,
    TrustServerCertificateEnabled,
    MissingExpectedCollation,
    InvalidDatabaseCommandTimeout,
    InvalidLdapConfiguration,
    InvalidSmtpConfiguration,
}
