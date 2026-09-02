using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.Configuration;

public sealed record BrowserTestDatabaseConnectionStrings(
    string DatabaseName,
    string RuntimeConnectionString,
    string MigrationConnectionString,
    string MigrationMasterConnectionString)
{
    public const string SuffixConfigurationKey = "FlowPilot:BrowserTests:DatabaseSuffix";

    public static BrowserTestDatabaseConnectionStrings FromConfiguration(
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        var suffix = RequireSafeSuffix(configuration[SuffixConfigurationKey]);
        var runtime = ParseNamedConnectionString(
            configuration.GetConnectionString("FlowPilot"),
            "ConnectionStrings:FlowPilot");
        var migration = ParseNamedConnectionString(
            configuration.GetConnectionString("FlowPilotMigration"),
            "ConnectionStrings:FlowPilotMigration");

        if (!string.Equals(runtime.DataSource, migration.DataSource, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(runtime.InitialCatalog, migration.InitialCatalog, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "浏览器测试要求运行连接与迁移连接指向同一服务器和数据库。");
        }

        var databaseName = CreateDatabaseName(migration.InitialCatalog, suffix);
        runtime.InitialCatalog = databaseName;
        migration.InitialCatalog = databaseName;
        var migrationMaster = new SqlConnectionStringBuilder(migration.ConnectionString)
        {
            InitialCatalog = "master",
        };

        return new BrowserTestDatabaseConnectionStrings(
            databaseName,
            runtime.ConnectionString,
            migration.ConnectionString,
            migrationMaster.ConnectionString);
    }

    public static bool ApplyRuntimeOverride(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        if (string.IsNullOrWhiteSpace(configuration[SuffixConfigurationKey]))
        {
            return false;
        }

        var connectionStrings = FromConfiguration(configuration);
        configuration["ConnectionStrings:FlowPilot"] = connectionStrings.RuntimeConnectionString;
        return true;
    }

    public static string RequireSafeSuffix(string? value)
    {
        var suffix = value?.Trim();
        if (suffix is null ||
            suffix.Length is < 17 or > 40 ||
            !suffix.StartsWith("PlaywrightTests_", StringComparison.Ordinal) ||
            suffix[16..].Any(character => !char.IsAsciiDigit(character)))
        {
            throw new InvalidOperationException(
                $"{SuffixConfigurationKey} 必须采用 PlaywrightTests_<数字> 格式。");
        }

        return suffix;
    }

    private static SqlConnectionStringBuilder ParseNamedConnectionString(
        string? connectionString,
        string configurationKey)
    {
        try
        {
            var builder = new SqlConnectionStringBuilder(connectionString);
            if (string.IsNullOrWhiteSpace(builder.DataSource) ||
                string.IsNullOrWhiteSpace(builder.InitialCatalog) ||
                IsSystemDatabase(builder.InitialCatalog))
            {
                throw new InvalidOperationException();
            }

            return builder;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
        {
            throw new InvalidOperationException(
                $"{configurationKey} 必须是明确指定非系统数据库的 SQL Server 连接字符串。",
                exception);
        }
    }

    private static string CreateDatabaseName(string baseName, string suffix)
    {
        var marker = $"_{suffix}";
        var maximumBaseLength = 128 - marker.Length;
        if (maximumBaseLength < 1)
        {
            throw new InvalidOperationException("浏览器测试数据库后缀过长。");
        }

        var trimmedBaseName = baseName.Length <= maximumBaseLength
            ? baseName
            : baseName[..maximumBaseLength];
        return trimmedBaseName + marker;
    }

    private static bool IsSystemDatabase(string databaseName) =>
        databaseName.Equals("master", StringComparison.OrdinalIgnoreCase) ||
        databaseName.Equals("model", StringComparison.OrdinalIgnoreCase) ||
        databaseName.Equals("msdb", StringComparison.OrdinalIgnoreCase) ||
        databaseName.Equals("tempdb", StringComparison.OrdinalIgnoreCase);
}
