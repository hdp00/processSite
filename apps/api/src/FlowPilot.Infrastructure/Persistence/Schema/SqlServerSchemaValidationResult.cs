namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed record SqlServerSchemaValidationResult(bool IsValid, string Code)
{
    public static SqlServerSchemaValidationResult Valid { get; } =
        new(true, SqlServerSchemaValidationCodes.Valid);

    public static SqlServerSchemaValidationResult StructureMismatch { get; } =
        new(false, SqlServerSchemaValidationCodes.StructureMismatch);
}
