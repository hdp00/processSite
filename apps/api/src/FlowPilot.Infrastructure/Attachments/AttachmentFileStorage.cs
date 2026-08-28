using FlowPilot.Infrastructure.Configuration;

namespace FlowPilot.Infrastructure.Attachments;

public sealed class AttachmentFileStorage
{
    private readonly AttachmentStorageOptions _options;
    private readonly string _rootWithSeparator;

    public AttachmentFileStorage(AttachmentStorageOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (!Path.IsPathFullyQualified(options.RootDirectory))
        {
            throw new InvalidOperationException("Attachment root directory must be an absolute path.");
        }

        _options = options;
        RootDirectory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.RootDirectory));
        _rootWithSeparator = RootDirectory + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(RootDirectory);
    }

    public string RootDirectory { get; }

    public static string CreateIncomingStorageKey(short year, Guid attachmentId) =>
        $"{year}/.incoming/{attachmentId:N}.part";

    public async Task<FileStream> CreateIncomingFileAsync(
        string storageKey,
        CancellationToken cancellationToken)
    {
        EnsureFreeSpace();
        var path = ResolvePath(storageKey);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await Task.CompletedTask.ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 128 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
    }

    public Stream OpenRead(string storageKey)
    {
        var path = ResolvePath(storageKey);
        return new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 128 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
    }

    public bool Exists(string storageKey) => File.Exists(ResolvePath(storageKey));

    public void DeleteIfExists(string storageKey)
    {
        var path = ResolvePath(storageKey);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    private string ResolvePath(string storageKey)
    {
        if (string.IsNullOrWhiteSpace(storageKey)
            || Path.IsPathFullyQualified(storageKey)
            || storageKey.Contains('\\', StringComparison.Ordinal)
            || storageKey.Split('/').Any(segment => segment is "" or "." or ".."))
        {
            throw new InvalidDataException("Attachment storage key is invalid.");
        }

        var path = Path.GetFullPath(
            Path.Combine(RootDirectory, storageKey.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(_rootWithSeparator, PathComparison))
        {
            throw new InvalidDataException("Attachment storage key escapes the storage root.");
        }

        return path;
    }

    private void EnsureFreeSpace()
    {
        var root = Path.GetPathRoot(RootDirectory)
            ?? throw new InvalidOperationException("Attachment root has no drive root.");
        var available = new DriveInfo(root).AvailableFreeSpace;
        if (available < _options.MinimumFreeSpaceBytes + _options.MaximumFileSizeBytes)
        {
            throw new AttachmentStorageFullException();
        }
    }

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}

public sealed class AttachmentStorageFullException : IOException;
