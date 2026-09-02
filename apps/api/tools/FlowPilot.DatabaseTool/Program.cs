using FlowPilot.Application.Health;
using FlowPilot.Database.Migrations;
using FlowPilot.Database.Seeding;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Health;
using FlowPilot.Infrastructure.Persistence;
using FlowPilot.Infrastructure.Persistence.Schema;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

return await RunAsync(args).ConfigureAwait(false);

static async Task<int> RunAsync(string[] arguments)
{
    var parsedArguments = ToolArguments.Parse(arguments);
    if (parsedArguments.ShowHelp)
    {
        WriteHelp();
        return 0;
    }

    if (parsedArguments.ErrorCode is not null)
    {
        WriteError(parsedArguments.ErrorCode, "命令参数无效。请使用 --help 查看用法。");
        return 2;
    }

    IConfiguration configuration;
    try
    {
        var configurationFiles = DevelopmentConfigurationLocator.Find();
        configuration = DatabaseToolConfigurationLoader.Load(
            configurationFiles,
            parsedArguments.ConfigurationValues);
    }
    catch (DatabaseToolConfigurationException exception)
    {
        WriteError(
            $"DATABASE_CONFIGURATION_{ToUpperSnakeCase(exception.Failure.ToString())}",
            DescribeConfigurationFailure(exception.Failure));
        return 2;
    }

    FlowPilotDatabaseOptions databaseOptions;
    try
    {
        databaseOptions = FlowPilotDatabaseOptions.FromConfiguration(configuration);
    }
    catch (FlowPilotDatabaseOptionsConfigurationException exception)
    {
        WriteError(
            "DATABASE_CONFIGURATION_INVALID_DATABASE_OPTION",
            $"数据库命令超时配置无效：{exception.ConfigurationKey} 必须是 1 到 {FlowPilotDatabaseOptions.MaximumCommandTimeoutSeconds} 之间的整数秒数。");
        return 2;
    }

    using var cancellation = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cancellation.Cancel();
    };

    try
    {
        return parsedArguments.Command switch
        {
            DatabaseToolCommand.Initialize => await InitializeAsync(
                    configuration,
                    databaseOptions,
                    cancellation.Token)
                .ConfigureAwait(false),
            DatabaseToolCommand.Seed => await SeedAsync(
                    configuration,
                    databaseOptions,
                    cancellation.Token)
                .ConfigureAwait(false),
            DatabaseToolCommand.Verify => await VerifyAsync(
                    configuration,
                    databaseOptions,
                    cancellation.Token)
                .ConfigureAwait(false),
            DatabaseToolCommand.PrepareBrowserTests => await PrepareBrowserTestsAsync(
                    configuration,
                    databaseOptions,
                    cancellation.Token)
                .ConfigureAwait(false),
            DatabaseToolCommand.CleanupBrowserTests => await CleanupBrowserTestsAsync(
                    configuration,
                    databaseOptions,
                    cancellation.Token)
                .ConfigureAwait(false),
            _ => 2,
        };
    }
    catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
    {
        WriteError("DATABASE_OPERATION_CANCELLED", "数据库操作已取消。");
        return 130;
    }
}

static async Task<int> PrepareBrowserTestsAsync(
    IConfiguration configuration,
    FlowPilotDatabaseOptions databaseOptions,
    CancellationToken cancellationToken)
{
    try
    {
        var manager = new BrowserTestDatabaseManager(configuration, databaseOptions);
        await manager.PrepareAsync(cancellationToken).ConfigureAwait(false);
        var database = BrowserTestDatabaseConnectionStrings.FromConfiguration(configuration);
        Console.WriteLine($"浏览器测试数据库已准备：{database.DatabaseName}。");
        return 0;
    }
    catch (Exception exception) when (exception is SqlException or InvalidOperationException)
    {
        WriteError("BROWSER_TEST_DATABASE_PREPARE_FAILED", exception.Message);
        return 3;
    }
}

static async Task<int> CleanupBrowserTestsAsync(
    IConfiguration configuration,
    FlowPilotDatabaseOptions databaseOptions,
    CancellationToken cancellationToken)
{
    try
    {
        var manager = new BrowserTestDatabaseManager(configuration, databaseOptions);
        await manager.DropAsync(cancellationToken).ConfigureAwait(false);
        Console.WriteLine("浏览器测试数据库已清理。");
        return 0;
    }
    catch (Exception exception) when (exception is SqlException or InvalidOperationException)
    {
        WriteError("BROWSER_TEST_DATABASE_CLEANUP_FAILED", exception.Message);
        return 3;
    }
}

