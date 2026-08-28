using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private async Task<string?> IssueInstanceNumberAsync(
        string prefix,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var yearMonth = now.ToOffset(TimeSpan.FromHours(8)).ToString("yyyyMM", System.Globalization.CultureInfo.InvariantCulture);
        var counter = await _dbContext.NumberCounters
            .FromSqlInterpolated(
                $"""
                SELECT [prefix], [year_month], [next_value], [revision], [updated_at]
                FROM [flowpilot].[number_counters] WITH (UPDLOCK, HOLDLOCK)
                WHERE [prefix] = {prefix} AND [year_month] = {yearMonth}
                """)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);

        long value;
        if (counter is null)
        {
            value = 1;
            _dbContext.NumberCounters.Add(new NumberCounterEntity
            {
                Prefix = prefix,
                YearMonth = yearMonth,
                NextValue = 2,
                Revision = 1,
                UpdatedAt = now.UtcDateTime,
            });
        }
        else
        {
            value = counter.NextValue;
            counter.NextValue = checked(counter.NextValue + 1);
            counter.Revision = checked(counter.Revision + 1);
            counter.UpdatedAt = now.UtcDateTime;
        }

        return value > 9999
            ? null
            : $"{prefix}{yearMonth[2..]}{value:0000}";
    }

    private static WorkflowInstanceEntity CreateInstanceEntity(
        Guid instanceId,
        string instanceNumber,
        RuntimeWorkflowDefinition definition,
        RuntimeWorkflowVersion version,
        ProcessInstanceActor actor,
        string verifiedEntryBaseUrl,
        JsonObject formValues,
        JsonObject fieldRevisions,
        RuntimeValue runtime,
        DateTimeOffset now) => new()
    {
        Id = instanceId,
        InstanceNumber = instanceNumber,
        DefinitionId = definition.Id,
        VersionId = version.Id,
        InitiatorUserId = actor.EffectiveUserId,
        ActualInitiatorUserId = actor.OperatorUserId,
        Title = ReadRequiredString(formValues, "title"),
        Status = runtime.Status,
        CurrentRound = 1,
        CurrentNodeSummary = string.Join("、", runtime.CurrentNodeNames),
        CurrentAssigneeId = runtime.CurrentAssignee?.Id,
        VerifiedEntryBaseUrl = verifiedEntryBaseUrl,
        FormValuesJson = formValues.ToJsonString(JsonOptions),
        FieldRevisionsJson = fieldRevisions.ToJsonString(JsonOptions),
        CreatedAt = now.UtcDateTime,
        UpdatedAt = now.UtcDateTime,
        SubmittedAt = now.UtcDateTime,
        CompletedAt = runtime.CompletedAt?.UtcDateTime,
        Revision = 1,
    };

    private void AddRuntimeFacts(
        WorkflowInstanceEntity instance,
        RuntimeValue runtime,
        ProcessInstanceActor actor,
        Guid? copySourceInstanceId,
        string traceId,
        DateTimeOffset now)
    {
        var metadata = new JsonObject
        {
            ["instanceNumber"] = instance.InstanceNumber,
            ["versionId"] = instance.VersionId,
        };
        if (copySourceInstanceId.HasValue)
        {
            metadata["copySourceInstanceId"] = copySourceInstanceId.Value;
        }

        _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
        {
            Id = runtime.CreatedEventId,
            EventType = "instance-created",
            InstanceId = instance.Id,
            Round = 1,
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            OccurredAt = now.UtcDateTime,
            MetadataJson = metadata.ToJsonString(JsonOptions),
        });
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "process-instance",
            ResourceId = instance.Id,
            Action = "create",
            FieldIdentifiersJson = JsonSerializer.Serialize(
                JsonNode.Parse(instance.FormValuesJson)!.AsObject().Select(item => item.Key).ToArray(),
                JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });

        if (runtime.FirstAssignee is null || runtime.FreeTimelineId is null)
        {
            return;
        }

        _dbContext.FreeTimelineEntries.Add(new FreeTimelineEntryEntity
        {
            Id = runtime.FreeTimelineId.Value,
            InstanceId = instance.Id,
            EntryType = "created",
            ActorUserId = actor.EffectiveUserId,
            AssigneeId = runtime.FirstAssignee.Id,
            OccurredAt = now.UtcDateTime,
            Revision = 1,
        });
        _dbContext.FreeParticipants.Add(new FreeParticipantEntity
        {
            InstanceId = instance.Id,
            UserId = actor.EffectiveUserId,
            SourceFlags = 1,
            FirstParticipatedAt = now.UtcDateTime,
            LastParticipatedAt = now.UtcDateTime,
        });
        if (runtime.FirstAssignee.Id != actor.EffectiveUserId)
        {
            _dbContext.FreeParticipants.Add(new FreeParticipantEntity
            {
                InstanceId = instance.Id,
                UserId = runtime.FirstAssignee.Id,
                SourceFlags = 2,
                FirstParticipatedAt = now.UtcDateTime,
                LastParticipatedAt = now.UtcDateTime,
            });
        }
    }

    private async Task AddFieldProjectionsAsync(
        WorkflowInstanceEntity instance,
        JsonObject formValues,
        CancellationToken cancellationToken)
    {
        var fields = await _dbContext.RuntimeVersionFields
            .AsNoTracking()
            .Where(item => item.VersionId == instance.VersionId
                && item.TableFieldId == null
                && item.IsQueryable)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var field in fields)
        {
            var projection = CreateFieldProjection(instance, field, formValues[field.FieldId]);
            if (projection is not null)
            {
                _dbContext.InstanceFieldValues.Add(projection);
            }
        }
    }

    private static InstanceFieldValueEntity? CreateFieldProjection(
        WorkflowInstanceEntity instance,
        RuntimeVersionField field,
        JsonNode? value)
    {
        if (IsEmpty(value))
        {
            return null;
        }

        var projection = new InstanceFieldValueEntity
        {
            Id = Guid.NewGuid(),
            InstanceId = instance.Id,
            DefinitionId = instance.DefinitionId,
            VersionId = instance.VersionId,
            FieldId = field.FieldId,
        };
        if (field.FieldType is "radio" or "select")
        {
            projection.ValueType = "option";
            projection.OptionId = DisplayValue(value);
            return projection;
        }

        if (value is JsonValue scalar && scalar.TryGetValue<bool>(out var boolean))
        {
            projection.ValueType = "boolean";
            projection.BooleanValue = boolean;
            return projection;
        }

        if (value is JsonValue numberValue && numberValue.TryGetValue<decimal>(out var number))
        {
            projection.ValueType = "number";
            projection.NumberValue = number;
            return projection;
        }

        var text = DisplayValue(value);
        if (text.Length > 2000)
        {
            throw new InvalidDataException($"Queryable field {field.FieldId} exceeds 2000 characters.");
        }

        projection.ValueType = "text";
        projection.TextValue = text;
        projection.TextValueHash = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return projection;
    }

    private async Task<AttachmentPreparation> ValidateAttachmentsAsync(
        CreateProcessInstanceRequest request,
        JsonObject snapshot,
        Guid actorId,
        CancellationToken cancellationToken)
    {
        var mappedIds = request.AttachmentIdsByField.Values.SelectMany(ids => ids).ToArray();
        var requestedIds = request.AttachmentIds.Count > 0
            ? request.AttachmentIds.ToArray()
            : mappedIds;
        var issues = new List<ProcessInstanceInputIssueDto>();
        if (requestedIds.Distinct().Count() != requestedIds.Length
            || mappedIds.Distinct().Count() != mappedIds.Length
            || !requestedIds.ToHashSet().SetEquals(mappedIds))
        {
            issues.Add(Issue(
                "attachmentIdsByField",
                "ATTACHMENT_FIELD_MISSING",
                "每个附件必须且只能关联一个当前表单字段。"));
        }

        var attachmentFields = ReadFormFields(snapshot)
            .Where(field => ReadString(field, "type") == "attachment")
            .ToDictionary(field => ReadRequiredString(field, "id"), StringComparer.Ordinal);
        foreach (var pair in request.AttachmentIdsByField)
        {
            if (!attachmentFields.TryGetValue(pair.Key, out var field))
            {
                issues.Add(Issue(
                    $"attachmentIdsByField.{pair.Key}",
                    "ATTACHMENT_FIELD_INVALID",
                    "附件字段不属于当前发布版本。"));
                continue;
            }

            var attachment = field["attachment"] as JsonObject;
            var maxCount = ReadInt(attachment, "maxCount") ?? (ReadBool(attachment, "inlinePdf") ? 1 : 20);
            if (pair.Value.Count > maxCount)
            {
                issues.Add(Issue(
                    $"attachmentIdsByField.{pair.Key}",
                    "ATTACHMENT_LIMIT_REACHED",
                    $"该字段最多允许 {maxCount} 个附件。"));
            }
        }

        if (issues.Count > 0)
        {
            return AttachmentPreparation.Failed(AttachmentFailure(issues));
        }

        if (requestedIds.Length == 0)
        {
            return AttachmentPreparation.Succeeded([]);
        }

        var attachments = await _dbContext.RuntimeAttachments
            .Where(item => requestedIds.Contains(item.Id))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var referencedIds = await _dbContext.AttachmentReferences
            .AsNoTracking()
            .Where(item => requestedIds.Contains(item.AttachmentId))
            .Select(item => item.AttachmentId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (attachments.Length != requestedIds.Length
            || attachments.Any(item => item.State != "staged" || item.UploadedBy != actorId)
            || referencedIds.Length > 0)
        {
            return AttachmentPreparation.Failed(Failure(
                ProcessInstanceCommandError.Forbidden,
                "ATTACHMENT_REFERENCE_FORBIDDEN",
                "不能使用部分附件",
                "发起流程只能提交当前用户尚未关联业务数据的暂存附件。"));
        }

        var fieldByAttachment = request.AttachmentIdsByField
            .SelectMany(pair => pair.Value.Select(id => (Id: id, FieldId: pair.Key)))
            .ToDictionary(item => item.Id, item => item.FieldId);
        foreach (var attachment in attachments)
        {
            var fieldId = fieldByAttachment[attachment.Id];
            var config = attachmentFields[fieldId]["attachment"] as JsonObject;
            var maxSizeMb = ReadInt(config, "maxSizeMb") ?? 100;
            if (attachment.SizeBytes > maxSizeMb * 1024L * 1024L)
            {
                issues.Add(Issue($"attachmentIdsByField.{fieldId}", "ATTACHMENT_TOO_LARGE", $"附件大小不能超过 {maxSizeMb} MB。"));
            }

            var contentType = attachment.DetectedContentType ?? attachment.DeclaredContentType ?? "application/octet-stream";
            if (ReadBool(config, "inlinePdf")
                && contentType != "application/pdf"
                && !attachment.OriginalFileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
            {
                issues.Add(Issue($"attachmentIdsByField.{fieldId}", "PDF_ATTACHMENT_REQUIRED", "该字段只允许 PDF 文件。"));
            }
        }

        if (issues.Count > 0)
        {
            return AttachmentPreparation.Failed(AttachmentFailure(issues));
        }

        return AttachmentPreparation.Succeeded(attachments
            .Select(item => new AttachmentSelection(item, fieldByAttachment[item.Id]))
            .ToArray());
    }

    private static ProcessInstanceCommandFailure AttachmentFailure(
        IReadOnlyList<ProcessInstanceInputIssueDto> issues) => Failure(
            ProcessInstanceCommandError.ValidationFailed,
            "ATTACHMENT_VALIDATION_FAILED",
            "附件校验未通过",
            "请重新选择符合当前表单配置的附件。",
            issues);

    private void AddAttachmentReferences(
        Guid instanceId,
        IReadOnlyList<AttachmentSelection> selections,
        Guid actorId,
        DateTimeOffset now)
    {
        foreach (var selection in selections)
        {
            selection.Attachment.State = "active";
            selection.Attachment.CleanupAfter = null;
            selection.Attachment.Revision = checked(selection.Attachment.Revision + 1);
            _dbContext.AttachmentReferences.Add(new AttachmentReferenceEntity
            {
                Id = Guid.NewGuid(),
                AttachmentId = selection.Attachment.Id,
                InstanceId = instanceId,
                FieldId = selection.FieldId,
                ReferenceType = "form-field",
                CreatedBy = actorId,
                CreatedAt = now.UtcDateTime,
            });
        }
    }

    private static int? ReadInt(JsonObject? source, string propertyName) =>
        source?[propertyName] is JsonValue value && value.TryGetValue<int>(out var result)
            ? result
            : null;

    private sealed record AttachmentSelection(RuntimeAttachment Attachment, string FieldId);

    private sealed record AttachmentPreparation(
        IReadOnlyList<AttachmentSelection>? Value,
        ProcessInstanceCommandFailure? Failure)
    {
        public static AttachmentPreparation Succeeded(IReadOnlyList<AttachmentSelection> value) => new(value, null);
        public static AttachmentPreparation Failed(ProcessInstanceCommandFailure failure) => new(null, failure);
    }
}
