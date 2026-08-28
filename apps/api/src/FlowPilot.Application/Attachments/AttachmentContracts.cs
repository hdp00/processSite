using System.Text.Json.Serialization;

namespace FlowPilot.Application.Attachments;

public sealed record AttachmentUserRefDto(Guid Id, string Name);

public sealed record AttachmentReferenceDto(
    string AggregateType,
    Guid AggregateId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? FieldId);

public sealed record AttachmentDto(
    Guid Id,
    int Revision,
    string OriginalName,
    long SizeBytes,
    string ContentType,
    string Sha256,
    string Status,
    AttachmentUserRefDto UploadedBy,
    DateTimeOffset UploadedAt,
    IReadOnlyList<AttachmentReferenceDto> ReferencedBy,
    string ContentUrl);

public sealed record AttachmentActor(
    Guid UserId,
    bool IsSuperAdmin,
    bool CanLaunch,
    bool CanReview,
    bool CanViewAllInstances);

public sealed record AttachmentUploadScope(
    Guid? DefinitionId,
    Guid? VersionId,
    Guid? InstanceId,
    string? FieldId,
    string Purpose);

public sealed record AttachmentUploadDraft(Guid Id);

public sealed record AttachmentContent(
    Stream Stream,
    long Length,
    string ContentType,
    string OriginalName,
    string Sha256,
    bool CanInline);

public sealed record AttachmentInputIssueDto(string Path, string Code, string Message);

public sealed record AttachmentFailure(
    int Status,
    string Code,
    string Title,
    string Detail,
    IReadOnlyList<AttachmentInputIssueDto>? Issues = null);

public sealed record AttachmentResult<T>(T? Value, AttachmentFailure? Failure)
{
    public bool Succeeded => Failure is null;
}

public sealed record AttachmentDeleteResult(AttachmentFailure? Failure)
{
    public bool Succeeded => Failure is null;

    public static AttachmentDeleteResult Success() => new((AttachmentFailure?)null);

    public static AttachmentDeleteResult Failed(AttachmentFailure failure) => new(failure);
}

public interface IAttachmentService
{
    Task<AttachmentResult<AttachmentUploadDraft>> UploadFileAsync(
        Stream source,
        string originalName,
        string? declaredContentType,
        AttachmentActor actor,
        CancellationToken cancellationToken);

    Task<AttachmentResult<AttachmentDto>> CompleteUploadAsync(
        Guid attachmentId,
        AttachmentUploadScope scope,
        AttachmentActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken);

    Task AbortUploadAsync(Guid attachmentId, string reason, CancellationToken cancellationToken);

    Task<AttachmentResult<AttachmentDto>> GetAsync(
        Guid attachmentId,
        AttachmentActor actor,
        CancellationToken cancellationToken);

    Task<AttachmentResult<AttachmentContent>> OpenContentAsync(
        Guid attachmentId,
        AttachmentActor actor,
        CancellationToken cancellationToken);

    Task<AttachmentDeleteResult> DeleteStagedAsync(
        Guid attachmentId,
        int expectedRevision,
        AttachmentActor actor,
        string traceId,
        CancellationToken cancellationToken);
}
