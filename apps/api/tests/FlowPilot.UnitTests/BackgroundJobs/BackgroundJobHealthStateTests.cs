using FlowPilot.Infrastructure.BackgroundJobs;

namespace FlowPilot.UnitTests.BackgroundJobs;

public sealed class BackgroundJobHealthStateTests
{
    [Fact]
    public void LatestOutcomeDeterminesWhetherTheJobIsCurrentlyFailed()
    {
        var state = new BackgroundJobHealthState();
        var first = new DateTimeOffset(2026, 8, 31, 1, 0, 0, TimeSpan.Zero);

        Assert.False(state.Read().HasCurrentFailure);

        state.RecordFailure(first);
        Assert.True(state.Read().HasCurrentFailure);

        state.RecordSuccess(first.AddSeconds(1));
        var recovered = state.Read();
        Assert.False(recovered.HasCurrentFailure);
        Assert.Equal(first, recovered.LastFailedAt);
        Assert.Equal(first.AddSeconds(1), recovered.LastSucceededAt);

        state.RecordFailure(first.AddSeconds(2));
        Assert.True(state.Read().HasCurrentFailure);
    }
}
