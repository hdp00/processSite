namespace FlowPilot.Application.Attachments;

public static class RichTextMediaPolicy
{
    public const string Purpose = "rich-text-media";

    public static bool IsSupportedContentType(string? contentType) =>
        contentType?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) == true
        || contentType?.StartsWith("video/", StringComparison.OrdinalIgnoreCase) == true;

    public static bool CanInline(string? contentType) =>
        string.Equals(contentType, "application/pdf", StringComparison.OrdinalIgnoreCase)
        || IsSupportedContentType(contentType);
}
