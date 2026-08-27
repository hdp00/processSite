namespace FlowPilot.Database.Migrations;

public sealed record DatabaseMigrationState(
    bool HasUserObjects,
    bool FlowPilotSchemaExists,
    bool MigrationLedgerExists,
    bool MigrationLedgerIsValid,
    IReadOnlyList<MigrationLedgerEntry> Entries);
