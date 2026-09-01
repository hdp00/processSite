using System.ComponentModel.DataAnnotations;
using System.Data;
using System.Text.Json;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Organization;
using FlowPilot.Application.Security;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService
{
    public async Task<OrganizationCommandResult<RoleDto>> CreateRoleAsync(
        CreateRoleRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var normalized = NormalizeRole(request);
        if (normalized.Failure is not null)
        {
            return Failed<RoleDto>(normalized.Failure);
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
                CreateRoleRouteScope,
                idempotencyKey,
                cancellationToken).ConfigureAwait(false);
            var replay = ReplayOrFailure<RoleDto>(existing, requestHash);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var issues = await ValidateRoleAsync(
                connection,
                transaction,
                input,
                cancellationToken).ConfigureAwait(false);
            if (issues.Count > 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<RoleDto>(IdentityValidationFailure("角色校验失败", issues));
            }

            var roleId = Guid.NewGuid();
            var code = $"ROLE-{roleId:N}"[..17].ToUpperInvariant();
            var idempotencyId = Guid.NewGuid();
            await InsertIdempotencyAsync(
                connection,
                transaction,
                idempotencyId,
                actor.EffectiveUserId,
                CreateRoleRouteScope,
                idempotencyKey,
                requestHash,
                now,
                cancellationToken).ConfigureAwait(false);

            await using (var command = CreateCommand(connection, transaction))
            {
                command.CommandText =
                    """
                    INSERT INTO [flowpilot].[roles]
                    (
                        [id], [code], [normalized_code], [name], [normalized_name], [description],
                        [is_enabled], [is_builtin], [revision], [created_at], [updated_at],
                        [created_by], [updated_by]
                    )
                    VALUES
                    (
                        @id, @code, @code, @name, @normalized_name, @description,
                        @is_enabled, 0, 1, @now, @now, @actor_id, @actor_id
                    );

                    INSERT INTO [flowpilot].[user_roles]
                        ([user_id], [role_id], [granted_by], [granted_at])
                    SELECT [id], @id, @actor_id, @now
                    FROM OPENJSON(@member_ids) WITH ([id] uniqueidentifier '$');
                    """;
                Add(command, "@id", SqlDbType.UniqueIdentifier, roleId);
                Add(command, "@code", SqlDbType.NVarChar, code, 100);
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

            await InsertOrganizationAuditAsync(
                connection,
                transaction,
                "role",
                roleId,
                "role.created",
                ["name", "description", "status", "memberIds"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            var created = await LoadRoleAsync(connection, transaction, roleId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("创建后的角色无法重新读取。");
            await CompleteIdempotencyAsync(
                connection,
                transaction,
                idempotencyId,
                created,
                created.Revision,
                $"/roles/{created.Id:D}",
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

    public async Task<OrganizationCommandResult<UserDto>> CreateUserAsync(
        CreateUserRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var normalized = NormalizeUser(request);
        if (normalized.Failure is not null)
        {
            return Failed<UserDto>(normalized.Failure);
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
                CreateUserRouteScope,
                idempotencyKey,
                cancellationToken).ConfigureAwait(false);
            var replay = ReplayOrFailure<UserDto>(existing, requestHash);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var issues = await ValidateUserAsync(
                connection,
                transaction,
                input,
                cancellationToken).ConfigureAwait(false);
            if (issues.Count > 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return Failed<UserDto>(IdentityValidationFailure("用户校验失败", issues));
            }

            var userId = Guid.NewGuid();
            var passwordHash = input.AuthenticationMode == "password"
                ? FlowPilotPasswordHasher.HashPassword(input.NormalizedLoginName, input.InitialPassword!)
                : null;
            var idempotencyId = Guid.NewGuid();
            await InsertIdempotencyAsync(
                connection,
                transaction,
                idempotencyId,
                actor.EffectiveUserId,
                CreateUserRouteScope,
                idempotencyKey,
                requestHash,
                now,
                cancellationToken).ConfigureAwait(false);

            await using (var command = CreateCommand(connection, transaction))
            {
                command.CommandText =
                    """
                    INSERT INTO [flowpilot].[users]
                    (
                        [id], [login_name], [normalized_login_name], [display_name], [email],
                        [authentication_mode], [password_hash], [department_id], [position_id],
                        [is_enabled], [is_builtin_super_admin], [revision], [created_at], [updated_at],
                        [created_by], [updated_by]
                    )
                    VALUES
                    (
                        @id, @login_name, @normalized_login_name, @display_name, @email,
                        @authentication_mode, @password_hash, @department_id, @position_id,
                        @is_enabled, 0, 1, @now, @now, @actor_id, @actor_id
                    );

                    INSERT INTO [flowpilot].[user_roles]
                        ([user_id], [role_id], [granted_by], [granted_at])
                    SELECT @id, [id], @actor_id, @now
                    FROM OPENJSON(@role_ids) WITH ([id] uniqueidentifier '$');
                    """;
                Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
                Add(command, "@login_name", SqlDbType.NVarChar, input.LoginName, 100);
                Add(command, "@normalized_login_name", SqlDbType.NVarChar, input.NormalizedLoginName, 100);
                Add(command, "@display_name", SqlDbType.NVarChar, input.Name, 100);
                Add(command, "@email", SqlDbType.NVarChar, input.Email, 320);
                Add(command, "@authentication_mode", SqlDbType.NVarChar, input.AuthenticationMode, 20);
                AddNullable(command, "@password_hash", SqlDbType.NVarChar, passwordHash, 500);
                AddNullable(command, "@department_id", SqlDbType.UniqueIdentifier, input.DepartmentId);
                AddNullable(command, "@position_id", SqlDbType.UniqueIdentifier, input.PositionId);
                Add(command, "@is_enabled", SqlDbType.Bit, input.IsEnabled);
                Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
                Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
                Add(command, "@role_ids", SqlDbType.NVarChar,
                    JsonSerializer.Serialize(input.RoleIds, JsonOptions), -1);
                await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }

            await InsertOrganizationAuditAsync(
                connection,
                transaction,
                "user",
                userId,
                "user.created",
                ["loginName", "name", "email", "authenticationMode", "departmentId", "positionId", "roleIds", "status"],
                actor,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            var created = await LoadUserAsync(connection, transaction, userId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("创建后的用户无法重新读取。");
            await CompleteIdempotencyAsync(
                connection,
                transaction,
                idempotencyId,
                created,
                created.Revision,
                $"/users/{created.Id:D}",
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

    private async Task<IReadOnlyList<OrganizationInputIssueDto>> ValidateRoleAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        NormalizedRoleInput input,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                (SELECT COUNT_BIG(1) FROM [flowpilot].[roles] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [normalized_name] = @normalized_name),
                (SELECT COUNT_BIG(1)
                 FROM OPENJSON(@member_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                 LEFT JOIN [flowpilot].[users] AS [u] WITH (UPDLOCK, HOLDLOCK)
                    ON [u].[id] = [requested].[id] AND [u].[is_builtin_super_admin] = 0
                 WHERE [u].[id] IS NULL);
            """;
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

    private async Task<IReadOnlyList<OrganizationInputIssueDto>> ValidateUserAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        NormalizedUserInput input,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                (SELECT COUNT_BIG(1) FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [normalized_login_name] = @normalized_login_name),
                (SELECT CASE WHEN @department_id IS NULL THEN 1 ELSE COUNT_BIG(1) END
                 FROM [flowpilot].[departments] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [id] = @department_id AND [is_enabled] = 1),
                (SELECT CASE WHEN @position_id IS NULL THEN 1 ELSE COUNT_BIG(1) END
                 FROM [flowpilot].[positions] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [id] = @position_id AND [is_enabled] = 1),
                (SELECT COUNT_BIG(1)
                 FROM OPENJSON(@role_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                 LEFT JOIN [flowpilot].[roles] AS [r] WITH (UPDLOCK, HOLDLOCK)
                    ON [r].[id] = [requested].[id]
                   AND [r].[is_enabled] = 1
                   AND [r].[is_builtin] = 0
                 WHERE [r].[id] IS NULL);
            """;
        Add(command, "@normalized_login_name", SqlDbType.NVarChar, input.NormalizedLoginName, 100);
        AddNullable(command, "@department_id", SqlDbType.UniqueIdentifier, input.DepartmentId);
        AddNullable(command, "@position_id", SqlDbType.UniqueIdentifier, input.PositionId);
        Add(command, "@role_ids", SqlDbType.NVarChar,
            JsonSerializer.Serialize(input.RoleIds, JsonOptions), -1);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        var issues = new List<OrganizationInputIssueDto>();
        if (reader.GetInt64(0) > 0)
        {
            issues.Add(Issue("loginName", "DUPLICATE", "登录账号已存在。"));
        }

        if (reader.GetInt64(1) != 1)
        {
            issues.Add(Issue("departmentId", "INVALID_REFERENCE", "部门不存在或已停用。"));
        }

        if (reader.GetInt64(2) != 1)
        {
            issues.Add(Issue("positionId", "INVALID_REFERENCE", "职务不存在或已停用。"));
        }

        if (reader.GetInt64(3) > 0)
        {
            issues.Add(Issue("roleIds", "INVALID_REFERENCE", "角色必须存在、已启用且不是内置角色。"));
        }

        return issues;
    }

    private async Task<RoleDto?> LoadRoleAsync(
        SqlConnection connection,
        SqlTransaction? transaction,
        Guid roleId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                [r].[id], [r].[revision], [r].[code], [r].[name], COALESCE([r].[description], N''),
                [r].[is_enabled], [r].[is_builtin],
                CONVERT(int, (SELECT COUNT_BIG(1) FROM [flowpilot].[user_roles] WHERE [role_id] = [r].[id])),
                COALESCE((SELECT [user_id] AS [id] FROM [flowpilot].[user_roles]
                    WHERE [role_id] = [r].[id] ORDER BY [user_id] FOR JSON PATH), N'[]'),
                CONVERT(int, (SELECT COUNT_BIG(1) FROM [flowpilot].[role_permissions] WHERE [role_id] = [r].[id])),
                CONVERT(int, (SELECT COUNT(DISTINCT [p].[resource])
                    FROM [flowpilot].[role_permissions] AS [rp]
                    INNER JOIN [flowpilot].[permissions] AS [p] ON [p].[code] = [rp].[permission_code]
                    WHERE [rp].[role_id] = [r].[id] AND [p].[action] = N'查看'))
            FROM [flowpilot].[roles] AS [r]
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

        var permissionCount = reader.GetInt32(9);
        return new RoleDto(
            reader.GetGuid(0),
            reader.GetInt32(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetBoolean(5) ? "enabled" : "disabled",
            reader.GetBoolean(6),
            reader.GetInt32(7),
            DeserializeArray<IdRow>(reader.GetString(8)).Select(item => item.Id).ToArray(),
            permissionCount,
            reader.GetInt32(10),
            permissionCount);
    }

    private async Task<UserDto?> LoadUserAsync(
        SqlConnection connection,
        SqlTransaction? transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                [u].[id], [u].[revision], [u].[login_name], [u].[display_name], [u].[email],
                [u].[authentication_mode], [u].[is_enabled], [u].[is_builtin_super_admin],
                [d].[id], [d].[name], [d].[path_cache], [p].[id], [p].[name],
                [u].[created_at], [u].[updated_at],
                (SELECT MAX([login_session].[created_at])
                    FROM [flowpilot].[sessions] AS [login_session]
                    WHERE [login_session].[operator_user_id] = [u].[id]),
                COALESCE((SELECT [r].[id], [r].[name]
                    FROM [flowpilot].[user_roles] AS [ur]
                    INNER JOIN [flowpilot].[roles] AS [r] ON [r].[id] = [ur].[role_id]
                    WHERE [ur].[user_id] = [u].[id]
                    ORDER BY [r].[name], [r].[id]
                    FOR JSON PATH), N'[]')
            FROM [flowpilot].[users] AS [u]
            LEFT JOIN [flowpilot].[departments] AS [d] ON [d].[id] = [u].[department_id]
            LEFT JOIN [flowpilot].[positions] AS [p] ON [p].[id] = [u].[position_id]
            WHERE [u].[id] = @id;
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new UserDto(
            reader.GetGuid(0),
            reader.GetInt32(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetBoolean(6) ? "enabled" : "disabled",
            reader.IsDBNull(8) ? null : new DepartmentRefDto(reader.GetGuid(8), reader.GetString(9), reader.GetString(10)),
            reader.IsDBNull(11) ? null : new PositionRefDto(reader.GetGuid(11), reader.GetString(12)),
            DeserializeArray<RoleRefDto>(reader.GetString(16)),
            reader.GetBoolean(7),
            AsUtc(reader.GetDateTime(13)),
            AsUtc(reader.GetDateTime(14)),
            reader.IsDBNull(15) ? null : AsUtc(reader.GetDateTime(15)));
    }

    private async Task InsertOrganizationAuditAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        string resourceType,
        Guid resourceId,
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
                @id, @resource_type, @resource_id, @action, @fields,
                @operator_id, @effective_id, @trace_id, N'success', @now
            );
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, Guid.NewGuid());
        Add(command, "@resource_type", SqlDbType.NVarChar, resourceType, 100);
        Add(command, "@resource_id", SqlDbType.UniqueIdentifier, resourceId);
        Add(command, "@action", SqlDbType.NVarChar, action, 100);
        Add(command, "@fields", SqlDbType.NVarChar,
            JsonSerializer.Serialize(fields, JsonOptions), -1);
        Add(command, "@operator_id", SqlDbType.UniqueIdentifier, actor.OperatorUserId);
        Add(command, "@effective_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
        Add(command, "@trace_id", SqlDbType.NVarChar, traceId, 100);
        Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static OrganizationCommandResult<T>? ReplayOrFailure<T>(
        IdempotencyState? existing,
        string requestHash)
    {
        if (existing is null)
        {
            return null;
        }

        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return Failed<T>(Failure(
                OrganizationCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已被使用",
                "同一个 Idempotency-Key 不能用于不同的创建请求。"));
        }

        if (string.Equals(existing.Status, "completed", StringComparison.Ordinal)
            && existing.ResponseBodyJson is not null)
        {
            var replay = JsonSerializer.Deserialize<T>(existing.ResponseBodyJson, JsonOptions)
                ?? throw new InvalidDataException("幂等响应数据无效。");
            return Succeeded(replay, replayed: true);
        }

        return Failed<T>(Failure(
            OrganizationCommandError.IdempotencyRequestInProgress,
            "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            "请求正在处理中",
            "相同的创建请求正在处理中，请稍后重试。"));
    }

    private static NormalizedRoleResult NormalizeRole(CreateRoleRequest request)
    {
        var issues = new List<OrganizationInputIssueDto>();
        var name = request.Name.Trim();
        if (name.Length is < 1 or > 100)
        {
            issues.Add(Issue("name", "INVALID_LENGTH", "角色名称长度必须为 1 到 100 个字符。"));
        }

        var description = string.IsNullOrWhiteSpace(request.Description)
            ? null
            : request.Description.Trim();
        var enabled = request.Status switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => (bool?)null,
        };
        if (enabled is null)
        {
            issues.Add(Issue("status", "INVALID_VALUE", "状态只能是 enabled 或 disabled。"));
        }

        var members = request.MemberIds.Distinct().Order().ToArray();
        if (members.Length != request.MemberIds.Count)
        {
            issues.Add(Issue("memberIds", "DUPLICATE", "角色成员不能重复。"));
        }

        return issues.Count > 0
            ? new NormalizedRoleResult(null, IdentityValidationFailure("角色校验失败", issues))
            : new NormalizedRoleResult(
                new NormalizedRoleInput(
                    name,
                    IdentityValueNormalizer.Normalize(name),
                    description,
                    enabled!.Value,
                    members),
                null);
    }

    private static NormalizedUserResult NormalizeUser(CreateUserRequest request)
    {
        var issues = new List<OrganizationInputIssueDto>();
        var loginName = request.LoginName.Trim();
        var normalizedLoginName = IdentityValueNormalizer.Normalize(loginName);
        var name = request.Name.Trim();
        var email = request.Email.Trim();
        if (loginName.Length is < 1 or > 100)
        {
            issues.Add(Issue("loginName", "INVALID_LENGTH", "登录账号长度必须为 1 到 100 个字符。"));
        }

        if (name.Length is < 1 or > 100)
        {
            issues.Add(Issue("name", "INVALID_LENGTH", "用户姓名长度必须为 1 到 100 个字符。"));
        }

        if (email.Length > 0 && !new EmailAddressAttribute().IsValid(email))
        {
            issues.Add(Issue("email", "INVALID_FORMAT", "邮箱格式不正确。"));
        }

        var enabled = request.Status switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => (bool?)null,
        };
        if (enabled is null)
        {
            issues.Add(Issue("status", "INVALID_VALUE", "状态只能是 enabled 或 disabled。"));
        }

        if (request.AuthenticationMode is not ("domain" or "password"))
        {
            issues.Add(Issue("authenticationMode", "INVALID_VALUE", "登录方式只能是 domain 或 password。"));
        }
        else if (request.AuthenticationMode == "password"
            && string.IsNullOrEmpty(request.InitialPassword))
        {
            issues.Add(Issue("initialPassword", "REQUIRED", "密码登录用户必须设置初始密码。"));
        }
        else if (request.AuthenticationMode == "domain"
            && !string.IsNullOrEmpty(request.InitialPassword))
        {
            issues.Add(Issue("initialPassword", "NOT_ALLOWED", "域登录用户不能设置本地密码。"));
        }

        var roles = request.RoleIds.Distinct().Order().ToArray();
        if (roles.Length != request.RoleIds.Count)
        {
            issues.Add(Issue("roleIds", "DUPLICATE", "用户角色不能重复。"));
        }

        return issues.Count > 0
            ? new NormalizedUserResult(null, IdentityValidationFailure("用户校验失败", issues))
            : new NormalizedUserResult(
                new NormalizedUserInput(
                    loginName,
                    normalizedLoginName,
                    name,
                    email,
                    request.AuthenticationMode,
                    request.InitialPassword,
                    request.DepartmentId,
                    request.PositionId,
                    enabled!.Value,
                    roles),
                null);
    }

    private static OrganizationCommandFailure IdentityValidationFailure(
        string title,
        IReadOnlyList<OrganizationInputIssueDto> issues) => Failure(
            OrganizationCommandError.ValidationFailed,
            "VALIDATION_FAILED",
            title,
            "请修正无效字段后重试。",
            issues);

    private sealed record NormalizedRoleInput(
        string Name,
        string NormalizedName,
        string? Description,
        bool IsEnabled,
        IReadOnlyList<Guid> MemberIds);

    private sealed record NormalizedRoleResult(
        NormalizedRoleInput? Value,
        OrganizationCommandFailure? Failure);

    private sealed record NormalizedUserInput(
        string LoginName,
        string NormalizedLoginName,
        string Name,
        string Email,
        string AuthenticationMode,
        string? InitialPassword,
        Guid? DepartmentId,
        Guid? PositionId,
        bool IsEnabled,
        IReadOnlyList<Guid> RoleIds);

    private sealed record NormalizedUserResult(
        NormalizedUserInput? Value,
        OrganizationCommandFailure? Failure);
}
