using System.Data.Common;
using FlowPilot.Application.Health;
using FlowPilot.Infrastructure.Health;

namespace FlowPilot.UnitTests.Health;

public sealed class SqlServerDatabaseReadinessCheckTests
{
    private static readonly DatabaseReadinessRequirements Requirements =
        new("Chinese_PRC_100_CI_AS_SC");

    [Fact]
    public async Task CheckAsync_RejectsMissingConnectionConfigurationWithoutReadingDatabase()
    {
        var reader = new StubSnapshotReader(IsConfigured: false, CreateReadySnapshot());
        var check = new SqlServerDatabaseReadinessCheck(reader, Requirements);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.ConfigurationMissing, result.Code);
        Assert.Equal(0, reader.ReadCount);
    }

    [Fact]
    public async Task CheckAsync_EvaluatesSnapshotReadFromDatabase()
    {
        var reader = new StubSnapshotReader(IsConfigured: true, CreateReadySnapshot());
        var check = new SqlServerDatabaseReadinessCheck(reader, Requirements);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.True(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.Ready, result.Code);
        Assert.Equal(1, reader.ReadCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsSanitizedUnavailableCodeForDatabaseFailures()
    {
        const string sensitiveText =
            "Server=sql.internal;Database=FlowPilot;User Id=flowpilot;Password=secret";
        var reader = new StubSnapshotReader(
            IsConfigured: true,
            _ => throw new TestDbException(sensitiveText));
        var check = new SqlServerDatabaseReadinessCheck(reader, Requirements);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.Unavailable, result.Code);
        Assert.DoesNotContain("sql.internal", result.Code, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret", result.Code, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task CheckAsync_ReturnsUnavailableCodeForInvalidProviderState()
    {
        var reader = new StubSnapshotReader(
            IsConfigured: true,
            _ => throw new InvalidOperationException("provider details must not escape"));
        var check = new SqlServerDatabaseReadinessCheck(reader, Requirements);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.Unavailable, result.Code);
    }

    [Fact]
    public async Task CheckAsync_PropagatesCallerCancellation()
    {
        using var cancellationSource = new CancellationTokenSource();
        await cancellationSource.CancelAsync();
        var reader = new StubSnapshotReader(
            IsConfigured: true,
            cancellationToken => Task.FromCanceled<DatabaseReadinessSnapshot>(cancellationToken));
        var check = new SqlServerDatabaseReadinessCheck(reader, Requirements);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => check.CheckAsync(cancellationSource.Token));
    }

    private static DatabaseReadinessSnapshot CreateReadySnapshot() =>
        new(
            "13.0.6300.2",
            "SP3",
            130,
            "Chinese_PRC_100_CI_AS_SC",
            FlowPilotSchemaExists: true,
            SchemaVersionStoreExists: true,
            SchemaVersionStoreIsValid: true,
            DatabaseSchemaVersion.Current);

    private sealed class StubSnapshotReader : ISqlServerReadinessSnapshotReader
    {
        private readonly Func<CancellationToken, Task<DatabaseReadinessSnapshot>> _read;

        public StubSnapshotReader(bool IsConfigured, DatabaseReadinessSnapshot snapshot)
            : this(IsConfigured, _ => Task.FromResult(snapshot))
        {
        }

        public StubSnapshotReader(
            bool IsConfigured,
            Func<CancellationToken, Task<DatabaseReadinessSnapshot>> read)
        {
            this.IsConfigured = IsConfigured;
            _read = read;
        }

        public bool IsConfigured { get; }

        public int ReadCount { get; private set; }

        public Task<DatabaseReadinessSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            ReadCount++;
            return _read(cancellationToken);
        }
    }

    private sealed class TestDbException(string message) : DbException(message);
}
