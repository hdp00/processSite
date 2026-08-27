namespace FlowPilot.Infrastructure.Health;

public interface IBuiltinSeedVersionReader
{
    Task<string?> ReadAsync(CancellationToken cancellationToken = default);
}
