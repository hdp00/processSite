using System.Text.Json.Serialization;

namespace FlowPilot.Contracts.Health;

public static class HealthStatuses
{
    public const string Ok = "ok";
    public const string Unavailable = "unavailable";
}

public sealed record LivenessDto(string Status, DateTimeOffset CheckedAt);

public sealed record ReadinessDto(
    string Status,
    DateTimeOffset CheckedAt,
    string Version,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Code = null);