static async Task<int> InitializeAsync(
    IConfiguration configuration,
    FlowPilotDatabaseOptions databaseOptions,
    CancellationToken cancellationToken)
{
    var request = new DatabaseMigrationRequest(
        configuration.GetConnectionString("FlowPilotMigration"),
        configuration["FlowPilot:Database:ExpectedCollation"],
        typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.1.0");

    try
    {
        var result = await new SqlServerDatabaseMigrator(databaseOptions)
            .ApplyAsync(request, cancellationToken)
            .ConfigureAwait(false);

        if (result.Outcome == DatabaseMigrationOutcome.Applied)
        {
            Console.WriteLine(
                $"数据库结构已初始化：版本 {result.SchemaVersion}，应用迁移 {result.AppliedMigrationCount} 个。");
        }
        else
        {
            Console.WriteLine($"数据库结构已经是当前版本：{result.SchemaVersion}。");
        }

        return 0;
    }
    catch (DatabaseMigrationException exception)
    {
        var diagnostic = DescribeMigrationDiagnostic(exception);
        WriteError(
            $"DATABASE_MIGRATION_{ToUpperSnakeCase(exception.Failure.ToString())}",
            diagnostic is null
                ? DescribeMigrationFailure(exception.Failure)
                : $"{DescribeMigrationFailure(exception.Failure)} {diagnostic}");
        return 3;
    }
}

static async Task<int> SeedAsync(
    IConfiguration configuration,
    FlowPilotDatabaseOptions databaseOptions,
    CancellationToken cancellationToken)
{
    try
    {
        var result = await SqlServerBuiltinSeeder.SeedAsync(
                configuration.GetConnectionString("FlowPilotMigration"),
                configuration["FlowPilot:Bootstrap:SuperAdminPassword"],
                databaseOptions.MigrationCommandTimeoutSeconds,
                cancellationToken)
            .ConfigureAwait(false);

        if (result.Outcome == BuiltinSeedOutcome.Applied)
        {
            Console.WriteLine(
                $"数据库内置数据已初始化：版本 {result.SeedVersion}，权限 {result.PermissionCount} 项。" +
                (result.SuperAdminCreated ? " 已创建超级管理员账号。" : string.Empty));
        }
        else
        {
            Console.WriteLine($"数据库内置数据已经是当前版本：{result.SeedVersion}。");
        }

        return 0;
    }
    catch (BuiltinSeedException exception)
    {
        var diagnostic = exception.InnerException is SqlException sqlException
            ? $" SQL 错误号 {sqlException.Number}，状态 {sqlException.State}，行 {sqlException.LineNumber}。"
            : string.Empty;
        WriteError(
            $"DATABASE_SEED_{ToUpperSnakeCase(exception.Failure.ToString())}",
            DescribeSeedFailure(exception.Failure) + diagnostic);
        return 3;
    }
}

static string? DescribeMigrationDiagnostic(DatabaseMigrationException exception)
{
    if (exception.Failure is not (
        DatabaseMigrationFailure.MigrationExecutionFailed or
        DatabaseMigrationFailure.SchemaStructureMismatch))
    {
        return null;
    }

    return exception.InnerException switch
    {
        SqlException sqlException =>
            $"SQL 错误号 {sqlException.Number}，状态 {sqlException.State}，行 {sqlException.LineNumber}。",
        InvalidOperationException invalidOperationException =>
            exception.Failure == DatabaseMigrationFailure.SchemaStructureMismatch
                ? $"结构差异：{invalidOperationException.Message}"
                : $"内部阶段：{invalidOperationException.GetType().Name}；{invalidOperationException.Message}",
        _ => null,
    };
}

static async Task<int> VerifyAsync(
    IConfiguration configuration,
    FlowPilotDatabaseOptions databaseOptions,
    CancellationToken cancellationToken)
{
    var connectionString = configuration.GetConnectionString("FlowPilot");
    var requiredSchemaVersion = DatabaseSchemaVersion.Current;
    var expectedCollation = databaseOptions.ExpectedCollation;

    if (string.IsNullOrWhiteSpace(connectionString) ||
        string.IsNullOrWhiteSpace(expectedCollation))
    {
        WriteError(
            DatabaseReadinessCodes.ConfigurationMissing,
            "缺少运行连接字符串或预期排序规则。");
        return 2;
    }

    if (!DatabaseToolConnectionStringValidator.IsValid(connectionString))
    {
        WriteError(
            "DATABASE_CONFIGURATION_INVALID_CONNECTION_STRING",
            "运行连接字符串格式无效，或未明确指定数据库名。");
        return 2;
    }

    var options = new DbContextOptionsBuilder<FlowPilotDbContext>()
        .UseSqlServer(
            connectionString,
            sqlServerOptions => sqlServerOptions
                .UseCompatibilityLevel(FlowPilotDbContext.SqlServerCompatibilityLevel)
                .CommandTimeout(databaseOptions.ApplicationCommandTimeoutSeconds))
        .Options;

    await using var context = new FlowPilotDbContext(options);
    var schemaStructureProbe = new SqlServerSchemaStructureProbe(databaseOptions);
    var reader = new SqlServerReadinessSnapshotReader(
        context,
        schemaStructureProbe,
        databaseOptions);
    var check = new SqlServerDatabaseReadinessCheck(
        reader,
        new DatabaseReadinessRequirements(expectedCollation));
    var result = await check.CheckAsync(cancellationToken).ConfigureAwait(false);

    if (!result.IsReady)
    {
        WriteError(result.Code, "运行账号连接或数据库结构检查未通过。");
        return 3;
    }

    Console.WriteLine($"数据库连接与结构检查通过：版本 {requiredSchemaVersion}。");
    return 0;
}

static string DescribeMigrationFailure(DatabaseMigrationFailure failure) => failure switch
{
    DatabaseMigrationFailure.InvalidConnectionString => "迁移连接字符串缺失或格式无效。",
    DatabaseMigrationFailure.DatabaseNameMissing => "迁移连接字符串必须明确指定数据库名。",
    DatabaseMigrationFailure.SystemDatabaseNotAllowed => "禁止在 SQL Server 系统数据库中执行初始化。",
    DatabaseMigrationFailure.DatabaseNameMismatch => "连接后的数据库与连接字符串指定名称不一致。",
    DatabaseMigrationFailure.ExpectedCollationMissing => "缺少预期数据库排序规则。",
    DatabaseMigrationFailure.DatabaseUnavailable => "无法连接数据库或读取数据库元数据。",
    DatabaseMigrationFailure.ServerVersionUnsupported => "SQL Server 版本不受支持。",
    DatabaseMigrationFailure.CompatibilityLevelUnsupported => "数据库兼容级别低于 130。",
    DatabaseMigrationFailure.CollationMismatch => "数据库排序规则与配置不一致。",
    DatabaseMigrationFailure.MigrationLockUnavailable => "另一个数据库初始化正在执行，请稍后重试。",
    DatabaseMigrationFailure.MigrationChecksumMismatch => "已执行迁移的校验和与当前代码不一致。",
    DatabaseMigrationFailure.UnknownMigration => "数据库包含当前代码无法识别的迁移版本。",
    DatabaseMigrationFailure.MigrationNotSucceeded => "数据库迁移账本包含未成功的迁移。",
    DatabaseMigrationFailure.SchemaStructureMismatch => "数据库实际结构与当前版本清单不一致。",
    DatabaseMigrationFailure.DatabaseStateUnknown => "数据库不是可初始化的空库，或现有结构不完整。",
    DatabaseMigrationFailure.MigrationCatalogInvalid => "程序内置迁移目录无效。",
    DatabaseMigrationFailure.MigrationExecutionFailed => "数据库结构初始化失败，事务已回滚。",
    _ => "数据库初始化输入或状态无效。",
};

static string DescribeSeedFailure(BuiltinSeedFailure failure) => failure switch
{
    BuiltinSeedFailure.InvalidConnectionString => "迁移连接字符串缺失或格式无效。",
    BuiltinSeedFailure.DatabaseNameMissing => "迁移连接字符串必须明确指定数据库名。",
    BuiltinSeedFailure.SystemDatabaseNotAllowed => "禁止在 SQL Server 系统数据库中写入内置数据。",
    BuiltinSeedFailure.DatabaseUnavailable => "无法连接数据库。",
    BuiltinSeedFailure.SchemaNotReady => "数据库结构尚未初始化到当前版本，请先执行 pnpm db:init。",
    BuiltinSeedFailure.SeedLockUnavailable => "另一个内置数据初始化正在执行，请稍后重试。",
    BuiltinSeedFailure.InitialPasswordMissing =>
        "首次创建超级管理员前，请在本地配置中填写 FlowPilot:Bootstrap:SuperAdminPassword。",
    BuiltinSeedFailure.InitialPasswordInvalid => "超级管理员初始密码必须为 1 到 200 个字符，且不能保留示例占位值。",
    BuiltinSeedFailure.DataConflict => "数据库中存在与固定内置账号、角色或目录冲突的记录，事务已回滚。",
    BuiltinSeedFailure.SeedExecutionFailed => "内置数据初始化失败，事务已回滚。",
    _ => "内置数据初始化失败。",
};

static string DescribeConfigurationFailure(DatabaseToolConfigurationFailure failure) => failure switch
{
    DatabaseToolConfigurationFailure.RepositoryRootNotFound => "未找到 FlowPilot 后端工程根目录。",
    DatabaseToolConfigurationFailure.DefaultConfigurationMissing => "缺少 API 默认配置文件。",
    DatabaseToolConfigurationFailure.LocalConfigurationMissing =>
        "缺少本地调试配置文件。请先复制仓库中的本地配置示例。",
    DatabaseToolConfigurationFailure.ConfigurationFileInvalid =>
        "默认配置或本地调试配置不是有效的 JSON。请检查文件语法。",
    _ => "数据库工具配置无效。",
};

static string ToUpperSnakeCase(string value)
{
    var characters = new List<char>(value.Length + 8);
    for (var index = 0; index < value.Length; index++)
    {
        var character = value[index];
        if (index > 0 && char.IsUpper(character))
        {
            characters.Add('_');
        }

        characters.Add(char.ToUpperInvariant(character));
    }

    return new string([.. characters]);
}

static void WriteHelp()
{
    Console.WriteLine("FlowPilot 数据库工具");
    Console.WriteLine();
    Console.WriteLine("用法:");
    Console.WriteLine("  initialize [--Key=Value ...]  初始化或升级现有数据库结构");
    Console.WriteLine("  seed       [--Key=Value ...]  初始化或同步内置数据");
    Console.WriteLine("  verify     [--Key=Value ...]  使用运行账号验证连接与结构");
    Console.WriteLine("  prepare-browser-tests          重建并初始化隔离的浏览器测试数据库");
    Console.WriteLine("  cleanup-browser-tests          删除隔离的浏览器测试数据库");
    Console.WriteLine();
    Console.WriteLine("固定读取 API 默认配置与 apps/api/config/appsettings.Development.local.json。");
}

static void WriteError(string code, string message) =>
    Console.Error.WriteLine($"{code}: {message}");

internal enum DatabaseToolCommand
{
    None,
    Initialize,
    Seed,
    Verify,
    PrepareBrowserTests,
    CleanupBrowserTests,
}

internal sealed record ToolArguments(
    DatabaseToolCommand Command,
    IReadOnlyDictionary<string, string?> ConfigurationValues,
    bool ShowHelp,
    string? ErrorCode)
{
    public static ToolArguments Parse(string[] arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        if (arguments.Length == 0 || arguments is ["--help"] or ["-h"])
        {
            return new ToolArguments(DatabaseToolCommand.None, EmptyConfigurationValues(), ShowHelp: true, null);
        }

        var command = arguments[0] switch
        {
            "initialize" => DatabaseToolCommand.Initialize,
            "seed" => DatabaseToolCommand.Seed,
            "verify" => DatabaseToolCommand.Verify,
            "prepare-browser-tests" => DatabaseToolCommand.PrepareBrowserTests,
            "cleanup-browser-tests" => DatabaseToolCommand.CleanupBrowserTests,
            _ => DatabaseToolCommand.None,
        };
        if (command == DatabaseToolCommand.None)
        {
            return new ToolArguments(
                command,
                EmptyConfigurationValues(),
                ShowHelp: false,
                "DATABASE_COMMAND_INVALID");
        }

        var configurationValues = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < arguments.Length; index++)
        {
            var argument = arguments[index];
            var equalsIndex = argument.IndexOf('=', StringComparison.Ordinal);
            if (!argument.StartsWith("--", StringComparison.Ordinal) || equalsIndex <= 2)
            {
                return InvalidArguments(command);
            }

            var key = argument[2..equalsIndex];
            if (string.IsNullOrWhiteSpace(key) ||
                string.Equals(key, "configuration", StringComparison.OrdinalIgnoreCase))
            {
                return InvalidArguments(command);
            }

            configurationValues[key] = argument[(equalsIndex + 1)..];
        }

        return new ToolArguments(command, configurationValues, ShowHelp: false, null);
    }

    private static ToolArguments InvalidArguments(DatabaseToolCommand command) =>
        new(command, EmptyConfigurationValues(), ShowHelp: false, "DATABASE_ARGUMENT_INVALID");

    private static Dictionary<string, string?> EmptyConfigurationValues() =>
        new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
}

