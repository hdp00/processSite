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
    public async Task<UserDto?> GetUserAsync(
        Guid userId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        return await LoadUserAsync(connection, null, userId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<OrganizationCommandResult<UserDto>> UpdateUserAsync(
        Guid userId,
        UpdateUserRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.HasChanges)
        {
            return Failed<UserDto>(IdentityValidationFailure(
                "用户校验失败",
                [Issue("request", "EMPTY_PATCH", "至少需要修改一个字段。")]));
        }

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var current = await LoadUserStateAsync(connection, transaction, userId, cancellationToken)
            .ConfigureAwait(false);
        var stateFailure = ValidateMutableUser(current, expectedRevision);
        if (stateFailure is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<UserDto>(stateFailure);
        }

        var normalized = NormalizeUserUpdate(request, current!);
        if (normalized.Failure is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<UserDto>(normalized.Failure);
        }

        var input = normalized.Value!;
        var referenceIssues = await ValidateUserUpdateReferencesAsync(
            connection,
            transaction,
            userId,
            input,
            request,
            cancellationToken).ConfigureAwait(false);
        if (referenceIssues.Count > 0)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<UserDto>(IdentityValidationFailure("用户校验失败", referenceIssues));
        }

        var now = _timeProvider.GetUtcNow();
        await using (var command = CreateCommand(connection, transaction))
        {
            command.CommandText =
                """
                UPDATE [flowpilot].[users]
                SET [login_name] = @login_name,
                    [normalized_login_name] = @normalized_login_name,
                    [display_name] = @name,
                    [email] = @email,
                    [authentication_mode] = @authentication_mode,
                    [password_hash] = @password_hash,
                    [department_id] = @department_id,
                    [position_id] = @position_id,
                    [revision] = [revision] + 1,
                    [updated_at] = @now,
                    [updated_by] = @actor_id
                WHERE [id] = @id AND [revision] = @expected_revision;

                DELETE FROM [flowpilot].[user_roles] WHERE [user_id] = @id;
                INSERT INTO [flowpilot].[user_roles]
                    ([user_id], [role_id], [granted_by], [granted_at])
                SELECT @id, [id], @actor_id, @now
                FROM OPENJSON(@role_ids) WITH ([id] uniqueidentifier '$');
                """;
            Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
            Add(command, "@expected_revision", SqlDbType.Int, expectedRevision);
            Add(command, "@login_name", SqlDbType.NVarChar, input.LoginName, 100);
            Add(command, "@normalized_login_name", SqlDbType.NVarChar, input.NormalizedLoginName, 100);
            Add(command, "@name", SqlDbType.NVarChar, input.Name, 100);
            Add(command, "@email", SqlDbType.NVarChar, input.Email, 320);
            Add(command, "@authentication_mode", SqlDbType.NVarChar, input.AuthenticationMode, 20);
            AddNullable(command, "@password_hash", SqlDbType.NVarChar, input.PasswordHash, 500);
            AddNullable(command, "@department_id", SqlDbType.UniqueIdentifier, input.DepartmentId);
            AddNullable(command, "@position_id", SqlDbType.UniqueIdentifier, input.PositionId);
            Add(command, "@role_ids", SqlDbType.NVarChar, JsonSerializer.Serialize(input.RoleIds, JsonOptions), -1);
            Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
            Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
            if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) < 1)
            {
                throw new DBConcurrencyException("用户更新期间并发版本发生变化。");
            }
        }

        var authenticationModeChanged = !string.Equals(current!.AuthenticationMode, input.AuthenticationMode, StringComparison.Ordinal);
        var loginNameChanged = !string.Equals(current.NormalizedLoginName, input.NormalizedLoginName, StringComparison.Ordinal);
        if (authenticationModeChanged || loginNameChanged)
        {
            await RevokeUserSessionsAsync(
                connection,
                transaction,
                userId,
                loginNameChanged ? "login-name-changed" : "authentication-mode-changed",
                now,
                cancellationToken).ConfigureAwait(false);
        }

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "user",
            userId,
            "user.updated",
            UserUpdateFields(request),
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var updated = await LoadUserAsync(connection, transaction, userId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("更新后的用户无法重新读取。");
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(updated);
    }

    public async Task<OrganizationCommandResult<UserDto>> SetUserStatusAsync(
        Guid userId,
        SetStatusRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var isEnabled = request.Status switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => (bool?)null,
        };
        if (isEnabled is null)
        {
            return Failed<UserDto>(IdentityValidationFailure(
                "用户状态无效",
                [Issue("status", "INVALID_VALUE", "状态只能是 enabled 或 disabled。")]));
        }

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var current = await LoadUserStateAsync(connection, transaction, userId, cancellationToken)
            .ConfigureAwait(false);
        var stateFailure = ValidateMutableUser(current, expectedRevision);
        if (stateFailure is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<UserDto>(stateFailure);
        }

        var now = _timeProvider.GetUtcNow();
        await using (var command = CreateCommand(connection, transaction))
        {
            command.CommandText =
                """
                UPDATE [flowpilot].[users]
                SET [is_enabled] = @is_enabled,
                    [revision] = [revision] + 1,
                    [updated_at] = @now,
                    [updated_by] = @actor_id
                WHERE [id] = @id AND [revision] = @expected_revision;
                """;
            Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
            Add(command, "@expected_revision", SqlDbType.Int, expectedRevision);
            Add(command, "@is_enabled", SqlDbType.Bit, isEnabled.Value);
            Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
            Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
            if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
            {
                throw new DBConcurrencyException("用户状态更新期间并发版本发生变化。");
            }
        }

        if (!isEnabled.Value)
        {
            await RevokeUserSessionsAsync(
                connection,
                transaction,
                userId,
                "user-disabled",
                now,
                cancellationToken).ConfigureAwait(false);
        }

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "user",
            userId,
            isEnabled.Value ? "user.enabled" : "user.disabled",
            ["status"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var updated = await LoadUserAsync(connection, transaction, userId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("状态更新后的用户无法重新读取。");
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(updated);
    }

    public async Task<OrganizationCommandResult<bool>> ResetUserPasswordAsync(
        Guid userId,
        ResetPasswordRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.NewPassword.Length is < 1 or > 200)
        {
            return Failed<bool>(IdentityValidationFailure(
                "密码校验失败",
                [Issue("newPassword", "INVALID_LENGTH", "新密码长度必须为 1 到 200 个字符。")]));
        }

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var current = await LoadUserStateAsync(connection, transaction, userId, cancellationToken)
            .ConfigureAwait(false);
        var stateFailure = ValidateMutableUser(current, expectedRevision);
        if (stateFailure is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(stateFailure);
        }

        if (!string.Equals(current!.AuthenticationMode, "password", StringComparison.Ordinal))
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(Failure(
                OrganizationCommandError.Conflict,
                "AUTHENTICATION_MODE_CONFLICT",
                "域登录用户不能重置本地密码",
                "该用户的密码由域系统维护。"));
        }

        var now = _timeProvider.GetUtcNow();
        var passwordHash = FlowPilotPasswordHasher.HashPassword(
            current.NormalizedLoginName,
            request.NewPassword);
        await using (var command = CreateCommand(connection, transaction))
        {
            command.CommandText =
                """
                UPDATE [flowpilot].[users]
                SET [password_hash] = @password_hash,
                    [revision] = [revision] + 1,
                    [updated_at] = @now,
                    [updated_by] = @actor_id
                WHERE [id] = @id AND [revision] = @expected_revision;
                """;
            Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
            Add(command, "@expected_revision", SqlDbType.Int, expectedRevision);
            Add(command, "@password_hash", SqlDbType.NVarChar, passwordHash, 500);
            Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
            Add(command, "@actor_id", SqlDbType.UniqueIdentifier, actor.EffectiveUserId);
            if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
            {
                throw new DBConcurrencyException("密码重置期间并发版本发生变化。");
            }
        }

        await RevokeUserSessionsAsync(
            connection,
            transaction,
            userId,
            "password-reset",
            now,
            cancellationToken).ConfigureAwait(false);
        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "user",
            userId,
            "user.password-reset",
            ["password"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(true);
    }

    public async Task<OrganizationCommandResult<bool>> DeleteUserAsync(
        Guid userId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        if (userId == actor.EffectiveUserId || userId == actor.OperatorUserId)
        {
            return Failed<bool>(Failure(
                OrganizationCommandError.Conflict,
                "CURRENT_USER_DELETE_FORBIDDEN",
                "不能删除当前账号",
                "当前登录操作者或正在生效的模拟身份不能删除自己。"));
        }

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var current = await LoadUserStateAsync(connection, transaction, userId, cancellationToken)
            .ConfigureAwait(false);
        var stateFailure = ValidateMutableUser(current, expectedRevision);
        if (stateFailure is not null)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(stateFailure);
        }

        if (await UserHasReferencesAsync(connection, transaction, userId, cancellationToken).ConfigureAwait(false))
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(Failure(
                OrganizationCommandError.Conflict,
                "USER_REFERENCED",
                "用户仍被系统引用",
                "请先解除角色、流程权限组和流程版本等可变引用；已有历史业务记录的用户只能停用。"));
        }

        var now = _timeProvider.GetUtcNow();
        await using (var command = CreateCommand(connection, transaction))
        {
            command.CommandText =
                """
                DELETE FROM [flowpilot].[sessions]
                WHERE [operator_user_id] = @id OR [effective_user_id] = @id;
                DELETE FROM [flowpilot].[users]
                WHERE [id] = @id AND [revision] = @expected_revision;
                """;
            Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
            Add(command, "@expected_revision", SqlDbType.Int, expectedRevision);
            if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) < 1)
            {
                throw new DBConcurrencyException("用户删除期间并发版本发生变化。");
            }
        }

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "user",
            userId,
            "user.deleted",
            [],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(true);
    }

    private async Task<UserState?> LoadUserStateAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT [u].[revision], [u].[login_name], [u].[normalized_login_name], [u].[display_name], [u].[email],
                   [u].[authentication_mode], [u].[password_hash], [u].[department_id], [u].[position_id],
                   [u].[is_enabled], [u].[is_builtin_super_admin],
                   COALESCE((SELECT [role_id] AS [id] FROM [flowpilot].[user_roles]
                       WHERE [user_id] = [u].[id] ORDER BY [role_id] FOR JSON PATH), N'[]')
            FROM [flowpilot].[users] AS [u] WITH (UPDLOCK, HOLDLOCK)
            WHERE [u].[id] = @id;
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)) return null;
        return new UserState(
            reader.GetInt32(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetGuid(7),
            reader.IsDBNull(8) ? null : reader.GetGuid(8),
            reader.GetBoolean(9),
            reader.GetBoolean(10),
            DeserializeArray<IdRow>(reader.GetString(11)).Select(row => row.Id).ToArray());
    }

    private static OrganizationCommandFailure? ValidateMutableUser(UserState? current, int expectedRevision)
    {
        if (current is null)
        {
            return Failure(
                OrganizationCommandError.NotFound,
                "USER_NOT_FOUND",
                "用户不存在",
                "未找到指定的用户。");
        }

        if (current.Revision != expectedRevision)
        {
            return Failure(
                OrganizationCommandError.RevisionMismatch,
                "REVISION_MISMATCH",
                "用户已被修改",
                "请刷新用户信息后重试。",
                currentRevision: current.Revision);
        }

        return current.BuiltIn
            ? Failure(
                OrganizationCommandError.Conflict,
                "BUILTIN_USER_READ_ONLY",
                "内置账号不可修改",
                "超级管理员账号只能查看，不能通过业务接口修改、停用、重置密码或删除。")
            : null;
    }

    private static NormalizedUserUpdateResult NormalizeUserUpdate(UpdateUserRequest request, UserState current)
    {
        var issues = new List<OrganizationInputIssueDto>();
        var loginName = request.LoginName?.Trim() ?? current.LoginName;
        var normalizedLoginName = IdentityValueNormalizer.Normalize(loginName);
        var name = request.Name?.Trim() ?? current.Name;
        var email = request.Email?.Trim() ?? current.Email;
        var authenticationMode = request.AuthenticationMode?.Trim() ?? current.AuthenticationMode;
        var departmentId = request.DepartmentIdSpecified ? request.DepartmentId : current.DepartmentId;
        var positionId = request.PositionIdSpecified ? request.PositionId : current.PositionId;
        var roleIds = (request.RoleIds ?? current.RoleIds).Distinct().Order().ToArray();

        if (loginName.Length is < 1 or > 100)
            issues.Add(Issue("loginName", "INVALID_LENGTH", "登录账号长度必须为 1 到 100 个字符。"));
        if (name.Length is < 1 or > 100)
            issues.Add(Issue("name", "INVALID_LENGTH", "用户姓名长度必须为 1 到 100 个字符。"));
        if (email.Length > 0 && !new EmailAddressAttribute().IsValid(email))
            issues.Add(Issue("email", "INVALID_FORMAT", "邮箱格式不正确。"));
        if (authenticationMode is not ("domain" or "password"))
            issues.Add(Issue("authenticationMode", "INVALID_VALUE", "登录方式只能是 domain 或 password。"));
        if (request.RoleIds is not null && roleIds.Length != request.RoleIds.Count)
            issues.Add(Issue("roleIds", "DUPLICATE", "用户角色不能重复。"));

        string? passwordHash = current.PasswordHash;
        var switchingToPassword = current.AuthenticationMode == "domain" && authenticationMode == "password";
        if (switchingToPassword
            && string.IsNullOrEmpty(current.PasswordHash)
            && string.IsNullOrEmpty(request.NewPassword))
        {
            issues.Add(Issue("newPassword", "REQUIRED", "该账号没有可恢复的本地密码，切换为密码登录时必须设置新密码。"));
        }
        else if (request.NewPassword is not null
            && (!switchingToPassword || !string.IsNullOrEmpty(current.PasswordHash)))
        {
            issues.Add(Issue("newPassword", "NOT_ALLOWED", "账号已有可恢复的本地密码；切回密码登录后如需修改，请使用重置密码。"));
        }
        else if (switchingToPassword && request.NewPassword is not null)
        {
            passwordHash = FlowPilotPasswordHasher.HashPassword(normalizedLoginName, request.NewPassword);
        }

        return issues.Count > 0
            ? new NormalizedUserUpdateResult(null, IdentityValidationFailure("用户校验失败", issues))
            : new NormalizedUserUpdateResult(
                new NormalizedUserUpdate(loginName, normalizedLoginName, name, email, authenticationMode, passwordHash, departmentId, positionId, roleIds),
                null);
    }

    private async Task<IReadOnlyList<OrganizationInputIssueDto>> ValidateUserUpdateReferencesAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        NormalizedUserUpdate input,
        UpdateUserRequest request,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                (SELECT COUNT_BIG(1) FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [normalized_login_name] = @normalized_login_name AND [id] <> @id),
                (SELECT CASE WHEN @department_id IS NULL THEN 1 ELSE COUNT_BIG(1) END
                 FROM [flowpilot].[departments] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [id] = @department_id AND (@check_department_enabled = 0 OR [is_enabled] = 1)),
                (SELECT CASE WHEN @position_id IS NULL THEN 1 ELSE COUNT_BIG(1) END
                 FROM [flowpilot].[positions] WITH (UPDLOCK, HOLDLOCK)
                 WHERE [id] = @position_id AND (@check_position_enabled = 0 OR [is_enabled] = 1)),
                (SELECT COUNT_BIG(1)
                 FROM OPENJSON(@role_ids) WITH ([id] uniqueidentifier '$') AS [requested]
                 LEFT JOIN [flowpilot].[roles] AS [r] WITH (UPDLOCK, HOLDLOCK)
                    ON [r].[id] = [requested].[id]
                   AND [r].[is_builtin] = 0
                   AND (@check_roles_enabled = 0 OR [r].[is_enabled] = 1)
                 WHERE [r].[id] IS NULL);
            """;
        AddNullable(command, "@department_id", SqlDbType.UniqueIdentifier, input.DepartmentId);
        Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
        Add(command, "@normalized_login_name", SqlDbType.NVarChar, input.NormalizedLoginName, 100);
        AddNullable(command, "@position_id", SqlDbType.UniqueIdentifier, input.PositionId);
        Add(command, "@check_department_enabled", SqlDbType.Bit, request.DepartmentIdSpecified);
        Add(command, "@check_position_enabled", SqlDbType.Bit, request.PositionIdSpecified);
        Add(command, "@check_roles_enabled", SqlDbType.Bit, request.RoleIds is not null);
        Add(command, "@role_ids", SqlDbType.NVarChar, JsonSerializer.Serialize(input.RoleIds, JsonOptions), -1);
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, cancellationToken)
            .ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        var issues = new List<OrganizationInputIssueDto>();
        if (reader.GetInt64(0) > 0)
            issues.Add(Issue("loginName", "DUPLICATE", "登录账号已存在。"));
        if (reader.GetInt64(1) != 1)
            issues.Add(Issue("departmentId", "INVALID_REFERENCE", "部门不存在或已停用。"));
        if (reader.GetInt64(2) != 1)
            issues.Add(Issue("positionId", "INVALID_REFERENCE", "职务不存在或已停用。"));
        if (reader.GetInt64(3) > 0)
            issues.Add(Issue("roleIds", "INVALID_REFERENCE", "角色必须存在、已启用且不是内置角色。"));
        return issues;
    }

    private async Task RevokeUserSessionsAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        string reason,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            UPDATE [flowpilot].[sessions]
            SET [revoked_at] = @now, [revocation_reason] = @reason
            WHERE ([operator_user_id] = @id OR [effective_user_id] = @id)
              AND [revoked_at] IS NULL;
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
        Add(command, "@reason", SqlDbType.NVarChar, reason, 500);
        Add(command, "@now", SqlDbType.DateTime2, now.UtcDateTime);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> UserHasReferencesAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            DECLARE @id_text nvarchar(36) = CONVERT(nvarchar(36), @id);
            SELECT CASE WHEN
                EXISTS (SELECT 1 FROM [flowpilot].[user_roles] WHERE [user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_group_users] WHERE [user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_definition_versions]
                    WHERE [basic_json] LIKE N'%' + @id_text + N'%' OR [snapshot_json] LIKE N'%' + @id_text + N'%')
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_instances]
                    WHERE [initiator_user_id] = @id OR [actual_initiator_user_id] = @id OR [current_assignee_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_tasks]
                    WHERE [assignee_id] = @id OR [default_assignee_id] = @id OR [actual_assignee_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[free_timeline_entries]
                    WHERE [actor_user_id] = @id OR [previous_assignee_id] = @id OR [assignee_id] = @id OR [edited_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[free_participants] WHERE [user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_events]
                    WHERE [operator_user_id] = @id OR [effective_user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[attachments] WHERE [uploaded_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[attachment_references] WHERE [created_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[email_outbox] WHERE [recipient_user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[impersonation_records]
                    WHERE [super_admin_user_id] = @id OR [target_user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[idempotency_records] WHERE [actor_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[audit_events]
                    WHERE [operator_user_id] = @id OR [effective_user_id] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[departments]
                    WHERE [created_by] = @id OR [updated_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[positions]
                    WHERE [created_by] = @id OR [updated_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[roles]
                    WHERE [created_by] = @id OR [updated_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_permission_groups]
                    WHERE [created_by] = @id OR [updated_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_definitions]
                    WHERE [created_by] = @id OR [updated_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_definition_versions]
                    WHERE [created_by] = @id OR [updated_by] = @id
                       OR [first_published_by] = @id OR [latest_published_by] = @id OR [unpublished_by] = @id)
                OR EXISTS (SELECT 1 FROM [flowpilot].[users]
                    WHERE [id] <> @id AND ([created_by] = @id OR [updated_by] = @id))
                OR EXISTS (SELECT 1 FROM [flowpilot].[system_state] WHERE [updated_by] = @id)
            THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END;
            """;
        Add(command, "@id", SqlDbType.UniqueIdentifier, userId);
        return (bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) ?? false);
    }

    private static List<string> UserUpdateFields(UpdateUserRequest request)
    {
        var fields = new List<string>();
        if (request.LoginName is not null) fields.Add("loginName");
        if (request.Name is not null) fields.Add("name");
        if (request.Email is not null) fields.Add("email");
        if (request.DepartmentIdSpecified) fields.Add("departmentId");
        if (request.PositionIdSpecified) fields.Add("positionId");
        if (request.RoleIds is not null) fields.Add("roleIds");
        if (request.AuthenticationMode is not null) fields.Add("authenticationMode");
        if (request.NewPassword is not null) fields.Add("password");
        return fields;
    }

    private sealed record UserState(
        int Revision,
        string LoginName,
        string NormalizedLoginName,
        string Name,
        string Email,
        string AuthenticationMode,
        string? PasswordHash,
        Guid? DepartmentId,
        Guid? PositionId,
        bool IsEnabled,
        bool BuiltIn,
        IReadOnlyList<Guid> RoleIds);

    private sealed record NormalizedUserUpdate(
        string LoginName,
        string NormalizedLoginName,
        string Name,
        string Email,
        string AuthenticationMode,
        string? PasswordHash,
        Guid? DepartmentId,
        Guid? PositionId,
        IReadOnlyList<Guid> RoleIds);

    private sealed record NormalizedUserUpdateResult(
        NormalizedUserUpdate? Value,
        OrganizationCommandFailure? Failure);
}
