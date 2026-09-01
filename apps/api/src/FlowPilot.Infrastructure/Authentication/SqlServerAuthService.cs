using System.Data;
using System.Security.Cryptography;
using System.Text;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Security;
using FlowPilot.Infrastructure.Configuration;
using Microsoft.AspNetCore.Identity;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.Authentication;

public sealed partial class SqlServerAuthService : IAuthService
{
    private const string PasswordAuthenticationMode = "password";
    private const string DomainAuthenticationMode = "domain";
    private const string EnabledStatus = "enabled";
    private static readonly TimeSpan IdleSessionLifetime = TimeSpan.FromHours(8);
    private static readonly TimeSpan AbsoluteSessionLifetime = TimeSpan.FromHours(24);
    private static readonly string DummyPasswordHash = FlowPilotPasswordHasher.HashPassword(
        "unknown-login",
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));

    private readonly string? _connectionString;
    private readonly int _commandTimeoutSeconds;
    private readonly TimeProvider _timeProvider;
    private readonly LoginAttemptLimiter _loginAttemptLimiter;
    private readonly IDomainAuthenticator _domainAuthenticator;

    public SqlServerAuthService(
        IConfiguration configuration,
        FlowPilotDatabaseOptions databaseOptions,
        TimeProvider timeProvider,
        LoginAttemptLimiter loginAttemptLimiter,
        IDomainAuthenticator domainAuthenticator)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(databaseOptions);
        ArgumentNullException.ThrowIfNull(timeProvider);
        ArgumentNullException.ThrowIfNull(loginAttemptLimiter);
        ArgumentNullException.ThrowIfNull(domainAuthenticator);

        _connectionString = configuration.GetConnectionString("FlowPilot");
        _commandTimeoutSeconds = databaseOptions.ApplicationCommandTimeoutSeconds;
        _timeProvider = timeProvider;
        _loginAttemptLimiter = loginAttemptLimiter;
        _domainAuthenticator = domainAuthenticator;
    }

    public async Task<LoginResult> LoginAsync(
        string loginName,
        string password,
        string sourceIp,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(loginName)
            || loginName.Length > 100
            || string.IsNullOrEmpty(password)
            || password.Length > 200)
        {
            return LoginResult.Failed(AuthenticationFailure.BadRequest);
        }

        var normalizedLoginName = IdentityValueNormalizer.Normalize(loginName);
        if (normalizedLoginName.Length is 0 or > 100)
        {
            return LoginResult.Failed(AuthenticationFailure.BadRequest);
        }
        sourceIp = string.IsNullOrWhiteSpace(sourceIp) ? "unknown" : sourceIp.Trim();

        var existingLimit = _loginAttemptLimiter.Check(normalizedLoginName, sourceIp);
        if (existingLimit.IsLimited)
        {
            return LoginResult.Failed(
                AuthenticationFailure.RateLimited,
                existingLimit.RetryAfterSeconds);
        }

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        var user = await LoadUserByNormalizedLoginNameAsync(
            connection,
            transaction: null,
            normalizedLoginName,
            cancellationToken).ConfigureAwait(false);

        if (user is null)
        {
            _ = FlowPilotPasswordHasher.VerifyHashedPassword(
                normalizedLoginName,
                DummyPasswordHash,
                password);
            return FailedCredentialResult(normalizedLoginName, sourceIp);
        }

        if (!user.IsEnabled)
        {
            VerifyForDisabledUser(user, normalizedLoginName, password);
            return FailedCredentialResult(normalizedLoginName, sourceIp);
        }

        PasswordVerificationResult? verification = null;
        if (string.Equals(user.AuthenticationMode, DomainAuthenticationMode, StringComparison.Ordinal))
        {
            var domainResult = await _domainAuthenticator.AuthenticateAsync(
                user.LoginName,
                password,
                cancellationToken).ConfigureAwait(false);
            if (domainResult == DomainAuthenticationResult.Unavailable)
            {
                return LoginResult.Failed(AuthenticationFailure.DomainAuthenticationUnavailable);
            }
            if (domainResult == DomainAuthenticationResult.InvalidCredentials)
            {
                return FailedCredentialResult(normalizedLoginName, sourceIp);
            }
        }
        else if (!string.Equals(
                user.AuthenticationMode,
                PasswordAuthenticationMode,
                StringComparison.Ordinal)
            || string.IsNullOrEmpty(user.PasswordHash))
        {
            _ = FlowPilotPasswordHasher.VerifyHashedPassword(
                normalizedLoginName,
                DummyPasswordHash,
                password);
            return FailedCredentialResult(normalizedLoginName, sourceIp);
        }

        else
        {
            verification = FlowPilotPasswordHasher.VerifyHashedPassword(
                normalizedLoginName,
                user.PasswordHash!,
                password);
            if (verification == PasswordVerificationResult.Failed)
            {
                return FailedCredentialResult(normalizedLoginName, sourceIp);
            }
        }

        var now = TruncateToMilliseconds(_timeProvider.GetUtcNow());
        var idleExpiresAt = now.Add(IdleSessionLifetime);
        var absoluteExpiresAt = now.Add(AbsoluteSessionLifetime);
        var sessionToken = GenerateSessionToken();
        var tokenHash = HashSessionToken(sessionToken);

        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken)
            .ConfigureAwait(false);

        var expectedPasswordHash = user.PasswordHash;
        if (verification == PasswordVerificationResult.SuccessRehashNeeded)
        {
            var replacementHash = FlowPilotPasswordHasher.HashPassword(
                normalizedLoginName,
                password);
            var replaced = await ReplacePasswordHashAsync(
                connection,
                transaction,
                user.Id,
                expectedPasswordHash!,
                replacementHash,
                now,
                cancellationToken).ConfigureAwait(false);
            if (!replaced)
            {
                return FailedCredentialResult(normalizedLoginName, sourceIp);
            }

            expectedPasswordHash = replacementHash;
        }

        var sessionCreated = await InsertSessionAsync(
            connection,
            transaction,
            user,
            user.AuthenticationMode,
            expectedPasswordHash,
            tokenHash,
            now,
            idleExpiresAt,
            absoluteExpiresAt,
            cancellationToken).ConfigureAwait(false);
        if (!sessionCreated)
        {
            return FailedCredentialResult(normalizedLoginName, sourceIp);
        }

        var view = await LoadUserSessionViewAsync(
            connection,
            transaction,
            user.Id,
            cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Authenticated user disappeared before session commit.");

        var session = CreateSessionDto(view, view, impersonation: null, idleExpiresAt);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        _loginAttemptLimiter.RegisterSuccess(normalizedLoginName, sourceIp);
        return LoginResult.Success(session, sessionToken);
    }

    public async Task<CurrentSessionResult> GetCurrentSessionAsync(
        string? sessionToken,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidSessionTokenShape(sessionToken))
        {
            return CurrentSessionResult.AuthenticationRequired();
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
            return CurrentSessionResult.AuthenticationRequired();
        }

        var effectiveUser = await LoadUserSessionViewAsync(
            connection,
            transaction,
            state.EffectiveUserId,
            cancellationToken).ConfigureAwait(false);
        if (effectiveUser is null || !effectiveUser.UserRecord.IsEnabled)
        {
            return CurrentSessionResult.AuthenticationRequired();
        }

        var operatorUser = state.OperatorUserId == state.EffectiveUserId
            ? effectiveUser
            : await LoadUserSessionViewAsync(
                connection,
                transaction,
                state.OperatorUserId,
                cancellationToken).ConfigureAwait(false);
        if (operatorUser is null || !operatorUser.UserRecord.IsEnabled)
        {
            return CurrentSessionResult.AuthenticationRequired();
        }

        var impersonation = state.ImpersonationRecordId is { } impersonationRecordId
            ? await LoadImpersonationContextAsync(
                connection,
                transaction,
                impersonationRecordId,
                state.OperatorUserId,
                state.EffectiveUserId,
                state.AbsoluteExpiresAt,
                cancellationToken).ConfigureAwait(false)
            : null;
        if (state.OperatorUserId != state.EffectiveUserId && impersonation is null)
        {
            return CurrentSessionResult.AuthenticationRequired();
        }

        var session = CreateSessionDto(
            effectiveUser,
            operatorUser,
            impersonation,
            state.IdleExpiresAt);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return CurrentSessionResult.Success(session);
    }

    public async Task LogoutAsync(
        string? sessionToken,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidSessionTokenShape(sessionToken))
        {
            return;
        }

        var now = TruncateToMilliseconds(_timeProvider.GetUtcNow());
        var tokenHash = HashSessionToken(sessionToken!);
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = (SqlTransaction)await connection
            .BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken)
            .ConfigureAwait(false);
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[sessions]
            SET [revoked_at] = @now,
                [revocation_reason] = N'logout'
            OUTPUT
                INSERTED.[operator_user_id],
                INSERTED.[effective_user_id],
                INSERTED.[impersonation_record_id]
            WHERE [token_hash] = @token_hash
              AND [revoked_at] IS NULL;
            """);
        AddBinaryParameter(command, "@token_hash", tokenHash);
        AddUtcParameter(command, "@now", now);
        RevokedSessionState? revokedSession = null;
        await using (var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false))
        {
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                revokedSession = new RevokedSessionState(
                    reader.GetGuid(0),
                    reader.GetGuid(1),
                    reader.IsDBNull(2) ? null : reader.GetGuid(2));
            }
        }

        if (revokedSession?.ImpersonationRecordId is { } impersonationId)
        {
            await CloseImpersonationRecordAsync(
                connection,
                transaction,
                impersonationId,
                revokedSession.OperatorUserId,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
            await InsertImpersonationAuditAsync(
                connection,
                transaction,
                impersonationId,
                "auth.impersonation-stopped",
                revokedSession.OperatorUserId,
                revokedSession.EffectiveUserId,
                traceId,
                now,
                cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    private LoginResult FailedCredentialResult(string normalizedLoginName, string sourceIp)
    {
        var decision = _loginAttemptLimiter.RegisterFailure(normalizedLoginName, sourceIp);
        return decision.IsLimited
            ? LoginResult.Failed(
                AuthenticationFailure.RateLimited,
                decision.RetryAfterSeconds)
            : LoginResult.Failed(AuthenticationFailure.InvalidCredentials);
    }

    private static void VerifyForDisabledUser(
        UserRecord user,
        string normalizedLoginName,
        string password)
    {
        var passwordHash = string.Equals(
                user.AuthenticationMode,
                PasswordAuthenticationMode,
                StringComparison.Ordinal)
            && !string.IsNullOrEmpty(user.PasswordHash)
                ? user.PasswordHash
                : DummyPasswordHash;
        _ = FlowPilotPasswordHasher.VerifyHashedPassword(
            normalizedLoginName,
            passwordHash,
            password);
    }

    private async Task<SqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_connectionString))
        {
            throw new InvalidOperationException("ConnectionStrings:FlowPilot is not configured.");
        }

        var connection = new SqlConnection(_connectionString);
        try
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            return connection;
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<UserRecord?> LoadUserByNormalizedLoginNameAsync(
        SqlConnection connection,
        SqlTransaction? transaction,
        string normalizedLoginName,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            $"""
            {UserSelectSql}
            WHERE [u].[normalized_login_name] = @normalized_login_name;
            """);
        command.Parameters.Add("@normalized_login_name", SqlDbType.NVarChar, 100).Value =
            normalizedLoginName;
        return await ReadSingleUserAsync(command, cancellationToken).ConfigureAwait(false);
    }

    private async Task<UserRecord?> LoadUserByIdAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            $"""
            {UserSelectSql}
            WHERE [u].[id] = @user_id;
            """);
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = userId;
        return await ReadSingleUserAsync(command, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<UserRecord?> ReadSingleUserAsync(
        SqlCommand command,
        CancellationToken cancellationToken)
    {
        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new UserRecord(
            reader.GetGuid(0),
            reader.GetInt32(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.GetBoolean(7),
            reader.GetBoolean(8),
            reader.IsDBNull(9) ? null : reader.GetGuid(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetGuid(12),
            reader.IsDBNull(13) ? null : reader.GetString(13),
            AsUtc(reader.GetDateTime(14)),
            AsUtc(reader.GetDateTime(15)));
    }

    private async Task<bool> ReplacePasswordHashAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        string previousHash,
        string replacementHash,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [flowpilot].[users]
            SET [password_hash] = @replacement_hash,
                [updated_at] = @now,
                [revision] = [revision] + 1
            WHERE [id] = @user_id
              AND [password_hash] = @previous_hash
              AND [authentication_mode] = N'password'
              AND [is_enabled] = 1;
            """);
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = userId;
        command.Parameters.Add("@previous_hash", SqlDbType.NVarChar, 500).Value = previousHash;
        command.Parameters.Add("@replacement_hash", SqlDbType.NVarChar, 500).Value = replacementHash;
        AddUtcParameter(command, "@now", now);
        return await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) == 1;
    }

    private async Task<bool> InsertSessionAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        UserRecord user,
        string expectedAuthenticationMode,
        string? expectedPasswordHash,
        byte[] tokenHash,
        DateTimeOffset now,
        DateTimeOffset idleExpiresAt,
        DateTimeOffset absoluteExpiresAt,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            INSERT INTO [flowpilot].[sessions]
            (
                [id],
                [token_hash],
                [operator_user_id],
                [effective_user_id],
                [permission_snapshot_version],
                [created_at],
                [last_accessed_at],
                [idle_expires_at],
                [absolute_expires_at],
                [revoked_at],
                [revocation_reason]
            )
            SELECT
                @session_id,
                @token_hash,
                [u].[id],
                [u].[id],
                @permission_snapshot_version,
                @now,
                @now,
                @idle_expires_at,
                @absolute_expires_at,
                NULL,
                NULL
            FROM [flowpilot].[users] AS [u]
            WHERE [u].[id] = @user_id
              AND [u].[authentication_mode] = @expected_authentication_mode
              AND (@expected_authentication_mode = N'domain' OR [u].[password_hash] = @expected_password_hash)
              AND [u].[is_enabled] = 1;
            """);
        command.Parameters.Add("@session_id", SqlDbType.UniqueIdentifier).Value = Guid.NewGuid();
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = user.Id;
        command.Parameters.Add("@permission_snapshot_version", SqlDbType.Int).Value =
            BuiltinCatalog.PermissionSnapshotVersion;
        command.Parameters.Add("@expected_authentication_mode", SqlDbType.NVarChar, 20).Value = expectedAuthenticationMode;
        command.Parameters.Add("@expected_password_hash", SqlDbType.NVarChar, 500).Value =
            (object?)expectedPasswordHash ?? DBNull.Value;
        AddBinaryParameter(command, "@token_hash", tokenHash);
        AddUtcParameter(command, "@now", now);
        AddUtcParameter(command, "@idle_expires_at", idleExpiresAt);
        AddUtcParameter(command, "@absolute_expires_at", absoluteExpiresAt);
        return await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) == 1;
    }

    private async Task<SessionState?> TouchSessionAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        byte[] tokenHash,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var idleCandidate = now.Add(IdleSessionLifetime);
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            UPDATE [s]
            SET [last_accessed_at] = @now,
                [idle_expires_at] =
                    CASE
                        WHEN @idle_candidate < [s].[absolute_expires_at] THEN @idle_candidate
                        ELSE [s].[absolute_expires_at]
                    END
            OUTPUT
                INSERTED.[id],
                INSERTED.[operator_user_id],
                INSERTED.[effective_user_id],
                INSERTED.[idle_expires_at],
                INSERTED.[absolute_expires_at],
                INSERTED.[impersonation_record_id]
            FROM [flowpilot].[sessions] AS [s]
            WHERE [s].[token_hash] = @token_hash
              AND [s].[revoked_at] IS NULL
              AND [s].[idle_expires_at] > @now
              AND [s].[absolute_expires_at] > @now
              AND EXISTS
              (
                  SELECT 1
                  FROM [flowpilot].[users] AS [operator]
                  WHERE [operator].[id] = [s].[operator_user_id]
                    AND [operator].[is_enabled] = 1
              )
              AND EXISTS
              (
                  SELECT 1
                  FROM [flowpilot].[users] AS [effective]
                  WHERE [effective].[id] = [s].[effective_user_id]
                    AND [effective].[is_enabled] = 1
              );
            """);
        AddBinaryParameter(command, "@token_hash", tokenHash);
        AddUtcParameter(command, "@now", now);
        AddUtcParameter(command, "@idle_candidate", idleCandidate);

        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new SessionState(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            AsUtc(reader.GetDateTime(3)),
            AsUtc(reader.GetDateTime(4)),
            reader.IsDBNull(5) ? null : reader.GetGuid(5));
    }

    private async Task<UserSessionView?> LoadUserSessionViewAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        var user = await LoadUserByIdAsync(
            connection,
            transaction,
            userId,
            cancellationToken).ConfigureAwait(false);
        if (user is null)
        {
            return null;
        }

        var roles = await LoadRolesAsync(
            connection,
            transaction,
            userId,
            cancellationToken).ConfigureAwait(false);
        var lastLoginAt = await LoadLastLoginAtAsync(
            connection,
            transaction,
            userId,
            cancellationToken).ConfigureAwait(false);
        IReadOnlyList<string> permissions = user.IsBuiltinSuperAdmin
            ? BuiltinCatalog.PermissionCodes.ToArray()
            : await LoadPermissionsAsync(
                connection,
                transaction,
                userId,
                cancellationToken).ConfigureAwait(false);

        var userDto = new UserDto(
            user.Id,
            user.Revision,
            user.LoginName,
            user.DisplayName,
            user.Email,
            user.AuthenticationMode,
            user.IsEnabled ? EnabledStatus : "disabled",
            user.DepartmentId is { } departmentId
                ? new DepartmentRefDto(departmentId, user.DepartmentName!, user.DepartmentPath!)
                : null,
            user.PositionId is { } positionId
                ? new PositionRefDto(positionId, user.PositionName!)
                : null,
            roles,
            user.IsBuiltinSuperAdmin,
            user.CreatedAt,
            user.UpdatedAt,
            lastLoginAt);

        return new UserSessionView(
            user,
            userDto,
            roles.Select(role => role.Id).ToArray(),
            permissions);
    }

    private async Task<IReadOnlyList<RoleRefDto>> LoadRolesAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            SELECT [r].[id], [r].[name]
            FROM [flowpilot].[user_roles] AS [ur]
            INNER JOIN [flowpilot].[roles] AS [r]
                ON [r].[id] = [ur].[role_id]
            WHERE [ur].[user_id] = @user_id
              AND [r].[is_enabled] = 1
            ORDER BY [r].[normalized_name], [r].[id];
            """);
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = userId;

        var roles = new List<RoleRefDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            roles.Add(new RoleRefDto(reader.GetGuid(0), reader.GetString(1)));
        }

        return roles;
    }

    private async Task<DateTimeOffset?> LoadLastLoginAtAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            "SELECT MAX([created_at]) FROM [flowpilot].[sessions] WHERE [operator_user_id] = @user_id;");
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = userId;
        var value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        return value is DateTime timestamp ? AsUtc(timestamp) : null;
    }

    private async Task<IReadOnlyList<string>> LoadPermissionsAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(
            connection,
            transaction,
            """
            SELECT [p].[code]
            FROM [flowpilot].[user_roles] AS [ur]
            INNER JOIN [flowpilot].[roles] AS [r]
                ON [r].[id] = [ur].[role_id]
               AND [r].[is_enabled] = 1
            INNER JOIN [flowpilot].[role_permissions] AS [rp]
                ON [rp].[role_id] = [r].[id]
            INNER JOIN [flowpilot].[permissions] AS [p]
                ON [p].[code] = [rp].[permission_code]
            WHERE [ur].[user_id] = @user_id
            GROUP BY [p].[code]
            ORDER BY MIN([p].[sort_order]), [p].[code];
            """);
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = userId;

        var permissions = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            permissions.Add(reader.GetString(0));
        }

        return permissions;
    }

    private static SessionDto CreateSessionDto(
        UserSessionView effectiveUser,
        UserSessionView operatorUser,
        ImpersonationContextDto? impersonation,
        DateTimeOffset expiresAt) =>
        new(
            effectiveUser.User,
            operatorUser.User,
            effectiveUser.RoleIds,
            effectiveUser.Permissions,
            effectiveUser.UserRecord.IsBuiltinSuperAdmin,
            operatorUser.UserRecord.IsBuiltinSuperAdmin,
            impersonation,
            expiresAt);

    private SqlCommand CreateCommand(
        SqlConnection connection,
        SqlTransaction? transaction,
        string commandText)
    {
        var command = connection.CreateCommand();
        command.CommandText = commandText;
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Transaction = transaction;
        return command;
    }

    private static void AddBinaryParameter(SqlCommand command, string name, byte[] value) =>
        command.Parameters.Add(name, SqlDbType.Binary, 32).Value = value;

    private static void AddUtcParameter(
        SqlCommand command,
        string name,
        DateTimeOffset value)
    {
        var parameter = command.Parameters.Add(name, SqlDbType.DateTime2);
        parameter.Scale = 3;
        parameter.Value = value.UtcDateTime;
    }

    private static string GenerateSessionToken()
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        return token.TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static byte[] HashSessionToken(string sessionToken) =>
        SHA256.HashData(Encoding.UTF8.GetBytes(sessionToken));

    private static bool IsValidSessionTokenShape(string? sessionToken) =>
        sessionToken is { Length: 43 }
        && sessionToken.All(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_');

    private static DateTimeOffset TruncateToMilliseconds(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return new DateTimeOffset(
            utc.Ticks - (utc.Ticks % TimeSpan.TicksPerMillisecond),
            TimeSpan.Zero);
    }

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private const string UserSelectSql = """
        SELECT TOP (1)
            [u].[id],
            [u].[revision],
            [u].[login_name],
            [u].[display_name],
            [u].[email],
            [u].[authentication_mode],
            [u].[password_hash],
            [u].[is_enabled],
            [u].[is_builtin_super_admin],
            [d].[id],
            [d].[name],
            [d].[path_cache],
            [p].[id],
            [p].[name],
            [u].[created_at],
            [u].[updated_at]
        FROM [flowpilot].[users] AS [u]
        LEFT JOIN [flowpilot].[departments] AS [d]
            ON [d].[id] = [u].[department_id]
        LEFT JOIN [flowpilot].[positions] AS [p]
            ON [p].[id] = [u].[position_id]
        """;

    private sealed record UserRecord(
        Guid Id,
        int Revision,
        string LoginName,
        string DisplayName,
        string Email,
        string AuthenticationMode,
        string? PasswordHash,
        bool IsEnabled,
        bool IsBuiltinSuperAdmin,
        Guid? DepartmentId,
        string? DepartmentName,
        string? DepartmentPath,
        Guid? PositionId,
        string? PositionName,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    private sealed record UserSessionView(
        UserRecord UserRecord,
        UserDto User,
        IReadOnlyList<Guid> RoleIds,
        IReadOnlyList<string> Permissions);

    private sealed record SessionState(
        Guid SessionId,
        Guid OperatorUserId,
        Guid EffectiveUserId,
        DateTimeOffset IdleExpiresAt,
        DateTimeOffset AbsoluteExpiresAt,
        Guid? ImpersonationRecordId);

    private sealed record RevokedSessionState(
        Guid OperatorUserId,
        Guid EffectiveUserId,
        Guid? ImpersonationRecordId);
}
