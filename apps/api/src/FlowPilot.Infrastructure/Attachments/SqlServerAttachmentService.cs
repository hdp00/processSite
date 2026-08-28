using System.Buffers;
using System.Security.Cryptography;
using FlowPilot.Application.Attachments;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Attachments;

public sealed partial class SqlServerAttachmentService(
    FlowPilotDbContext dbContext,
    AttachmentFileStorage fileStorage,
    AttachmentStorageOptions storageOptions,
    IProcessDefinitionQueryService processDefinitionQueryService,
    IProcessInstanceQueryService processInstanceQueryService,
    TimeProvider timeProvider) : IAttachmentService
{
    private const string UploadRouteScope = "POST:/attachments";
    private static readonly HashSet<string> DangerousExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "exe", "dll", "msi", "com", "scr", "bat", "cmd", "ps1", "vbs", "js", "lnk",
    };

    private static readonly TimeZoneInfo BusinessTimeZone = FindBusinessTimeZone();

    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly AttachmentFileStorage _fileStorage = fileStorage;
    private readonly AttachmentStorageOptions _storageOptions = storageOptions;
    private readonly IProcessDefinitionQueryService _processDefinitionQueryService = processDefinitionQueryService;
    private readonly IProcessInstanceQueryService _processInstanceQueryService = processInstanceQueryService;
    private readonly TimeProvider _timeProvider = timeProvider;

    public async Task<AttachmentResult<AttachmentUploadDraft>> UploadFileAsync(
        Stream source,
        string originalName,
        string? declaredContentType,
        AttachmentActor actor,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        var fileName = NormalizeFileName(originalName);
        if (fileName is null)
        {
            return new AttachmentResult<AttachmentUploadDraft>(null, Failure(
                422,
                "ATTACHMENT_NAME_REQUIRED",
                "文件名无效",
                "上传文件必须具有长度不超过 255 个字符的有效名称。"));
        }

        var extension = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
        if (DangerousExtensions.Contains(extension))
        {
            return new AttachmentResult<AttachmentUploadDraft>(null, Failure(
                415,
                "DANGEROUS_ATTACHMENT_TYPE",
                "文件类型不安全",
                $"系统禁止上传 .{extension} 文件。"));
        }

        var now = _timeProvider.GetUtcNow();
        var year = checked((short)TimeZoneInfo.ConvertTime(now, BusinessTimeZone).Year);
        var attachment = new RuntimeAttachment
        {
            Id = Guid.NewGuid(),
            State = "uploading",
            StorageYear = year,
            OriginalFileName = fileName,
            Extension = extension,
            DeclaredContentType = NormalizeContentType(declaredContentType),
            Purpose = "pending",
            UploadedBy = actor.UserId,
            CreatedAt = now.UtcDateTime,
            Revision = 1,
        };
        attachment.StorageKey = AttachmentFileStorage.CreateIncomingStorageKey(year, attachment.Id);
        _dbContext.RuntimeAttachments.Add(attachment);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            var file = await WriteFileAsync(attachment.StorageKey, source, cancellationToken)
                .ConfigureAwait(false);
            var validation = ValidateFileSignature(extension, file.Signature);
            if (validation is not null)
            {
                await FailUploadAsync(attachment, validation.Detail, CancellationToken.None).ConfigureAwait(false);
                return new AttachmentResult<AttachmentUploadDraft>(null, validation);
            }

            attachment.SizeBytes = file.SizeBytes;
            attachment.Sha256 = file.Sha256;
            attachment.DetectedContentType = DetectContentType(file.Signature, attachment.DeclaredContentType);
            attachment.Revision = checked(attachment.Revision + 1);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return new AttachmentResult<AttachmentUploadDraft>(new AttachmentUploadDraft(attachment.Id), null);
        }
        catch (AttachmentTooLargeException)
        {
            await FailUploadAsync(attachment, "Attachment exceeds the configured maximum size.", CancellationToken.None)
                .ConfigureAwait(false);
            return new AttachmentResult<AttachmentUploadDraft>(null, Failure(
                413,
                "ATTACHMENT_TOO_LARGE",
                "附件超过大小限制",
                $"单个文件不能超过 {_storageOptions.MaximumFileSizeBytes / 1024 / 1024} MB。"));
        }
        catch (AttachmentStorageFullException)
        {
            await FailUploadAsync(attachment, "Attachment disk reserve is insufficient.", CancellationToken.None)
                .ConfigureAwait(false);
            return new AttachmentResult<AttachmentUploadDraft>(null, Failure(
                507,
                "ATTACHMENT_STORAGE_FULL",
                "附件存储空间不足",
                "服务器附件磁盘的可用空间不足，请联系管理员。"));
        }
        catch (OperationCanceledException)
        {
            await FailUploadAsync(attachment, "Attachment upload was cancelled.", CancellationToken.None)
                .ConfigureAwait(false);
            throw;
        }
        catch (IOException)
        {
            await FailUploadAsync(attachment, "Attachment file could not be written.", CancellationToken.None)
                .ConfigureAwait(false);
            return new AttachmentResult<AttachmentUploadDraft>(null, StorageUnavailable());
        }
    }

    public async Task AbortUploadAsync(
        Guid attachmentId,
        string reason,
        CancellationToken cancellationToken)
    {
        var attachment = await _dbContext.RuntimeAttachments
            .SingleOrDefaultAsync(item => item.Id == attachmentId, cancellationToken)
            .ConfigureAwait(false);
        if (attachment is not null && attachment.State == "uploading")
        {
            await FailUploadAsync(attachment, reason, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<WrittenFile> WriteFileAsync(
        string storageKey,
        Stream source,
        CancellationToken cancellationToken)
    {
        await using var destination = await _fileStorage
            .CreateIncomingFileAsync(storageKey, cancellationToken)
            .ConfigureAwait(false);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(128 * 1024);
        var signature = new byte[8];
        var signatureLength = 0;
        long size = 0;
        try
        {
            while (true)
            {
                var read = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                size = checked(size + read);
                if (size > _storageOptions.MaximumFileSizeBytes)
                {
                    throw new AttachmentTooLargeException();
                }

                if (signatureLength < signature.Length)
                {
                    var copyLength = Math.Min(signature.Length - signatureLength, read);
                    buffer.AsSpan(0, copyLength).CopyTo(signature.AsSpan(signatureLength));
                    signatureLength += copyLength;
                }

                hash.AppendData(buffer, 0, read);
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            }

            await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
            return new WrittenFile(
                size,
                Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(),
                signature.AsSpan(0, signatureLength).ToArray());
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private async Task FailUploadAsync(
        RuntimeAttachment attachment,
        string reason,
        CancellationToken cancellationToken)
    {
        try
        {
            _fileStorage.DeleteIfExists(attachment.StorageKey);
        }
        catch (IOException)
        {
            reason = $"{reason} The partial file could not be deleted.";
        }

        attachment.State = "failed";
        attachment.LastError = reason.Length <= 1000 ? reason : reason[..1000];
        attachment.Revision = checked(attachment.Revision + 1);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    private static AttachmentFailure? ValidateFileSignature(string extension, byte[] signature)
    {
        if (StartsWith(signature, [0x4d, 0x5a]))
        {
            return Failure(
                415,
                "DANGEROUS_ATTACHMENT_SIGNATURE",
                "文件内容不安全",
                "文件内容被识别为 Windows 可执行文件，与文件名无关。");
        }

        if (extension == "pdf" && !StartsWith(signature, "%PDF-"u8))
        {
            return Failure(
                415,
                "PDF_SIGNATURE_INVALID",
                "PDF 内容无效",
                "文件扩展名为 PDF，但内容签名不是有效的 PDF。");
        }

        return null;
    }

    private static string DetectContentType(byte[] signature, string? declaredContentType)
    {
        if (StartsWith(signature, "%PDF-"u8)) return "application/pdf";
        if (StartsWith(signature, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
        if (StartsWith(signature, [0xff, 0xd8, 0xff])) return "image/jpeg";
        if (StartsWith(signature, "GIF8"u8)) return "image/gif";
        if (StartsWith(signature, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
        return declaredContentType ?? "application/octet-stream";
    }

    private static bool StartsWith(byte[] value, ReadOnlySpan<byte> prefix) =>
        value.AsSpan().StartsWith(prefix);

    private static string? NormalizeFileName(string value)
    {
        var name = value.Replace('\\', '/').Split('/').LastOrDefault()?.Trim();
        return string.IsNullOrWhiteSpace(name)
            || name.Length > 255
            || name.Any(char.IsControl)
            ? null
            : name;
    }

    private static string? NormalizeContentType(string? value)
    {
        var contentType = value?.Split(';', 2)[0].Trim().ToLowerInvariant();
        return string.IsNullOrWhiteSpace(contentType) || contentType.Length > 255
            ? null
            : contentType;
    }

    private static AttachmentFailure Failure(int status, string code, string title, string detail) =>
        new(status, code, title, detail);

    private static AttachmentFailure StorageUnavailable() => Failure(
        503,
        "ATTACHMENT_STORAGE_UNAVAILABLE",
        "附件存储不可用",
        "服务器暂时无法访问附件存储，请稍后重试。");

    private static TimeZoneInfo FindBusinessTimeZone()
    {
        foreach (var id in new[] { "Asia/Shanghai", "China Standard Time" })
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(id);
            }
            catch (TimeZoneNotFoundException)
            {
            }
        }

        throw new InvalidOperationException("Asia/Shanghai time zone is unavailable.");
    }

    private sealed record WrittenFile(long SizeBytes, string Sha256, byte[] Signature);

    private sealed class AttachmentTooLargeException : IOException;
}
