using System.Diagnostics.CodeAnalysis;

namespace FlowPilot.Infrastructure.Deployment;

public sealed class DeploymentPathResolver : IDeploymentPathResolver
{
    public const string RootMarkerFileName = "flowpilot.root";
    public const int MaximumDirectoriesToInspect = 6;

    private readonly IDeploymentFileSystem _fileSystem;

    public DeploymentPathResolver()
        : this(PhysicalDeploymentFileSystem.Instance)
    {
    }

    public DeploymentPathResolver(IDeploymentFileSystem fileSystem)
    {
        ArgumentNullException.ThrowIfNull(fileSystem);
        _fileSystem = fileSystem;
    }

    public DeploymentPaths Resolve() => Resolve(AppContext.BaseDirectory);

    public DeploymentPaths Resolve(string startDirectory)
    {
        var normalizedStartDirectory = NormalizeAndValidateStartDirectory(startDirectory);
        var markers = FindMarkers(normalizedStartDirectory);

        if (markers.Count == 0)
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.MarkerNotFound,
                $"No {RootMarkerFileName} marker was found within the deployment search boundary.");
        }

        if (markers.Count > 1)
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.MultipleMarkersFound,
                $"More than one {RootMarkerFileName} marker was found within the deployment search boundary.");
        }

        var deploymentRootDirectory = markers[0];
        if (IsFileSystemRoot(deploymentRootDirectory))
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.DeploymentRootIsFileSystemRoot,
                "The FlowPilot deployment root cannot be a file-system root directory.");
        }

        var appDirectory = Path.Combine(deploymentRootDirectory, "App");
        if (!IsStrictDescendant(appDirectory, normalizedStartDirectory))
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.ApiOutsideAppDirectory,
                "The FlowPilot API base directory must be inside the deployment root App directory.");
        }

        ValidateReleaseBoundary(appDirectory, normalizedStartDirectory);

        return new DeploymentPaths(deploymentRootDirectory, normalizedStartDirectory);
    }

    private void ValidateReleaseBoundary(string appDirectory, string apiBaseDirectory)
    {
        var releasesDirectory = Path.Combine(appDirectory, "releases");
        if (IsWithinReleaseApiDirectory(releasesDirectory, apiBaseDirectory))
        {
            return;
        }

        var stablePathSegments = GetDescendantSegments(appDirectory, apiBaseDirectory);
        if (stablePathSegments.Length < 2
            || !IsStableReleaseLinkName(stablePathSegments[0])
            || !PathSegmentEquals(stablePathSegments[1], "api"))
        {
            ThrowApiOutsideReleaseDirectory();
        }

        var stableLinkDirectory = Path.Combine(appDirectory, stablePathSegments[0]);
        var linkTarget = _fileSystem.ResolveDirectoryLinkTarget(stableLinkDirectory);
        if (string.IsNullOrWhiteSpace(linkTarget) || !Path.IsPathFullyQualified(linkTarget))
        {
            ThrowApiOutsideReleaseDirectory();
        }

        var normalizedLinkTarget = NormalizeDirectory(linkTarget);
        var releaseTargetSegments = GetDescendantSegments(releasesDirectory, normalizedLinkTarget);
        if (releaseTargetSegments.Length != 1)
        {
            ThrowApiOutsideReleaseDirectory();
        }

        var resolvedApiBaseDirectory = stablePathSegments
            .Skip(1)
            .Aggregate(normalizedLinkTarget, Path.Combine);
        if (!IsWithinReleaseApiDirectory(releasesDirectory, resolvedApiBaseDirectory))
        {
            ThrowApiOutsideReleaseDirectory();
        }
    }

    private static bool IsWithinReleaseApiDirectory(
        string releasesDirectory,
        string candidateDirectory)
    {
        var segments = GetDescendantSegments(releasesDirectory, candidateDirectory);
        return segments.Length >= 2 && PathSegmentEquals(segments[1], "api");
    }

    private static bool IsStableReleaseLinkName(string segment) =>
        PathSegmentEquals(segment, "current") || PathSegmentEquals(segment, "previous");

    private static string[] GetDescendantSegments(string parentDirectory, string candidateDirectory)
    {
        var normalizedParent = NormalizeDirectory(parentDirectory);
        var normalizedCandidate = NormalizeDirectory(candidateDirectory);
        var relative = Path.GetRelativePath(normalizedParent, normalizedCandidate);

        if (string.Equals(relative, ".", StringComparison.Ordinal)
            || Path.IsPathRooted(relative)
            || string.Equals(relative, "..", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            return [];
        }

        return relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
    }

    private static bool PathSegmentEquals(string left, string right) =>
        string.Equals(left, right, PathComparison);

    [DoesNotReturn]
    private static void ThrowApiOutsideReleaseDirectory()
    {
        throw new DeploymentPathException(
            DeploymentPathFailure.ApiOutsideReleaseDirectory,
            "The FlowPilot API base directory must be inside App/releases or a valid current/previous directory link targeting App/releases.");
    }

    private string NormalizeAndValidateStartDirectory(string startDirectory)
    {
        if (string.IsNullOrWhiteSpace(startDirectory))
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.StartPathInvalid,
                "The API base directory is required.");
        }

        if (!Path.IsPathFullyQualified(startDirectory))
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.StartPathNotAbsolute,
                "The API base directory must be an absolute path.");
        }

        string normalized;
        try
        {
            normalized = NormalizeDirectory(startDirectory);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.StartPathInvalid,
                "The API base directory is not a valid path.");
        }

        if (!_fileSystem.DirectoryExists(normalized))
        {
            throw new DeploymentPathException(
                DeploymentPathFailure.StartDirectoryNotFound,
                "The API base directory does not exist.");
        }

        return normalized;
    }

    private List<string> FindMarkers(string startDirectory)
    {
        var markers = new List<string>(capacity: 1);
        DirectoryInfo? current = new(startDirectory);

        for (var inspected = 0;
             current is not null && inspected < MaximumDirectoriesToInspect;
             inspected++, current = current.Parent)
        {
            var directory = NormalizeDirectory(current.FullName);
            if (_fileSystem.FileExists(Path.Combine(directory, RootMarkerFileName)))
            {
                markers.Add(directory);
            }
        }

        return markers;
    }

    private static bool IsFileSystemRoot(string directory)
    {
        var root = Path.GetPathRoot(directory);
        return root is not null
            && string.Equals(
                NormalizeDirectory(root),
                NormalizeDirectory(directory),
                PathComparison);
    }

    private static bool IsStrictDescendant(string parentDirectory, string candidateDirectory)
    {
        var normalizedParent = NormalizeDirectory(parentDirectory);
        var normalizedCandidate = NormalizeDirectory(candidateDirectory);
        var relative = Path.GetRelativePath(normalizedParent, normalizedCandidate);

        if (string.Equals(relative, ".", StringComparison.Ordinal))
        {
            return false;
        }

        return !Path.IsPathRooted(relative)
            && !string.Equals(relative, "..", StringComparison.Ordinal)
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal);
    }

    private static string NormalizeDirectory(string path) =>
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}
