using FlowPilot.Application.Attachments;

namespace FlowPilot.UnitTests.Attachments;

public sealed class RichTextMediaPolicyTests
{
    [Theory]
    [InlineData("image/png")]
    [InlineData("image/jpeg")]
    [InlineData("video/mp4")]
    [InlineData("VIDEO/WEBM")]
    public void SupportedContentTypesAreImagesOrVideos(string contentType)
    {
        Assert.True(RichTextMediaPolicy.IsSupportedContentType(contentType));
        Assert.True(RichTextMediaPolicy.CanInline(contentType));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("text/html")]
    [InlineData("application/javascript")]
    public void ExecutableOrUnknownContentTypesAreRejected(string? contentType)
    {
        Assert.False(RichTextMediaPolicy.IsSupportedContentType(contentType));
        Assert.False(RichTextMediaPolicy.CanInline(contentType));
    }

    [Fact]
    public void PdfCanBeInlinedButIsNotRichTextMedia()
    {
        Assert.False(RichTextMediaPolicy.IsSupportedContentType("application/pdf"));
        Assert.True(RichTextMediaPolicy.CanInline("application/pdf"));
    }
}