internal static class DevelopmentConfigurationLocator
{
    public static DatabaseToolConfigurationFiles Find() =>
        FindFromApplicationBaseDirectory(AppContext.BaseDirectory);

    internal static DatabaseToolConfigurationFiles FindFromApplicationBaseDirectory(
        string applicationBaseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationBaseDirectory);

        var normalizedApplicationBaseDirectory = Path.GetFullPath(applicationBaseDirectory);
        var directory = new DirectoryInfo(normalizedApplicationBaseDirectory);
        for (var depth = 0; directory is not null && depth <= 8; depth++, directory = directory.Parent)
        {
            if (IsExpectedApiRoot(directory.FullName, normalizedApplicationBaseDirectory))
            {
                return CreateConfigurationFiles(directory.FullName);
            }

            var repositoryApiRoot = Path.Combine(directory.FullName, "apps", "api");
            if (IsExpectedApiRoot(repositoryApiRoot, normalizedApplicationBaseDirectory))
            {
                return CreateConfigurationFiles(repositoryApiRoot);
            }
        }

        throw new DatabaseToolConfigurationException(
            DatabaseToolConfigurationFailure.RepositoryRootNotFound);
    }

    private static bool IsExpectedApiRoot(
        string apiRoot,
        string normalizedApplicationBaseDirectory)
    {
        var toolProjectRoot = Path.Combine(apiRoot, "tools", "FlowPilot.DatabaseTool");
        return File.Exists(Path.Combine(apiRoot, "FlowPilot.slnx")) &&
            File.Exists(Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json")) &&
            Directory.Exists(Path.Combine(apiRoot, "config")) &&
            Directory.Exists(toolProjectRoot) &&
            IsWithin(toolProjectRoot, normalizedApplicationBaseDirectory);
    }

    private static bool IsWithin(string expectedParent, string candidate)
    {
        var relativePath = Path.GetRelativePath(
            Path.GetFullPath(expectedParent),
            Path.GetFullPath(candidate));
        return string.Equals(relativePath, ".", StringComparison.Ordinal) ||
            (!Path.IsPathRooted(relativePath) &&
             !string.Equals(relativePath, "..", StringComparison.Ordinal) &&
             !relativePath.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) &&
             !relativePath.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal));
    }

    private static DatabaseToolConfigurationFiles CreateConfigurationFiles(string apiRoot) =>
        new(
            Path.Combine(apiRoot, "src", "FlowPilot.Api", "appsettings.json"),
            Path.Combine(apiRoot, "config", "appsettings.Development.local.json"));
}

