namespace FlowPilot.Database.Migrations;

public sealed record DatabaseMigrationRequest(
    string? ConnectionString,
    string? ExpectedCollation,
    string? ToolVersion);
