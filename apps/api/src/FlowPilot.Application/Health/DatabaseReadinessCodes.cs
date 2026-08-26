namespace FlowPilot.Application.Health;

public static class DatabaseReadinessCodes
{
    public const string Ready = "READY";
    public const string ConfigurationMissing = "DATABASE_CONFIGURATION_MISSING";
    public const string Unavailable = "DATABASE_UNAVAILABLE";
    public const string ServerVersionUnsupported = "DATABASE_SERVER_VERSION_UNSUPPORTED";
    public const string CompatibilityLevelUnsupported = "DATABASE_COMPATIBILITY_LEVEL_UNSUPPORTED";
    public const string CollationMismatch = "DATABASE_COLLATION_MISMATCH";
    public const string SchemaMissing = "DATABASE_SCHEMA_MISSING";
    public const string SchemaVersionStoreMissing = "DATABASE_SCHEMA_VERSION_STORE_MISSING";
    public const string SchemaVersionStoreInvalid = "DATABASE_SCHEMA_VERSION_STORE_INVALID";
    public const string SchemaVersionMissing = "DATABASE_SCHEMA_VERSION_MISSING";
    public const string SchemaVersionMismatch = "DATABASE_SCHEMA_VERSION_MISMATCH";
}
