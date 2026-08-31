using FlowPilot.Infrastructure.Authentication;
using Microsoft.Extensions.Caching.Memory;

namespace FlowPilot.UnitTests.Authentication;

public sealed class LoginAttemptLimiterTests
{
    [Fact]
    public void FifthFailureLimitsTheAccountAndSuccessClearsThatAccountBucket()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        var limiter = new LoginAttemptLimiter(cache, clock);

        for (var attempt = 1; attempt < 5; attempt++)
        {
            Assert.False(limiter.RegisterFailure("user", "10.0.0.1").IsLimited);
        }

        var limited = limiter.RegisterFailure("user", "10.0.0.1");
        Assert.True(limited.IsLimited);
        Assert.Equal(300, limited.RetryAfterSeconds);
        Assert.True(limiter.Check("user", "10.0.0.1").IsLimited);

        limiter.RegisterSuccess("user", "10.0.0.1");

        Assert.False(limiter.Check("user", "10.0.0.1").IsLimited);
    }

    [Fact]
    public void ExpiredWindowStartsWithAnEmptyBucket()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        var limiter = new LoginAttemptLimiter(cache, clock);

        for (var attempt = 0; attempt < 5; attempt++)
        {
            limiter.RegisterFailure("user", "10.0.0.2");
        }

        clock.Advance(TimeSpan.FromMinutes(5));

        Assert.False(limiter.Check("user", "10.0.0.2").IsLimited);
        Assert.False(limiter.RegisterFailure("user", "10.0.0.2").IsLimited);
    }

    [Fact]
    public void MostRestrictiveDecisionKeepsTheLongestRetry()
    {
        var result = LoginLimitDecision.MostRestrictive(
            LoginLimitDecision.Limited(12),
            LoginLimitDecision.Limited(45));

        Assert.True(result.IsLimited);
        Assert.Equal(45, result.RetryAfterSeconds);
        Assert.Equal(LoginLimitDecision.Allowed, LoginLimitDecision.MostRestrictive(
            LoginLimitDecision.Allowed,
            LoginLimitDecision.Allowed));
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now = _now.Add(duration);
    }
}
