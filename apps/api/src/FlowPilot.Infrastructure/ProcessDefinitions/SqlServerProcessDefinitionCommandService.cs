using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionCommandService(
    FlowPilotDbContext dbContext,
    FlowPilotDatabaseOptions databaseOptions,
    TimeProvider timeProvider) : IProcessDefinitionCommandService
{
    private const string CreateRouteScope = "POST /process-definitions";
    private const string ValidateRouteScope =
        "POST /process-definitions/{definitionId}/versions/{versionId}/validate";
    private static readonly TimeSpan IdempotencyLease = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan IdempotencyRetention = TimeSpan.FromDays(7);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> FieldTypes =
        ["text", "textarea", "rich-text", "radio", "checkbox", "select", "cascader", "table", "attachment"];
    private static readonly HashSet<string> ConditionOperators =
        ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not-contains", "empty", "not-empty"];
    private static readonly HashSet<string> SystemFieldKeys =
        ["instanceCode", "processName", "processVersion", "status", "currentNode", "currentRound", "initiator", "createdAt", "updatedAt"];

    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly int _commandTimeoutSeconds = databaseOptions.ApplicationCommandTimeoutSeconds;
    private readonly TimeProvider _timeProvider = timeProvider;

    public async Task<ProcessDefinitionCommandResult<CreateProcessDefinitionCommandValue>> CreateAsync(
        ProcessBasicConfigInput basic,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(basic);
        ArgumentNullException.ThrowIfNull(actor);

        var normalizedBasic = NormalizeBasic(basic);
        var requestHash = HashRequest(
            $"{CreateRouteScope}\n{JsonSerializer.Serialize(normalizedBasic, JsonOptions)}");
        var reservation = await ReserveIdempotencyAsync<CreateProcessDefinitionResponseDto>(
            actor.EffectiveUserId,
            CreateRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return new ProcessDefinitionCommandResult<CreateProcessDefinitionCommandValue>(
                new CreateProcessDefinitionCommandValue(
                    reservation.ReplayValue,
                    reservation.ReplayRevision!.Value,
                    true),
                null);
        }

        if (reservation.Failure is not null)
        {
            return new ProcessDefinitionCommandResult<CreateProcessDefinitionCommandValue>(
                null,
                reservation.Failure);
        }

        var now = UtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var inputIssues = ValidateBasicInput(normalizedBasic, catalog);
            if (inputIssues.Count > 0)
            {
                var failure = ValidationFailure("流程基本信息校验失败", inputIssues);
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return new ProcessDefinitionCommandResult<CreateProcessDefinitionCommandValue>(null, failure);
            }

            var definitionId = Guid.NewGuid();
            var versionId = Guid.NewGuid();
            var code = CreateDefinitionCode(normalizedBasic.Type, definitionId);
            var snapshot = CreateDefaultSnapshot(normalizedBasic, now);
            var validation = ValidateVersion(normalizedBasic, snapshot, catalog, now);
            var basicJson = SerializeNode(CreateBasicNode(normalizedBasic));
            var snapshotJson = SerializeNode(snapshot);
            var validationJson = SerializeValidation(validation);

            await InsertDefinitionAsync(
                definitionId,
                code,
                normalizedBasic,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertVersionAsync(
                versionId,
                definitionId,
                basicJson,
                snapshotJson,
                validation,
                validationJson,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await ReplaceReferencesAsync(
                versionId,
                normalizedBasic,
                snapshot,
                cancellationToken).ConfigureAwait(false);
            await ReplaceFieldCatalogAsync(versionId, snapshot, cancellationToken)
                .ConfigureAwait(false);
            await InsertAuditAsync(
                definitionId,
                "create",
                ["basic", "form", "systemFields", "flow"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);

            var response = CreateResponse(
                definitionId,
                versionId,
                code,
                normalizedBasic,
                snapshot,
                validation,
                actor,
                now,
                basicJson,
                snapshotJson);
            await CompleteIdempotencySuccessAsync(
                reservation,
                201,
                1,
                response,
                $"/api/flowpilot/v1/process-definitions/{definitionId:D}",
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);

            return new ProcessDefinitionCommandResult<CreateProcessDefinitionCommandValue>(
                new CreateProcessDefinitionCommandValue(response, 1, false),
                null);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveBasicAsync(
        Guid definitionId,
        Guid versionId,
        ProcessBasicConfigInput basic,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default) =>
        SaveAsync(
            definitionId,
            versionId,
            expectedRevision,
            actor,
            traceId,
            "save-basic",
            async (state, catalog, now, token) =>
            {
                var normalized = NormalizeBasic(basic);
                var issues = ValidateBasicInput(normalized, catalog, state.DefinitionType);
                if (issues.Count > 0)
                {
                    return SavePreparation.Failed(
                        ValidationFailure("流程基本信息校验失败", issues));
                }

                var snapshot = ParseObject(state.SnapshotJson, "snapshot_json");
                foreach (var startNode in FlowNodes(snapshot)
                    .Where(node => string.Equals(NodeKind(node), "start", StringComparison.Ordinal)))
                {
                    if (startNode["data"] is JsonObject data)
                    {
                        data["permissionGroupIds"] = GuidArray(normalized.StarterGroupIds);
                    }
                }

                return SavePreparation.Ready(
                    normalized,
                    snapshot,
                    SerializeNode(CreateBasicNode(normalized)),
                    SerializeNode(snapshot),
                    []);
            },
            cancellationToken);

    public Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveFormAsync(
        Guid definitionId,
        Guid versionId,
        SaveFormDesignerRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default) =>
        SaveAsync(
            definitionId,
            versionId,
            expectedRevision,
            actor,
            traceId,
            "save-form-designer",
            (state, _, now, _) =>
            {
                var normalizedForm = NormalizeForm(request, now);
                if (normalizedForm.Failure is not null)
                {
                    return Task.FromResult(SavePreparation.Failed(normalizedForm.Failure));
                }

                var basic = ParseBasic(state.BasicJson);
                var snapshot = ParseObject(state.SnapshotJson, "snapshot_json");
                snapshot["form"] = normalizedForm.Form!;
                snapshot["systemFields"] = normalizedForm.SystemFields!;
                var removed = RemoveMissingFlowFieldReferences(snapshot);
                return Task.FromResult(SavePreparation.Ready(
                    basic,
                    snapshot,
                    state.BasicJson,
                    SerializeNode(snapshot),
                    removed));
            },
            cancellationToken);

    public Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveFlowAsync(
        Guid definitionId,
        Guid versionId,
        SaveFlowDesignerRequest request,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default) =>
        SaveAsync(
            definitionId,
            versionId,
            expectedRevision,
            actor,
            traceId,
            "save-flow-designer",
            (state, catalog, now, _) =>
            {
                if (!string.Equals(state.DefinitionType, "approval", StringComparison.Ordinal))
                {
                    return Task.FromResult(SavePreparation.Failed(new ProcessDefinitionCommandFailure(
                        ProcessDefinitionCommandError.Conflict,
                        "FLOW_DESIGNER_NOT_APPLICABLE",
                        "自由协作流程没有流程图",
                        "自由协作流程只需要配置初始表单和受理范围。")));
                }

                var flow = NormalizeFlow(request.Flow, now);
                if (flow.Failure is not null)
                {
                    return Task.FromResult(SavePreparation.Failed(flow.Failure));
                }

                var basic = ParseBasic(state.BasicJson) with
                {
                    Name = request.BasicPatch.Name.Trim(),
                    StarterGroupIds = [.. request.BasicPatch.StarterGroupIds],
                };
                var inputIssues = ValidateBasicInput(basic, catalog, state.DefinitionType);
                if (inputIssues.Count > 0)
                {
                    return Task.FromResult(SavePreparation.Failed(
                        ValidationFailure("流程基本信息校验失败", inputIssues)));
                }

                var snapshot = ParseObject(state.SnapshotJson, "snapshot_json");
                snapshot["flow"] = flow.Value!;
                var referenceIssues = ValidateSnapshotReferences(basic, snapshot, catalog);
                if (referenceIssues.Count > 0)
                {
                    return Task.FromResult(SavePreparation.Failed(
                        ValidationFailure("流程图引用校验失败", referenceIssues)));
                }

                return Task.FromResult(SavePreparation.Ready(
                    basic,
                    snapshot,
                    SerializeNode(CreateBasicNode(basic)),
                    SerializeNode(snapshot),
                    []));
            },
            cancellationToken);

    public async Task<ProcessDefinitionCommandResult<ValidateProcessVersionCommandValue>> ValidateAsync(
        Guid definitionId,
        Guid versionId,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        var requestHash = HashRequest(
            $"{ValidateRouteScope}\n{definitionId:D}:{versionId:D}:{expectedRevision}");
        var reservation = await ReserveIdempotencyAsync<ProcessVersionValidationDto>(
            actor.EffectiveUserId,
            ValidateRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return new ProcessDefinitionCommandResult<ValidateProcessVersionCommandValue>(
                new ValidateProcessVersionCommandValue(
                    reservation.ReplayValue,
                    reservation.ReplayRevision!.Value,
                    true),
                null);
        }

        if (reservation.Failure is not null)
        {
            return new ProcessDefinitionCommandResult<ValidateProcessVersionCommandValue>(
                null,
                reservation.Failure);
        }

        var now = UtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var state = await LoadVersionForUpdateAsync(definitionId, versionId, cancellationToken)
                .ConfigureAwait(false);
            var failure = ValidateStateForMutation(state, expectedRevision, requireEditable: false);
            if (failure is not null)
            {
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return new ProcessDefinitionCommandResult<ValidateProcessVersionCommandValue>(null, failure);
            }

            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var basic = ParseBasic(state!.BasicJson);
            var snapshot = ParseObject(state.SnapshotJson, "snapshot_json");
            var validation = ValidateVersion(basic, snapshot, catalog, now);
            var nextRevision = checked(state.Revision + 1);

            await UpdateValidationAsync(
                state,
                validation,
                SerializeValidation(validation),
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertAuditAsync(
                versionId,
                "validate-version",
                ["validation"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            await CompleteIdempotencySuccessAsync(
                reservation,
                200,
                nextRevision,
                validation,
                location: null,
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);

            return new ProcessDefinitionCommandResult<ValidateProcessVersionCommandValue>(
                new ValidateProcessVersionCommandValue(validation, nextRevision, false),
                null);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>> SaveAsync(
        Guid definitionId,
        Guid versionId,
        int expectedRevision,
        ProcessDefinitionMutationActor actor,
        string traceId,
        string action,
        Func<VersionState, ReferenceCatalog, DateTimeOffset, CancellationToken, Task<SavePreparation>> prepare,
        CancellationToken cancellationToken)
    {
        var now = UtcNow();
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var state = await LoadVersionForUpdateAsync(definitionId, versionId, cancellationToken)
                .ConfigureAwait(false);
            var stateFailure = ValidateStateForMutation(state, expectedRevision, requireEditable: true);
            if (stateFailure is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return new ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>(null, stateFailure);
            }

            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var prepared = await prepare(state!, catalog, now, cancellationToken).ConfigureAwait(false);
            if (prepared.Failure is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return new ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>(
                    null,
                    prepared.Failure);
            }

            var referenceIssues = ValidateSnapshotReferences(
                prepared.Basic!,
                prepared.Snapshot!,
                catalog);
            if (referenceIssues.Count > 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return new ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>(
                    null,
                    ValidationFailure("流程配置引用校验失败", referenceIssues));
            }

            var validation = ValidateVersion(prepared.Basic!, prepared.Snapshot!, catalog, now);
            await UpdateVersionAsync(
                state!,
                prepared.BasicJson!,
                prepared.SnapshotJson!,
                validation,
                SerializeValidation(validation),
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await ReplaceReferencesAsync(
                versionId,
                prepared.Basic!,
                prepared.Snapshot!,
                cancellationToken).ConfigureAwait(false);
            await ReplaceFieldCatalogAsync(versionId, prepared.Snapshot!, cancellationToken)
                .ConfigureAwait(false);

            await UpdateDefinitionAfterVersionSaveAsync(
                state!,
                prepared.Basic!,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertAuditAsync(
                versionId,
                action,
                [action.Replace("save-", string.Empty, StringComparison.Ordinal)],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);

            return new ProcessDefinitionCommandResult<SaveProcessVersionCommandValue>(
                new SaveProcessVersionCommandValue(
                    checked(state!.Revision + 1),
                    prepared.RemovedReferences),
                null);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<IdempotencyReservation<T>> ReserveIdempotencyAsync<T>(
        Guid actorId,
        string routeScope,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var now = UtcNow();
        var leaseOwner = Guid.NewGuid().ToString("N");
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        await using var select = CreateCommand();
        select.CommandText =
            """
            SELECT [id], [request_hash], [status], [first_http_status],
                   [replay_headers_json], [response_body_json], [lease_until]
            FROM [flowpilot].[idempotency_records] WITH (UPDLOCK, HOLDLOCK)
            WHERE [actor_id] = @actor_id
              AND [route_scope] = @route_scope
              AND [idempotency_key] = @idempotency_key;
            """;
        Add(select, "@actor_id", SqlDbType.UniqueIdentifier, actorId);
        Add(select, "@route_scope", SqlDbType.NVarChar, routeScope, 200);
        Add(select, "@idempotency_key", SqlDbType.NVarChar, idempotencyKey, 200);

        await using var reader = await select.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var id = reader.GetGuid(0);
            var storedHash = reader.GetString(1);
            var status = reader.GetString(2);
            short? httpStatus = reader.IsDBNull(3) ? null : reader.GetInt16(3);
            var headersJson = reader.IsDBNull(4) ? null : reader.GetString(4);
            var responseJson = reader.IsDBNull(5) ? null : reader.GetString(5);
            DateTime? leaseUntil = reader.IsDBNull(6) ? null : reader.GetDateTime(6);
            await reader.CloseAsync().ConfigureAwait(false);

            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(storedHash),
                    Encoding.ASCII.GetBytes(requestHash)))
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return IdempotencyReservation<T>.Rejected(new ProcessDefinitionCommandFailure(
                    ProcessDefinitionCommandError.IdempotencyKeyReused,
                    "IDEMPOTENCY_KEY_REUSED",
                    "幂等键已用于其他请求",
                    "请为不同请求生成新的 Idempotency-Key。"));
            }

            if (string.Equals(status, "completed", StringComparison.Ordinal)
                && httpStatus is >= 200 and < 300
                && !string.IsNullOrWhiteSpace(responseJson))
            {
                var replay = JsonSerializer.Deserialize<T>(responseJson, JsonOptions)
                    ?? throw new InvalidDataException("Stored idempotency response is invalid.");
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return IdempotencyReservation<T>.Replayed(
                    replay,
                    ReadStoredRevision(headersJson));
            }

            if (string.Equals(status, "failed", StringComparison.Ordinal)
                && httpStatus.HasValue
                && !string.IsNullOrWhiteSpace(responseJson))
            {
                var failure = ParseStoredFailure(responseJson, httpStatus.Value);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return IdempotencyReservation<T>.Rejected(failure);
            }

            if (leaseUntil.HasValue && leaseUntil.Value > now.UtcDateTime)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return IdempotencyReservation<T>.Rejected(new ProcessDefinitionCommandFailure(
                    ProcessDefinitionCommandError.IdempotencyRequestInProgress,
                    "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                    "相同请求正在处理中",
                    "请稍后使用相同的 Idempotency-Key 重试。"));
            }

            await using var takeover = CreateCommand();
            takeover.CommandText =
                """
                UPDATE [flowpilot].[idempotency_records]
                SET [status] = N'processing',
                    [first_http_status] = NULL,
                    [replay_headers_json] = NULL,
                    [response_body_json] = NULL,
                    [lease_owner] = @lease_owner,
                    [lease_until] = @lease_until,
                    [completed_at] = NULL
                WHERE [id] = @id;
                """;
            Add(takeover, "@lease_owner", SqlDbType.NVarChar, leaseOwner, 100);
            Add(takeover, "@lease_until", SqlDbType.DateTime2, now.Add(IdempotencyLease).UtcDateTime);
            Add(takeover, "@id", SqlDbType.UniqueIdentifier, id);
            await takeover.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return IdempotencyReservation<T>.Reserved(id, leaseOwner);
        }

        await reader.CloseAsync().ConfigureAwait(false);
        var recordId = Guid.NewGuid();
        await using var insert = CreateCommand();
        insert.CommandText =
            """
            INSERT INTO [flowpilot].[idempotency_records]
            (
                [id], [actor_id], [route_scope], [idempotency_key], [request_hash],
                [status], [first_http_status], [replay_headers_json], [response_body_json],
                [lease_owner], [lease_until], [created_at], [completed_at], [expires_at]
            )
            VALUES
            (
                @id, @actor_id, @route_scope, @idempotency_key, @request_hash,
                N'processing', NULL, NULL, NULL,
                @lease_owner, @lease_until, @created_at, NULL, @expires_at
            );
            """;
        Add(insert, "@id", SqlDbType.UniqueIdentifier, recordId);
        Add(insert, "@actor_id", SqlDbType.UniqueIdentifier, actorId);
        Add(insert, "@route_scope", SqlDbType.NVarChar, routeScope, 200);
        Add(insert, "@idempotency_key", SqlDbType.NVarChar, idempotencyKey, 200);
        Add(insert, "@request_hash", SqlDbType.VarChar, requestHash, 64);
        Add(insert, "@lease_owner", SqlDbType.NVarChar, leaseOwner, 100);
        Add(insert, "@lease_until", SqlDbType.DateTime2, now.Add(IdempotencyLease).UtcDateTime);
        Add(insert, "@created_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(insert, "@expires_at", SqlDbType.DateTime2, now.Add(IdempotencyRetention).UtcDateTime);
        await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return IdempotencyReservation<T>.Reserved(recordId, leaseOwner);
    }

    private async Task CompleteIdempotencySuccessAsync<T>(
        IdempotencyReservation<T> reservation,
        int httpStatus,
        int revision,
        T response,
        string? location,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var headers = new JsonObject
        {
            ["etag"] = $"\"{revision}\"",
        };
        if (location is not null)
        {
            headers["location"] = location;
        }

        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[idempotency_records]
            SET [status] = N'completed',
                [first_http_status] = @http_status,
                [replay_headers_json] = @headers_json,
                [response_body_json] = @body_json,
                [lease_owner] = NULL,
                [lease_until] = NULL,
                [completed_at] = @completed_at
            WHERE [id] = @id
              AND [status] = N'processing'
              AND [lease_owner] = @lease_owner;
            """;
        Add(command, "@http_status", SqlDbType.SmallInt, httpStatus);
        Add(command, "@headers_json", SqlDbType.NVarChar, SerializeNode(headers));
        Add(command, "@body_json", SqlDbType.NVarChar, JsonSerializer.Serialize(response, JsonOptions));
        Add(command, "@completed_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@id", SqlDbType.UniqueIdentifier, reservation.Id!.Value);
        Add(command, "@lease_owner", SqlDbType.NVarChar, reservation.LeaseOwner!, 100);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The idempotency reservation was lost before completion.");
        }
    }

    private async Task CompleteIdempotencyFailureInCurrentTransactionAsync<T>(
        IdempotencyReservation<T> reservation,
        ProcessDefinitionCommandFailure failure,
        string traceId,
        CancellationToken cancellationToken)
    {
        if (!reservation.Id.HasValue || reservation.LeaseOwner is null)
        {
            return;
        }

        var now = UtcNow();
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[idempotency_records]
            SET [status] = N'failed',
                [first_http_status] = @http_status,
                [replay_headers_json] = @headers_json,
                [response_body_json] = @body_json,
                [lease_owner] = NULL,
                [lease_until] = NULL,
                [completed_at] = @completed_at
            WHERE [id] = @id
              AND [status] = N'processing'
              AND [lease_owner] = @lease_owner;
            """;
        Add(command, "@http_status", SqlDbType.SmallInt, FailureStatus(failure));
        Add(command, "@headers_json", SqlDbType.NVarChar, SerializeNode(new JsonObject()));
        Add(command, "@body_json", SqlDbType.NVarChar, SerializeFailure(failure, traceId));
        Add(command, "@completed_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@id", SqlDbType.UniqueIdentifier, reservation.Id.Value);
        Add(command, "@lease_owner", SqlDbType.NVarChar, reservation.LeaseOwner, 100);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static int FailureStatus(ProcessDefinitionCommandFailure failure) => failure.Error switch
    {
        ProcessDefinitionCommandError.NotFound => 404,
        ProcessDefinitionCommandError.RevisionMismatch => 412,
        ProcessDefinitionCommandError.ValidationFailed => 422,
        _ => 409,
    };

    private static string SerializeFailure(
        ProcessDefinitionCommandFailure failure,
        string traceId)
    {
        var body = new JsonObject
        {
            ["code"] = failure.Code,
            ["title"] = failure.Title,
            ["detail"] = failure.Detail,
            ["traceId"] = traceId,
        };
        if (failure.CurrentRevision.HasValue)
        {
            body["currentRevision"] = failure.CurrentRevision.Value;
        }

        if (failure.Issues is { Count: > 0 })
        {
            body["errors"] = JsonSerializer.SerializeToNode(failure.Issues, JsonOptions);
        }

        return SerializeNode(body);
    }

    private static ProcessDefinitionCommandFailure ParseStoredFailure(
        string json,
        int httpStatus)
    {
        var node = ParseObject(json, "response_body_json");
        var code = StringValue(node, "code") ?? "CONFLICT";
        var issues = node["errors"] is JsonArray errors
            ? errors.Deserialize<IReadOnlyList<ProcessDefinitionInputIssueDto>>(JsonOptions)
            : null;
        return new ProcessDefinitionCommandFailure(
            httpStatus switch
            {
                404 => ProcessDefinitionCommandError.NotFound,
                412 => ProcessDefinitionCommandError.RevisionMismatch,
                422 => ProcessDefinitionCommandError.ValidationFailed,
                _ => ProcessDefinitionCommandError.Conflict,
            },
            code,
            StringValue(node, "title") ?? "请求未完成",
            StringValue(node, "detail") ?? "请检查请求后重试。",
            issues,
            IntValue(node, "currentRevision"));
    }

    private static int ReadStoredRevision(string? headersJson)
    {
        if (string.IsNullOrWhiteSpace(headersJson))
        {
            throw new InvalidDataException("Stored idempotency response has no ETag.");
        }

        var headers = ParseObject(headersJson, "replay_headers_json");
        var etag = StringValue(headers, "etag");
        if (etag is null
            || etag.Length < 3
            || !int.TryParse(etag.AsSpan(1, etag.Length - 2), out var revision))
        {
            throw new InvalidDataException("Stored idempotency ETag is invalid.");
        }

        return revision;
    }

    private async Task<VersionState?> LoadVersionForUpdateAsync(
        Guid definitionId,
        Guid versionId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            SELECT
                [d].[id], [d].[type], [d].[published_version_id], [d].[revision],
                [v].[id], [v].[revision], [v].[basic_json], [v].[snapshot_json],
                CASE WHEN EXISTS
                (
                    SELECT 1
                    FROM [flowpilot].[workflow_instances] AS [i]
                    WHERE [i].[version_id] = [v].[id]
                ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS [has_instances]
            FROM [flowpilot].[workflow_definitions] AS [d] WITH (UPDLOCK, HOLDLOCK)
            INNER JOIN [flowpilot].[workflow_definition_versions] AS [v] WITH (UPDLOCK, HOLDLOCK)
                ON [v].[definition_id] = [d].[id]
            WHERE [d].[id] = @definition_id
              AND [v].[id] = @version_id;
            """;
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, definitionId);
        Add(command, "@version_id", SqlDbType.UniqueIdentifier, versionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new VersionState(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetGuid(2),
            reader.GetInt32(3),
            reader.GetGuid(4),
            reader.GetInt32(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetBoolean(8));
    }

    private static ProcessDefinitionCommandFailure? ValidateStateForMutation(
        VersionState? state,
        int expectedRevision,
        bool requireEditable)
    {
        if (state is null)
        {
            return new ProcessDefinitionCommandFailure(
                ProcessDefinitionCommandError.NotFound,
                "VERSION_NOT_FOUND",
                "流程版本不存在",
                "未找到指定流程定义下的流程版本。");
        }

        if (state.Revision != expectedRevision)
        {
            return new ProcessDefinitionCommandFailure(
                ProcessDefinitionCommandError.RevisionMismatch,
                "REVISION_MISMATCH",
                "流程版本已被修改",
                "请重新加载最新版本后再提交。",
                CurrentRevision: state.Revision);
        }

        if (requireEditable
            && (state.PublishedVersionId == state.VersionId || state.HasInstances))
        {
            return new ProcessDefinitionCommandFailure(
                ProcessDefinitionCommandError.VersionNotEditable,
                "VERSION_NOT_EDITABLE",
                "流程版本不可编辑",
                state.PublishedVersionId == state.VersionId
                    ? "当前发布版本必须先取消发布，且没有实例后才能编辑。"
                    : "已经产生实例的流程版本永久只读，请复制新建版本。",
                CurrentRevision: state.Revision);
        }

        return null;
    }

    private async Task InsertDefinitionAsync(
        Guid definitionId,
        string code,
        ProcessBasicConfigInput basic,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            INSERT INTO [flowpilot].[workflow_definitions]
            (
                [id], [code], [normalized_code], [name], [description], [type],
                [is_disabled], [published_version_id], [next_version_number],
                [instance_count], [revision], [created_at], [updated_at],
                [created_by], [updated_by]
            )
            VALUES
            (
                @id, @code, @normalized_code, @name, @description, @type,
                0, NULL, 2, 0, 1, @created_at, @updated_at,
                @created_by, @updated_by
            );
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, definitionId);
        Add(command, "@code", SqlDbType.NVarChar, code, 100);
        Add(command, "@normalized_code", SqlDbType.NVarChar, code.ToUpperInvariant(), 100);
        Add(command, "@name", SqlDbType.NVarChar, basic.Name, 200);
        AddNullable(command, "@description", SqlDbType.NVarChar, basic.Description, 2000);
        Add(command, "@type", SqlDbType.NVarChar, basic.Type, 20);
        Add(command, "@created_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@created_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task InsertVersionAsync(
        Guid versionId,
        Guid definitionId,
        string basicJson,
        string snapshotJson,
        ProcessVersionValidationDto validation,
        string validationJson,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            INSERT INTO [flowpilot].[workflow_definition_versions]
            (
                [id], [definition_id], [version_number], [version_label],
                [basic_json], [snapshot_json], [validation_status], [validation_json],
                [validated_at], [instance_count], [revision], [created_at], [created_by],
                [updated_at], [updated_by], [first_published_at], [first_published_by],
                [latest_published_at], [latest_published_by], [unpublished_at],
                [unpublished_by], [unpublished_reason]
            )
            VALUES
            (
                @id, @definition_id, 1, N'V1',
                @basic_json, @snapshot_json, @validation_status, @validation_json,
                @validated_at, 0, 1, @created_at, @created_by,
                @updated_at, @updated_by, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL
            );
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, versionId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, definitionId);
        Add(command, "@basic_json", SqlDbType.NVarChar, basicJson);
        Add(command, "@snapshot_json", SqlDbType.NVarChar, snapshotJson);
        Add(command, "@validation_status", SqlDbType.NVarChar, validation.Status, 20);
        Add(command, "@validation_json", SqlDbType.NVarChar, validationJson);
        Add(command, "@validated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@created_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@created_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task UpdateVersionAsync(
        VersionState state,
        string basicJson,
        string snapshotJson,
        ProcessVersionValidationDto validation,
        string validationJson,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            UPDATE [flowpilot].[workflow_definition_versions]
            SET [basic_json] = @basic_json,
                [snapshot_json] = @snapshot_json,
                [validation_status] = @validation_status,
                [validation_json] = @validation_json,
                [validated_at] = @validated_at,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @version_id
              AND [definition_id] = @definition_id
              AND [revision] = @revision;
            """;
        Add(command, "@basic_json", SqlDbType.NVarChar, basicJson);
        Add(command, "@snapshot_json", SqlDbType.NVarChar, snapshotJson);
        Add(command, "@validation_status", SqlDbType.NVarChar, validation.Status, 20);
        Add(command, "@validation_json", SqlDbType.NVarChar, validationJson);
        Add(command, "@validated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@version_id", SqlDbType.UniqueIdentifier, state.VersionId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, state.DefinitionId);
        Add(command, "@revision", SqlDbType.Int, state.Revision);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The process version changed while it was being saved.");
        }
    }

    private Task UpdateValidationAsync(
        VersionState state,
        ProcessVersionValidationDto validation,
        string validationJson,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        UpdateVersionAsync(
            state,
            state.BasicJson,
            state.SnapshotJson,
            validation,
            validationJson,
            actorId,
            now,
            cancellationToken);

    private async Task UpdateDefinitionAfterVersionSaveAsync(
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
            SET [name] = CASE WHEN [published_version_id] IS NULL THEN @name ELSE [name] END,
                [description] = CASE WHEN [published_version_id] IS NULL THEN @description ELSE [description] END,
                [revision] = [revision] + 1,
                [updated_at] = @updated_at,
                [updated_by] = @updated_by
            WHERE [id] = @definition_id
              AND [revision] = @definition_revision;
            """;
        Add(command, "@name", SqlDbType.NVarChar, basic.Name, 200);
        AddNullable(command, "@description", SqlDbType.NVarChar, basic.Description, 2000);
        Add(command, "@updated_at", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@updated_by", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@definition_id", SqlDbType.UniqueIdentifier, state.DefinitionId);
        Add(command, "@definition_revision", SqlDbType.Int, state.DefinitionRevision);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("The process definition changed while its version was saved.");
        }
    }

    private async Task InsertAuditAsync(
        Guid resourceId,
        string action,
        IReadOnlyList<string> fields,
        ProcessDefinitionMutationActor actor,
        string traceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            INSERT INTO [flowpilot].[audit_events]
            (
                [id], [resource_type], [resource_id], [action],
                [field_identifiers_json], [operator_user_id], [effective_user_id],
                [trace_id], [result], [occurred_at]
            )
            VALUES
            (
                @id, @resource_type, @resource_id, @action,
                @field_identifiers_json, @operator_user_id, @effective_user_id,
                @trace_id, N'success', @occurred_at
            );
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, Guid.NewGuid());
        Add(command, "@resource_type", SqlDbType.NVarChar,
            action == "create" ? "process-definition" : "process-version", 100);
        Add(command, "@resource_id", SqlDbType.UniqueIdentifier, resourceId);
        Add(command, "@action", SqlDbType.NVarChar, action, 100);
        Add(command, "@field_identifiers_json", SqlDbType.NVarChar,
            JsonSerializer.Serialize(fields, JsonOptions));
        Add(command, "@operator_user_id", SqlDbType.UniqueIdentifier, actor.OperatorUserId);
        Add(command, "@effective_user_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
        Add(command, "@trace_id", SqlDbType.NVarChar, traceId, 100);
        Add(command, "@occurred_at", SqlDbType.DateTime2, now.UtcDateTime);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task ReplaceReferencesAsync(
        Guid versionId,
        ProcessBasicConfigInput basic,
        JsonObject snapshot,
        CancellationToken cancellationToken)
    {
        await using (var delete = CreateCommand())
        {
            delete.CommandText =
                """
                DELETE FROM [flowpilot].[workflow_version_group_refs]
                WHERE [version_id] = @version_id;
                DELETE FROM [flowpilot].[workflow_version_role_refs]
                WHERE [version_id] = @version_id;
                """;
            Add(delete, "@version_id", SqlDbType.UniqueIdentifier, versionId);
            await delete.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        var groupReferences = new HashSet<GroupReference>();
        foreach (var groupId in basic.StarterGroupIds)
        {
            groupReferences.Add(new GroupReference(groupId, "start", null));
        }

        foreach (var groupId in basic.CloseGroupIds)
        {
            groupReferences.Add(new GroupReference(groupId, "close", null));
        }

        if (string.Equals(basic.Type, "free", StringComparison.Ordinal))
        {
            foreach (var groupId in basic.AssigneeGroupIds)
            {
                groupReferences.Add(new GroupReference(groupId, "review", null));
            }
        }
        else
        {
            foreach (var node in FlowNodes(snapshot))
            {
                var data = node["data"] as JsonObject;
                if (!string.Equals(StringValue(data, "kind"), "approval", StringComparison.Ordinal)
                    || !Guid.TryParse(StringValue(data, "permissionGroupId"), out var groupId))
                {
                    continue;
                }

                groupReferences.Add(new GroupReference(
                    groupId,
                    "review",
                    StringValue(node, "id")));
            }
        }

        foreach (var reference in groupReferences)
        {
            await using var insert = CreateCommand();
            insert.CommandText =
                """
                INSERT INTO [flowpilot].[workflow_version_group_refs]
                    ([id], [version_id], [group_id], [purpose], [node_id])
                VALUES
                    (@id, @version_id, @group_id, @purpose, @node_id);
                """;
            Add(insert, "@id", SqlDbType.UniqueIdentifier, Guid.NewGuid());
            Add(insert, "@version_id", SqlDbType.UniqueIdentifier, versionId);
            Add(insert, "@group_id", SqlDbType.UniqueIdentifier, reference.GroupId);
            Add(insert, "@purpose", SqlDbType.NVarChar, reference.Purpose, 20);
            AddNullable(insert, "@node_id", SqlDbType.NVarChar, reference.NodeId, 100);
            await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        foreach (var roleId in basic.VisibleRoleIds)
        {
            await using var insert = CreateCommand();
            insert.CommandText =
                """
                INSERT INTO [flowpilot].[workflow_version_role_refs]
                    ([version_id], [role_id], [purpose])
                VALUES
                    (@version_id, @role_id, N'visible');
                """;
            Add(insert, "@version_id", SqlDbType.UniqueIdentifier, versionId);
            Add(insert, "@role_id", SqlDbType.UniqueIdentifier, roleId);
            await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ReplaceFieldCatalogAsync(
        Guid versionId,
        JsonObject snapshot,
        CancellationToken cancellationToken)
    {
        await using (var delete = CreateCommand())
        {
            delete.CommandText =
                """
                DELETE FROM [flowpilot].[workflow_version_field_catalog]
                WHERE [version_id] = @version_id;
                """;
            Add(delete, "@version_id", SqlDbType.UniqueIdentifier, versionId);
            await delete.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        foreach (var field in FormFields(snapshot))
        {
            var fieldId = StringValue(field, "id")!;
            var fieldType = StringValue(field, "type")!;
            if (string.Equals(fieldType, "table", StringComparison.Ordinal))
            {
                if (field["columns"] is not JsonArray columns)
                {
                    continue;
                }

                foreach (var column in columns.OfType<JsonObject>())
                {
                    var columnId = StringValue(column, "id")!;
                    await InsertFieldCatalogRowAsync(
                        versionId,
                        $"{fieldId}.{columnId}",
                        fieldId,
                        columnId,
                        StringValue(column, "label")!,
                        StringValue(column, "type") ?? "text",
                        isQueryable: false,
                        isListed: BoolValue(field, "listVisible") || BoolValue(field, "taskVisible"),
                        isExportable: BoolValue(field, "exportVisible"),
                        StringValue(field, "inputStage") ?? "initiator",
                        cancellationToken).ConfigureAwait(false);
                }

                continue;
            }

            await InsertFieldCatalogRowAsync(
                versionId,
                fieldId,
                tableFieldId: null,
                columnId: null,
                StringValue(field, "label")!,
                fieldType,
                BoolValue(field, "queryable"),
                BoolValue(field, "listVisible") || BoolValue(field, "taskVisible"),
                BoolValue(field, "exportVisible"),
                StringValue(field, "inputStage") ?? "initiator",
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task InsertFieldCatalogRowAsync(
        Guid versionId,
        string fieldId,
        string? tableFieldId,
        string? columnId,
        string name,
        string fieldType,
        bool isQueryable,
        bool isListed,
        bool isExportable,
        string inputStage,
        CancellationToken cancellationToken)
    {
        await using var insert = CreateCommand();
        insert.CommandText =
            """
            INSERT INTO [flowpilot].[workflow_version_field_catalog]
            (
                [id], [version_id], [field_id], [table_field_id], [column_id],
                [name], [field_type], [is_queryable], [is_listed], [is_exportable],
                [input_stage]
            )
            VALUES
            (
                @id, @version_id, @field_id, @table_field_id, @column_id,
                @name, @field_type, @is_queryable, @is_listed, @is_exportable,
                @input_stage
            );
            """;
        Add(insert, "@id", SqlDbType.UniqueIdentifier, Guid.NewGuid());
        Add(insert, "@version_id", SqlDbType.UniqueIdentifier, versionId);
        Add(insert, "@field_id", SqlDbType.NVarChar, fieldId, 100);
        AddNullable(insert, "@table_field_id", SqlDbType.NVarChar, tableFieldId, 100);
        AddNullable(insert, "@column_id", SqlDbType.NVarChar, columnId, 100);
        Add(insert, "@name", SqlDbType.NVarChar, name, 200);
        Add(insert, "@field_type", SqlDbType.NVarChar, fieldType, 50);
        Add(insert, "@is_queryable", SqlDbType.Bit, isQueryable);
        Add(insert, "@is_listed", SqlDbType.Bit, isListed);
        Add(insert, "@is_exportable", SqlDbType.Bit, isExportable);
        Add(insert, "@input_stage", SqlDbType.NVarChar, inputStage, 50);
        await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static ProcessBasicConfigInput NormalizeBasic(ProcessBasicConfigInput basic) => basic with
    {
        Name = basic.Name.Trim(),
        InstancePrefix = basic.InstancePrefix.Trim(),
        Type = basic.Type.Trim(),
        Description = basic.Description.Trim(),
        StarterGroupIds = [.. basic.StarterGroupIds],
        AssigneeGroupIds = [.. basic.AssigneeGroupIds],
        CloseGroupIds = [.. basic.CloseGroupIds],
        VisibleRoleIds = [.. basic.VisibleRoleIds],
        VisibleUserIds = [.. basic.VisibleUserIds],
    };

    private static List<ProcessDefinitionInputIssueDto> ValidateBasicInput(
        ProcessBasicConfigInput basic,
        ReferenceCatalog catalog,
        string? fixedType = null)
    {
        var issues = new List<ProcessDefinitionInputIssueDto>();
        if (basic.Name.Length is < 1 or > 100)
        {
            issues.Add(InputIssue("name", "INVALID_LENGTH", "流程名称长度必须为 1 到 100 个字符。"));
        }

        if (basic.Description.Length > 2000)
        {
            issues.Add(InputIssue("description", "INVALID_LENGTH", "流程说明不能超过 2000 个字符。"));
        }

        if (basic.InstancePrefix.Length is < 1 or > 30
            || basic.InstancePrefix.Any(character =>
                !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_'))
        {
            issues.Add(InputIssue(
                "instancePrefix",
                "INVALID_FORMAT",
                "实例编号前缀必须为 1 到 30 位字母、数字、横线或下划线。"));
        }

        if (basic.Type is not ("approval" or "free"))
        {
            issues.Add(InputIssue("type", "INVALID_ENUM", "流程类型必须是 approval 或 free。"));
        }
        else if (fixedType is not null
            && !string.Equals(basic.Type, fixedType, StringComparison.Ordinal))
        {
            issues.Add(InputIssue("type", "TYPE_IMMUTABLE", "流程类型创建后不能修改。"));
        }

        ValidateUniqueIds(basic.StarterGroupIds, "starterGroupIds", issues);
        ValidateUniqueIds(basic.AssigneeGroupIds, "assigneeGroupIds", issues);
        ValidateUniqueIds(basic.CloseGroupIds, "closeGroupIds", issues);
        ValidateUniqueIds(basic.VisibleRoleIds, "visibleRoleIds", issues);
        ValidateUniqueIds(basic.VisibleUserIds, "visibleUserIds", issues);
        if (basic.StarterGroupIds.Length == 0)
        {
            issues.Add(InputIssue("starterGroupIds", "MIN_ITEMS", "至少选择一个发起流程权限组。"));
        }

        if (basic.CloseGroupIds.Length == 0)
        {
            issues.Add(InputIssue("closeGroupIds", "MIN_ITEMS", "至少选择一个关闭流程权限组。"));
        }

        if (basic.Type == "free" && basic.AssigneeGroupIds.Length == 0)
        {
            issues.Add(InputIssue("assigneeGroupIds", "MIN_ITEMS", "自由协作流程至少选择一个受理流程权限组。"));
        }

        ValidateGroupReferences(basic.StarterGroupIds, "start", "starterGroupIds", catalog, issues);
        ValidateGroupReferences(basic.CloseGroupIds, "close", "closeGroupIds", catalog, issues);
        ValidateGroupReferences(basic.AssigneeGroupIds, "review", "assigneeGroupIds", catalog, issues);
        foreach (var roleId in basic.VisibleRoleIds)
        {
            if (!catalog.Roles.ContainsKey(roleId))
            {
                issues.Add(InputIssue("visibleRoleIds", "ROLE_NOT_FOUND", $"角色 {roleId:D} 不存在。"));
            }
        }

        foreach (var userId in basic.VisibleUserIds)
        {
            if (!catalog.Users.ContainsKey(userId))
            {
                issues.Add(InputIssue("visibleUserIds", "USER_NOT_FOUND", $"用户 {userId:D} 不存在。"));
            }
        }

        return issues;
    }

    private static void ValidateUniqueIds(
        Guid[] values,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (values.Any(value => value == Guid.Empty))
        {
            issues.Add(InputIssue(path, "INVALID_UUID", "引用标识不能是空 UUID。"));
        }

        if (values.Distinct().Count() != values.Length)
        {
            issues.Add(InputIssue(path, "DUPLICATE_ID", "同一引用不能重复选择。"));
        }
    }

    private static void ValidateGroupReferences(
        IEnumerable<Guid> groupIds,
        string purpose,
        string path,
        ReferenceCatalog catalog,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        foreach (var groupId in groupIds)
        {
            if (!catalog.Groups.TryGetValue(groupId, out var group))
            {
                issues.Add(InputIssue(path, "GROUP_NOT_FOUND", $"流程权限组 {groupId:D} 不存在。"));
            }
            else if (!group.Purposes.Contains(purpose))
            {
                issues.Add(InputIssue(path, "GROUP_PURPOSE_MISMATCH", $"流程权限组“{group.Name}”不具备所需用途。"));
            }
        }
    }

    private static NormalizedForm NormalizeForm(
        SaveFormDesignerRequest request,
        DateTimeOffset now)
    {
        var issues = new List<ProcessDefinitionInputIssueDto>();
        if (request.Form["fields"] is not JsonArray fields || fields.Count == 0)
        {
            return NormalizedForm.Failed(ValidationFailure(
                "表单设计格式无效",
                [InputIssue("form.fields", "MIN_ITEMS", "初始表单至少包含固定标题字段。")]));
        }

        var normalizedFields = new JsonArray();
        var fieldIds = new HashSet<string>(StringComparer.Ordinal);
        var optionIds = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < fields.Count; index++)
        {
            if (fields[index] is not JsonObject field)
            {
                issues.Add(InputIssue($"form.fields[{index}]", "INVALID_OBJECT", "表单字段必须是对象。"));
                continue;
            }

            var path = $"form.fields[{index}]";
            var id = RequiredString(field, "id", path, 100, issues);
            var type = RequiredString(field, "type", path, 50, issues);
            var label = RequiredString(field, "label", path, 200, issues);
            if (id is not null && !fieldIds.Add(id))
            {
                issues.Add(InputIssue($"{path}.id", "DUPLICATE_ID", "表单字段标识不能重复。"));
            }

            if (type is not null && !FieldTypes.Contains(type))
            {
                issues.Add(InputIssue($"{path}.type", "INVALID_ENUM", "表单字段类型无效。"));
            }

            var normalized = new JsonObject
            {
                ["id"] = id,
                ["type"] = type,
                ["label"] = label,
                ["required"] = BoolValue(field, "required"),
                ["listVisible"] = BoolValue(field, "listVisible"),
                ["taskVisible"] = BoolValue(field, "taskVisible"),
                ["queryable"] = BoolValue(field, "queryable"),
                ["exportVisible"] = BoolValue(field, "exportVisible"),
                ["inputStage"] = NormalizeInputStage(StringValue(field, "inputStage")),
            };
            CopyOptionalString(field, normalized, "description", 2000, path, issues);
            CopyOptionalString(field, normalized, "placeholder", 500, path, issues);
            CopyOptionalNode(field, normalized, "defaultValue");

            if (type is "radio" or "checkbox" or "select" or "cascader"
                && field["options"] is JsonArray options)
            {
                normalized["options"] = NormalizeOptions(options, $"{path}.options", optionIds, issues);
            }

            if (field["displayCondition"] is JsonObject condition)
            {
                normalized["displayCondition"] = NormalizeCondition(condition, $"{path}.displayCondition", issues);
            }

            if (type == "attachment" && field["attachment"] is JsonObject attachment)
            {
                normalized["attachment"] = NormalizeAttachment(attachment, $"{path}.attachment", issues);
            }

            if (type == "table" && field["columns"] is JsonArray columns)
            {
                var normalizedColumns = new JsonArray();
                var columnIds = new HashSet<string>(StringComparer.Ordinal);
                for (var columnIndex = 0; columnIndex < columns.Count; columnIndex++)
                {
                    if (columns[columnIndex] is not JsonObject column)
                    {
                        issues.Add(InputIssue($"{path}.columns[{columnIndex}]", "INVALID_OBJECT", "表格列必须是对象。"));
                        continue;
                    }

                    var columnPath = $"{path}.columns[{columnIndex}]";
                    var columnId = RequiredString(column, "id", columnPath, 100, issues);
                    var columnLabel = RequiredString(column, "label", columnPath, 200, issues);
                    var columnType = StringValue(column, "type") ?? "text";
                    if (columnId is not null && !columnIds.Add(columnId))
                    {
                        issues.Add(InputIssue($"{columnPath}.id", "DUPLICATE_ID", "同一表格内的列标识不能重复。"));
                    }

                    if (id is not null && columnId is not null && $"{id}.{columnId}".Length > 100)
                    {
                        issues.Add(InputIssue($"{columnPath}.id", "INVALID_LENGTH", "表格字段与列的组合标识不能超过 100 个字符。"));
                    }

                    if (columnType is not ("text" or "radio" or "checkbox" or "select"))
                    {
                        issues.Add(InputIssue($"{columnPath}.type", "INVALID_ENUM", "表格列类型无效。"));
                    }

                    var normalizedColumn = new JsonObject
                    {
                        ["id"] = columnId,
                        ["label"] = columnLabel,
                        ["type"] = columnType,
                        ["required"] = BoolValue(column, "required"),
                        ["reviewEditable"] = BoolValue(column, "reviewEditable"),
                    };
                    CopyOptionalNode(column, normalizedColumn, "defaultValue");
                    CopyOptionalInt(column, normalizedColumn, "width", 60, int.MaxValue, columnPath, issues);
                    CopyOptionalEnum(column, normalizedColumn, "align", ["left", "center", "right"], columnPath, issues);
                    if (columnType is "radio" or "checkbox" or "select"
                        && column["options"] is JsonArray columnOptions)
                    {
                        normalizedColumn["options"] = NormalizeOptions(
                            columnOptions,
                            $"{columnPath}.options",
                            optionIds,
                            issues);
                    }

                    normalizedColumns.Add(normalizedColumn);
                }

                normalized["columns"] = normalizedColumns;
            }

            normalizedFields.Add(normalized);
        }

        var normalizedSystemFields = new JsonArray();
        var systemKeys = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < request.SystemFields.Count; index++)
        {
            if (request.SystemFields[index] is not JsonObject field)
            {
                issues.Add(InputIssue($"systemFields[{index}]", "INVALID_OBJECT", "系统字段必须是对象。"));
                continue;
            }

            var path = $"systemFields[{index}]";
            var key = RequiredString(field, "key", path, 50, issues);
            var label = RequiredString(field, "label", path, 200, issues);
            if (key is not null && !SystemFieldKeys.Contains(key))
            {
                issues.Add(InputIssue($"{path}.key", "INVALID_ENUM", "系统字段标识无效。"));
            }
            else if (key is not null && !systemKeys.Add(key))
            {
                issues.Add(InputIssue($"{path}.key", "DUPLICATE_ID", "系统字段标识不能重复。"));
            }

            normalizedSystemFields.Add(new JsonObject
            {
                ["key"] = key,
                ["label"] = label,
                ["taskVisible"] = BoolValue(field, "taskVisible"),
                ["processListVisible"] = BoolValue(field, "processListVisible"),
                ["exportVisible"] = BoolValue(field, "exportVisible"),
            });
        }

        if (issues.Count > 0)
        {
            return NormalizedForm.Failed(ValidationFailure("表单设计格式无效", issues));
        }

        return NormalizedForm.Success(
            new JsonObject
            {
                ["fields"] = normalizedFields,
                ["savedAt"] = JsonValue.Create(now),
            },
            normalizedSystemFields);
    }

    private static NormalizedFlow NormalizeFlow(JsonObject source, DateTimeOffset now)
    {
        var issues = new List<ProcessDefinitionInputIssueDto>();
        if (source["nodes"] is not JsonArray nodes || source["edges"] is not JsonArray edges)
        {
            return NormalizedFlow.Failed(ValidationFailure(
                "流程图格式无效",
                [InputIssue("flow", "INVALID_SHAPE", "flow 必须包含 nodes 和 edges 数组。")]));
        }

        var normalizedNodes = new JsonArray();
        var nodeIds = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < nodes.Count; index++)
        {
            if (nodes[index] is not JsonObject node || node["data"] is not JsonObject data)
            {
                issues.Add(InputIssue($"flow.nodes[{index}]", "INVALID_OBJECT", "流程节点格式无效。"));
                continue;
            }

            var path = $"flow.nodes[{index}]";
            var id = RequiredString(node, "id", path, 100, issues);
            var kind = RequiredString(data, "kind", $"{path}.data", 20, issues);
            var label = RequiredString(data, "label", $"{path}.data", 200, issues);
            if (id is not null && !nodeIds.Add(id))
            {
                issues.Add(InputIssue($"{path}.id", "DUPLICATE_ID", "流程节点标识不能重复。"));
            }

            if (kind is not ("start" or "approval" or "end"))
            {
                issues.Add(InputIssue($"{path}.data.kind", "INVALID_ENUM", "流程节点类型无效。"));
            }

            var position = node["position"] as JsonObject;
            var normalizedData = new JsonObject
            {
                ["kind"] = kind,
                ["label"] = label,
            };
            CopyOptionalString(data, normalizedData, "description", 2000, $"{path}.data", issues);
            CopyOptionalGuid(data, normalizedData, "permissionGroupId", $"{path}.data", issues);
            CopyOptionalGuidArray(data, normalizedData, "permissionGroupIds", $"{path}.data", issues);
            normalizedData["specifyAssignee"] = BoolValue(data, "specifyAssignee");
            normalizedData["editableFieldIds"] = NormalizeStringArray(data["editableFieldIds"], $"{path}.data.editableFieldIds", 100, issues);
            normalizedData["handlingMode"] = NormalizeEnum(
                StringValue(data, "handlingMode") ?? "approval",
                ["approval", "confirmation"],
                "approval",
                $"{path}.data.handlingMode",
                issues);
            normalizedData["allowRepeatedEditing"] = BoolValue(data, "allowRepeatedEditing");
            if (data["activationCondition"] is JsonObject condition)
            {
                normalizedData["activationCondition"] = NormalizeCondition(
                    condition,
                    $"{path}.data.activationCondition",
                    issues);
            }

            if (data["emailNotification"] is JsonObject email)
            {
                normalizedData["emailNotification"] = NormalizeEmail(
                    email,
                    $"{path}.data.emailNotification",
                    issues);
            }

            normalizedNodes.Add(new JsonObject
            {
                ["id"] = id,
                ["position"] = new JsonObject
                {
                    ["x"] = NumberValue(position, "x"),
                    ["y"] = NumberValue(position, "y"),
                },
                ["data"] = normalizedData,
            });
        }

        var normalizedEdges = new JsonArray();
        var edgeIds = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < edges.Count; index++)
        {
            if (edges[index] is not JsonObject edge)
            {
                issues.Add(InputIssue($"flow.edges[{index}]", "INVALID_OBJECT", "流程连线必须是对象。"));
                continue;
            }

            var path = $"flow.edges[{index}]";
            var id = RequiredString(edge, "id", path, 100, issues);
            var sourceId = RequiredString(edge, "source", path, 100, issues);
            var targetId = RequiredString(edge, "target", path, 100, issues);
            if (id is not null && !edgeIds.Add(id))
            {
                issues.Add(InputIssue($"{path}.id", "DUPLICATE_ID", "流程连线标识不能重复。"));
            }

            normalizedEdges.Add(new JsonObject
            {
                ["id"] = id,
                ["source"] = sourceId,
                ["target"] = targetId,
            });
        }

        var meta = source["meta"] as JsonObject;
        var rejectionHandling = NormalizeEnum(
            StringValue(meta, "rejectionHandling") ?? "resubmit-or-close",
            ["resubmit-or-close", "resubmit-only", "auto-close"],
            "resubmit-or-close",
            "flow.meta.rejectionHandling",
            issues);
        if (issues.Count > 0)
        {
            return NormalizedFlow.Failed(ValidationFailure("流程图格式无效", issues));
        }

        return NormalizedFlow.Success(new JsonObject
        {
            ["nodes"] = normalizedNodes,
            ["edges"] = normalizedEdges,
            ["savedAt"] = JsonValue.Create(now),
            ["meta"] = new JsonObject { ["rejectionHandling"] = rejectionHandling },
        });
    }

    private static JsonArray NormalizeOptions(
        JsonArray source,
        string path,
        HashSet<string> allIds,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        var result = new JsonArray();
        var siblingLabels = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < source.Count; index++)
        {
            if (source[index] is not JsonObject option)
            {
                issues.Add(InputIssue($"{path}[{index}]", "INVALID_OBJECT", "选项必须是对象。"));
                continue;
            }

            var optionPath = $"{path}[{index}]";
            var id = RequiredString(option, "id", optionPath, 100, issues);
            var label = RequiredString(option, "label", optionPath, 200, issues);
            if (id is not null && !allIds.Add(id))
            {
                issues.Add(InputIssue($"{optionPath}.id", "DUPLICATE_ID", "版本内的选项标识不能重复。"));
            }

            if (label is not null && !siblingLabels.Add(label))
            {
                issues.Add(InputIssue($"{optionPath}.label", "DUPLICATE_LABEL", "同一级选项名称不能重复。"));
            }

            var normalized = new JsonObject
            {
                ["id"] = id,
                ["label"] = label,
            };
            if (option["children"] is JsonArray children)
            {
                normalized["children"] = NormalizeOptions(
                    children,
                    $"{optionPath}.children",
                    allIds,
                    issues);
            }

            result.Add(normalized);
        }

        return result;
    }

    private static JsonObject NormalizeCondition(
        JsonObject source,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        var mode = NormalizeEnum(
            StringValue(source, "mode") ?? "all",
            ["all", "any"],
            "all",
            $"{path}.mode",
            issues);
        var result = new JsonObject
        {
            ["mode"] = mode,
            ["rules"] = new JsonArray(),
        };
        if (source["rules"] is not JsonArray rules)
        {
            issues.Add(InputIssue($"{path}.rules", "REQUIRED", "条件必须包含规则数组。"));
            return result;
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var normalizedRules = (JsonArray)result["rules"]!;
        for (var index = 0; index < rules.Count; index++)
        {
            if (rules[index] is not JsonObject rule)
            {
                issues.Add(InputIssue($"{path}.rules[{index}]", "INVALID_OBJECT", "条件规则必须是对象。"));
                continue;
            }

            var rulePath = $"{path}.rules[{index}]";
            var id = RequiredString(rule, "id", rulePath, 100, issues);
            var fieldId = RequiredString(rule, "fieldId", rulePath, 100, issues);
            var op = RequiredString(rule, "operator", rulePath, 30, issues);
            if (id is not null && !ids.Add(id))
            {
                issues.Add(InputIssue($"{rulePath}.id", "DUPLICATE_ID", "同一条件内的规则标识不能重复。"));
            }

            if (op is not null && !ConditionOperators.Contains(op))
            {
                issues.Add(InputIssue($"{rulePath}.operator", "INVALID_ENUM", "条件操作符无效。"));
            }

            var normalizedRule = new JsonObject
            {
                ["id"] = id,
                ["fieldId"] = fieldId,
                ["operator"] = op,
            };
            CopyOptionalNode(rule, normalizedRule, "value");
            normalizedRules.Add(normalizedRule);
        }

        return result;
    }

    private static JsonObject NormalizeAttachment(
        JsonObject source,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        var result = new JsonObject
        {
            ["inlinePdf"] = BoolValue(source, "inlinePdf"),
            ["excelToPdf"] = BoolValue(source, "excelToPdf"),
        };
        CopyOptionalInt(source, result, "maxSizeMb", 1, 100, path, issues);
        CopyOptionalInt(source, result, "maxCount", 1, 20, path, issues);
        CopyOptionalInt(source, result, "maxPreviewPages", 1, 50, path, issues);
        if (source["allowedExtensions"] is JsonArray extensions)
        {
            var normalized = new JsonArray();
            foreach (var extension in extensions)
            {
                if (extension is not JsonValue value
                    || !value.TryGetValue<string>(out var text)
                    || string.IsNullOrWhiteSpace(text)
                    || text.Any(character => !char.IsAsciiLetterOrDigit(character)))
                {
                    issues.Add(InputIssue($"{path}.allowedExtensions", "INVALID_FORMAT", "附件扩展名只能包含小写字母和数字。"));
                    continue;
                }

                normalized.Add(text.ToLowerInvariant());
            }

            result["allowedExtensions"] = normalized;
        }

        return result;
    }

    private static JsonObject NormalizeEmail(
        JsonObject source,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        var result = new JsonObject
        {
            ["enabled"] = BoolValue(source, "enabled"),
            ["notifyReviewers"] = BoolValue(source, "notifyReviewers"),
            ["notifyInitiator"] = BoolValue(source, "notifyInitiator"),
        };
        CopyOptionalGuidArray(source, result, "extraUserIds", path, issues);
        result["extraUserIds"] ??= new JsonArray();
        return result;
    }

    private static JsonArray NormalizeStringArray(
        JsonNode? source,
        string path,
        int maxLength,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (source is null)
        {
            return [];
        }

        if (source is not JsonArray items)
        {
            issues.Add(InputIssue(path, "INVALID_ARRAY", "该字段必须是数组。"));
            return [];
        }

        var result = new JsonArray();
        var unique = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < items.Count; index++)
        {
            if (items[index] is not JsonValue value
                || !value.TryGetValue<string>(out var text)
                || string.IsNullOrWhiteSpace(text)
                || text.Length > maxLength)
            {
                issues.Add(InputIssue($"{path}[{index}]", "INVALID_STRING", $"标识长度必须为 1 到 {maxLength} 个字符。"));
                continue;
            }

            if (!unique.Add(text))
            {
                issues.Add(InputIssue(path, "DUPLICATE_ID", "数组中的标识不能重复。"));
                continue;
            }

            result.Add(text);
        }

        return result;
    }

    private static void CopyOptionalGuid(
        JsonObject source,
        JsonObject target,
        string name,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        var text = StringValue(source, name);
        if (text is null)
        {
            return;
        }

        if (!Guid.TryParse(text, out var id) || id == Guid.Empty)
        {
            issues.Add(InputIssue($"{path}.{name}", "INVALID_UUID", "引用标识必须是有效 UUID。"));
            return;
        }

        target[name] = id.ToString("D");
    }

    private static void CopyOptionalGuidArray(
        JsonObject source,
        JsonObject target,
        string name,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (source[name] is null)
        {
            return;
        }

        if (source[name] is not JsonArray values)
        {
            issues.Add(InputIssue($"{path}.{name}", "INVALID_ARRAY", "引用列表必须是数组。"));
            return;
        }

        var normalized = new JsonArray();
        var unique = new HashSet<Guid>();
        for (var index = 0; index < values.Count; index++)
        {
            var text = values[index] is JsonValue value && value.TryGetValue<string>(out var item)
                ? item
                : null;
            if (!Guid.TryParse(text, out var id) || id == Guid.Empty)
            {
                issues.Add(InputIssue($"{path}.{name}[{index}]", "INVALID_UUID", "引用标识必须是有效 UUID。"));
                continue;
            }

            if (!unique.Add(id))
            {
                issues.Add(InputIssue($"{path}.{name}", "DUPLICATE_ID", "引用标识不能重复。"));
                continue;
            }

            normalized.Add(id.ToString("D"));
        }

        target[name] = normalized;
    }

    private static string? RequiredString(
        JsonObject source,
        string name,
        string path,
        int maxLength,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        var value = StringValue(source, name)?.Trim();
        if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength)
        {
            issues.Add(InputIssue($"{path}.{name}", "INVALID_LENGTH", $"{name} 长度必须为 1 到 {maxLength} 个字符。"));
            return null;
        }

        return value;
    }

    private static void CopyOptionalString(
        JsonObject source,
        JsonObject target,
        string name,
        int maxLength,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (source[name] is null)
        {
            return;
        }

        var value = StringValue(source, name);
        if (value is null || value.Length > maxLength)
        {
            issues.Add(InputIssue($"{path}.{name}", "INVALID_LENGTH", $"{name} 不能超过 {maxLength} 个字符。"));
            return;
        }

        target[name] = value;
    }

    private static void CopyOptionalNode(JsonObject source, JsonObject target, string name)
    {
        if (source[name] is { } value)
        {
            target[name] = value.DeepClone();
        }
    }

    private static void CopyOptionalInt(
        JsonObject source,
        JsonObject target,
        string name,
        int minimum,
        int maximum,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (source[name] is null)
        {
            return;
        }

        var value = IntValue(source, name);
        if (!value.HasValue || value.Value < minimum || value.Value > maximum)
        {
            issues.Add(InputIssue($"{path}.{name}", "OUT_OF_RANGE", $"{name} 必须在 {minimum} 到 {maximum} 之间。"));
            return;
        }

        target[name] = value.Value;
    }

    private static void CopyOptionalEnum(
        JsonObject source,
        JsonObject target,
        string name,
        HashSet<string> allowed,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (source[name] is null)
        {
            return;
        }

        var value = StringValue(source, name);
        if (value is null || !allowed.Contains(value))
        {
            issues.Add(InputIssue($"{path}.{name}", "INVALID_ENUM", $"{name} 的取值无效。"));
            return;
        }

        target[name] = value;
    }

    private static string NormalizeEnum(
        string value,
        HashSet<string> allowed,
        string fallback,
        string path,
        List<ProcessDefinitionInputIssueDto> issues)
    {
        if (allowed.Contains(value))
        {
            return value;
        }

        issues.Add(InputIssue(path, "INVALID_ENUM", "枚举值无效。"));
        return fallback;
    }

    private static string NormalizeInputStage(string? value) => value switch
    {
        "both" => "both",
        "reviewer" => "reviewer",
        _ => "initiator",
    };
}
