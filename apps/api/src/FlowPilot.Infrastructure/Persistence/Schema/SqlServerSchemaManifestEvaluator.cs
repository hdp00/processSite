namespace FlowPilot.Infrastructure.Persistence.Schema;

public static class SqlServerSchemaManifestEvaluator
{
    public static SqlServerSchemaValidationResult Evaluate(
        FlowPilotSchemaManifest manifest,
        SqlServerSchemaSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(snapshot);

        return manifest.Tables.SetEquals(snapshot.Tables) &&
            manifest.Columns.SetEquals(snapshot.Columns) &&
            manifest.Constraints.SetEquals(snapshot.Constraints) &&
            manifest.Indexes.SetEquals(snapshot.Indexes) &&
            manifest.Triggers.SetEquals(snapshot.Triggers) &&
            manifest.ColumnSignatures.SetEquals(snapshot.ColumnSignatures) &&
            manifest.CheckConstraintSignatures.SetEquals(snapshot.CheckConstraintSignatures) &&
            manifest.ForeignKeySignatures.SetEquals(snapshot.ForeignKeySignatures) &&
            manifest.KeyConstraintSignatures.SetEquals(snapshot.KeyConstraintSignatures) &&
            manifest.IndexSignatures.SetEquals(snapshot.IndexSignatures) &&
            manifest.TriggerSignatures.SetEquals(snapshot.TriggerSignatures) &&
            snapshot.OtherObjects.Count == 0
                ? SqlServerSchemaValidationResult.Valid
                : SqlServerSchemaValidationResult.StructureMismatch;
    }
}
