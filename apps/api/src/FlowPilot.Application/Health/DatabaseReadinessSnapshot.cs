namespace FlowPilot.Application.Health;

public sealed record DatabaseReadinessSnapshot(
    string? ProductVersion,
    string? ProductLevel,
    int CompatibilityLevel,
    string? Collation,
    bool FlowPilotSchemaExists,
    bool SchemaVersionStoreExists,
    bool SchemaVersionStoreIsValid,
    string? AppliedSchemaVersion);
