using FlowPilot.Infrastructure.Attachments;
using FlowPilot.Infrastructure.Configuration;

namespace FlowPilot.UnitTests.Attachments;

public sealed class AttachmentFileStorageTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "flowpilot-storage-tests",
        Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task IncomingFileCanBeWrittenReadAndDeletedWithinTheRoot()
    {
        var storage = CreateStorage();
        var attachmentId = Guid.NewGuid();
        var key = AttachmentFileStorage.CreateIncomingStorageKey(2026, attachmentId);
        var content = "FlowPilot attachment"u8.ToArray();

        await using (var output = await storage.CreateIncomingFileAsync(
            key,
            TestContext.Current.CancellationToken))
        {
            await output.WriteAsync(content, TestContext.Current.CancellationToken);
        }

        Assert.True(storage.Exists(key));
        using (var input = storage.OpenRead(key))
        using (var memory = new MemoryStream())
        {
            await input.CopyToAsync(memory, TestContext.Current.CancellationToken);
            Assert.Equal(content, memory.ToArray());
        }

        storage.DeleteIfExists(key);
        Assert.False(storage.Exists(key));
    }

    [Theory]
    [InlineData("")]
    [InlineData("../escape")]
    [InlineData("2026/../escape")]
    [InlineData("2026\\escape")]
    [InlineData("2026//escape")]
    public void InvalidStorageKeysAreRejected(string key)
    {
        var storage = CreateStorage();

        Assert.Throws<InvalidDataException>(() => storage.Exists(key));
    }

    [Fact]
    public void RootMustBeAnAbsolutePath()
    {
        var options = new AttachmentStorageOptions("relative", 1024, 0);

        Assert.Throws<InvalidOperationException>(() => new AttachmentFileStorage(options));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private AttachmentFileStorage CreateStorage() => new(new AttachmentStorageOptions(
        _root,
        MaximumFileSizeBytes: 1024,
        MinimumFreeSpaceBytes: 0));
}
