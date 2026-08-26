using FlowPilot.Domain.Common;

namespace FlowPilot.UnitTests.Domain;

public sealed class RevisionTests
{
    [Fact]
    public void ConstructorRejectsNonPositiveValues()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new Revision(0));
    }

    [Fact]
    public void NextAdvancesRevision()
    {
        var revision = new Revision(7);

        Assert.Equal(new Revision(8), revision.Next());
    }

    [Theory]
    [InlineData("\"1\"", 1)]
    [InlineData("\"42\"", 42)]
    public void StrongEntityTagRoundTrips(string entityTag, int expected)
    {
        Assert.True(Revision.TryParseStrongEntityTag(entityTag, out var revision));
        Assert.Equal(expected, revision.Value);
        Assert.Equal(entityTag, revision.ToStrongEntityTag());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1")]
    [InlineData("W/\"1\"")]
    [InlineData("\"0\"")]
    [InlineData("\"-1\"")]
    [InlineData("\"abc\"")]
    public void ParserRejectsInvalidOrWeakEntityTags(string? entityTag)
    {
        Assert.False(Revision.TryParseStrongEntityTag(entityTag, out _));
    }
}
