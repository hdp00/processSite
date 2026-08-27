namespace FlowPilot.Database.Migrations;

public sealed record MigrationLedgerEntry(
    string MigrationId,
    string Name,
    string Checksum,
    string Result);
