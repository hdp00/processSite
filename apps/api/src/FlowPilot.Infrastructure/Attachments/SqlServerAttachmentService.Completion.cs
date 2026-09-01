using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.Attachments;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Attachments;

public sealed partial class SqlServerAttachmentService
{
    public async Task<AttachmentResult<AttachmentDto>> CompleteUploadAsync(
        Guid attachmentId,
        AttachmentUploadScope scope,
        AttachmentActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken)
    {
        var attachment = await _dbContext.RuntimeAttachments
            .SingleOrDefaultAsync(item => item.Id == attachmentId, cancellationToken)
            .ConfigureAwait(false);
        if (attachment is null || attachment.State != "uploading" || attachment.UploadedBy != actor.UserId)
        {
            return new AttachmentResult<AttachmentDto>(null, Failure(
                409,
                "ATTACHMENT_UPLOAD_NOT_COMPLETABLE",
                "附件上传状态已变化",
                "当前上传无法完成，请重新选择文件。"));
        }

        var policyResult = await ValidateUploadScopeAsync(scope, actor, attachment, cancellationToken)
            .ConfigureAwait(false);
        if (policyResult is not null)
        {
            await FailUploadAsync(attachment, policyResult.Detail, CancellationToken.None).ConfigureAwait(false);
            return new AttachmentResult<AttachmentDto>(null, policyResult);
        }

        var requestHash = CreateRequestHash(attachment, scope);
        var now = _timeProvider.GetUtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var existing = await _dbContext.IdempotencyRecords
            .SingleOrDefaultAsync(
                item => item.ActorId == actor.UserId
                    && item.RouteScope == UploadRouteScope
                    && item.IdempotencyKey == idempotencyKey,
                cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            await AbortUploadAsync(attachment.Id, "Duplicate upload request.", CancellationToken.None)
                .ConfigureAwait(false);
            if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
            {
                return new AttachmentResult<AttachmentDto>(null, Failure(
                    409,
                    "IDEMPOTENCY_KEY_REUSED",
                    "幂等键已用于其他请求",
                    "请为不同的附件上传使用新的 Idempotency-Key。"));
            }

            if (existing.Status != "completed" || !TryReadAttachmentId(existing.ResponseBodyJson, out var replayId))
            {
                return new AttachmentResult<AttachmentDto>(null, Failure(
                    409,
                    "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                    "附件上传正在处理中",
                    "相同上传请求仍在处理中，请稍后重试。"));
            }

            return await GetAsync(replayId, actor, cancellationToken).ConfigureAwait(false);
        }

        var isRichTextMedia = string.Equals(scope.Purpose, RichTextMediaPolicy.Purpose, StringComparison.Ordinal);
        attachment.State = isRichTextMedia ? "active" : "staged";
        attachment.Purpose = scope.Purpose;
        attachment.StagedAt = now.UtcDateTime;
        attachment.CleanupAfter = isRichTextMedia ? null : now.AddHours(24).UtcDateTime;
        attachment.LastError = null;
        attachment.Revision = checked(attachment.Revision + 1);

        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "attachment",
            ResourceId = attachment.Id,
            Action = "attachment.upload",
            FieldIdentifiersJson = JsonSerializer.Serialize(new[] { scope.FieldId }),
            OperatorUserId = actor.UserId,
            EffectiveUserId = actor.UserId,
            TraceId = traceId.Length <= 100 ? traceId : traceId[..100],
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
        _dbContext.IdempotencyRecords.Add(new IdempotencyRecordEntity
        {
            Id = Guid.NewGuid(),
            ActorId = actor.UserId,
            RouteScope = UploadRouteScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = 201,
            ReplayHeadersJson = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                ["ETag"] = $"\"{attachment.Revision}\"",
            }),
            ResponseBodyJson = JsonSerializer.Serialize(new { attachmentId = attachment.Id }),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddHours(24).UtcDateTime,
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);

