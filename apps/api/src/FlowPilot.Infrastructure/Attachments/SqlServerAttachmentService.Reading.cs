using System.Text.Json;
using FlowPilot.Application.Attachments;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Attachments;

public sealed partial class SqlServerAttachmentService
{
    public async Task<AttachmentResult<AttachmentDto>> GetAsync(
        Guid attachmentId,
        AttachmentActor actor,
        CancellationToken cancellationToken)
    {
        var accessible = await LoadAccessibleAsync(attachmentId, actor, cancellationToken)
            .ConfigureAwait(false);
        if (accessible.Failure is not null)
        {
            return new AttachmentResult<AttachmentDto>(null, accessible.Failure);
        }

        return new AttachmentResult<AttachmentDto>(
            await BuildDtoAsync(accessible.Attachment!, accessible.References!, cancellationToken)
                .ConfigureAwait(false),
            null);
    }

    public async Task<AttachmentResult<AttachmentContent>> OpenContentAsync(
        Guid attachmentId,
        AttachmentActor actor,
        CancellationToken cancellationToken)
    {
        var accessible = await LoadAccessibleAsync(attachmentId, actor, cancellationToken)
            .ConfigureAwait(false);
        if (accessible.Failure is not null)
        {
            return new AttachmentResult<AttachmentContent>(null, accessible.Failure);
        }

        var attachment = accessible.Attachment!;
        if (!_fileStorage.Exists(attachment.StorageKey))
        {
            return new AttachmentResult<AttachmentContent>(null, Failure(
                503,
                "ATTACHMENT_CONTENT_UNAVAILABLE",
                "附件内容暂不可用",
                "附件元数据存在，但服务器暂时无法读取文件内容。"));
        }

        try
        {
            var contentType = attachment.DetectedContentType
                ?? attachment.DeclaredContentType
                ?? "application/octet-stream";
            return new AttachmentResult<AttachmentContent>(new AttachmentContent(
                _fileStorage.OpenRead(attachment.StorageKey),
                attachment.SizeBytes ?? 0,
                contentType,
                attachment.OriginalFileName,
                attachment.Sha256 ?? string.Empty,
                RichTextMediaPolicy.CanInline(contentType)), null);
        }
        catch (IOException)
        {
            return new AttachmentResult<AttachmentContent>(null, StorageUnavailable());
        }
    }

    public async Task<AttachmentDeleteResult> DeleteStagedAsync(
        Guid attachmentId,
        int expectedRevision,
        AttachmentActor actor,
        string traceId,
        CancellationToken cancellationToken)
    {
        var attachment = await _dbContext.RuntimeAttachments
            .SingleOrDefaultAsync(item => item.Id == attachmentId, cancellationToken)
            .ConfigureAwait(false);
        if (attachment is null || attachment.State is "uploading" or "failed" or "deleted")
        {
            return AttachmentDeleteResult.Failed(NotFound());
        }

        if (attachment.State == "active" && attachment.Purpose == RichTextMediaPolicy.Purpose)
        {
            return AttachmentDeleteResult.Failed(Failure(
                409,
                "RICH_TEXT_MEDIA_ACTIVE",
                "富文本媒体已生效",
                "为避免已保存的正文失效，富文本图片或视频不能通过暂存附件接口删除。"));
        }

        if (attachment.State != "staged")
        {
            return AttachmentDeleteResult.Failed(Failure(
                409,
                "ATTACHMENT_ALREADY_REFERENCED",
                "附件已被业务数据引用",
                "只能删除尚未建立业务引用的暂存附件。"));
        }

        if (!actor.IsSuperAdmin && attachment.UploadedBy != actor.UserId)
        {
            return AttachmentDeleteResult.Failed(Forbidden("只有上传人可以删除该暂存附件。"));
        }

        if (attachment.Revision != expectedRevision)
        {
            return AttachmentDeleteResult.Failed(Failure(
                412,
                "ETAG_MISMATCH",
                "附件已发生变化",
                "请刷新附件信息后重试。"));
        }

        var now = _timeProvider.GetUtcNow();
        attachment.State = "cleanup-pending";
        attachment.CleanupAfter = now.UtcDateTime;
        attachment.Revision = checked(attachment.Revision + 1);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _fileStorage.DeleteIfExists(attachment.StorageKey);
        }
        catch (IOException exception)
        {
            attachment.LastError = exception.Message.Length <= 1000
                ? exception.Message
                : exception.Message[..1000];
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return AttachmentDeleteResult.Failed(StorageUnavailable());
        }

