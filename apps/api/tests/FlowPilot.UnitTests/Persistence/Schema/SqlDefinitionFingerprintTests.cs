using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public sealed class SqlDefinitionFingerprintTests
{
    [Fact]
    public void ComputeExpression_NormalizesCatalogStyleRedundantParentheses()
    {
        const string source = "([revision] >= 1)";
        const string catalogStyle = "(([revision] >= (1) /* catalog formatting */))";

        Assert.Equal(
            SqlDefinitionFingerprint.ComputeExpression(source),
            SqlDefinitionFingerprint.ComputeExpression(catalogStyle));
    }

    [Fact]
    public void ComputeExpression_PreservesMeaningfulBooleanGrouping()
    {
        const string leftGrouped = "(([a] = 1 OR [b] = 1) AND [c] = 1)";
        const string rightGrouped = "([a] = 1 OR ([b] = 1 AND [c] = 1))";

        Assert.NotEqual(
            SqlDefinitionFingerprint.ComputeExpression(leftGrouped),
            SqlDefinitionFingerprint.ComputeExpression(rightGrouped));
    }

    [Fact]
    public void ComputeExpression_PreservesUnicodeStringLiteralContent()
    {
        const string expected = "([status] = N'pending')";
        const string changed = "([status] = N'completed')";

        Assert.NotEqual(
            SqlDefinitionFingerprint.ComputeExpression(expected),
            SqlDefinitionFingerprint.ComputeExpression(changed));
    }

    [Fact]
    public void ComputeModule_NormalizesTriviaButDetectsBehaviorChanges()
    {
        const string source = """
            CREATE TRIGGER [flowpilot].[tr_test]
            ON [flowpilot].[events]
            INSTEAD OF UPDATE
            AS
            BEGIN
                THROW 51000, 'blocked', 1;
            END;
            """;
        const string triviaOnly = """
            create /* stable comment */ trigger [flowpilot].[tr_test]
              on [flowpilot].[events] instead of update as begin
              throw 51000,'blocked',1; end;
            """;
        const string changed = """
            CREATE TRIGGER [flowpilot].[tr_test]
            ON [flowpilot].[events]
            INSTEAD OF UPDATE
            AS
            BEGIN
                THROW 51001, 'blocked', 1;
            END;
            """;

        var expectedHash = SqlDefinitionFingerprint.ComputeModule(source);

        Assert.Equal(expectedHash, SqlDefinitionFingerprint.ComputeModule(triviaOnly));
        Assert.NotEqual(expectedHash, SqlDefinitionFingerprint.ComputeModule(changed));
    }
}
