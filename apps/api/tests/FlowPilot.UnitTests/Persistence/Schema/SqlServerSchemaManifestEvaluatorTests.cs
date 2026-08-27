using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public sealed class SqlServerSchemaManifestEvaluatorTests
{
    private static readonly FlowPilotSchemaManifest Manifest = new(
        "202608260001",
        "flowpilot",
        ["table"],
        ["table.column"],
        ["table.constraint"],
        ["table.index"],
        ["table.trigger"]);

    [Fact]
    public void EvaluateReturnsValidForAnExactSnapshot()
    {
        var result = SqlServerSchemaManifestEvaluator.Evaluate(Manifest, CreateSnapshot());

        Assert.True(result.IsValid);
        Assert.Equal(SqlServerSchemaValidationCodes.Valid, result.Code);
    }

    [Theory]
    [InlineData("table")]
    [InlineData("column")]
    [InlineData("constraint")]
    [InlineData("index")]
    [InlineData("trigger")]
    public void EvaluateRejectsMissingOrExtraObjects(string category)
    {
        AssertMismatch(SqlServerSchemaManifestEvaluator.Evaluate(
            Manifest,
            CreateSnapshot(omittedCategory: category)));
        AssertMismatch(SqlServerSchemaManifestEvaluator.Evaluate(
            Manifest,
            CreateSnapshot(extraCategory: category)));
    }

    private static SqlServerSchemaSnapshot CreateSnapshot(
        string? omittedCategory = null,
        string? extraCategory = null)
    {
        IEnumerable<string> Select(string category, IReadOnlySet<string> expected)
        {
            if (string.Equals(category, omittedCategory, StringComparison.Ordinal))
            {
                return [];
            }

            return string.Equals(category, extraCategory, StringComparison.Ordinal)
                ? expected.Append($"unexpected_{category}")
                : expected;
        }

        return new SqlServerSchemaSnapshot(
            Select("table", Manifest.Tables),
            Select("column", Manifest.Columns),
            Select("constraint", Manifest.Constraints),
            Select("index", Manifest.Indexes),
            Select("trigger", Manifest.Triggers));
    }

    private static void AssertMismatch(SqlServerSchemaValidationResult result)
    {
        Assert.False(result.IsValid);
        Assert.Equal(SqlServerSchemaValidationCodes.StructureMismatch, result.Code);
    }
}