        attachment.State = "deleted";
        attachment.CleanupAfter = null;
        attachment.LastError = null;
        attachment.Revision = checked(attachment.Revision + 1);
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "attachment",
            ResourceId = attachment.Id,
            Action = "attachment.delete",
            FieldIdentifiersJson = JsonSerializer.Serialize(Array.Empty<string>()),
            OperatorUserId = actor.UserId,
            EffectiveUserId = actor.UserId,
            TraceId = traceId.Length <= 100 ? traceId : traceId[..100],
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return AttachmentDeleteResult.Success();
    }

    private async Task<AccessibleAttachment> LoadAccessibleAsync(
        Guid attachmentId,
        AttachmentActor actor,
        CancellationToken cancellationToken)
    {
        var attachment = await _dbContext.RuntimeAttachments
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == attachmentId, cancellationToken)
            .ConfigureAwait(false);
        if (attachment is null || attachment.State is "uploading" or "failed" or "deleted")
        {
            return AccessibleAttachment.Failed(NotFound());
        }

        var references = await _dbContext.AttachmentReferences
            .AsNoTracking()
            .Where(item => item.AttachmentId == attachmentId)
            .OrderBy(item => item.CreatedAt)
            .ThenBy(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (attachment.State == "active" && attachment.Purpose == RichTextMediaPolicy.Purpose)
        {
            return AccessibleAttachment.Success(attachment, references);
        }
        if ((attachment.State is "staged" or "cleanup-pending") && references.Length == 0)
        {
            return actor.IsSuperAdmin || attachment.UploadedBy == actor.UserId
                ? AccessibleAttachment.Success(attachment, references)
                : AccessibleAttachment.Failed(Forbidden("只有上传人可以访问尚未提交的附件。"));
        }

        if (actor.IsSuperAdmin || actor.CanViewAllInstances)
        {
            return AccessibleAttachment.Success(attachment, references);
        }

        var queryActor = new ProcessInstanceQueryActor(
            actor.UserId,
            actor.IsSuperAdmin,
            actor.CanReview,
            actor.CanLaunch,
            false,
            actor.CanViewAllInstances);
        foreach (var instanceId in references.Select(item => item.InstanceId).Distinct())
        {
            var instance = await _processInstanceQueryService
                .GetAsync(instanceId, queryActor, cancellationToken)
                .ConfigureAwait(false);
            if (instance.Error is null)
            {
                return AccessibleAttachment.Success(attachment, references);
            }
        }

        return AccessibleAttachment.Failed(Forbidden("当前账号不在该附件所属流程实例的数据可见范围内。"));
    }

    private async Task<AttachmentDto> BuildDtoAsync(
        RuntimeAttachment attachment,
        IReadOnlyList<AttachmentReferenceEntity> references,
        CancellationToken cancellationToken)
    {
        var uploaderName = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(item => item.Id == attachment.UploadedBy)
            .Select(item => item.DisplayName)
            .SingleAsync(cancellationToken)
            .ConfigureAwait(false);
        return new AttachmentDto(
            attachment.Id,
            attachment.Revision,
            attachment.OriginalFileName,
            attachment.SizeBytes ?? 0,
            attachment.DetectedContentType ?? attachment.DeclaredContentType ?? "application/octet-stream",
            attachment.Sha256 ?? string.Empty,
            attachment.State,
            new AttachmentUserRefDto(attachment.UploadedBy, uploaderName),
            new DateTimeOffset(DateTime.SpecifyKind(
                attachment.StagedAt ?? attachment.CreatedAt,
                DateTimeKind.Utc)),
            references.Select(reference => new AttachmentReferenceDto(
                reference.FreeTimelineEntryId is null ? "process-instance" : "free-timeline-entry",
                reference.FreeTimelineEntryId ?? reference.InstanceId,
                reference.FieldId)).ToArray(),
            $"/api/flowpilot/v1/attachments/{attachment.Id:D}/content");
    }

    private static AttachmentFailure NotFound() => Failure(
        404,
        "ATTACHMENT_NOT_FOUND",
        "附件不存在",
        "未找到指定附件，文件可能已被替换或删除。");

    private static AttachmentFailure Forbidden(string detail) => Failure(
        403,
        "ATTACHMENT_READ_FORBIDDEN",
        "不能访问附件",
        detail);

    private sealed record AccessibleAttachment(
        RuntimeAttachment? Attachment,
        AttachmentReferenceEntity[]? References,
        AttachmentFailure? Failure)
    {
        public static AccessibleAttachment Success(
            RuntimeAttachment attachment,
            AttachmentReferenceEntity[] references) => new(attachment, references, null);

        public static AccessibleAttachment Failed(AttachmentFailure failure) => new(null, null, failure);
    }
}
