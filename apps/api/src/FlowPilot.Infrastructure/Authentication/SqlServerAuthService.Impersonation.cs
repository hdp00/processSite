using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Security;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.Authentication;

public sealed partial class SqlServerAuthService
{
    private static readonly TimeSpan ImpersonationIdempotencyLease = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan ImpersonationIdempotencyRetention = TimeSpan.FromDays(7);
    private static readonly JsonSerializerOptions ImpersonationJsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<ImpersonationCandidateResult> ListImpersonationCandidatesAsync(
        string? sessionToken,
        int page,
        int pageSize,
        string? query,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidSessionTokenShape(sessionToken))
        {
            return ImpersonationCandidateResult.Failed(ImpersonationFailure.AuthenticationRequired);
        }

        var now = TruncateToMilliseconds(_timeProvider.GetUtcNow());
        var tokenHash = HashSessionToken(sessionToken!);
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken)
            .ConfigureAwait(false);

        var state = await TouchSessionAsync(
            connection,
            transaction,
            tokenHash,
            now,
            cancellationToken).ConfigureAwait(false);
        if (state is null)
        {
            return ImpersonationCandidateResult.Failed(ImpersonationFailure.AuthenticationRequired);
        }

        var operatorUser = await LoadUserSessionViewAsync(
            connection,
            transaction,
            state.OperatorUserId,
            cancellationToken).ConfigureAwait(false);
        if (operatorUser is null || !operatorUser.UserRecord.IsBuiltinSuperAdmin)
        {
            return ImpersonationCandidateResult.Failed(ImpersonationFailure.NotAllowed);
        }

        var normalizedQuery = string.IsNullOrWhiteSpace(query) ? null : query.Trim();
        var total = await CountImpersonationCandidatesAsync(
            connection,
            transaction,
            normalizedQuery,
            cancellationToken).ConfigureAwait(false);
        var userIds = await LoadImpersonationCandidateIdsAsync(
            connection,
            transaction,
            page,
            pageSize,
            normalizedQuery,
            cancellationToken).ConfigureAwait(false);

        var users = new List<UserDto>(userIds.Count);
        foreach (var userId in userIds)
        {
            var candidate = await LoadUserSessionViewAsync(
                connection,
                transaction,
                userId,
                cancellationToken).ConfigureAwait(false);
            if (candidate is not null)
            {
                users.Add(candidate.User);
            }
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return ImpersonationCandidateResult.Success(new ImpersonationCandidatePageDto(
            users,
            new AuthenticationPageMetaDto(
                page,
                pageSize,
                total,
                total == 0 ? 0 : (int)Math.Ceiling(total / (double)pageSize))));
    }

    public async Task<ImpersonationCommandResult> StartImpersonationAsync(
        string? sessionToken,
        Guid targetUserId,
        string reason,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        reason = reason?.Trim() ?? string.Empty;
        if (!IsValidSessionTokenShape(sessionToken)
            || targetUserId == Guid.Empty
            || reason.Length is < 1 or > 500)
        {
            return ImpersonationCommandResult.Failed(
                IsValidSessionTokenShape(sessionToken)
                    ? ImpersonationFailure.TargetInvalid
                    : ImpersonationFailure.AuthenticationRequired);
        }

        var now = TruncateToMilliseconds(_timeProvider.GetUtcNow());
        var tokenHash = HashSessionToken(sessionToken!);
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        var state = await TouchSessionAsync(
            connection,
            transaction,
            tokenHash,
            now,
            cancellationToken).ConfigureAwait(false);
        if (state is null)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.AuthenticationRequired);
        }

        var operatorUser = await LoadUserSessionViewAsync(
            connection,
            transaction,
            state.OperatorUserId,
            cancellationToken).ConfigureAwait(false);
        if (operatorUser is null || !operatorUser.UserRecord.IsBuiltinSuperAdmin)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.NotAllowed);
        }

        var reservation = await ReserveImpersonationIdempotencyAsync(
            connection,
            transaction,
            state.OperatorUserId,
            $"auth/impersonation:start:{state.SessionId:D}",
            idempotencyKey,
            HashImpersonationRequest($"{targetUserId:D}\n{reason}"),
            now,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayedSession is not null)
        {
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return ImpersonationCommandResult.Success(reservation.ReplayedSession);
        }

        if (reservation.Failure is { } reservationFailure)
        {
            return ImpersonationCommandResult.Failed(reservationFailure);
        }

        if (state.ImpersonationRecordId is { } activeRecordId)
        {
            var active = await LoadImpersonationContextAsync(
                connection,
                transaction,
                activeRecordId,
                state.OperatorUserId,
                state.EffectiveUserId,
                state.AbsoluteExpiresAt,
                cancellationToken).ConfigureAwait(false);
            if (active is null)
            {
                return ImpersonationCommandResult.Failed(ImpersonationFailure.InvalidSessionState);
            }

            if (active.TargetUserId == targetUserId)
            {
                var effectiveUser = await LoadUserSessionViewAsync(
                    connection,
                    transaction,
                    targetUserId,
                    cancellationToken).ConfigureAwait(false);
                if (effectiveUser is null || !effectiveUser.UserRecord.IsEnabled)
                {
                    return ImpersonationCommandResult.Failed(ImpersonationFailure.TargetInvalid);
                }

                var replayableSession = CreateSessionDto(
                    effectiveUser,
                    operatorUser,
                    active,
                    state.IdleExpiresAt);
                await CompleteImpersonationIdempotencyAsync(
                    connection,
                    transaction,
                    reservation.RecordId!.Value,
                    replayableSession,
                    now,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return ImpersonationCommandResult.Success(replayableSession);
            }

            return ImpersonationCommandResult.Failed(ImpersonationFailure.AlreadyActive);
        }

        if (state.EffectiveUserId != state.OperatorUserId)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.InvalidSessionState);
        }

        var targetUser = await LoadUserSessionViewAsync(
            connection,
            transaction,
            targetUserId,
            cancellationToken).ConfigureAwait(false);
        if (targetUser is null)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.TargetNotFound);
        }

        if (!targetUser.UserRecord.IsEnabled || targetUser.UserRecord.IsBuiltinSuperAdmin)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.TargetInvalid);
        }

        var impersonationId = Guid.NewGuid();
        await InsertImpersonationRecordAsync(
            connection,
            transaction,
            impersonationId,
            state.OperatorUserId,
            targetUserId,
            reason,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);

        if (!await ActivateImpersonationAsync(
                connection,
                transaction,
                state.SessionId,
                state.OperatorUserId,
                targetUserId,
                impersonationId,
                cancellationToken).ConfigureAwait(false))
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.InvalidSessionState);
        }

        await InsertImpersonationAuditAsync(
            connection,
            transaction,
            impersonationId,
            "auth.impersonation-started",
            state.OperatorUserId,
            targetUserId,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);

        var context = new ImpersonationContextDto(
            impersonationId,
            state.OperatorUserId,
            targetUserId,
            reason,
            now,
            state.AbsoluteExpiresAt);
        var session = CreateSessionDto(
            targetUser,
            operatorUser,
            context,
            state.IdleExpiresAt);
        await CompleteImpersonationIdempotencyAsync(
            connection,
            transaction,
            reservation.RecordId!.Value,
            session,
            now,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return ImpersonationCommandResult.Success(session);
    }

    public async Task<ImpersonationCommandResult> StopImpersonationAsync(
        string? sessionToken,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidSessionTokenShape(sessionToken))
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.AuthenticationRequired);
        }

        var now = TruncateToMilliseconds(_timeProvider.GetUtcNow());
        var tokenHash = HashSessionToken(sessionToken!);
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        var state = await TouchSessionAsync(
            connection,
            transaction,
            tokenHash,
            now,
            cancellationToken).ConfigureAwait(false);
        if (state is null)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.AuthenticationRequired);
        }

        var operatorUser = await LoadUserSessionViewAsync(
            connection,
            transaction,
            state.OperatorUserId,
            cancellationToken).ConfigureAwait(false);
        if (operatorUser is null || !operatorUser.UserRecord.IsBuiltinSuperAdmin)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.NotAllowed);
        }

        var reservation = await ReserveImpersonationIdempotencyAsync(
            connection,
            transaction,
            state.OperatorUserId,
            $"auth/impersonation:stop:{state.SessionId:D}",
            idempotencyKey,
            HashImpersonationRequest("stop"),
            now,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayedSession is not null)
        {
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return ImpersonationCommandResult.Success(reservation.ReplayedSession);
        }

        if (reservation.Failure is { } reservationFailure)
        {
            return ImpersonationCommandResult.Failed(reservationFailure);
        }

        if (state.ImpersonationRecordId is not { } impersonationId)
        {
            if (state.EffectiveUserId != state.OperatorUserId)
            {
                return ImpersonationCommandResult.Failed(ImpersonationFailure.InvalidSessionState);
            }

            var currentSession = CreateSessionDto(
                operatorUser,
                operatorUser,
                impersonation: null,
                state.IdleExpiresAt);
            await CompleteImpersonationIdempotencyAsync(
                connection,
                transaction,
                reservation.RecordId!.Value,
                currentSession,
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return ImpersonationCommandResult.Success(currentSession);
        }

        var active = await LoadImpersonationContextAsync(
            connection,
            transaction,
            impersonationId,
            state.OperatorUserId,
            state.EffectiveUserId,
            state.AbsoluteExpiresAt,
            cancellationToken).ConfigureAwait(false);
        if (active is null)
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.InvalidSessionState);
        }

        if (!await EndImpersonationAsync(
                connection,
                transaction,
                state.SessionId,
                impersonationId,
                state.OperatorUserId,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false))
        {
            return ImpersonationCommandResult.Failed(ImpersonationFailure.InvalidSessionState);
        }

        await InsertImpersonationAuditAsync(
            connection,
            transaction,
            impersonationId,
            "auth.impersonation-stopped",
            state.OperatorUserId,
            state.EffectiveUserId,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var restoredSession = CreateSessionDto(
            operatorUser,
            operatorUser,
            impersonation: null,
            state.IdleExpiresAt);
        await CompleteImpersonationIdempotencyAsync(
            connection,
            transaction,
            reservation.RecordId!.Value,
            restoredSession,
            now,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return ImpersonationCommandResult.Success(restoredSession);
    }

    private async Task<int> CountImpersonationCandidatesAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        string? query,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            SELECT COUNT_BIG(*)
            FROM [flowpilot].[users] AS [u]
            WHERE [u].[is_enabled] = 1
              AND [u].[is_builtin_super_admin] = 0
              AND (@query IS NULL
                   OR [u].[login_name] LIKE N'%' + @query + N'%'
                   OR [u].[display_name] LIKE N'%' + @query + N'%'
                   OR [u].[email] LIKE N'%' + @query + N'%');
            """);
        command.Parameters.Add("@query", SqlDbType.NVarChar, 100).Value =
            query is null ? DBNull.Value : query;
        return checked((int)(long)(await command.ExecuteScalarAsync(cancellationToken)
            .ConfigureAwait(false) ?? 0L));
    }

    private async Task<IReadOnlyList<Guid>> LoadImpersonationCandidateIdsAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        int page,
        int pageSize,
        string? query,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            SELECT [u].[id]
            FROM [flowpilot].[users] AS [u]
            WHERE [u].[is_enabled] = 1
              AND [u].[is_builtin_super_admin] = 0
              AND (@query IS NULL
                   OR [u].[login_name] LIKE N'%' + @query + N'%'
                   OR [u].[display_name] LIKE N'%' + @query + N'%'
                   OR [u].[email] LIKE N'%' + @query + N'%')
            ORDER BY [u].[normalized_login_name], [u].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """);
        command.Parameters.Add("@query", SqlDbType.NVarChar, 100).Value =
            query is null ? DBNull.Value : query;
        command.Parameters.Add("@offset", SqlDbType.Int).Value = checked((page - 1) * pageSize);
        command.Parameters.Add("@page_size", SqlDbType.Int).Value = pageSize;

        var ids = new List<Guid>(pageSize);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            ids.Add(reader.GetGuid(0));
        }

        return ids;
    }

    private async Task<ImpersonationContextDto?> LoadImpersonationContextAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid impersonationId,
        Guid operatorUserId,
        Guid effectiveUserId,
        DateTimeOffset absoluteExpiresAt,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            SELECT [id], [super_admin_user_id], [target_user_id], [reason], [started_at]
            FROM [flowpilot].[impersonation_records]
            WHERE [id] = @id
              AND [super_admin_user_id] = @operator_id
              AND [target_user_id] = @effective_id
              AND [ended_at] IS NULL;
            """);
        command.Parameters.Add("@id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        command.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        command.Parameters.Add("@effective_id", SqlDbType.UniqueIdentifier).Value = effectiveUserId;

        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new ImpersonationContextDto(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            reader.GetString(3),
            AsUtc(reader.GetDateTime(4)),
            absoluteExpiresAt);
    }

    private async Task InsertImpersonationRecordAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid impersonationId,
        Guid operatorUserId,
        Guid targetUserId,
        string reason,
        string traceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            INSERT INTO [flowpilot].[impersonation_records]
                ([id], [super_admin_user_id], [target_user_id], [reason],
                 [started_at], [ended_at], [start_trace_id], [end_trace_id])
            VALUES
                (@id, @operator_id, @target_id, @reason,
                 @now, NULL, @trace_id, NULL);
            """);
        command.Parameters.Add("@id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        command.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        command.Parameters.Add("@target_id", SqlDbType.UniqueIdentifier).Value = targetUserId;
        command.Parameters.Add("@reason", SqlDbType.NVarChar, 1000).Value = reason;
        command.Parameters.Add("@trace_id", SqlDbType.NVarChar, 100).Value = traceId;
        AddUtcParameter(command, "@now", now);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> ActivateImpersonationAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid sessionId,
        Guid operatorUserId,
        Guid targetUserId,
        Guid impersonationId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[sessions]
            SET [effective_user_id] = @target_id,
                [impersonation_record_id] = @impersonation_id,
                [permission_snapshot_version] = @permission_snapshot_version
            WHERE [id] = @session_id
              AND [operator_user_id] = @operator_id
              AND [effective_user_id] = @operator_id
              AND [impersonation_record_id] IS NULL
              AND [revoked_at] IS NULL;
            """);
        command.Parameters.Add("@session_id", SqlDbType.UniqueIdentifier).Value = sessionId;
        command.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        command.Parameters.Add("@target_id", SqlDbType.UniqueIdentifier).Value = targetUserId;
        command.Parameters.Add("@impersonation_id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        command.Parameters.Add("@permission_snapshot_version", SqlDbType.Int).Value =
            BuiltinCatalog.PermissionSnapshotVersion;
        return await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) == 1;
    }

    private async Task<bool> EndImpersonationAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid sessionId,
        Guid impersonationId,
        Guid operatorUserId,
        string traceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var recordCommand = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[impersonation_records]
            SET [ended_at] = @now,
                [end_trace_id] = @trace_id
            WHERE [id] = @impersonation_id
              AND [super_admin_user_id] = @operator_id
              AND [ended_at] IS NULL;
            """);
        recordCommand.Parameters.Add("@impersonation_id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        recordCommand.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        recordCommand.Parameters.Add("@trace_id", SqlDbType.NVarChar, 100).Value = traceId;
        AddUtcParameter(recordCommand, "@now", now);
        if (await recordCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            return false;
        }

        await using var sessionCommand = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[sessions]
            SET [effective_user_id] = [operator_user_id],
                [impersonation_record_id] = NULL,
                [permission_snapshot_version] = @permission_snapshot_version
            WHERE [id] = @session_id
              AND [operator_user_id] = @operator_id
              AND [impersonation_record_id] = @impersonation_id
              AND [revoked_at] IS NULL;
            """);
        sessionCommand.Parameters.Add("@session_id", SqlDbType.UniqueIdentifier).Value = sessionId;
        sessionCommand.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        sessionCommand.Parameters.Add("@impersonation_id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        sessionCommand.Parameters.Add("@permission_snapshot_version", SqlDbType.Int).Value =
            BuiltinCatalog.PermissionSnapshotVersion;
        return await sessionCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) == 1;
    }

    private async Task InsertImpersonationAuditAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid impersonationId,
        string action,
        Guid operatorUserId,
        Guid effectiveUserId,
        string traceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            INSERT INTO [flowpilot].[audit_events]
                ([id], [resource_type], [resource_id], [action], [field_identifiers_json],
                 [operator_user_id], [effective_user_id], [trace_id], [result], [occurred_at])
            VALUES
                (@id, N'impersonation', @resource_id, @action, NULL,
                 @operator_id, @effective_id, @trace_id, N'success', @now);
            """);
        command.Parameters.Add("@id", SqlDbType.UniqueIdentifier).Value = Guid.NewGuid();
        command.Parameters.Add("@resource_id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        command.Parameters.Add("@action", SqlDbType.NVarChar, 100).Value = action;
        command.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        command.Parameters.Add("@effective_id", SqlDbType.UniqueIdentifier).Value = effectiveUserId;
        command.Parameters.Add("@trace_id", SqlDbType.NVarChar, 100).Value = traceId;
        AddUtcParameter(command, "@now", now);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImpersonationIdempotencyReservation> ReserveImpersonationIdempotencyAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid actorId,
        string routeScope,
        string idempotencyKey,
        string requestHash,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var readCommand = CreateCommand(
            connection,
            transaction,
            """
            SELECT [request_hash], [status], [response_body_json]
            FROM [flowpilot].[idempotency_records] WITH (UPDLOCK, HOLDLOCK)
            WHERE [actor_id] = @actor_id
              AND [route_scope] = @route_scope
              AND [idempotency_key] = @idempotency_key;
            """);
        readCommand.Parameters.Add("@actor_id", SqlDbType.UniqueIdentifier).Value = actorId;
        readCommand.Parameters.Add("@route_scope", SqlDbType.NVarChar, 200).Value = routeScope;
        readCommand.Parameters.Add("@idempotency_key", SqlDbType.NVarChar, 200).Value = idempotencyKey;

        string? existingHash = null;
        string? existingStatus = null;
        string? responseJson = null;
        await using (var reader = await readCommand.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false))
        {
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                existingHash = reader.GetString(0);
                existingStatus = reader.GetString(1);
                responseJson = reader.IsDBNull(2) ? null : reader.GetString(2);
            }
        }

        if (existingHash is not null)
        {
            if (!string.Equals(existingHash, requestHash, StringComparison.Ordinal))
            {
                return ImpersonationIdempotencyReservation.Failed(
                    ImpersonationFailure.IdempotencyKeyReused);
            }

            if (string.Equals(existingStatus, "completed", StringComparison.Ordinal)
                && responseJson is not null)
            {
                var replay = JsonSerializer.Deserialize<SessionDto>(
                    responseJson,
                    ImpersonationJsonOptions)
                    ?? throw new InvalidDataException("Impersonation idempotency response is invalid.");
                return ImpersonationIdempotencyReservation.Replayed(replay);
            }

            return ImpersonationIdempotencyReservation.Failed(
                ImpersonationFailure.IdempotencyRequestInProgress);
        }

        var recordId = Guid.NewGuid();
        await using var insertCommand = CreateCommand(
            connection,
            transaction,
            """
            INSERT INTO [flowpilot].[idempotency_records]
                ([id], [actor_id], [route_scope], [idempotency_key], [request_hash],
                 [status], [first_http_status], [replay_headers_json], [response_body_json],
                 [lease_owner], [lease_until], [created_at], [completed_at], [expires_at])
            VALUES
                (@id, @actor_id, @route_scope, @idempotency_key, @request_hash,
                 N'processing', NULL, NULL, NULL,
                 @lease_owner, @lease_until, @now, NULL, @expires_at);
            """);
        insertCommand.Parameters.Add("@id", SqlDbType.UniqueIdentifier).Value = recordId;
        insertCommand.Parameters.Add("@actor_id", SqlDbType.UniqueIdentifier).Value = actorId;
        insertCommand.Parameters.Add("@route_scope", SqlDbType.NVarChar, 200).Value = routeScope;
        insertCommand.Parameters.Add("@idempotency_key", SqlDbType.NVarChar, 200).Value = idempotencyKey;
        insertCommand.Parameters.Add("@request_hash", SqlDbType.VarChar, 64).Value = requestHash;
        insertCommand.Parameters.Add("@lease_owner", SqlDbType.NVarChar, 100).Value = Guid.NewGuid().ToString("N");
        AddUtcParameter(insertCommand, "@lease_until", now.Add(ImpersonationIdempotencyLease));
        AddUtcParameter(insertCommand, "@now", now);
        AddUtcParameter(insertCommand, "@expires_at", now.Add(ImpersonationIdempotencyRetention));
        await insertCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        return ImpersonationIdempotencyReservation.Reserved(recordId);
    }

    private async Task CompleteImpersonationIdempotencyAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid recordId,
        SessionDto session,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[idempotency_records]
            SET [status] = N'completed',
                [first_http_status] = 200,
                [replay_headers_json] = N'{}',
                [response_body_json] = @response_body,
                [lease_owner] = NULL,
                [lease_until] = NULL,
                [completed_at] = @now
            WHERE [id] = @id
              AND [status] = N'processing';
            """);
        command.Parameters.Add("@id", SqlDbType.UniqueIdentifier).Value = recordId;
        command.Parameters.Add("@response_body", SqlDbType.NVarChar, -1).Value =
            JsonSerializer.Serialize(session, ImpersonationJsonOptions);
        AddUtcParameter(command, "@now", now);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("Impersonation idempotency record changed during the request.");
        }
    }

    private static string HashImpersonationRequest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private async Task CloseImpersonationRecordAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid impersonationId,
        Guid operatorUserId,
        string traceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[impersonation_records]
            SET [ended_at] = @now,
                [end_trace_id] = @trace_id
            WHERE [id] = @impersonation_id
              AND [super_admin_user_id] = @operator_id
              AND [ended_at] IS NULL;
            """);
        command.Parameters.Add("@impersonation_id", SqlDbType.UniqueIdentifier).Value = impersonationId;
        command.Parameters.Add("@operator_id", SqlDbType.UniqueIdentifier).Value = operatorUserId;
        command.Parameters.Add("@trace_id", SqlDbType.NVarChar, 100).Value = traceId;
        AddUtcParameter(command, "@now", now);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private sealed record ImpersonationIdempotencyReservation(
        Guid? RecordId,
        SessionDto? ReplayedSession,
        ImpersonationFailure? Failure)
    {
        public static ImpersonationIdempotencyReservation Reserved(Guid recordId) =>
            new(recordId, null, null);

        public static ImpersonationIdempotencyReservation Replayed(SessionDto session) =>
            new(null, session, null);

        public static ImpersonationIdempotencyReservation Failed(ImpersonationFailure failure) =>
            new(null, null, failure);
    }
}
