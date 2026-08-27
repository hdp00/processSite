namespace FlowPilot.Database.Migrations;

public sealed record DatabaseMigrationResult(
    DatabaseMigrationOutcome Outcome,
    string SchemaVersion,
    int AppliedMigrationCount);
