namespace FlowPilot.Application.Health;

public sealed record DatabaseReadinessResult(bool IsReady, string Code)
{
    public static DatabaseReadinessResult Ready { get; } =
        new(true, DatabaseReadinessCodes.Ready);

    public static DatabaseReadinessResult NotReady(string code)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(code);
        return new DatabaseReadinessResult(false, code);
    }
}
