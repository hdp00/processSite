using System.Diagnostics;
using FlowPilot.Api.Http;
using FlowPilot.Application.Attachments;
using FlowPilot.Application.Authentication;
using FlowPilot.Domain.Common;
using FlowPilot.Infrastructure.Configuration;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class AttachmentsController(
    IAuthService authService,
    IAttachmentService attachmentService,
    AttachmentStorageOptions storageOptions) : ControllerBase
{
    private const string LaunchPermission = "work-launch:发起";
    private const string ReviewPermission = "work-task:审核";
    private const string MonitorPermission = "system-monitor:查看";

    [HttpPost("attachments")]
    [Consumes("multipart/form-data")]
    [DisableFormValueModelBinding]
    [RequestSizeLimit(110 * 1024 * 1024)]
    [ProducesResponseType<AttachmentDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status413PayloadTooLarge)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status415UnsupportedMediaType)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<AttachmentDto>> Upload(CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        if (!TryGetMultipartBoundary(out var boundary))
        {
            return ProblemResponse(400, "INVALID_MULTIPART_BODY", "上传内容无效", "请求体必须是有效的 multipart/form-data。");
        }

        AttachmentUploadDraft? draft = null;
        try
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            var reader = new MultipartReader(boundary, Request.Body)
            {
                BodyLengthLimit = storageOptions.MaximumFileSizeBytes + 1024 * 1024,
            };
            while (await reader.ReadNextSectionAsync(cancellationToken).ConfigureAwait(false) is { } section)
            {
                if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition)
                    || !string.Equals(disposition.DispositionType.Value, "form-data", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var fieldName = HeaderUtilities.RemoveQuotes(disposition.Name).Value ?? string.Empty;
                var fileName = HeaderUtilities.RemoveQuotes(
                    disposition.FileNameStar.HasValue ? disposition.FileNameStar : disposition.FileName).Value;
                if (!string.IsNullOrWhiteSpace(fileName))
                {
                    if (fieldName != "file" || draft is not null)
                    {
                        return await AbortAndReturnAsync(
                            draft,
                            ProblemResponse(422, "ATTACHMENT_FILE_INVALID", "附件文件无效", "请求只能包含一个名为 file 的文件。"),
                            cancellationToken).ConfigureAwait(false);
                    }

                    var upload = await attachmentService.UploadFileAsync(
                        section.Body,
                        fileName,
                        section.ContentType,
                        CreateActor(session),
                        cancellationToken).ConfigureAwait(false);
                    if (!upload.Succeeded)
                    {
                        return FailureResponse(upload.Failure!);
                    }

                    draft = upload.Value;
                    continue;
                }

                if (fieldName.Length == 0 || fieldName.Length > 100)
                {
                    return await AbortAndReturnAsync(
                        draft,
                        ProblemResponse(422, "ATTACHMENT_SCOPE_INVALID", "附件范围无效", "附件范围字段名称无效。"),
                        cancellationToken).ConfigureAwait(false);
                }

                values[fieldName] = (await ReadSmallFormValueAsync(section.Body, cancellationToken)
                    .ConfigureAwait(false)).Trim();
            }

            if (draft is null)
            {
                return ProblemResponse(422, "ATTACHMENT_FILE_REQUIRED", "缺少附件文件", "multipart 请求必须包含名为 file 的文件。");
            }

            var result = await attachmentService.CompleteUploadAsync(
                draft.Id,
                new AttachmentUploadScope(
                    ParseGuid(values, "definitionId"),
                    ParseGuid(values, "versionId"),
                    ParseGuid(values, "instanceId"),
                    Value(values, "fieldId"),
                    Value(values, "purpose") ?? "form-field"),
                CreateActor(session),
                idempotencyKey,
                GetTraceId(),
                cancellationToken).ConfigureAwait(false);
            if (!result.Succeeded)
            {
                return FailureResponse(result.Failure!);
            }

            var attachment = result.Value!;
            Response.Headers.ETag = new Revision(attachment.Revision).ToStrongEntityTag();
            return Created($"{ApiConstants.PathBase}/attachments/{attachment.Id:D}", attachment);
        }
        catch (IOException)
        {
            return await AbortAndReturnAsync(
                draft,
                ProblemResponse(400, "INVALID_MULTIPART_BODY", "上传内容无效", "无法解析 multipart 上传内容。"),
                CancellationToken.None).ConfigureAwait(false);
        }
    }

    [HttpGet("attachments/{attachmentId:guid}")]
    [ProducesResponseType<AttachmentDto>(StatusCodes.Status200OK)]
    public async Task<ActionResult<AttachmentDto>> Get(
        Guid attachmentId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        var result = await attachmentService.GetAsync(attachmentId, CreateActor(session), cancellationToken)
            .ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return FailureResponse(result.Failure!);
        }

        Response.Headers.ETag = new Revision(result.Value!.Revision).ToStrongEntityTag();
        return Ok(result.Value);
    }

    [HttpGet("attachments/{attachmentId:guid}/content")]
    public async Task<IActionResult> Content(
        Guid attachmentId,
        [FromQuery] string disposition = "attachment",
        CancellationToken cancellationToken = default)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (disposition is not ("attachment" or "inline"))
        {
            return ProblemResponse(400, "BAD_REQUEST", "下载方式无效", "disposition 必须是 attachment 或 inline。");
        }

        if (Request.Headers.Range.Any(value => value?.Contains(',', StringComparison.Ordinal) == true))
        {
            return ProblemResponse(416, "MULTIPLE_RANGES_NOT_SUPPORTED", "不支持多区间下载", "首版附件接口仅支持单个字节区间。");
        }

        var result = await attachmentService
            .OpenContentAsync(attachmentId, CreateActor(session), cancellationToken)
            .ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return FailureResponse(result.Failure!);
        }

        var content = result.Value!;
        var inline = disposition == "inline" && content.CanInline;
        if (disposition == "inline" && !content.CanInline)
        {
            content.Stream.Dispose();
            return ProblemResponse(415, "ATTACHMENT_INLINE_NOT_ALLOWED", "不能内联预览", "只有实际识别为 PDF 的附件可以内联预览。");
        }

        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.AcceptRanges = "bytes";
        Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        if (inline)
        {
            Response.Headers.ContentSecurityPolicy = "sandbox";
            Response.Headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(content.OriginalName)}";
        }

        return new FileStreamResult(content.Stream, content.ContentType)
        {
            EnableRangeProcessing = true,
            EntityTag = new EntityTagHeaderValue($"\"{content.Sha256}\""),
            FileDownloadName = inline ? null : content.OriginalName,
        };
    }

    [HttpDelete("attachments/{attachmentId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Delete(
        Guid attachmentId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!TryGetExpectedRevision(out var revision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await attachmentService.DeleteStagedAsync(
            attachmentId,
            revision,
            CreateActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : FailureResponse(result.Failure!);
    }

    private async Task<ObjectResult> AbortAndReturnAsync(
        AttachmentUploadDraft? draft,
        ObjectResult response,
        CancellationToken cancellationToken)
    {
        if (draft is not null)
        {
            await attachmentService.AbortUploadAsync(draft.Id, "Multipart upload validation failed.", cancellationToken)
                .ConfigureAwait(false);
        }

        return response;
    }

    private static async Task<string> ReadSmallFormValueAsync(
        Stream stream,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[2049];
        var length = 0;
        while (true)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            length += read;
            if (length > 2000)
            {
                throw new InvalidDataException("Multipart form value is too long.");
            }
        }

        return System.Text.Encoding.UTF8.GetString(buffer, 0, length);
    }

    private bool TryGetMultipartBoundary(out string boundary)
    {
        boundary = string.Empty;
        if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var contentType)
            || !string.Equals(contentType.MediaType.Value, "multipart/form-data", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        boundary = HeaderUtilities.RemoveQuotes(contentType.Boundary).Value ?? string.Empty;
        return boundary.Length is > 0 and <= 70;
    }

    private bool TryGetIdempotencyKey(out string key, out ObjectResult? problem)
    {
        key = string.Empty;
        problem = null;
        var values = Request.Headers["Idempotency-Key"];
        if (values.Count != 1)
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "缺少幂等键", "请求必须携带一个 Idempotency-Key。");
            return false;
        }

        key = values[0]?.Trim() ?? string.Empty;
        if (key.Length is < 16 or > 200)
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "幂等键格式无效", "Idempotency-Key 的长度必须为 16 到 200 个字符。");
            return false;
        }

        return true;
    }

    private bool TryGetExpectedRevision(out int revision, out ObjectResult? problem)
    {
        revision = default;
        problem = null;
        var values = Request.Headers.IfMatch;
        if (values.Count == 0)
        {
            problem = ProblemResponse(428, "IF_MATCH_REQUIRED", "缺少并发版本", "请求必须携带 If-Match。");
            return false;
        }

        if (values.Count != 1 || !Revision.TryParseStrongEntityTag(values[0], out var parsed))
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "If-Match 格式无效", "If-Match 必须是单个强 ETag。");
            return false;
        }

        revision = parsed.Value;
        return true;
    }

    private async Task<SessionDto?> GetCurrentSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.GetCurrentSessionAsync(sessionToken, cancellationToken)
            .ConfigureAwait(false);
        return result.Session;
    }

    private static AttachmentActor CreateActor(SessionDto session) => new(
        session.User.Id,
        session.SuperAdmin,
        HasPermission(session, LaunchPermission),
        HasPermission(session, ReviewPermission),
        HasPermission(session, MonitorPermission));

    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);

    private static Guid? ParseGuid(Dictionary<string, string> values, string key) =>
        values.TryGetValue(key, out var value) && Guid.TryParse(value, out var id) ? id : null;

    private static string? Value(Dictionary<string, string> values, string key) =>
        values.TryGetValue(key, out var value) && value.Length > 0 ? value : null;

    private ObjectResult FailureResponse(AttachmentFailure failure) =>
        ProblemResponse(failure.Status, failure.Code, failure.Title, failure.Detail, failure.Issues);

    private string GetTraceId() => Activity.Current?.TraceId.ToString() ?? HttpContext.TraceIdentifier;

    private ObjectResult ProblemResponse(
        int status,
        string code,
        string title,
        string detail,
        IReadOnlyList<AttachmentInputIssueDto>? errors = null)
    {
        var problem = new ProblemDetails
        {
            Status = status,
            Type = $"/problems/{code.ToLowerInvariant().Replace('_', '-')}",
            Title = title,
            Detail = detail,
            Instance = Request.Path,
        };
        problem.Extensions["code"] = code;
        problem.Extensions["traceId"] = GetTraceId();
        if (errors is not null)
        {
            problem.Extensions["errors"] = errors;
        }

        return StatusCode(status, problem);
    }
}
