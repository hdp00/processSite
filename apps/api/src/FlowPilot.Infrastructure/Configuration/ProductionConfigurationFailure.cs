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
    MissingRequiredSchemaVersion,
    MissingRequiredBuiltinSeedVersion,
    MissingExpectedCollation,
    InvalidDatabaseCommandTimeout,
    InvalidLdapConfiguration,
    InvalidSmtpConfiguration,
}
