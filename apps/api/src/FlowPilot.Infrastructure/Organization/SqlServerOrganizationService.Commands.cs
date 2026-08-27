using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FlowPilot.Application.Organization;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService
{
    private const string CreateGroupRouteScope = "POST:/workflow-permission-groups";
    private const string CreateRoleRouteScope = "POST:/roles";
    private const string CreateUserRouteScope = "POST:/users";

    public async Task<OrganizationCommandResult<WorkflowPermissionGroupDto>> CreateWorkflowGroupAsync(
        CreateWorkflowPermissionGroupRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var normalized = NormalizeCreateRequest(request);
        if (normalized.Failure is not null)
        {
            return Failed<WorkflowPermissionGroupDto>(normalized.Failure);
        }

        var input = normalized.Value!;
        var requestHash = HashRequest(JsonSerializer.Serialize(input, JsonOptions));
        var now = _timeProvider.GetUtcNow();
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var existing = await LoadIdempotencyAsync(
                connection,
                transaction,
                actor.EffectiveUserId,
                CreateGroupRouteScope,
                idempotencyKey,
                cancellationToken).ConfigureAwait(false);
            if (existing is not null)
            {
                if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
                {
                    await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                    return Failed<WorkflowPermissionGroupDto>(Failure(
                        OrganizationCommandError.IdempotencyKeyReused,
                        "IDEMPOTENCY_KEY_REUSED",
                        "幂等键已被使用",
                        "同一个 Idempotency-Key 不能用于不同的创建请求。"));
                }

                if (string.Equals(existing.Status, "completed", StringComparison.Ordinal)
                    && existing.ResponseBodyJson is not null)
                {
                    var replay = JsonSerializer.Deserialize<WorkflowPermissionGroupDto>(
                        existing.ResponseBodyJson,
                        JsonOptions) ?? throw new InvalidDataException("幂等响应数据无效。");
                    await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                    return Succeeded(replay, replayed: true);
                }

                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(Failure(
                    OrganizationCommandError.IdempotencyRequestInProgress,
                    "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                    "请求正在处理中",
                    "相同的创建请求正在处理中，请稍后重试。"));
            }

            var validation = await ValidateGroupInputAsync(
                connection,
                transaction,
                input,
                groupId: null,
                cancellationToken).ConfigureAwait(false);
            if (validation.Count > 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(ValidationFailure(validation));
            }

            var groupId = Guid.NewGuid();
            var code = $"WPG-{groupId:N}"[..16].ToUpperInvariant();
            var idempotencyId = Guid.NewGuid();
            await InsertIdempotencyAsync(
                connection,
                transaction,
                idempotencyId,
                actor.EffectiveUserId,
                CreateGroupRouteScope,
                idempotencyKey,
                requestHash,
                now,
                cancellationToken).ConfigureAwait(false);

            await using (var insert = CreateCommand(connection, transaction))
            {
                insert.CommandText =
                    """
                    INSERT INTO [flowpilot].[workflow_permission_groups]
                    (
                        [id], [code], [normalized_code], [name], [description], [is_enabled],
                        [revision], [created_at], [updated_at], [created_by], [updated_by]
                    )
                    VALUES
                    (
                        @id, @code, @code, @name, @description, @is_enabled,
                        1, @now, @now, @actor_id, @actor_id
                    );
                    """;
                Add(insert, "@id", SqlDbType.UniqueIdentifier, groupId);
                Add(insert, "@code", SqlDbType.NVarChar, code, 100);
                Add(insert, "@name", SqlDbType.NVarChar, input.Name, 200);
                AddNullable(insert, "@description", SqlDbType.NVarChar, input.Description, 1000);
                Add(insert, "@is_enabled", SqlDbType.Bit, input.IsEnabled);
                Add(insert, "@now", SqlDbType.DateTime2, now.UtcDateTime);
                Add(insert, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
                await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }

            await ReplaceGroupRelationsAsync(
                connection,
                transaction,
                groupId,
                input,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertGroupAuditAsync(
                connection,
                transaction,
                groupId,
                "workflow-group.created",
                ["name", "purposes", "status", "directUserIds", "roleIds"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);

            var created = await LoadWorkflowGroupAsync(connection, transaction, groupId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("创建后的流程权限组无法重新读取。");
            await CompleteIdempotencyAsync(
                connection,
                transaction,
                idempotencyId,
                created,
                created.Revision,
                $"/workflow-permission-groups/{created.Id:D}",
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(created);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<OrganizationCommandResult<WorkflowPermissionGroupDto>> UpdateWorkflowGroupAsync(
        Guid groupId,
        UpdateWorkflowPermissionGroupRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.HasChanges)
        {
            return Failed<WorkflowPermissionGroupDto>(ValidationFailure(
                [Issue("request", "MIN_PROPERTIES", "至少提供一个需要修改的字段。")]));
        }

        var now = _timeProvider.GetUtcNow();
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var current = await LoadGroupForUpdateAsync(
                connection,
                transaction,
                groupId,
                cancellationToken).ConfigureAwait(false);
            if (current is null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(Failure(
                    OrganizationCommandError.NotFound,
                    "WORKFLOW_GROUP_NOT_FOUND",
                    "流程权限组不存在",
                    "未找到指定的流程权限组。"));
            }

            if (current.Revision != expectedRevision)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(Failure(
                    OrganizationCommandError.RevisionMismatch,
                    "REVISION_MISMATCH",
                    "流程权限组已被修改",
                    "请刷新后基于最新内容重新提交。",
                    currentRevision: current.Revision));
            }

            var normalized = NormalizeUpdateRequest(request, current);
            if (normalized.Failure is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(normalized.Failure);
            }

            var input = normalized.Value!;
            var validation = await ValidateGroupInputAsync(
                connection,
                transaction,
                input,
                groupId,
                cancellationToken).ConfigureAwait(false);
            if (validation.Count > 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(ValidationFailure(validation));
            }

            var removedPurposes = current.Purposes
                .Except(input.Purposes, StringComparer.Ordinal)
                .ToArray();
            if (removedPurposes.Length > 0
                && await HasReferencedPurposeAsync(
                    connection,
                    transaction,
                    groupId,
                    removedPurposes,
                    cancellationToken).ConfigureAwait(false))
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<WorkflowPermissionGroupDto>(Failure(
                    OrganizationCommandError.Conflict,
                    "WORKFLOW_GROUP_PURPOSE_REFERENCED",
                    "权限组用途正在被流程引用",
                    "请先在流程基本信息或流程设计器中解除相应用途的引用。"));
            }

            await using (var update = CreateCommand(connection, transaction))
            {
                update.CommandText =
                    """
                    UPDATE [flowpilot].[workflow_permission_groups]
                    SET [name] = @name,
                        [description] = @description,
                        [is_enabled] = @is_enabled,
                        [revision] = [revision] + 1,
                        [updated_at] = @now,
                        [updated_by] = @actor_id
                    WHERE [id] = @id AND [revision] = @revision;
                    """;
                Add(update, "@id", SqlDbType.UniqueIdentifier, groupId);
                Add(update, "@revision", SqlDbType.Int, expectedRevision);
                Add(update, "@name", SqlDbType.NVarChar, input.Name, 200);
                AddNullable(update, "@description", SqlDbType.NVarChar, input.Description, 1000);
                Add(update, "@is_enabled", SqlDbType.Bit, input.IsEnabled);
                Add(update, "@now", SqlDbType.DateTime2, now.UtcDateTime);
                Add(update, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
                if (await update.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
                {
                    throw new DBConcurrencyException("流程权限组修订号在事务中意外变化。");
                }
            }

            await ReplaceGroupRelationsAsync(
                connection,
                transaction,
                groupId,
                input,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertGroupAuditAsync(
                connection,
                transaction,
                groupId,
                "workflow-group.updated",
                ["name", "purposes", "status", "directUserIds", "roleIds"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);

            var updated = await LoadWorkflowGroupAsync(connection, transaction, groupId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("更新后的流程权限组无法重新读取。");
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(updated);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<OrganizationCommandResult<bool>> DeleteWorkflowGroupAsync(
        Guid groupId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        var now = _timeProvider.GetUtcNow();
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var current = await LoadGroupForUpdateAsync(
                connection,
                transaction,
                groupId,
                cancellationToken).ConfigureAwait(false);
            if (current is null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<bool>(Failure(
                    OrganizationCommandError.NotFound,
                    "WORKFLOW_GROUP_NOT_FOUND",
                    "流程权限组不存在",
                    "未找到指定的流程权限组。"));
            }

            if (current.Revision != expectedRevision)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<bool>(Failure(
                    OrganizationCommandError.RevisionMismatch,
                    "REVISION_MISMATCH",
                    "流程权限组已被修改",
                    "请刷新后重试删除。",
                    currentRevision: current.Revision));
            }

            await using (var references = CreateCommand(connection, transaction))
            {
                references.CommandText =
                    """
                    SELECT
                        (SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_version_group_refs]
                         WHERE [group_id] = @group_id),
                        (SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_tasks]
                         WHERE [group_id] = @group_id);
                    """;
                Add(references, "@group_id", SqlDbType.UniqueIdentifier, groupId);
                await using var reader = await references.ExecuteReaderAsync(
                    CommandBehavior.SingleRow,
                    cancellationToken).ConfigureAwait(false);
                await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
                if (reader.GetInt64(0) > 0 || reader.GetInt64(1) > 0)
                {
                    await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                    return Failed<bool>(Failure(
                        OrganizationCommandError.Conflict,
                        "WORKFLOW_GROUP_REFERENCED",
                        "流程权限组正在被引用",
                        "已被流程版本或历史任务引用的权限组不能删除，请改为停用。"));
                }
            }

            await InsertGroupAuditAsync(
                connection,
                transaction,
                groupId,
                "workflow-group.deleted",
                ["workflowPermissionGroup"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            await using (var delete = CreateCommand(connection, transaction))
            {
                delete.CommandText =
                    "DELETE FROM [flowpilot].[workflow_permission_groups] WHERE [id] = @id AND [revision] = @revision;";
                Add(delete, "@id", SqlDbType.UniqueIdentifier, groupId);
                Add(delete, "@revision", SqlDbType.Int, expectedRevision);
                if (await delete.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
                {
                    throw new DBConcurrencyException("流程权限组修订号在事务中意外变化。");
                }
            }

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(true);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<GroupState?> LoadGroupForUpdateAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid groupId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                [g].[revision], [g].[name], COALESCE([g].[description], N''), [g].[is_enabled],
                COALESCE((SELECT [purpose] AS [value]
                    FROM [flowpilot].[workflow_permission_group_purposes]
                    WHERE [group_id] = [g].[id] ORDER BY [purpose] FOR JSON PATH), N'[]'),
                COALESCE((SELECT [user_id] AS [id]
                    FROM [flowpilot].[workflow_group_users]
                    WHERE [group_id] = [g].[id] ORDER BY [user_id] FOR JSON PATH), N'[]'),
                COALESCE((SELECT [role_id] AS [id]
                    FROM [flowpilot].[workflow_group_roles]
                    WHERE [group_id] = [g].[id] ORDER BY [role_id] FOR JSON PATH), N'[]')
            FROM [flowpilot].[workflow_permission_groups] AS [g] WITH (UPDLOCK, HOLDLOCK)
            WHERE [g].[id] = @id;
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, groupId);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new GroupState(
            reader.GetInt32(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetBoolean(3),
            DeserializeArray<StringRow>(reader.GetString(4)).Select(item => item.Value).ToArray(),
            DeserializeArray<IdRow>(reader.GetString(5)).Select(item => item.Id).ToArray(),
            DeserializeArray<IdRow>(reader.GetString(6)).Select(item => item.Id).ToArray());
    }

    private async Task<IReadOnlyList<OrganizationInputIssueDto>> ValidateGroupInputAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        NormalizedGroupInput input,
        Guid? groupId,
        CancellationToken cancellationToken)
    {
        var issues = new List<OrganizationInputIssueDto>();
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                (SELECT COUNT_BIG(1)
                 FROM OPENJSON(@direct_user_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                 LEFT JOIN [flowpilot].[users] AS [u] WITH (UPDLOCK, HOLDLOCK)
                    ON [u].[id] = [requested].[id]
                   AND [u].[is_enabled] = 1
                   AND [u].[is_builtin_super_admin] = 0
                 WHERE [u].[id] IS NULL),
                (SELECT COUNT_BIG(1)
                 FROM OPENJSON(@role_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                 LEFT JOIN [flowpilot].[roles] AS [r] WITH (UPDLOCK, HOLDLOCK)
                    ON [r].[id] = [requested].[id]
                   AND [r].[is_enabled] = 1
                   AND [r].[is_builtin] = 0
                 WHERE [r].[id] IS NULL),
                (SELECT COUNT_BIG(1)
                 FROM [flowpilot].[workflow_permission_groups] AS [g] WITH (UPDLOCK, HOLDLOCK)
                 WHERE UPPER(LTRIM(RTRIM([g].[name]))) = UPPER(@name)
                   AND (@group_id IS NULL OR [g].[id] <> @group_id));
            """;
        Add(command, "@direct_user_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.DirectUserIds, JsonOptions), -1);
        Add(command, "@role_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.RoleIds, JsonOptions), -1);
        Add(command, "@name", SqlDbType.NVarChar, input.Name, 200);
        AddNullable(command, "@group_id", SqlDbType.UniqueIdentifier, groupId);

        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        if (reader.GetInt64(0) > 0)
        {
            issues.Add(Issue(
                "directUserIds",
                "INVALID_REFERENCE",
                "直接成员必须是存在且已启用的普通用户。"));
        }

        if (reader.GetInt64(1) > 0)
        {
            issues.Add(Issue(
                "roleIds",
                "INVALID_REFERENCE",
                "关联角色必须是存在且已启用的非内置角色。"));
        }

        if (reader.GetInt64(2) > 0)
        {
            issues.Add(Issue("name", "DUPLICATE", "流程权限组名称已存在。"));
        }

        return issues;
    }

    private async Task ReplaceGroupRelationsAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid groupId,
        NormalizedGroupInput input,
        Guid actorId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            DELETE FROM [flowpilot].[workflow_group_users] WHERE [group_id] = @group_id;
            DELETE FROM [flowpilot].[workflow_group_roles] WHERE [group_id] = @group_id;

            DELETE [current]
            FROM [flowpilot].[workflow_permission_group_purposes] AS [current]
            WHERE [current].[group_id] = @group_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM OPENJSON(@purposes) WITH ([purpose] nvarchar(20) '$') AS [requested]
                  WHERE [requested].[purpose] = [current].[purpose]
              );

            INSERT INTO [flowpilot].[workflow_permission_group_purposes] ([group_id], [purpose])
            SELECT @group_id, [purpose]
            FROM OPENJSON(@purposes) WITH ([purpose] nvarchar(20) '$') AS [requested]
            WHERE NOT EXISTS (
                SELECT 1
                FROM [flowpilot].[workflow_permission_group_purposes] AS [current]
                WHERE [current].[group_id] = @group_id
                  AND [current].[purpose] = [requested].[purpose]
            );

            INSERT INTO [flowpilot].[workflow_group_users]
                ([group_id], [user_id], [added_by], [added_at])
            SELECT @group_id, [id], @actor_id, @now
            FROM OPENJSON(@direct_user_ids) WITH ([id] uniqueidentifier '$');

            INSERT INTO [flowpilot].[workflow_group_roles]
                ([group_id], [role_id], [added_by], [added_at])
            SELECT @group_id, [id], @actor_id, @now
            FROM OPENJSON(@role_ids) WITH ([id] uniqueidentifier '$');
            """;
        Add(command, "@group_id", SqlDbType.UniqueIdentifier, groupId);
        Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@purposes", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.Purposes, JsonOptions), -1);
        Add(command, "@direct_user_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.DirectUserIds, JsonOptions), -1);
        Add(command, "@role_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.RoleIds, JsonOptions), -1);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> HasReferencedPurposeAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid groupId,
        IReadOnlyList<string> purposes,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_version_group_refs] AS [reference]
            INNER JOIN OPENJSON(@purposes) WITH ([purpose] nvarchar(20) '$') AS [removed]
                ON [removed].[purpose] = [reference].[purpose]
            WHERE [reference].[group_id] = @group_id;
            """;
        Add(command, "@group_id", SqlDbType.UniqueIdentifier, groupId);
        Add(command, "@purposes", SqlDbType.NVarChar,
            JsonSerializer.Serialize(purposes, JsonOptions), -1);
        return Convert.ToInt64(
            await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false),
            System.Globalization.CultureInfo.InvariantCulture) > 0;
    }

    private async Task<IdempotencyState?> LoadIdempotencyAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid actorId,
        string routeScope,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT [request_hash], [status], [response_body_json]
            FROM [flowpilot].[idempotency_records] WITH (UPDLOCK, HOLDLOCK)
            WHERE [actor_id] = @actor_id
              AND [route_scope] = @route_scope
              AND [idempotency_key] = @idempotency_key;
            """;
        Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@route_scope", SqlDbType.NVarChar, routeScope, 200);
        Add(command, "@idempotency_key", SqlDbType.NVarChar, idempotencyKey, 200);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new IdempotencyState(
                reader.GetString(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2))
            : null;
    }

    private async Task InsertIdempotencyAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid id,
        Guid actorId,
        string routeScope,
        string idempotencyKey,
        string requestHash,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            INSERT INTO [flowpilot].[idempotency_records]
            (
                [id], [actor_id], [route_scope], [idempotency_key], [request_hash], [status],
                [first_http_status], [replay_headers_json], [response_body_json],
                [lease_owner], [lease_until], [created_at], [completed_at], [expires_at]
            )
            VALUES
            (
                @id, @actor_id, @route_scope, @idempotency_key, @request_hash, N'processing',
                NULL, NULL, NULL, @lease_owner, @lease_until, @now, NULL, @expires_at
            );
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, id);
        Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actorId);
        Add(command, "@route_scope", SqlDbType.NVarChar, routeScope, 200);
        Add(command, "@idempotency_key", SqlDbType.NVarChar, idempotencyKey, 200);
        Add(command, "@request_hash", SqlDbType.VarChar, requestHash, 64);
        Add(command, "@lease_owner", SqlDbType.NVarChar, Guid.NewGuid().ToString("N"), 100);
        Add(command, "@lease_until", SqlDbType.DateTime2, now.AddMinutes(2).UtcDateTime);
        Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
        Add(command, "@expires_at", SqlDbType.DateTime2, now.AddDays(7).UtcDateTime);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task CompleteIdempotencyAsync<T>(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid id,
        T response,
        int revision,
        string location,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            UPDATE [flowpilot].[idempotency_records]
            SET [status] = N'completed',
                [first_http_status] = 201,
                [replay_headers_json] = @headers,
                [response_body_json] = @body,
                [lease_owner] = NULL,
                [lease_until] = NULL,
                [completed_at] = @now
            WHERE [id] = @id AND [status] = N'processing';
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, id);
        Add(command, "@headers", SqlDbType.NVarChar,
            JsonSerializer.Serialize(new
            {
                etag = $"\"{revision}\"",
                location,
            }, JsonOptions), -1);
        Add(command, "@body", SqlDbType.NVarChar,
            JsonSerializer.Serialize(response, JsonOptions), -1);
        Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new DBConcurrencyException("创建请求的幂等记录无法完成。");
        }
    }

    private async Task InsertGroupAuditAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid groupId,
        string action,
        IReadOnlyList<string> fields,
        WorkflowGroupMutationActor actor,
        string traceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            INSERT INTO [flowpilot].[audit_events]
            (
                [id], [resource_type], [resource_id], [action], [field_identifiers_json],
                [operator_user_id], [effective_user_id], [trace_id], [result], [occurred_at]
            )
            VALUES
            (
                @id, N'workflow-permission-group', @resource_id, @action, @fields,
                @operator_id, @effective_id, @trace_id, N'success', @now
            );
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, Guid.NewGuid());
        Add(command, "@resource_id", SqlDbType.UniqueIdentifier, groupId);
        Add(command, "@action", SqlDbType.NVarChar, action, 100);
        Add(command, "@fields", SqlDbType.NVarChar,
            JsonSerializer.Serialize(fields, JsonOptions), -1);
        Add(command, "@operator_id", SqlDbType.UniqueIdentifier, actor.OperatorUserId);
        Add(command, "@effective_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
        Add(command, "@trace_id", SqlDbType.NVarChar, traceId, 100);
        Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static NormalizedGroupResult NormalizeCreateRequest(
        CreateWorkflowPermissionGroupRequest request) => NormalizeGroupInput(
            request.Name,
            request.Description,
            request.Purposes,
            request.Status,
            request.DirectUserIds,
            request.RoleIds);

    private static NormalizedGroupResult NormalizeUpdateRequest(
        UpdateWorkflowPermissionGroupRequest request,
        GroupState current) => NormalizeGroupInput(
            request.Name ?? current.Name,
            request.Description ?? current.Description,
            request.Purposes ?? current.Purposes.Select(ToApiPurpose).ToArray(),
            request.Status ?? (current.IsEnabled ? "enabled" : "disabled"),
            request.DirectUserIds ?? current.DirectUserIds,
            request.RoleIds ?? current.RoleIds);

    private static NormalizedGroupResult NormalizeGroupInput(
        string name,
        string? description,
        IReadOnlyList<string> purposes,
        string status,
        IReadOnlyList<Guid> directUserIds,
        IReadOnlyList<Guid> roleIds)
    {
        var issues = new List<OrganizationInputIssueDto>();
        var normalizedName = name.Trim();
        if (normalizedName.Length is < 1 or > 100)
        {
            issues.Add(Issue("name", "INVALID_LENGTH", "权限组名称长度必须为 1 到 100 个字符。"));
        }

        var normalizedDescription = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        if (normalizedDescription is { Length: > 500 })
        {
            issues.Add(Issue("description", "MAX_LENGTH", "说明不能超过 500 个字符。"));
        }

        var normalizedPurposes = purposes
            .Select(ToDatabasePurpose)
            .Where(value => value is not null)
            .Select(value => value!)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (purposes.Count == 0 || normalizedPurposes.Length != purposes.Distinct(StringComparer.Ordinal).Count())
        {
            issues.Add(Issue(
                "purposes",
                "INVALID_VALUE",
                "允许用途只能包含 start、review-or-accept、close，且不能重复。"));
        }

        var isEnabled = status switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => (bool?)null,
        };
        if (isEnabled is null)
        {
            issues.Add(Issue("status", "INVALID_VALUE", "状态只能是 enabled 或 disabled。"));
        }

        var normalizedUsers = directUserIds.Distinct().Order().ToArray();
        if (normalizedUsers.Length != directUserIds.Count)
        {
            issues.Add(Issue("directUserIds", "DUPLICATE", "直接成员不能重复。"));
        }

        var normalizedRoles = roleIds.Distinct().Order().ToArray();
        if (normalizedRoles.Length != roleIds.Count)
        {
            issues.Add(Issue("roleIds", "DUPLICATE", "关联角色不能重复。"));
        }

        return issues.Count > 0
            ? new NormalizedGroupResult(null, ValidationFailure(issues))
            : new NormalizedGroupResult(
                new NormalizedGroupInput(
                    normalizedName,
                    normalizedDescription,
                    normalizedPurposes,
                    isEnabled!.Value,
                    normalizedUsers,
                    normalizedRoles),
                null);
    }

    private static string ToApiPurpose(string purpose) =>
        string.Equals(purpose, "review", StringComparison.Ordinal) ? "review-or-accept" : purpose;

    private static string HashRequest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static OrganizationInputIssueDto Issue(string path, string code, string message) =>
        new(path, code, message);

    private static OrganizationCommandFailure ValidationFailure(
        IReadOnlyList<OrganizationInputIssueDto> issues) => Failure(
            OrganizationCommandError.ValidationFailed,
            "VALIDATION_FAILED",
            "流程权限组校验失败",
            "请修正无效字段后重试。",
            issues);

    private static OrganizationCommandFailure Failure(
        OrganizationCommandError error,
        string code,
        string title,
        string detail,
        IReadOnlyList<OrganizationInputIssueDto>? issues = null,
        int? currentRevision = null) =>
        new(error, code, title, detail, issues, currentRevision);

    private static OrganizationCommandResult<T> Succeeded<T>(T value, bool replayed = false) =>
        new(new OrganizationCommandValue<T>(value, replayed), null);

    private static OrganizationCommandResult<T> Failed<T>(OrganizationCommandFailure failure) =>
        new(null, failure);

    private sealed record NormalizedGroupInput(
        string Name,
        string? Description,
        IReadOnlyList<string> Purposes,
        bool IsEnabled,
        IReadOnlyList<Guid> DirectUserIds,
        IReadOnlyList<Guid> RoleIds);

    private sealed record NormalizedGroupResult(
        NormalizedGroupInput? Value,
        OrganizationCommandFailure? Failure);

    private sealed record GroupState(
        int Revision,
        string Name,
        string Description,
        bool IsEnabled,
        IReadOnlyList<string> Purposes,
        IReadOnlyList<Guid> DirectUserIds,
        IReadOnlyList<Guid> RoleIds);

    private sealed record IdempotencyState(
        string RequestHash,
        string Status,
        string? ResponseBodyJson);
}
