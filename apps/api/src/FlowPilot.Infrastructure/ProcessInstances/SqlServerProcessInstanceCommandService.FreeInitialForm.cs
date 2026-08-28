using System.Data;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    public async Task<ProcessInstanceCommandResult<UpdateProcessInstanceSubmissionCommandValue>> UpdateFreeInitialFormAsync(
        Guid instanceId,
        UpdateProcessInstanceSubmissionRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        if (request.FormValues is null)
        {
            return UpdateFailed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "初始表单不完整",
                "请填写自由协作初始表单。",
                [Issue("formValues", "REQUIRED", "请填写初始表单。")]));
        }

        if ((request.AssigneeByNode?.Count ?? 0) > 0)
        {
            return UpdateFailed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "ASSIGNEE_NOT_APPLICABLE",
                "不能修改审核责任人",
                "自由协作流程没有审核节点。",
                [Issue("assigneeByNode", "NOT_APPLICABLE", "自由协作流程不使用审核节点责任人。")]));
        }

        var normalizedRequest = request with
        {
            AttachmentIds = request.AttachmentIds ?? [],
            AttachmentIdsByField = request.AttachmentIdsByField
                ?? new Dictionary<string, IReadOnlyList<Guid>>(),
            AssigneeByNode = request.AssigneeByNode ?? new Dictionary<string, Guid>(),
        };

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var preparation = await LoadFreeInstanceAsync(
                instanceId,
                expectedRevision,
                transaction,
                cancellationToken).ConfigureAwait(false);
            if (preparation.Failure is not null)
            {
                return UpdateFailed(preparation.Failure);
            }

            var instance = preparation.Value!;
            if (!actor.IsSuperAdmin && instance.InitiatorUserId != actor.EffectiveUserId)
            {
                return await RollbackUpdateFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Forbidden,
                        "FREE_INITIAL_FORM_FORBIDDEN",
                        "不能修改初始表单",
                        "只有该事项的实际发起人可以修改初始表单。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            if (!TryParseVersion(version, out _, out var snapshot))
            {
                return await RollbackUpdateFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "LOCKED_VERSION_INVALID",
                        "流程版本不可用",
                        "实例锁定的自由协作版本配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var lockedSnapshot = snapshot!;
            var oldValues = ParseStoredObject(instance.FormValuesJson);
            var form = NormalizeAndValidateForm(request.FormValues, lockedSnapshot, oldValues);
            if (form.Failure is not null)
            {
                return await RollbackUpdateFailureAsync(transaction, form.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var currentReferences = await _dbContext.AttachmentReferences
                .Where(reference => reference.InstanceId == instance.Id
                    && reference.ReferenceType == "form-field")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var attachments = await ValidateUpdatedAttachmentsAsync(
                normalizedRequest,
                lockedSnapshot,
                actor.EffectiveUserId,
                currentReferences,
                cancellationToken).ConfigureAwait(false);
            if (attachments.Failure is not null)
            {
                return await RollbackUpdateFailureAsync(transaction, attachments.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var now = _timeProvider.GetUtcNow();
            var changedFieldIds = ChangedFieldIds(oldValues, form.Values!);
            var changedAttachmentFieldIds = await ReplaceAttachmentReferencesAsync(
                instance.Id,
                currentReferences,
                attachments.Value!,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            var revisedFieldIds = changedFieldIds
                .Concat(changedAttachmentFieldIds)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (revisedFieldIds.Length == 0)
            {
                return await RollbackUpdateFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "FREE_INITIAL_FORM_UNCHANGED",
                        "初始表单没有变化",
                        "请修改初始表单后再保存。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var fieldRevisions = UpdateFieldRevisions(
                ParseStoredObject(instance.FieldRevisionsJson),
                revisedFieldIds);
            instance.Title = ReadRequiredString(form.Values!, "title");
            instance.FormValuesJson = form.Values!.ToJsonString(JsonOptions);
            instance.FieldRevisionsJson = fieldRevisions.ToJsonString(JsonOptions);
            instance.UpdatedAt = now.UtcDateTime;

            var projections = await _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == instance.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            _dbContext.InstanceFieldValues.RemoveRange(projections);
            await AddFieldProjectionsAsync(instance, form.Values!, cancellationToken)
                .ConfigureAwait(false);

            var changes = BuildFreeInitialFormChanges(lockedSnapshot, revisedFieldIds);
            _dbContext.FreeTimelineEntries.Add(new FreeTimelineEntryEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instance.Id,
                EntryType = "form-edited",
                ActorUserId = actor.EffectiveUserId,
                FieldChangesJson = BuildFreeFieldChangesJson(changes),
                OccurredAt = now.UtcDateTime,
                Revision = 1,
            });
            AddFreeAudit(instance.Id, "edit-initial-form", actor, traceId, now, revisedFieldIds);

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return UpdateSucceeded(instance.Id, instance.Revision);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return UpdateFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private static WorkflowFieldChangeDto[] BuildFreeInitialFormChanges(
        JsonObject snapshot,
        IReadOnlyList<string> fieldIds)
    {
        var labels = ReadFormFields(snapshot).ToDictionary(
            field => ReadRequiredString(field, "id"),
            field => ReadString(field, "label") ?? ReadRequiredString(field, "id"),
            StringComparer.Ordinal);
        return fieldIds
            .Select(fieldId => new WorkflowFieldChangeDto(
                fieldId,
                labels.GetValueOrDefault(fieldId, fieldId)))
            .ToArray();
    }

    private static string BuildFreeFieldChangesJson(IReadOnlyList<WorkflowFieldChangeDto> changes) =>
        new JsonObject
        {
            ["fieldIds"] = new JsonArray(changes
                .Select(change => (JsonNode?)JsonValue.Create(change.FieldId))
                .ToArray()),
            ["fieldNames"] = new JsonArray(changes
                .Select(change => (JsonNode?)JsonValue.Create(change.LabelSnapshot))
                .ToArray()),
        }.ToJsonString(JsonOptions);
}
