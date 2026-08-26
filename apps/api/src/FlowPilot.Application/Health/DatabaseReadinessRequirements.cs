namespace FlowPilot.Application.Health;

public sealed record DatabaseReadinessRequirements(
    string? RequiredSchemaVersion,
    string? ExpectedCollation);
