using FlowPilot.Database.Migrations;

namespace FlowPilot.UnitTests.Database;

public sealed class SqlScriptChecksumTests
{
    [Fact]
    public void ComputeSha256_NormalizesBomLineEndingsAndFinalNewlines()
    {
        var windowsSql = "\uFEFFSELECT 1;\r\n\r\n";
        var unixSql = "SELECT 1;\n";

        var windowsChecksum = SqlScriptChecksum.ComputeSha256(windowsSql);
        var unixChecksum = SqlScriptChecksum.ComputeSha256(unixSql);

        Assert.Equal(unixChecksum, windowsChecksum);
        Assert.Equal(64, windowsChecksum.Length);
        Assert.All(
            windowsChecksum,
            character => Assert.True(char.IsAsciiDigit(character) || character is >= 'a' and <= 'f'));
    }

    [Fact]
    public void ComputeSha256_PreservesMeaningfulSqlChanges()
    {
        var first = SqlScriptChecksum.ComputeSha256("SELECT 1;");
        var second = SqlScriptChecksum.ComputeSha256("SELECT 2;");

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void MigrationCatalog_LoadsTheOrderedChecksummedMigrationChain()
    {
        var migrations = MigrationCatalog.Migrations;

        Assert.Equal(7, migrations.Count);
        Assert.Equal("202608260001", migrations[0].Id);
        Assert.Equal("initial_schema", migrations[0].Name);
        Assert.Equal(MigrationCatalog.CurrentSchemaVersion, migrations[^1].Id);
        Assert.Equal("process_version_source", migrations[^1].Name);
        Assert.Equal(migrations.OrderBy(item => item.Id).Select(item => item.Id), migrations.Select(item => item.Id));
        Assert.All(migrations, migration =>
        {
            Assert.Equal(SqlScriptChecksum.ComputeSha256(migration.Sql), migration.Checksum);
            Assert.DoesNotContain("\nGO\n", migration.Sql, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Theory]
    [InlineData("GO\nSELECT 1;")]
    [InlineData("SELECT 1;\nGO 2")]
    [InlineData(":r other.sql")]
    [InlineData("USE [master]")]
    [InlineData("BEGIN TRANSACTION;")]
    public void SchemaMigration_RejectsUnsupportedScriptDirectives(string sql)
    {
        var exception = Assert.Throws<DatabaseMigrationException>(
            () => new SchemaMigration("202608260001", "initial_schema", sql));

        Assert.Equal(DatabaseMigrationFailure.MigrationCatalogInvalid, exception.Failure);
    }
}
