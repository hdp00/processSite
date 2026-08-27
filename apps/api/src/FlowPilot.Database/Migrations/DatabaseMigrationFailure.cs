namespace FlowPilot.Database.Migrations;

public enum DatabaseMigrationFailure
{
    InvalidInput,
    InvalidConnectionString,
    DatabaseNameMissing,
    SystemDatabaseNotAllowed,
    DatabaseNameMismatch,
    ExpectedCollationMissing,
    DatabaseUnavailable,
    ServerVersionUnsupported,
    CompatibilityLevelUnsupported,
    CollationMismatch,
    MigrationCatalogInvalid,
    DatabaseStateUnknown,
    UnknownMigration,
    MigrationNotSucceeded,
    MigrationChecksumMismatch,
    SchemaStructureMismatch,
    MigrationLockUnavailable,
    MigrationExecutionFailed,
}
