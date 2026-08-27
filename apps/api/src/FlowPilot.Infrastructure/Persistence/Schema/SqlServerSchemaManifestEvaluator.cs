namespace FlowPilot.Infrastructure.Persistence.Schema;

public static class SqlServerSchemaManifestEvaluator
{
    public static SqlServerSchemaValidationResult Evaluate(
        FlowPilotSchemaManifest manifest,
        SqlServerSchemaSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(snapshot);

        var differences = new List<string>();
        AddDifferences("tables", manifest.Tables, snapshot.Tables, differences);
        AddDifferences("columns", manifest.Columns, snapshot.Columns, differences);
        AddDifferences("constraints", manifest.Constraints, snapshot.Constraints, differences);
        AddDifferences("indexes", manifest.Indexes, snapshot.Indexes, differences);
        AddDifferences("triggers", manifest.Triggers, snapshot.Triggers, differences);

        return differences.Count == 0
            ? SqlServerSchemaValidationResult.Valid
            : SqlServerSchemaValidationResult.StructureMismatchWithDifferences(differences);
    }

    private static void AddDifferences(
        string category,
        IReadOnlySet<string> expected,
        IReadOnlySet<string> actual,
        List<string> destination)
    {
        if (expected.SetEquals(actual))
        {
            return;
        }

        var missing = expected.Except(actual, StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var unexpected = actual.Except(expected, StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var examples = new List<string>(2);
        if (missing.Length > 0)
        {
            examples.Add($"missingExample={missing[0]}");
        }

        if (unexpected.Length > 0)
        {
            examples.Add($"unexpectedExample={unexpected[0]}");
        }

        destination.Add(
            $"{category}: missing={missing.Length}, unexpected={unexpected.Length}; " +
            string.Join("; ", examples));
    }
}
