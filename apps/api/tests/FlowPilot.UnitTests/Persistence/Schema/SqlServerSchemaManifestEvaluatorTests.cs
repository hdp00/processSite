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
        ["table.trigger"],
        ["table.column|type=sys.int|userDefined=0|nullable=0|collation=-" +
            "|computed=0|computedDefinition=-|persisted=0" +
            "|identity=0|seed=-|increment=-|rowGuid=0|sparse=0|ansiPadded=0"],
        ["table.constraint|check"],
        ["table.constraint|foreignKey"],
        ["table.constraint|key"],
        ["table.index|shape"],
        ["table.trigger|shape"]);

    [Fact]
    public void Evaluate_ReturnsValidForAnExactSnapshot()
    {
        var result = SqlServerSchemaManifestEvaluator.Evaluate(
            Manifest,
            CreateSnapshot());

        Assert.True(result.IsValid);
        Assert.Equal(SqlServerSchemaValidationCodes.Valid, result.Code);
    }

    [Theory]
    [InlineData("table")]
    [InlineData("column")]
    [InlineData("constraint")]
    [InlineData("index")]
    [InlineData("trigger")]
    [InlineData("columnSignature")]
    [InlineData("checkConstraintSignature")]
    [InlineData("foreignKeySignature")]
    [InlineData("keyConstraintSignature")]
    [InlineData("indexSignature")]
    [InlineData("triggerSignature")]
    public void Evaluate_ReturnsOneStableFailureForEveryMissingObjectCategory(
        string category)
    {
        var result = SqlServerSchemaManifestEvaluator.Evaluate(
            Manifest,
            CreateSnapshot(omittedCategory: category));

        AssertMismatch(result);
    }

    [Theory]
    [InlineData("table")]
    [InlineData("column")]
    [InlineData("constraint")]
    [InlineData("index")]
    [InlineData("trigger")]
    [InlineData("columnSignature")]
    [InlineData("checkConstraintSignature")]
    [InlineData("foreignKeySignature")]
    [InlineData("keyConstraintSignature")]
    [InlineData("indexSignature")]
    [InlineData("triggerSignature")]
    public void Evaluate_ReturnsOneStableFailureForEveryExtraObjectCategory(
        string category)
    {
        var result = SqlServerSchemaManifestEvaluator.Evaluate(
            Manifest,
            CreateSnapshot(extraCategory: category));

        AssertMismatch(result);
    }

    [Fact]
    public void Evaluate_RejectsAnOtherwiseUnallowedSchemaObject()
    {
        var result = SqlServerSchemaManifestEvaluator.Evaluate(
            Manifest,
            CreateSnapshot(otherObjects: ["VIEW:unexpected_view"]));

        AssertMismatch(result);
    }

    private static SqlServerSchemaSnapshot CreateSnapshot(
        string? omittedCategory = null,
        string? extraCategory = null,
        IEnumerable<string>? otherObjects = null)
    {
        IEnumerable<string> Select(
            string category,
            IReadOnlySet<string> expected)
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
            Select("trigger", Manifest.Triggers),
            otherObjects ?? [],
            Select("columnSignature", Manifest.ColumnSignatures),
            Select("checkConstraintSignature", Manifest.CheckConstraintSignatures),
            Select("foreignKeySignature", Manifest.ForeignKeySignatures),
            Select("keyConstraintSignature", Manifest.KeyConstraintSignatures),
            Select("indexSignature", Manifest.IndexSignatures),
            Select("triggerSignature", Manifest.TriggerSignatures));
    }

    private static void AssertMismatch(SqlServerSchemaValidationResult result)
    {
        Assert.False(result.IsValid);
        Assert.Equal(SqlServerSchemaValidationCodes.StructureMismatch, result.Code);
    }
}
