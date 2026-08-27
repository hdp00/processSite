namespace FlowPilot.Infrastructure.Persistence.Schema;

public static class SqlServerSchemaValidationCodes
{
    public const string Valid = "READY";
    public const string StructureMismatch = "DATABASE_SCHEMA_STRUCTURE_MISMATCH";
}
