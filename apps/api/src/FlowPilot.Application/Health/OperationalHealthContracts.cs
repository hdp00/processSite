namespace FlowPilot.Application.Health;

public sealed record OperationalHealthCheckDto(
    string Name,
    string Status,
    DateTimeOffset CheckedAt,
    string? Code = null,
    string? Message = null,
    IReadOnlyDictionary<string, object?>? Metrics = null);

public sealed record OperationalHealthDto(
    string Status,
    DateTimeOffset CheckedAt,
    string Version,
    IReadOnlyList<OperationalHealthCheckDto> Checks);

public interface IOperationalHealthService
{
    Task<OperationalHealthDto> GetAsync(string applicationVersion, CancellationToken cancellationToken = default);
}
