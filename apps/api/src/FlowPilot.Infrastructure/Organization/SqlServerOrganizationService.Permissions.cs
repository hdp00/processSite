using System.Data;
using FlowPilot.Application.Organization;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService
{
    public async Task<IReadOnlyList<PermissionDto>> ListPermissionsAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            SELECT [code], [name], [resource]
            FROM [flowpilot].[permissions]
            ORDER BY [sort_order], [code];
            """;

        var permissions = new List<PermissionDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            permissions.Add(new PermissionDto(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                "action",
                string.Empty));
        }

        return permissions;
    }

    public async Task<RolePermissionsDto?> GetRolePermissionsAsync(
        Guid roleId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        return await LoadRolePermissionsAsync(connection, null, roleId, cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<OrganizationCommandResult<RolePermissionsDto>> ReplaceRolePermissionsAsync(
        Guid roleId,
        ReplaceRolePermissionsRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var codes = request.PermissionCodes
            .Select(code => code.Trim())
            .Where(code => code.Length > 0)
            .ToArray();
        if (codes.Length != request.PermissionCodes.Count
            || codes.Distinct(StringComparer.Ordinal).Count() != codes.Length)
        {
            return Failed<RolePermissionsDto>(Failure(
                OrganizationCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "角色权限校验失败",
                "权限编号不能为空或重复。",
                [Issue("permissionCodes", "INVALID_VALUE", "权限编号不能为空或重复。")]));
        }

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);

        await using (var roleCommand = CreateCommand(connection, transaction))
        {
            roleCommand.CommandText =
                """
                SELECT [revision], [is_builtin]
                FROM [flowpilot].[roles] WITH (UPDLOCK, HOLDLOCK)
                WHERE [id] = @role_id;
                """;
            Add(roleCommand, "@role_id", SqlDbType.UniqueIdentifier, roleId);
            await using var reader = await roleCommand.ExecuteReaderAsync(
                CommandBehavior.SingleRow,
                cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return Failed<RolePermissionsDto>(Failure(
                    OrganizationCommandError.NotFound,
                    "ROLE_NOT_FOUND",
                    "角色不存在",
                    "未找到指定的角色。"));
            }

            var currentRevision = reader.GetInt32(0);
            if (currentRevision != expectedRevision)
            {
                return Failed<RolePermissionsDto>(Failure(
                    OrganizationCommandError.RevisionMismatch,
                    "REVISION_MISMATCH",
                    "角色已被修改",
                    "请刷新角色后重新保存权限。",
                    currentRevision: currentRevision));
            }

            if (reader.GetBoolean(1))
            {
                return Failed<RolePermissionsDto>(Failure(
                    OrganizationCommandError.Conflict,
                    "BUILTIN_ROLE_READ_ONLY",
                    "内置角色不可修改",
                    "超级管理员角色始终拥有全部权限。"));
            }
        }

        var knownCodes = new HashSet<string>(StringComparer.Ordinal);
        await using (var catalogCommand = CreateCommand(connection, transaction))
        {
            catalogCommand.CommandText = "SELECT [code] FROM [flowpilot].[permissions] WITH (HOLDLOCK);";
            await using var reader = await catalogCommand.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                knownCodes.Add(reader.GetString(0));
            }
        }

        var unknownCodes = codes.Where(code => !knownCodes.Contains(code)).ToArray();
        if (unknownCodes.Length > 0)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<RolePermissionsDto>(Failure(
                OrganizationCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "角色权限校验失败",
                $"权限编号不存在：{string.Join("、", unknownCodes)}。",
                [Issue("permissionCodes", "INVALID_REFERENCE", "包含不存在的权限编号。")]));
        }

        var now = _timeProvider.GetUtcNow();
        await using (var update = CreateCommand(connection, transaction))
        {
            update.CommandText =
                """
                DELETE FROM [flowpilot].[role_permissions] WHERE [role_id] = @role_id;
                INSERT INTO [flowpilot].[role_permissions]
                    ([role_id], [permission_code], [granted_by], [granted_at])
                SELECT @role_id, [value], @actor_id, @now
                FROM OPENJSON(@permission_codes);
                UPDATE [flowpilot].[roles]
                SET [revision] = [revision] + 1, [updated_at] = @now, [updated_by] = @actor_id
                WHERE [id] = @role_id;
                """;
            Add(update, "@role_id", SqlDbType.UniqueIdentifier, roleId);
            Add(update, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
            Add(update, "@now", SqlDbType.DateTime2, now.UtcDateTime);
            Add(update, "@permission_codes", SqlDbType.NVarChar,
                System.Text.Json.JsonSerializer.Serialize(codes, JsonOptions), -1);
            await update.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "role",
            roleId,
            "permissions-replaced",
            ["permissionCodes"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var result = await LoadRolePermissionsAsync(connection, transaction, roleId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Updated role disappeared before commit.");
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(result);
    }

    private async Task<RolePermissionsDto?> LoadRolePermissionsAsync(
        SqlConnection connection,
        SqlTransaction? transaction,
        Guid roleId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT [r].[revision], COALESCE((
                SELECT [rp].[permission_code] AS [value]
                FROM [flowpilot].[role_permissions] AS [rp]
                INNER JOIN [flowpilot].[permissions] AS [p] ON [p].[code] = [rp].[permission_code]
                WHERE [rp].[role_id] = [r].[id]
                ORDER BY [p].[sort_order], [p].[code]
                FOR JSON PATH
            ), N'[]')
            FROM [flowpilot].[roles] AS [r]
            WHERE [r].[id] = @role_id;
            """;
        Add(command, "@role_id", SqlDbType.UniqueIdentifier, roleId);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)) return null;
        var values = DeserializeArray<ValueRow>(reader.GetString(1)).Select(item => item.Value).ToArray();
        return new RolePermissionsDto(roleId, reader.GetInt32(0), values);
    }

    private sealed record ValueRow(string Value);
}
