using Microsoft.Extensions.Caching.Memory;

namespace FlowPilot.Infrastructure.Authentication;

public sealed class LoginAttemptLimiter(
    IMemoryCache cache,
    TimeProvider timeProvider)
{
    private const int AccountAndIpLimit = 5;
    private const int IpLimit = 30;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);
    private readonly object _bucketCreationLock = new();

    public LoginLimitDecision Check(string normalizedLoginName, string sourceIp)
    {
        var now = timeProvider.GetUtcNow();
        var accountDecision = Read(AccountKey(normalizedLoginName, sourceIp), AccountAndIpLimit, now);
        var ipDecision = Read(IpKey(sourceIp), IpLimit, now);
        return LoginLimitDecision.MostRestrictive(accountDecision, ipDecision);
    }

    public LoginLimitDecision RegisterFailure(string normalizedLoginName, string sourceIp)
    {
        var now = timeProvider.GetUtcNow();
        var accountDecision = Increment(
            AccountKey(normalizedLoginName, sourceIp),
            AccountAndIpLimit,
            now);
        var ipDecision = Increment(IpKey(sourceIp), IpLimit, now);
        return LoginLimitDecision.MostRestrictive(accountDecision, ipDecision);
    }

    public void RegisterSuccess(string normalizedLoginName, string sourceIp) =>
        cache.Remove(AccountKey(normalizedLoginName, sourceIp));

    private LoginLimitDecision Read(string key, int limit, DateTimeOffset now)
    {
        if (!cache.TryGetValue<AttemptBucket>(key, out var bucket) || bucket is null)
        {
            return LoginLimitDecision.Allowed;
        }

        lock (bucket.SyncRoot)
        {
            return bucket.ExpiresAt <= now || bucket.Count < limit
                ? LoginLimitDecision.Allowed
                : LoginLimitDecision.Limited(RetryAfterSeconds(bucket.ExpiresAt, now));
        }
    }

    private LoginLimitDecision Increment(string key, int limit, DateTimeOffset now)
    {
        var bucket = GetOrCreateBucket(key, now);

        lock (bucket.SyncRoot)
        {
            bucket.Count++;
            return bucket.Count < limit
                ? LoginLimitDecision.Allowed
                : LoginLimitDecision.Limited(RetryAfterSeconds(bucket.ExpiresAt, now));
        }
    }

    private AttemptBucket GetOrCreateBucket(string key, DateTimeOffset now)
    {
        lock (_bucketCreationLock)
        {
            if (cache.TryGetValue<AttemptBucket>(key, out var existing)
                && existing is not null
                && existing.ExpiresAt > now)
            {
                return existing;
            }

            cache.Remove(key);
            var created = new AttemptBucket(now.Add(Window));
            cache.Set(key, created, created.ExpiresAt);
            return created;
        }
    }

    private static int RetryAfterSeconds(DateTimeOffset expiresAt, DateTimeOffset now) =>
        Math.Max(1, (int)Math.Ceiling((expiresAt - now).TotalSeconds));

    private static string AccountKey(string normalizedLoginName, string sourceIp) =>
        $"flowpilot-login-account:{sourceIp}\n{normalizedLoginName}";

    private static string IpKey(string sourceIp) => $"flowpilot-login-ip:{sourceIp}";

    private sealed class AttemptBucket(DateTimeOffset expiresAt)
    {
        public object SyncRoot { get; } = new();

        public DateTimeOffset ExpiresAt { get; } = expiresAt;

        public int Count { get; set; }
    }
}

public readonly record struct LoginLimitDecision(bool IsLimited, int RetryAfterSeconds)
{
    public static LoginLimitDecision Allowed => new(false, 0);

    public static LoginLimitDecision Limited(int retryAfterSeconds) =>
        new(true, retryAfterSeconds);

    public static LoginLimitDecision MostRestrictive(
        LoginLimitDecision first,
        LoginLimitDecision second)
    {
        if (!first.IsLimited)
        {
            return second;
        }

        if (!second.IsLimited)
        {
            return first;
        }

        return first.RetryAfterSeconds >= second.RetryAfterSeconds ? first : second;
    }
}
