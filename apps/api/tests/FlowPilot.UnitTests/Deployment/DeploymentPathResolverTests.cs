using FlowPilot.Infrastructure.Deployment;

namespace FlowPilot.UnitTests.Deployment;

public sealed class DeploymentPathResolverTests
{
    [Fact]
    public void Resolve_FindsMarkerFromCurrentJunctionStylePath()
    {
        using var tree = new TemporaryDeploymentTree();
        var releaseDirectory = tree.CreateDirectory("App", "releases", "2026.08.26.1");
        var currentDirectory = tree.CreateDirectory("App", "current");
        var apiDirectory = tree.CreateDirectory("App", "current", "api");
        tree.CreateMarker();
        var fileSystem = new LinkTargetDeploymentFileSystem(
            currentDirectory,
            releaseDirectory);

        var paths = new DeploymentPathResolver(fileSystem).Resolve(apiDirectory);

        Assert.Equal(tree.Root, paths.DeploymentRootDirectory);
        Assert.Equal(apiDirectory, paths.ApiBaseDirectory);
        Assert.Equal(Path.Combine(tree.Root, "App"), paths.AppDirectory);
    }

    [Fact]
    public void Resolve_FindsMarkerFromResolvedReleasePath()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "releases", "2026.08.26.1", "api");
        tree.CreateMarker();

        var paths = new DeploymentPathResolver().Resolve(apiDirectory);

        Assert.Equal(tree.Root, paths.DeploymentRootDirectory);
        Assert.Equal(apiDirectory, paths.ApiBaseDirectory);
    }

    [Fact]
    public void Resolve_AcceptsMarkerInSixthInspectedDirectory()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory(
            "App",
            "releases",
            "2026.08.26.1",
            "api",
            "nested");
        tree.CreateMarker();

        var paths = new DeploymentPathResolver().Resolve(apiDirectory);

        Assert.Equal(tree.Root, paths.DeploymentRootDirectory);
    }

    [Fact]
    public void Resolve_RejectsMarkerBeyondSixInspectedDirectories()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory(
            "App",
            "releases",
            "2026.08.26.1",
            "api",
            "nested",
            "deeper");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.MarkerNotFound, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsMissingMarker()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "releases", "2026.08.26.1", "api");

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.MarkerNotFound, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsMultipleMarkersWithinSearchBoundary()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "releases", "2026.08.26.1", "api");
        tree.CreateMarker();
        File.WriteAllText(Path.Combine(tree.Root, "App", DeploymentPathResolver.RootMarkerFileName), string.Empty);

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.MultipleMarkersFound, exception.Failure);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Resolve_RejectsEmptyStartPath(string startDirectory)
    {
        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(startDirectory));

        Assert.Equal(DeploymentPathFailure.StartPathInvalid, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsRelativeStartPath()
    {
        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(Path.Combine("App", "current", "api")));

        Assert.Equal(DeploymentPathFailure.StartPathNotAbsolute, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsMissingStartDirectory()
    {
        using var tree = new TemporaryDeploymentTree();
        var missingDirectory = Path.Combine(tree.Root, "App", "current", "api");

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(missingDirectory));

        Assert.Equal(DeploymentPathFailure.StartDirectoryNotFound, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsFileSystemRootAsDeploymentRoot()
    {
        var fileSystemRoot = Path.GetPathRoot(Path.GetFullPath(Path.DirectorySeparatorChar.ToString()))!;
        var fileSystem = new PredicateDeploymentFileSystem(
            directoryExists: path => path == fileSystemRoot,
            fileExists: path => path == Path.Combine(fileSystemRoot, DeploymentPathResolver.RootMarkerFileName));

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver(fileSystem).Resolve(fileSystemRoot));

        Assert.Equal(DeploymentPathFailure.DeploymentRootIsFileSystemRoot, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsApiOutsideAppBoundary()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("ApiOutsideApp");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideAppDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_DoesNotTreatSiblingPathPrefixAsInsideApp()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("Application", "api");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideAppDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsAppDirectoryItselfAsApiBase()
    {
        using var tree = new TemporaryDeploymentTree();
        var appDirectory = tree.CreateDirectory("App");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(appDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideAppDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsApiInAppButOutsideReleaseBoundary()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "staging", "api");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideReleaseDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsStableDirectoryThatIsNotALink()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "current", "api");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideReleaseDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsStableLinkTargetOutsideReleases()
    {
        using var tree = new TemporaryDeploymentTree();
        var escapedReleaseDirectory = tree.CreateDirectory("EscapedRelease");
        var currentDirectory = tree.CreateDirectory("App", "current");
        var apiDirectory = tree.CreateDirectory("App", "current", "api");
        tree.CreateMarker();
        var fileSystem = new LinkTargetDeploymentFileSystem(
            currentDirectory,
            escapedReleaseDirectory);

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver(fileSystem).Resolve(apiDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideReleaseDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_RejectsReleaseDirectoryOutsideItsApiFolder()
    {
        using var tree = new TemporaryDeploymentTree();
        var toolsDirectory = tree.CreateDirectory(
            "App",
            "releases",
            "2026.08.26.1",
            "tools");
        tree.CreateMarker();

        var exception = Assert.Throws<DeploymentPathException>(
            () => new DeploymentPathResolver().Resolve(toolsDirectory));

        Assert.Equal(DeploymentPathFailure.ApiOutsideReleaseDirectory, exception.Failure);
    }

    [Fact]
    public void Resolve_ReturnsCanonicalPersistentAndConfigurationPaths()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "releases", "2026.08.26.1", "api");
        tree.CreateMarker();

        var paths = new DeploymentPathResolver().Resolve(
            Path.Combine(apiDirectory, ".", string.Empty));

        Assert.Equal(Path.Combine(tree.Root, "Config"), paths.ConfigDirectory);
        Assert.Equal(Path.Combine(tree.Root, "Secrets"), paths.SecretsDirectory);
        Assert.Equal(Path.Combine(tree.Root, "App", "releases"), paths.ReleasesDirectory);
        Assert.Equal(
            Path.Combine(tree.Root, "Config", "appsettings.Production.json"),
            paths.ProductionConfigurationFile);
        Assert.Equal(
            Path.Combine(tree.Root, "Secrets", "secrets.Production.json"),
            paths.ProductionSecretsFile);
        Assert.Equal(Path.Combine(tree.Root, "Data", "Attachments"), paths.AttachmentsDirectory);
        Assert.Equal(Path.Combine(tree.Root, "Logs"), paths.LogsDirectory);
        Assert.Equal(Path.Combine(tree.Root, "Temp"), paths.TempDirectory);
        Assert.Equal(Path.Combine(tree.Root, "Backup"), paths.BackupDirectory);
        Assert.All(
            new[]
            {
                paths.DeploymentRootDirectory,
                paths.ApiBaseDirectory,
                paths.AppDirectory,
                paths.ReleasesDirectory,
                paths.ConfigDirectory,
                paths.SecretsDirectory,
                paths.DataDirectory,
                paths.AttachmentsDirectory,
                paths.LogsDirectory,
                paths.TempDirectory,
                paths.BackupDirectory,
                paths.ProductionConfigurationFile,
                paths.ProductionSecretsFile,
            },
            path => Assert.True(Path.IsPathFullyQualified(path)));
    }

    [Fact]
    public void Resolve_IgnoresLegacyPathOverrideEnvironmentVariables()
    {
        using var tree = new TemporaryDeploymentTree();
        var apiDirectory = tree.CreateDirectory("App", "releases", "2026.08.26.1", "api");
        tree.CreateMarker();
        var unrelatedRoot = tree.CreateDirectory("unrelated");
        var previousHome = Environment.GetEnvironmentVariable("FLOWPILOT_HOME");
        var previousConfig = Environment.GetEnvironmentVariable("FLOWPILOT_CONFIG_FILE");
        var previousSecrets = Environment.GetEnvironmentVariable("FLOWPILOT_SECRETS_FILE");

        try
        {
            Environment.SetEnvironmentVariable("FLOWPILOT_HOME", unrelatedRoot);
            Environment.SetEnvironmentVariable("FLOWPILOT_CONFIG_FILE", Path.Combine(unrelatedRoot, "config.json"));
            Environment.SetEnvironmentVariable("FLOWPILOT_SECRETS_FILE", Path.Combine(unrelatedRoot, "secrets.json"));

            var paths = new DeploymentPathResolver().Resolve(apiDirectory);

            Assert.Equal(tree.Root, paths.DeploymentRootDirectory);
            Assert.Equal(
                Path.Combine(tree.Root, "Config", "appsettings.Production.json"),
                paths.ProductionConfigurationFile);
            Assert.Equal(
                Path.Combine(tree.Root, "Secrets", "secrets.Production.json"),
                paths.ProductionSecretsFile);
        }
        finally
        {
            Environment.SetEnvironmentVariable("FLOWPILOT_HOME", previousHome);
            Environment.SetEnvironmentVariable("FLOWPILOT_CONFIG_FILE", previousConfig);
            Environment.SetEnvironmentVariable("FLOWPILOT_SECRETS_FILE", previousSecrets);
        }
    }

    private sealed class TemporaryDeploymentTree : IDisposable
    {
        public TemporaryDeploymentTree()
        {
            Root = Path.Combine(Path.GetTempPath(), $"flowpilot-deployment-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Root);
        }

        public string Root { get; }

        public string CreateDirectory(params string[] segments)
        {
            var path = segments.Aggregate(Root, Path.Combine);
            Directory.CreateDirectory(path);
            return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        }

        public void CreateMarker() =>
            File.WriteAllText(Path.Combine(Root, DeploymentPathResolver.RootMarkerFileName), string.Empty);

        public void Dispose()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
    }

    private sealed class PredicateDeploymentFileSystem(
        Func<string, bool> directoryExists,
        Func<string, bool> fileExists) : IDeploymentFileSystem
    {
        public bool DirectoryExists(string path) => directoryExists(path);

        public bool FileExists(string path) => fileExists(path);

        public string? ResolveDirectoryLinkTarget(string path) => null;
    }

    private sealed class LinkTargetDeploymentFileSystem(
        string linkDirectory,
        string targetDirectory) : IDeploymentFileSystem
    {
        private readonly string _linkDirectory = Path.GetFullPath(linkDirectory);
        private readonly string _targetDirectory = Path.GetFullPath(targetDirectory);

        public bool DirectoryExists(string path) => Directory.Exists(path);

        public bool FileExists(string path) => File.Exists(path);

        public string? ResolveDirectoryLinkTarget(string path) =>
            string.Equals(
                Path.GetFullPath(path),
                _linkDirectory,
                OperatingSystem.IsWindows()
                    ? StringComparison.OrdinalIgnoreCase
                    : StringComparison.Ordinal)
                ? _targetDirectory
                : null;
    }
}
