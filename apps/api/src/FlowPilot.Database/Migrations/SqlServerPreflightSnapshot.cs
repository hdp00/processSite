namespace FlowPilot.Database.Migrations;

public sealed record SqlServerPreflightSnapshot(
    string? DatabaseName,
    string? ProductVersion,
    string? ProductLevel,
    int CompatibilityLevel,
    string? Collation);
