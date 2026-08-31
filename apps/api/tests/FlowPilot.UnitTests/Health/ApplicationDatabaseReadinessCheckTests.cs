using System.Data.Common;
using FlowPilot.Application.Health;
using FlowPilot.Application.Security;
using FlowPilot.Infrastructure.Health;

namespace FlowPilot.UnitTests.Health;

public sealed class ApplicationDatabaseReadinessCheckTests
{
    private const string ExpectedCollation = "Chinese_PRC_100_CI_AS_SC";

    [Fact]
    public async Task CheckAsync_PreservesStructuralFailureWithoutReadingSeedState()
    {
        var structuralReader = new StubStructuralReader(
            CreateReadyStructuralSnapshot() with { FlowPilotSchemaExists = false });
        var seedReader = new StubBuiltinSeedVersionReader(BuiltinCatalog.SeedVersion);
        var check = CreateCheck(structuralReader, seedReader);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.SchemaMissing, result.Code);
        Assert.Equal(1, structuralReader.ReadCount);
        Assert.Equal(0, seedReader.ReadCount);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task CheckAsync_ReturnsStableMissingCodeWhenBuiltinSeedWasNotApplied(
        string? appliedVersion)
    {
        var seedReader = new StubBuiltinSeedVersionReader(appliedVersion);
        var check = CreateCheck(new StubStructuralReader(CreateReadyStructuralSnapshot()), seedReader);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.BuiltinSeedVersionMissing, result.Code);
        Assert.Equal(1, seedReader.ReadCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsStableMismatchCodeForOutdatedBuiltinSeed()
    {
        var check = CreateCheck(
            new StubStructuralReader(CreateReadyStructuralSnapshot()),
            new StubBuiltinSeedVersionReader("202608250001"));

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.BuiltinSeedVersionMismatch, result.Code);
    }

    [Fact]
    public async Task CheckAsync_ReturnsReadyForMatchingTrimmedBuiltinSeedVersion()
    {
        var check = CreateCheck(
            new StubStructuralReader(CreateReadyStructuralSnapshot()),
            new StubBuiltinSeedVersionReader($" {BuiltinCatalog.SeedVersion} "));

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.True(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.Ready, result.Code);
    }

    [Fact]
    public async Task CheckAsync_SanitizesSeedStateDatabaseFailures()
    {
        var seedReader = new StubBuiltinSeedVersionReader(
            _ => throw new TestDbException("Password=never-log-this"));
        var check = CreateCheck(new StubStructuralReader(CreateReadyStructuralSnapshot()), seedReader);

        var result = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.IsReady);
        Assert.Equal(DatabaseReadinessCodes.Unavailable, result.Code);
        Assert.DoesNotContain("never-log-this", result.Code, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CheckAsync_PropagatesCallerCancellationDuringSeedRead()
    {
        using var cancellationSource = new CancellationTokenSource();
        await cancellationSource.CancelAsync();
        var seedReader = new StubBuiltinSeedVersionReader(
            cancellationToken => Task.FromCanceled<string?>(cancellationToken));
        var check = CreateCheck(new StubStructuralReader(CreateReadyStructuralSnapshot()), seedReader);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => check.CheckAsync(cancellationSource.Token));
    }

    private static ApplicationDatabaseReadinessCheck CreateCheck(
        StubStructuralReader structuralReader,
        IBuiltinSeedVersionReader seedReader)
    {
        var structuralCheck = new SqlServerDatabaseReadinessCheck(
            structuralReader,
            new DatabaseReadinessRequirements(ExpectedCollation));
        return new ApplicationDatabaseReadinessCheck(
            structuralCheck,
            seedReader);
    }

    private static DatabaseReadinessSnapshot CreateReadyStructuralSnapshot() =>
        new(
            "13.0.6300.2",
            "SP3",
            130,
            ExpectedCollation,
            FlowPilotSchemaExists: true,
            SchemaVersionStoreExists: true,
            SchemaVersionStoreIsValid: true,
            DatabaseSchemaVersion.Current);

    private sealed class StubStructuralReader(DatabaseReadinessSnapshot snapshot)
        : ISqlServerReadinessSnapshotReader
    {
        public bool IsConfigured => true;

        public int ReadCount { get; private set; }

        public Task<DatabaseReadinessSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            ReadCount++;
            return Task.FromResult(snapshot);
        }
    }

    private sealed class StubBuiltinSeedVersionReader : IBuiltinSeedVersionReader
    {
        private readonly Func<CancellationToken, Task<string?>> _read;

        public StubBuiltinSeedVersionReader(string? version)
            : this(_ => Task.FromResult(version))
        {
        }

        public StubBuiltinSeedVersionReader(Func<CancellationToken, Task<string?>> read)
        {
            _read = read;
        }

        public int ReadCount { get; private set; }

        public Task<string?> ReadAsync(CancellationToken cancellationToken = default)
        {
            ReadCount++;
            return _read(cancellationToken);
        }
    }

    private sealed class TestDbException(string message) : DbException(message);
}
