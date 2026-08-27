namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed record SqlServerSchemaValidationResult(bool IsValid, string Code)
{
    public IReadOnlyList<string> Differences { get; init; } = [];

    public static SqlServerSchemaValidationResult Valid { get; } =
        new(true, SqlServerSchemaValidationCodes.Valid);

    public static SqlServerSchemaValidationResult StructureMismatch { get; } =
        new(false, SqlServerSchemaValidationCodes.StructureMismatch);

    public static SqlServerSchemaValidationResult StructureMismatchWithDifferences(
        IEnumerable<string> differences)
    {
        ArgumentNullException.ThrowIfNull(differences);
        return StructureMismatch with { Differences = differences.ToArray() };
    }
}
