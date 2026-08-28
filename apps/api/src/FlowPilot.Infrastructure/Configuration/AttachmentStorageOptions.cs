namespace FlowPilot.Infrastructure.Configuration;

public sealed record AttachmentStorageOptions(
    string RootDirectory,
    long MaximumFileSizeBytes,
    long MinimumFreeSpaceBytes);
