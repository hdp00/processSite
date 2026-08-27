using System.Data;
using System.Text.Json;
using FlowPilot.Application.Organization;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService
{
    public async Task<RoleDto?> GetRoleAsync(
        Guid roleId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        return await LoadRoleAsync(connection, null, roleId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<OrganizationCommandResult<RoleDto>> UpdateRoleAsync(
        Guid roleId,
        UpdateRoleRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.HasChanges)
        {
            return Failed<RoleDto>(IdentityValidationFailure(
                "角色校验失败",
                [Issue("request", "MIN_PROPERTIES", "至少提供一个需要修改的字段。")]));
        }

        var now = _timeProvider.GetUtcNow();
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var current = await LoadRoleForUpdateAsync(
                connection,
                transaction,
                roleId,
                cancellationToken).ConfigureAwait(false);
            if (current is null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<RoleDto>(RoleNotFoundFailure());
            }

            if (current.IsBuiltIn)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<RoleDto>(BuiltInRoleFailure());
            }

            if (current.Revision != expectedRevision)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<RoleDto>(Failure(
                    OrganizationCommandError.RevisionMismatch,
                    "REVISION_MISMATCH",
                    "角色已被修改",
                    "请刷新后基于最新内容重新提交。",
                    currentRevision: current.Revision));
            }

            var normalized = NormalizeRole(new CreateRoleRequest
            {
                Name = request.Name ?? current.Name,
                Description = request.Description ?? current.Description,
                Status = request.Status ?? (current.IsEnabled ? "enabled" : "disabled"),
                MemberIds = request.MemberIds ?? current.MemberIds,
            });
            if (normalized.Failure is not null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<RoleDto>(normalized.Failure);
            }

            var input = normalized.Value!;
            var issues = await ValidateRoleUpdateAsync(
                connection,
                transaction,
                roleId,
                input,
                cancellationToken).ConfigureAwait(false);
            if (issues.Count > 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<RoleDto>(IdentityValidationFailure("角色校验失败", issues));
            }

            await using (var command = CreateCommand(connection, transaction))
            {
                command.CommandText =
                    """
                    UPDATE [flowpilot].[roles]
                    SET [name] = @name,
                        [normalized_name] = @normalized_name,
                        [description] = @description,
                        [is_enabled] = @is_enabled,
                        [revision] = [revision] + 1,
                        [updated_at] = @now,
                        [updated_by] = @actor_id
                    WHERE [id] = @id AND [revision] = @revision;

                    DELETE FROM [flowpilot].[user_roles] WHERE [role_id] = @id;

                    INSERT INTO [flowpilot].[user_roles]
                        ([user_id], [role_id], [granted_by], [granted_at])
                    SELECT [id], @id, @actor_id, @now
                    FROM OPENJSON(@member_ids) WITH ([id] uniqueidentifier '$');
                    """;
                Add(command, "@id", SqlDbType.UniqueIdentifier, roleId);
                Add(command, "@revision", SqlDbType.Int, expectedRevision);
                Add(command, "@name", SqlDbType.NVarChar, input.Name, 200);
                Add(command, "@normalized_name", SqlDbType.NVarChar, input.NormalizedName, 200);
                AddNullable(command, "@description", SqlDbType.NVarChar, input.Description, 1000);
                Add(command, "@is_enabled", SqlDbType.Bit, input.IsEnabled);
                Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
                Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
                Add(command, "@member_ids", SqlDbType.NVarChar,
                    JsonSerializer.Serialize(input.MemberIds, JsonOptions), -1);
                await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }

            var fields = new List<string>();
            if (request.Name is not null) fields.Add("name");
            if (request.Description is not null) fields.Add("description");
            if (request.Status is not null) fields.Add("status");
            if (request.MemberIds is not null) fields.Add("memberIds");
            await InsertOrganizationAuditAsync(
                connection,
                transaction,
                "role",
                roleId,
                "role.updated",
                fields,
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);

            var updated = await LoadRoleAsync(connection, transaction, roleId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("更新后的角色无法重新读取。");
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(updated);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    public async Task<OrganizationCommandResult<bool>> DeleteRoleAsync(
        Guid roleId,
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
            var current = await LoadRoleForUpdateAsync(
                connection,
                transaction,
                roleId,
                cancellationToken).ConfigureAwait(false);
            if (current is null)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<bool>(RoleNotFoundFailure());
            }

            if (current.IsBuiltIn)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<bool>(BuiltInRoleFailure());
            }

            if (current.Revision != expectedRevision)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<bool>(Failure(
                    OrganizationCommandError.RevisionMismatch,
                    "REVISION_MISMATCH",
                    "角色已被修改",
                    "请刷新后重试删除。",
                    currentRevision: current.Revision));
            }

            var isReferenced = false;
            await using (var references = CreateCommand(connection, transaction))
            {
                references.CommandText =
                    """
                    SELECT
                        (SELECT COUNT_BIG(1) FROM [flowpilot].[user_roles] WHERE [role_id] = @role_id),
                        (SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_group_roles] WHERE [role_id] = @role_id),
                        (SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_version_role_refs] WHERE [role_id] = @role_id);
                    """;
                Add(references, "@role_id", SqlDbType.UniqueIdentifier, roleId);
                await using var reader = await references.ExecuteReaderAsync(
                    CommandBehavior.SingleRow,
                    cancellationToken).ConfigureAwait(false);
                await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
                isReferenced = reader.GetInt64(0) > 0
                    || reader.GetInt64(1) > 0
                    || reader.GetInt64(2) > 0;
            }

            if (isReferenced)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<bool>(Failure(
                    OrganizationCommandError.Conflict,
                    "ROLE_REFERENCED",
                    "角色仍被系统引用",
                    "请先解除用户、流程权限组和流程版本引用；历史业务角色请改为停用。"));
            }

            await InsertOrganizationAuditAsync(
                connection,
                transaction,
                "role",
                roleId,
                "role.deleted",
                ["role"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            await using (var command = CreateCommand(connection, transaction))
            {
                command.CommandText =
                    "DELETE FROM [flowpilot].[roles] WHERE [id] = @id AND [revision] = @revision;";
                Add(command, "@id", SqlDbType.UniqueIdentifier, roleId);
                Add(command, "@revision", SqlDbType.Int, expectedRevision);
                if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
                {
                    throw new DBConcurrencyException("角色修订号在事务中意外变化。");
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

    public async Task<OrganizationCommandResult<WorkflowGroupChangeImpactDto>> PreviewRoleChangeImpactAsync(
        Guid roleId,
        RoleChangeImpactRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var memberIds = request.NextMemberIds.Distinct().Order().ToArray();
        var issues = new List<OrganizationInputIssueDto>();
        if (memberIds.Length != request.NextMemberIds.Count)
        {
            issues.Add(Issue("nextMemberIds", "DUPLICATE", "角色成员不能重复。"));
        }

        var nextEnabled = request.NextStatus switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => (bool?)null,
        };
        if (nextEnabled is null)
        {
            issues.Add(Issue("nextStatus", "INVALID_VALUE", "状态只能是 enabled 或 disabled。"));
        }

        if (issues.Count > 0)
        {
            return Failed<WorkflowGroupChangeImpactDto>(
                IdentityValidationFailure("角色变更影响校验失败", issues));
        }
        var nextEnabledValue = nextEnabled ?? false;

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        var role = await LoadRoleAsync(connection, null, roleId, cancellationToken).ConfigureAwait(false);
        if (role is null)
        {
            return Failed<WorkflowGroupChangeImpactDto>(RoleNotFoundFailure());
        }

        if (role.BuiltIn)
        {
            return Failed<WorkflowGroupChangeImpactDto>(BuiltInRoleFailure());
        }

        await using (var validation = CreateCommand(connection))
        {
            validation.CommandText =
                """
                SELECT COUNT_BIG(1)
                FROM OPENJSON(@member_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                LEFT JOIN [flowpilot].[users] AS [u]
                    ON [u].[id] = [requested].[id] AND [u].[is_builtin_super_admin] = 0
                WHERE [u].[id] IS NULL;
                """;
            Add(validation, "@member_ids", SqlDbType.NVarChar,
                JsonSerializer.Serialize(memberIds, JsonOptions), -1);
            if ((long)(await validation.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) ?? 0L) > 0)
            {
                return Failed<WorkflowGroupChangeImpactDto>(IdentityValidationFailure(
                    "角色变更影响校验失败",
                    [Issue("nextMemberIds", "INVALID_REFERENCE", "角色成员必须是存在的非内置用户。")]));
            }
        }

        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            DECLARE @next_members TABLE ([user_id] uniqueidentifier NOT NULL PRIMARY KEY);
            INSERT INTO @next_members ([user_id])
            SELECT [id]
            FROM OPENJSON(@member_ids) WITH ([id] uniqueidentifier '$');

            ;WITH [linked_groups] AS
            (
                SELECT [g].[id]
                FROM [flowpilot].[workflow_group_roles] AS [gr]
                INNER JOIN [flowpilot].[workflow_permission_groups] AS [g]
                    ON [g].[id] = [gr].[group_id] AND [g].[is_enabled] = 1
                WHERE [gr].[role_id] = @role_id
            ),
            [current_effective] AS
            (
                SELECT [lg].[id] AS [group_id], [gu].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_users] AS [gu] ON [gu].[group_id] = [lg].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [gu].[user_id] AND [u].[is_enabled] = 1
                UNION
                SELECT [lg].[id], [ur].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_roles] AS [gr] ON [gr].[group_id] = [lg].[id]
                INNER JOIN [flowpilot].[roles] AS [r] ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [r].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [ur].[user_id] AND [u].[is_enabled] = 1
            ),
            [next_effective] AS
            (
                SELECT [lg].[id] AS [group_id], [gu].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_users] AS [gu] ON [gu].[group_id] = [lg].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [gu].[user_id] AND [u].[is_enabled] = 1
                UNION
                SELECT [lg].[id], [ur].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_roles] AS [gr]
                    ON [gr].[group_id] = [lg].[id] AND [gr].[role_id] <> @role_id
                INNER JOIN [flowpilot].[roles] AS [r] ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [r].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [ur].[user_id] AND [u].[is_enabled] = 1
                UNION
                SELECT [lg].[id], [nm].[user_id]
                FROM [linked_groups] AS [lg]
                CROSS JOIN @next_members AS [nm]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [nm].[user_id] AND [u].[is_enabled] = 1
                WHERE @next_enabled = 1
            ),
            [losing_pairs] AS
            (
                SELECT [group_id], [user_id] FROM [current_effective]
                EXCEPT
                SELECT [group_id], [user_id] FROM [next_effective]
            ),
            [losing_users] AS
            (
                SELECT DISTINCT [user_id] FROM [losing_pairs]
            )
            SELECT
                [u].[id], [u].[display_name], [u].[login_name], [u].[email], COALESCE([d].[path_cache], N'')
            FROM [losing_users] AS [losing]
            INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [losing].[user_id]
            LEFT JOIN [flowpilot].[departments] AS [d] ON [d].[id] = [u].[department_id]
            ORDER BY [u].[display_name], [u].[id];

            ;WITH [linked_groups] AS
            (
                SELECT [g].[id]
                FROM [flowpilot].[workflow_group_roles] AS [gr]
                INNER JOIN [flowpilot].[workflow_permission_groups] AS [g]
                    ON [g].[id] = [gr].[group_id] AND [g].[is_enabled] = 1
                WHERE [gr].[role_id] = @role_id
            ),
            [current_effective] AS
            (
                SELECT [lg].[id] AS [group_id], [gu].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_users] AS [gu] ON [gu].[group_id] = [lg].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [gu].[user_id] AND [u].[is_enabled] = 1
                UNION
                SELECT [lg].[id], [ur].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_roles] AS [gr] ON [gr].[group_id] = [lg].[id]
                INNER JOIN [flowpilot].[roles] AS [r] ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [r].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [ur].[user_id] AND [u].[is_enabled] = 1
            ),
            [next_effective] AS
            (
                SELECT [lg].[id] AS [group_id], [gu].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_users] AS [gu] ON [gu].[group_id] = [lg].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [gu].[user_id] AND [u].[is_enabled] = 1
                UNION
                SELECT [lg].[id], [ur].[user_id]
                FROM [linked_groups] AS [lg]
                INNER JOIN [flowpilot].[workflow_group_roles] AS [gr]
                    ON [gr].[group_id] = [lg].[id] AND [gr].[role_id] <> @role_id
                INNER JOIN [flowpilot].[roles] AS [r] ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [r].[id]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [ur].[user_id] AND [u].[is_enabled] = 1
                UNION
                SELECT [lg].[id], [nm].[user_id]
                FROM [linked_groups] AS [lg]
                CROSS JOIN @next_members AS [nm]
                INNER JOIN [flowpilot].[users] AS [u] ON [u].[id] = [nm].[user_id] AND [u].[is_enabled] = 1
                WHERE @next_enabled = 1
            ),
            [losing_pairs] AS
            (
                SELECT [group_id], [user_id] FROM [current_effective]
                EXCEPT
                SELECT [group_id], [user_id] FROM [next_effective]
            )
            SELECT CONVERT(int, COUNT_BIG(1))
            FROM [flowpilot].[workflow_tasks] AS [task]
            WHERE [task].[status] IN (N'inactive', N'pending')
              AND EXISTS
              (
                  SELECT 1 FROM [losing_pairs] AS [losing]
                  WHERE [losing].[group_id] = [task].[group_id]
              );
            """;
        Add(command, "@role_id", SqlDbType.UniqueIdentifier, roleId);
        Add(command, "@member_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(memberIds, JsonOptions), -1);
        Add(command, "@next_enabled", SqlDbType.Bit, nextEnabledValue);

        var losingUsers = new List<WorkflowMemberUserRefDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            losingUsers.Add(new WorkflowMemberUserRefDto(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4)));
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        var affectedTasks = reader.GetInt32(0);
        return Succeeded(new WorkflowGroupChangeImpactDto(
            losingUsers.Count,
            affectedTasks,
            losingUsers));
    }

    private async Task<RoleUpdateState?> LoadRoleForUpdateAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid roleId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                [r].[revision], [r].[name], COALESCE([r].[description], N''),
                [r].[is_enabled], [r].[is_builtin],
                COALESCE((SELECT [user_id] AS [id]
                    FROM [flowpilot].[user_roles]
                    WHERE [role_id] = [r].[id] ORDER BY [user_id] FOR JSON PATH), N'[]')
            FROM [flowpilot].[roles] AS [r] WITH (UPDLOCK, HOLDLOCK)
            WHERE [r].[id] = @id;
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, roleId);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new RoleUpdateState(
            reader.GetInt32(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetBoolean(3),
            reader.GetBoolean(4),
            DeserializeArray<IdRow>(reader.GetString(5)).Select(item => item.Id).ToArray());
    }

    private async Task<IReadOnlyList<OrganizationInputIssueDto>> ValidateRoleUpdateAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid roleId,
        NormalizedRoleInput input,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                (SELECT COUNT_BIG(1) FROM [flowpilot].[roles] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [normalized_name] = @normalized_name AND [id] <> @role_id),
                (SELECT COUNT_BIG(1)
                 FROM OPENJSON(@member_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                 LEFT JOIN [flowpilot].[users] AS [u] WITH (UPDLOCK, HOLDLOCK)
                    ON [u].[id] = [requested].[id] AND [u].[is_builtin_super_admin] = 0
                 WHERE [u].[id] IS NULL);
            """;
        Add(command, "@role_id", SqlDbType.UniqueIdentifier, roleId);
        Add(command, "@normalized_name", SqlDbType.NVarChar, input.NormalizedName, 200);
        Add(command, "@member_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.MemberIds, JsonOptions), -1);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);

        var issues = new List<OrganizationInputIssueDto>();
        if (reader.GetInt64(0) > 0)
        {
            issues.Add(Issue("name", "DUPLICATE", "角色名称已存在。"));
        }

        if (reader.GetInt64(1) > 0)
        {
            issues.Add(Issue("memberIds", "INVALID_REFERENCE", "角色成员必须是存在的非内置用户。"));
        }

        return issues;
    }

    private static OrganizationCommandFailure RoleNotFoundFailure() => Failure(
        OrganizationCommandError.NotFound,
        "ROLE_NOT_FOUND",
        "角色不存在",
        "未找到指定的角色。");

    private static OrganizationCommandFailure BuiltInRoleFailure() => Failure(
        OrganizationCommandError.Conflict,
        "BUILT_IN_ROLE_READ_ONLY",
        "内置角色不可修改",
        "超级管理员角色由系统维护，不能修改或删除。");

    private sealed record RoleUpdateState(
        int Revision,
        string Name,
        string Description,
        bool IsEnabled,
        bool IsBuiltIn,
        IReadOnlyList<Guid> MemberIds);
}