internal sealed record DatabaseToolConfigurationFiles(
    string DefaultConfigurationFile,
    string LocalConfigurationFile);

internal enum DatabaseToolConfigurationFailure
{
    RepositoryRootNotFound,
    DefaultConfigurationMissing,
    LocalConfigurationMissing,
    ConfigurationFileInvalid,
}

internal sealed class DatabaseToolConfigurationException : InvalidOperationException
{
    public DatabaseToolConfigurationException(DatabaseToolConfigurationFailure failure)
        : base($"Database tool configuration failed ({failure}).")
    {
        Failure = failure;
    }

    public DatabaseToolConfigurationFailure Failure { get; }
}

internal static class DatabaseToolConfigurationLoader
{
    public static IConfiguration Load(
        DatabaseToolConfigurationFiles files,
        IReadOnlyDictionary<string, string?> commandLineValues)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(commandLineValues);

        RequireFile(
            files.DefaultConfigurationFile,
            DatabaseToolConfigurationFailure.DefaultConfigurationMissing);
        RequireFile(
            files.LocalConfigurationFile,
            DatabaseToolConfigurationFailure.LocalConfigurationMissing);

        var configuration = new ConfigurationManager();
        try
        {
            configuration
                .AddJsonFile(files.DefaultConfigurationFile, optional: false, reloadOnChange: false)
                .AddJsonFile(files.LocalConfigurationFile, optional: false, reloadOnChange: false)
                .AddEnvironmentVariables()
                .AddInMemoryCollection(commandLineValues);
        }
        catch (Exception exception) when (exception is InvalidDataException or FormatException)
        {
            throw new DatabaseToolConfigurationException(
                DatabaseToolConfigurationFailure.ConfigurationFileInvalid);
        }

        return configuration;
    }

    private static void RequireFile(string path, DatabaseToolConfigurationFailure failure)
    {
        if (!File.Exists(path))
        {
            throw new DatabaseToolConfigurationException(failure);
        }
    }
}

internal static class DatabaseToolConnectionStringValidator
{
    public static bool IsValid(string connectionString)
    {
        try
        {
            var builder = new SqlConnectionStringBuilder(connectionString);
            return !string.IsNullOrWhiteSpace(builder.InitialCatalog);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
