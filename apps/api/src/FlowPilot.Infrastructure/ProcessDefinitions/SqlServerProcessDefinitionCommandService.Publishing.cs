using System.Data;
using System.Text.Json;
using FlowPilot.Application.ProcessDefinitions;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionCommandService
{
    private const string PublishRouteScope =
        "POST /process-definitions/{definitionId}/versions/{versionId}/publish";
    private const string UnpublishRouteScope =
        "POST /process-definitions/{definitionId}/versions/{versionId}/unpublish";

    public async Task<ProcessDefinitionCommandResult<PublishProcessVersionCommandValue>> PublishAsync(
        Guid definitionId,
        Guid versionId,
        PublishProcessVersionRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var changeNote = request.ChangeNote.Trim();
        var requestHash = HashRequest(
            $"{PublishRouteScope}\n{definitionId:D}:{versionId:D}:{expectedRevision}:" +
            JsonSerializer.Serialize(changeNote, JsonOptions));
        var reservation = await ReserveIdempotencyAsync<PublishProcessVersionCommandValue>(
            actor.EffectiveUserId,
            PublishRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return Succeeded(reservation.ReplayValue with { Replayed = true });
        }

        if (reservation.Failure is not null)
        {
            return Failed<PublishProcessVersionCommandValue>(reservation.Failure);
        }

        var now = UtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var failure = ValidateRequiredText(
                changeNote,
                "changeNote",
                "CHANGE_NOTE_REQUIRED",
                "发布说明不能为空",
                "请填写本次发布内容。");
            var state = failure is null
                ? await LoadVersionForUpdateAsync(definitionId, versionId, cancellationToken)
                    .ConfigureAwait(false)
                : null;
            failure ??= ValidateStateForMutation(state, expectedRevision, requireEditable: false);
            if (failure is null && state!.PublishedVersionId == versionId)
            {
                failure = new ProcessDefinitionCommandFailure(
                    ProcessDefinitionCommandError.Conflict,
                    "VERSION_ALREADY_PUBLISHED",
                    "流程版本已经发布",
                    "当前版本已经是流程的发布版本，无需重复发布。");
            }

            if (failure is not null)
            {
                return await CompleteFailureAsync(
                    reservation,
                    failure,
                    traceId,
                    transaction,
                    cancellationToken).ConfigureAwait(false);
            }

            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var basic = ParseBasic(state!.BasicJson);
            var snapshot = ParseObject(state.SnapshotJson, "snapshot_json");
            var validation = ValidateVersion(basic, snapshot, catalog, now);
            if (!string.Equals(validation.Status, "passed", StringComparison.Ordinal))
            {
                await UpdateValidationAsync(
                    state,
                    validation,
                    SerializeValidation(validation),
                    actor.EffectiveUserId,
                    now,
                    cancellationToken).ConfigureAwait(false);
                failure = PublishValidationFailure(validation);
                return await CompleteFailureAsync(
                    reservation,
                    failure,
                    traceId,
                    transaction,
                    cancellationToken).ConfigureAwait(false);
            }

            var previousPublishedVersionId = state.PublishedVersionId;
            if (previousPublishedVersionId.HasValue)
            {
                await MarkVersionUnpublishedAsync(
                    state.DefinitionId,
                    previousPublishedVersionId.Value,
                    changeNote,
                    actor.EffectiveUserId,
                    now,
                    cancellationToken).ConfigureAwait(false);
            }

            await MarkVersionPublishedAsync(
                state,
                validation,
                changeNote,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await SetPublishedVersionAsync(
                state,
                basic,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertAuditAsync(
                versionId,
                "process-version.published",
                ["publishedVersionId", "changeNote", "validation"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);

            var value = new PublishProcessVersionCommandValue(
                checked(state.DefinitionRevision + 1),
                checked(state.Revision + 1),
                previousPublishedVersionId,
                false);
            await CompleteIdempotencySuccessAsync(
                reservation,
                200,
                value.DefinitionRevision,
                value,
                location: null,
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(value);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ProcessDefinitionCommandResult<UnpublishProcessVersionCommandValue>> UnpublishAsync(
        Guid definitionId,
        Guid versionId,
        UnpublishProcessVersionRequest request,
        int expectedDefinitionRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var reason = request.Reason.Trim();
        var requestHash = HashRequest(
            $"{UnpublishRouteScope}\n{definitionId:D}:{versionId:D}:{expectedDefinitionRevision}:" +
            JsonSerializer.Serialize(reason, JsonOptions));
        var reservation = await ReserveIdempotencyAsync<UnpublishProcessVersionCommandValue>(
            actor.EffectiveUserId,
            UnpublishRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return Succeeded(reservation.ReplayValue with { Replayed = true });
        }

        if (reservation.Failure is not null)
        {
            return Failed<UnpublishProcessVersionCommandValue>(reservation.Failure);
        }

        var now = UtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var failure = ValidateRequiredText(
                reason,
                "reason",
                "REASON_REQUIRED",
                "取消发布原因不能为空",
                "请填写取消发布原因。");
            var state = failure is null
                ? await LoadVersionForUpdateAsync(definitionId, versionId, cancellationToken)
                    .ConfigureAwait(false)
                : null;
            if (failure is null && state is null)
            {
                failure = new ProcessDefinitionCommandFailure(
                    ProcessDefinitionCommandError.NotFound,
                    "VERSION_NOT_FOUND",
                    "流程版本不存在",
                    "未找到指定流程定义下的流程版本。");
            }
            else if (failure is null && state!.DefinitionRevision != expectedDefinitionRevision)
            {
                failure = new ProcessDefinitionCommandFailure(
                    ProcessDefinitionCommandError.RevisionMismatch,
                    "REVISION_MISMATCH",
                    "流程定义已被修改",
                    "请重新加载最新流程定义后再提交。",
                    CurrentRevision: state.DefinitionRevision);
            }
            else if (failure is null && state!.PublishedVersionId != versionId)
            {
                failure = new ProcessDefinitionCommandFailure(
                    ProcessDefinitionCommandError.Conflict,
                    "PUBLISH_POINTER_CHANGED",
                    "发布状态已经变化",
                    "当前版本已不是流程的发布版本，请刷新后重试。");
            }

            if (failure is not null)
            {
                return await CompleteFailureAsync(
                    reservation,
                    failure,
                    traceId,
                    transaction,
                    cancellationToken).ConfigureAwait(false);
            }

            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var basic = ParseBasic(state!.BasicJson);
            var snapshot = ParseObject(state.SnapshotJson, "snapshot_json");
            var validation = ValidateVersion(basic, snapshot, catalog, now);

            await UnpublishCurrentVersionAsync(
                state,
                validation,
                reason,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await ClearPublishedVersionAsync(
                state,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertAuditAsync(
                versionId,
                "process-version.unpublished",
                ["publishedVersionId", "reason", "validation"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);

            var value = new UnpublishProcessVersionCommandValue(
                checked(state.DefinitionRevision + 1),
                checked(state.Revision + 1),
                false);
            await CompleteIdempotencySuccessAsync(
                reservation,
                200,
                value.DefinitionRevision,
                value,
                location: null,
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(value);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private static ProcessDefinitionCommandResult<T> Succeeded<T>(T value) => new(value, null);

    private static ProcessDefinitionCommandResult<T> Failed<T>(
        ProcessDefinitionCommandFailure failure) => new(default, failure);

    private async Task<ProcessDefinitionCommandResult<T>> CompleteFailureAsync<T>(
        IdempotencyReservation<T> reservation,
        ProcessDefinitionCommandFailure failure,
        string traceId,
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        CancellationToken cancellationToken)
    {
        await CompleteIdempotencyFailureInCurrentTransactionAsync(
            reservation,
            failure,
            traceId,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Failed<T>(failure);
    }

    private static ProcessDefinitionCommandFailure? ValidateRequiredText(
        string value,
        string path,
        string code,
        string title,
        string detail)
    {
        if (value.Length is >= 1 and <= 1000)
        {
            return null;
        }

        var issueCode = value.Length == 0 ? "REQUIRED" : "INVALID_LENGTH";
        return new ProcessDefinitionCommandFailure(
            ProcessDefinitionCommandError.ValidationFailed,
            code,
            title,
            detail,
            [new ProcessDefinitionInputIssueDto(path, issueCode, detail)]);
    }

    private static ProcessDefinitionCommandFailure PublishValidationFailure(
        ProcessVersionValidationDto validation) => new(
            ProcessDefinitionCommandError.ValidationFailed,
            "VALIDATION_FAILED",
            "版本校验未通过",
            "请修复所有校验问题后重新发布。",
            validation.Issues
                .Select(issue => new ProcessDefinitionInputIssueDto(
                    issue.Path ?? "snapshot",
                    issue.Code,
                    issue.Message))
                .ToArray(),
            CurrentRevision: null);

    private async Task MarkVersionPublishedAsync(
        VersionState state,
        ProcessVersionValidationDto validation,
        string changeNote,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[workflow_definition_versions]
            SET [validation_status] = @validation_status,
                [validation_json] = @validation_json,
                [validated_at] = @validated_at,
                [change_note] = @change_note,
                [first_published_at] = COALESCE([first_published_at], @published_at),
                [first_published_by] = COALESCE([first_published_by], @published_by),
                [latest_published_at] = @published_at,
                [latest_published_by] = @published_by,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @version_id
              AND [definition_id] = @definition_id
              AND [revision] = @revision;
            """;
        Add(command, "@validation_status", SqlDbType.NVarChar, validation.Status, 20);
        Add(command, "@validation_json", SqlDbType.NVarChar, SerializeValidation(validation));
        Add(command, "@validated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@change_note", SqlDbType.NVarChar, changeNote, 1000);
        Add(command, "@published_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@published_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@version_id", SqlDbType.UniqueIdentifier, state.VersionId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, state.DefinitionId);
        Add(command, "@revision", SqlDbType.Int, state.Revision);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The process version changed while it was being published.");
        }
    }

    private async Task MarkVersionUnpublishedAsync(
        Guid definitionId,
        Guid versionId,
        string reason,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[workflow_definition_versions]
            SET [unpublished_at] = @unpublished_at,
                [unpublished_by] = @unpublished_by,
                [unpublished_reason] = @unpublished_reason,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @version_id
              AND [definition_id] = @definition_id;
            """;
        Add(command, "@unpublished_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@unpublished_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@unpublished_reason", SqlDbType.NVarChar, reason, 1000);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@version_id", SqlDbType.UniqueIdentifier, versionId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, definitionId);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The previous published version could not be updated.");
        }
    }

    private async Task UnpublishCurrentVersionAsync(
        VersionState state,
        ProcessVersionValidationDto validation,
        string reason,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[workflow_definition_versions]
            SET [validation_status] = @validation_status,
                [validation_json] = @validation_json,
                [validated_at] = @validated_at,
                [unpublished_at] = @unpublished_at,
                [unpublished_by] = @unpublished_by,
                [unpublished_reason] = @unpublished_reason,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @version_id
              AND [definition_id] = @definition_id
              AND [revision] = @revision;
            """;
        Add(command, "@validation_status", SqlDbType.NVarChar, validation.Status, 20);
        Add(command, "@validation_json", SqlDbType.NVarChar, SerializeValidation(validation));
        Add(command, "@validated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@unpublished_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@unpublished_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@unpublished_reason", SqlDbType.NVarChar, reason, 1000);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@version_id", SqlDbType.UniqueIdentifier, state.VersionId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, state.DefinitionId);
        Add(command, "@revision", SqlDbType.Int, state.Revision);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The process version changed while it was unpublished.");
        }
    }

    private async Task SetPublishedVersionAsync(
        VersionState state,
        ProcessBasicConfigInput basic,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[workflow_definitions]
            SET [name] = @name,
                [description] = @description,
                [published_version_id] = @published_version_id,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @definition_id
              AND [revision] = @revision;
            """;
        Add(command, "@name", SqlDbType.NVarChar, basic.Name, 200);
        AddNullable(command, "@description", SqlDbType.NVarChar, basic.Description, 2000);
        Add(command, "@published_version_id", SqlDbType.UniqueIdentifier, state.VersionId);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, state.DefinitionId);
        Add(command, "@revision", SqlDbType.Int, state.DefinitionRevision);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The process definition changed while it was published.");
        }
    }

    private async Task ClearPublishedVersionAsync(
        VersionState state,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[workflow_definitions]
            SET [published_version_id] = NULL,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @definition_id
              AND [published_version_id] = @version_id
              AND [revision] = @revision;
            """;
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, state.DefinitionId);
        Add(command, "@version_id", SqlDbType.UniqueIdentifier, state.VersionId);
        Add(command, "@revision", SqlDbType.Int, state.DefinitionRevision);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The process definition changed while it was unpublished.");
        }
    }
}