        return await GetAsync(attachment.Id, actor, cancellationToken).ConfigureAwait(false);
    }

    private async Task<AttachmentFailure?> ValidateUploadScopeAsync(
        AttachmentUploadScope scope,
        AttachmentActor actor,
        RuntimeAttachment attachment,
        CancellationToken cancellationToken)
    {
        if (string.Equals(scope.Purpose, RichTextMediaPolicy.Purpose, StringComparison.Ordinal))
        {
            if (scope.DefinitionId is not null
                || scope.VersionId is not null
                || scope.InstanceId is not null
                || !string.IsNullOrWhiteSpace(scope.FieldId))
            {
                return Failure(
                    422,
                    "ATTACHMENT_SCOPE_INVALID",
                    "富文本媒体范围无效",
                    "富文本媒体上传只需要提供 purpose=rich-text-media。");
            }

            var contentType = attachment.DetectedContentType ?? attachment.DeclaredContentType ?? string.Empty;
            return RichTextMediaPolicy.IsSupportedContentType(contentType)
                ? null
                : Failure(
                    415,
                    "RICH_TEXT_MEDIA_TYPE_INVALID",
                    "富文本媒体格式不支持",
                    "富文本编辑器只允许上传图片或视频文件。");
        }

        if (string.Equals(scope.Purpose, "free-reply", StringComparison.Ordinal))
        {
            return await ValidateFreeReplyUploadScopeAsync(scope, actor, cancellationToken)
                .ConfigureAwait(false);
        }

        if (!string.Equals(scope.Purpose, "form-field", StringComparison.Ordinal))
        {
            return Failure(422, "ATTACHMENT_PURPOSE_INVALID", "附件用途无效", "purpose 只支持 form-field、free-reply 或 rich-text-media。");
        }

        if (scope.InstanceId is not null)
        {
            return await ValidateInstanceUploadScopeAsync(scope, actor, attachment, cancellationToken)
                .ConfigureAwait(false);
        }

        if (scope.DefinitionId is null || scope.VersionId is null || string.IsNullOrWhiteSpace(scope.FieldId))
        {
            return Failure(
                422,
                "ATTACHMENT_SCOPE_INCOMPLETE",
                "附件范围不完整",
                "发起前上传必须同时提供 definitionId、versionId 和 fieldId。");
        }

        if (!actor.CanLaunch)
        {
            return Failure(403, "ATTACHMENT_UPLOAD_FORBIDDEN", "不能上传附件", "当前账号没有发起流程的权限。");
        }

        var launchConfig = await _processDefinitionQueryService.GetLaunchConfigAsync(
            scope.DefinitionId.Value,
            new ProcessDefinitionActor(actor.UserId, actor.IsSuperAdmin, false),
            cancellationToken).ConfigureAwait(false);
        if (launchConfig.Error == ProcessLaunchConfigError.NotFound)
        {
            return Failure(404, "PROCESS_DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。");
        }

        if (launchConfig.Error == ProcessLaunchConfigError.Forbidden)
        {
            return Failure(403, "PROCESS_LAUNCH_FORBIDDEN", "不能发起该流程", "当前账号不属于该流程的发起权限组。");
        }

        if (launchConfig.Error == ProcessLaunchConfigError.NotLaunchable || launchConfig.Config is null)
        {
            return Failure(409, "PROCESS_NOT_LAUNCHABLE", "流程当前不可发起", "流程未发布、已停用或发布依赖不可用。");
        }

        if (launchConfig.Config.Version.Id != scope.VersionId)
        {
            return Failure(
                409,
                "PUBLISHED_VERSION_CHANGED",
                "流程发布版本已变化",
                "请刷新发起页面并按当前发布版本重新选择附件。");
        }

        var field = ReadAttachmentField(launchConfig.Config.Version.Snapshot, scope.FieldId);
        if (field is null)
        {
            return Failure(422, "ATTACHMENT_FIELD_INVALID", "附件字段无效", "指定字段不是当前发布版本中的附件字段。");
        }

        return ValidateFieldPolicy(field, attachment);
    }

    private async Task<AttachmentFailure?> ValidateFreeReplyUploadScopeAsync(
        AttachmentUploadScope scope,
        AttachmentActor actor,
        CancellationToken cancellationToken)
    {
        if (scope.InstanceId is null
            || scope.DefinitionId is not null
            || scope.VersionId is not null
            || !string.IsNullOrWhiteSpace(scope.FieldId))
        {
            return Failure(
                422,
                "ATTACHMENT_SCOPE_INCOMPLETE",
                "附件范围无效",
                "回复附件只需要提供 instanceId 和 purpose=free-reply。");
        }

        var instance = await _dbContext.WorkflowInstances
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == scope.InstanceId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (instance is null)
        {
            return Failure(404, "INSTANCE_NOT_FOUND", "流程实例不存在", "指定的流程实例不存在。");
        }

        var workflowType = await _dbContext.RuntimeWorkflowDefinitions
            .AsNoTracking()
            .Where(item => item.Id == instance.DefinitionId)
            .Select(item => item.Type)
            .SingleAsync(cancellationToken)
            .ConfigureAwait(false);
        if (workflowType != "free")
        {
            return Failure(422, "FREE_REPLY_ATTACHMENT_INVALID", "不能上传回复附件", "指定实例不是自由协作事项。");
        }

        if (instance.Status != "in-progress")
        {
            return Failure(409, "FREE_FLOW_NOT_IN_PROGRESS", "事项当前不能回复", "只有进行中的自由协作事项可以上传回复附件。");
        }

        var isParticipant = await _dbContext.FreeParticipants
            .AsNoTracking()
            .AnyAsync(item => item.InstanceId == instance.Id && item.UserId == actor.UserId, cancellationToken)
            .ConfigureAwait(false);
        return actor.IsSuperAdmin || isParticipant
            ? null
            : Failure(403, "FREE_REPLY_FORBIDDEN", "不能回复该事项", "只有发起人、当前受理人或历史参与人可以上传回复附件。");
    }

    private async Task<AttachmentFailure?> ValidateInstanceUploadScopeAsync(
        AttachmentUploadScope scope,
        AttachmentActor actor,
        RuntimeAttachment attachment,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(scope.FieldId))
        {
            return Failure(422, "ATTACHMENT_SCOPE_INCOMPLETE", "附件范围不完整", "修改实例附件时必须提供 fieldId。");
        }

        var instance = await _dbContext.WorkflowInstances
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == scope.InstanceId, cancellationToken)
            .ConfigureAwait(false);
        if (instance is null)
        {
            return Failure(404, "INSTANCE_NOT_FOUND", "流程实例不存在", "指定的流程实例不存在。");
        }

        var detailResult = await _processInstanceQueryService.GetAsync(
            instance.Id,
            new ProcessInstanceQueryActor(
                actor.UserId,
                actor.IsSuperAdmin,
                actor.CanReview,
                actor.CanLaunch,
                false,
                actor.CanViewAllInstances),
            cancellationToken).ConfigureAwait(false);
        if (detailResult.Error is not null || detailResult.Instance is null)
        {
            return Failure(403, "ATTACHMENT_UPLOAD_FORBIDDEN", "不能上传附件", "当前账号不能查看或修改该流程实例。");
        }

        var version = await _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
            .ConfigureAwait(false);
        var snapshot = JsonNode.Parse(version.SnapshotJson) as JsonObject;
        var field = snapshot is null ? null : ReadAttachmentField(snapshot, scope.FieldId);
        if (field is null)
        {
            return Failure(422, "ATTACHMENT_FIELD_INVALID", "附件字段无效", "指定字段不是实例锁定版本中的附件字段。");
        }

        var canReview = actor.CanReview && detailResult.Instance.Tasks.Any(task =>
            task.TaskType == "approval"
            && task.AllowedActions.Any(action => action is "pass" or "confirm" or "reject" or "revise-fields")
            && task.EditableFieldIds?.Contains(scope.FieldId, StringComparer.Ordinal) == true);
        var hasDecision = await _dbContext.WorkflowTasks.AsNoTracking().AnyAsync(
            task => task.InstanceId == instance.Id
                && task.Round == instance.CurrentRound
                && task.TaskType == "approval"
                && task.Action != null,
            cancellationToken).ConfigureAwait(false);
        var inputStage = ReadString(field, "inputStage") ?? "initiator";
        var canEditAsInitiator = actor.CanLaunch
            && (actor.IsSuperAdmin || instance.InitiatorUserId == actor.UserId)
            && inputStage != "reviewer"
            && (instance.Status == "rejected-pending"
                || instance.Status == "reviewing" && !hasDecision);
        if (!canReview && !canEditAsInitiator)
        {
            return Failure(403, "ATTACHMENT_UPLOAD_FORBIDDEN", "不能上传附件", "当前账号不能修改该实例的附件字段。");
        }

        return ValidateFieldPolicy(field, attachment);
    }

    private static AttachmentFailure? ValidateFieldPolicy(JsonObject field, RuntimeAttachment attachment)
    {
        var config = field["attachment"] as JsonObject;
        var maxSizeMb = ReadPositiveInt(config, "maxSizeMb") ?? 100;
        if (attachment.SizeBytes > maxSizeMb * 1024L * 1024L)
        {
            return Failure(413, "ATTACHMENT_TOO_LARGE", "附件超过大小限制", $"该字段单个文件不能超过 {maxSizeMb} MB。");
        }

        var inlinePdf = ReadOptionalBool(config, "inlinePdf") ?? true;
        if (inlinePdf
            && (attachment.Extension != "pdf" || attachment.DetectedContentType != "application/pdf"))
        {
            return Failure(415, "PDF_ATTACHMENT_REQUIRED", "文件格式不支持", "该字段用于页面内 PDF 显示，只能上传 PDF 文件。");
        }

        var allowed = ReadStringArray(config, "allowedExtensions")
            .Select(value => value.TrimStart('.').ToLowerInvariant())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var convertedPdf = ReadOptionalBool(config, "excelToPdf") == true && attachment.Extension == "pdf";
        if (allowed.Count > 0 && !allowed.Contains(attachment.Extension) && !convertedPdf)
        {
            return Failure(
                415,
                "ATTACHMENT_EXTENSION_NOT_ALLOWED",
                "文件格式不支持",
                $"该字段只允许 {string.Join("、", allowed.Select(value => $".{value}"))} 文件。");
        }

        return null;
    }

    private static JsonObject? ReadAttachmentField(JsonObject snapshot, string fieldId) =>
        snapshot["form"]?["fields"] is JsonArray fields
            ? fields.OfType<JsonObject>().FirstOrDefault(field =>
                ReadString(field, "id") == fieldId && ReadString(field, "type") == "attachment")
            : null;

    private static string CreateRequestHash(RuntimeAttachment attachment, AttachmentUploadScope scope)
    {
        var value = string.Join('\n',
            attachment.OriginalFileName,
            attachment.DeclaredContentType ?? string.Empty,
            attachment.SizeBytes?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
            attachment.Sha256 ?? string.Empty,
            scope.DefinitionId?.ToString("D") ?? string.Empty,
            scope.VersionId?.ToString("D") ?? string.Empty,
            scope.InstanceId?.ToString("D") ?? string.Empty,
            scope.FieldId ?? string.Empty,
            scope.Purpose);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }

    private static bool TryReadAttachmentId(string? json, out Guid attachmentId)
    {
        attachmentId = Guid.Empty;
        try
        {
            var value = JsonNode.Parse(json ?? string.Empty)?["attachmentId"]?.GetValue<string>();
            return Guid.TryParse(value, out attachmentId);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static int? ReadPositiveInt(JsonObject? value, string propertyName) =>
        value?[propertyName] is JsonValue item
        && item.TryGetValue<int>(out var number)
        && number > 0
            ? number
            : null;

    private static bool? ReadOptionalBool(JsonObject? value, string propertyName) =>
        value?[propertyName] is JsonValue item && item.TryGetValue<bool>(out var flag)
            ? flag
            : null;

    private static string? ReadString(JsonObject value, string propertyName) =>
        value[propertyName] is JsonValue item && item.TryGetValue<string>(out var text)
            ? text
            : null;

    private static string[] ReadStringArray(JsonObject? value, string propertyName) =>
        value?[propertyName] is JsonArray items
            ? items.Select(item => item?.GetValue<string?>())
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Select(item => item!)
                .ToArray()
            : [];
}
