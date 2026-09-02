using System.Data;
using System.Text.Json;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Organization;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService : IOrganizationService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string? _connectionString;
    private readonly int _commandTimeoutSeconds;
    private readonly FlowPilotDbContext _dbContext;
    private readonly TimeProvider _timeProvider;

    public SqlServerOrganizationService(
        IConfiguration configuration,
        FlowPilotDatabaseOptions databaseOptions,
        FlowPilotDbContext dbContext,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(databaseOptions);
        ArgumentNullException.ThrowIfNull(dbContext);
        ArgumentNullException.ThrowIfNull(timeProvider);

        _connectionString = configuration.GetConnectionString("FlowPilot");
        _commandTimeoutSeconds = databaseOptions.ApplicationCommandTimeoutSeconds;
        _dbContext = dbContext;
        _timeProvider = timeProvider;
    }

    public async Task<OrganizationPageDto<UserDto>> ListUsersAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            SELECT COUNT_BIG(1)
            FROM [flowpilot].[users] AS [u]
            WHERE (@search IS NULL OR [u].[login_name] LIKE @search ESCAPE N'\'
                OR [u].[display_name] LIKE @search ESCAPE N'\'
                OR [u].[email] LIKE @search ESCAPE N'\')
              AND (@is_enabled IS NULL OR [u].[is_enabled] = @is_enabled)
              AND (@department_id IS NULL OR [u].[department_id] = @department_id)
              AND (@position_id IS NULL OR [u].[position_id] = @position_id)
              AND (@role_id IS NULL OR EXISTS
                  (SELECT 1 FROM [flowpilot].[user_roles] AS [filter_role]
                   WHERE [filter_role].[user_id] = [u].[id] AND [filter_role].[role_id] = @role_id))
              AND (@has_email IS NULL OR (@has_email = 1 AND LEN(LTRIM(RTRIM([u].[email]))) > 0)
                  OR (@has_email = 0 AND LEN(LTRIM(RTRIM([u].[email]))) = 0))
              AND (@authentication_mode IS NULL OR [u].[authentication_mode] = @authentication_mode);

            SELECT
                [u].[id], [u].[revision], [u].[login_name], [u].[display_name], [u].[email],
                [u].[authentication_mode], [u].[is_enabled], [u].[is_builtin_super_admin],
                [d].[id], [d].[name], [d].[path_cache], [p].[id], [p].[name],
                [u].[created_at], [u].[updated_at],
                (SELECT MAX([login_session].[created_at])
                    FROM [flowpilot].[sessions] AS [login_session]
                    WHERE [login_session].[operator_user_id] = [u].[id]),
                COALESCE((
                    SELECT [r].[id], [r].[name]
                    FROM [flowpilot].[user_roles] AS [ur]
                    INNER JOIN [flowpilot].[roles] AS [r] ON [r].[id] = [ur].[role_id]
                    WHERE [ur].[user_id] = [u].[id]
                    ORDER BY [r].[name], [r].[id]
                    FOR JSON PATH
                ), N'[]'),
                CONVERT(bit, CASE WHEN [u].[password_hash] IS NULL THEN 0 ELSE 1 END)
            FROM [flowpilot].[users] AS [u]
            LEFT JOIN [flowpilot].[departments] AS [d] ON [d].[id] = [u].[department_id]
            LEFT JOIN [flowpilot].[positions] AS [p] ON [p].[id] = [u].[position_id]
            WHERE (@search IS NULL OR [u].[login_name] LIKE @search ESCAPE N'\'
                OR [u].[display_name] LIKE @search ESCAPE N'\'
                OR [u].[email] LIKE @search ESCAPE N'\')
              AND (@is_enabled IS NULL OR [u].[is_enabled] = @is_enabled)
              AND (@department_id IS NULL OR [u].[department_id] = @department_id)
              AND (@position_id IS NULL OR [u].[position_id] = @position_id)
              AND (@role_id IS NULL OR EXISTS
                  (SELECT 1 FROM [flowpilot].[user_roles] AS [filter_role]
                   WHERE [filter_role].[user_id] = [u].[id] AND [filter_role].[role_id] = @role_id))
              AND (@has_email IS NULL OR (@has_email = 1 AND LEN(LTRIM(RTRIM([u].[email]))) > 0)
                  OR (@has_email = 0 AND LEN(LTRIM(RTRIM([u].[email]))) = 0))
              AND (@authentication_mode IS NULL OR [u].[authentication_mode] = @authentication_mode)
            ORDER BY [u].[display_name], [u].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """;
        AddCommonFilters(command, query);
        AddPagingParameters(command, query);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);

        var items = new List<UserDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            items.Add(new UserDto(
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
                reader.IsDBNull(15) ? null : AsUtc(reader.GetDateTime(15)),
                reader.GetBoolean(17)));
        }

        return CreatePage(items, query, total);
    }

    public async Task<OrganizationPageDto<RoleDto>> ListRolesAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            SELECT COUNT_BIG(1)
            FROM [flowpilot].[roles] AS [r]
            WHERE (@search IS NULL OR [r].[name] LIKE @search ESCAPE N'\'
                OR [r].[code] LIKE @search ESCAPE N'\')
              AND (@is_enabled IS NULL OR [r].[is_enabled] = @is_enabled);

            SELECT
                [r].[id], [r].[revision], [r].[code], [r].[name], COALESCE([r].[description], N''),
                [r].[is_enabled], [r].[is_builtin],
                CONVERT(int, (SELECT COUNT_BIG(1) FROM [flowpilot].[user_roles] AS [ur]
                    WHERE [ur].[role_id] = [r].[id])),
                COALESCE((SELECT [ur].[user_id] AS [id]
                    FROM [flowpilot].[user_roles] AS [ur]
                    WHERE [ur].[role_id] = [r].[id]
                    ORDER BY [ur].[user_id]
                    FOR JSON PATH), N'[]'),
                CONVERT(int, (SELECT COUNT_BIG(1) FROM [flowpilot].[role_permissions] AS [rp]
                    WHERE [rp].[role_id] = [r].[id])),
                CONVERT(int, (SELECT COUNT(DISTINCT [permission].[resource])
                    FROM [flowpilot].[role_permissions] AS [rp]
                    INNER JOIN [flowpilot].[permissions] AS [permission]
                        ON [permission].[code] = [rp].[permission_code]
                    WHERE [rp].[role_id] = [r].[id] AND [permission].[action] = N'查看'))
            FROM [flowpilot].[roles] AS [r]
            WHERE (@search IS NULL OR [r].[name] LIKE @search ESCAPE N'\'
                OR [r].[code] LIKE @search ESCAPE N'\')
              AND (@is_enabled IS NULL OR [r].[is_enabled] = @is_enabled)
            ORDER BY [r].[name], [r].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """;
        AddSearchAndStatus(command, query);
        AddPagingParameters(command, query);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);

        var items = new List<RoleDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var permissionCount = reader.GetInt32(9);
            var pagePermissionCount = reader.GetInt32(10);
            items.Add(new RoleDto(
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
                pagePermissionCount,
                permissionCount));
        }

        return CreatePage(items, query, total);
    }

    public async Task<IReadOnlyList<DepartmentDto>> ListDepartmentsAsync(
        bool includeDisabled,
        CancellationToken cancellationToken = default)
    {
        var departments = _dbContext.Departments.AsNoTracking();
        if (!includeDisabled)
        {
            departments = departments.Where(department => department.IsEnabled);
        }

        var rows = await departments
            .OrderBy(department => department.SortOrder)
            .ThenBy(department => department.Name)
            .ThenBy(department => department.Id)
            .Select(department => new DepartmentRow(
                department.Id,
                department.Revision,
                department.Code,
                department.Name,
                department.ParentId,
                department.Path,
                department.SortOrder,
                department.IsEnabled,
                department.Description ?? string.Empty,
                _dbContext.OrganizationUserReferences.Count(user => user.DepartmentId == department.Id)))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var byParent = rows.ToLookup(row => row.ParentId);
        IReadOnlyList<DepartmentDto> CreateChildren(Guid? parentId, int level) =>
            byParent[parentId]
                .Select(row => new DepartmentDto(
                    row.Id,
                    row.Revision,
                    row.Code,
                    row.Name,
                    row.ParentId,
                    row.Path,
                    level,
                    row.SortOrder,
                    row.IsEnabled ? "enabled" : "disabled",
                    row.Description,
                    row.UserCount,
                    CreateChildren(row.Id, level + 1)))
                .ToArray();

        return CreateChildren(null, 1);
    }

    public async Task<OrganizationPageDto<PositionDto>> ListPositionsAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var positions = _dbContext.Positions.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var search = query.Search.Trim();
            positions = positions.Where(position =>
                position.Name.Contains(search) || position.Code.Contains(search));
        }

        positions = query.Status switch
        {
            "enabled" => positions.Where(position => position.IsEnabled),
            "disabled" => positions.Where(position => !position.IsEnabled),
            _ => positions,
        };

        var total = await positions.LongCountAsync(cancellationToken).ConfigureAwait(false);
        var items = await positions
            .OrderBy(position => position.SortOrder)
            .ThenBy(position => position.Name)
            .ThenBy(position => position.Id)
            .Skip(checked((query.Page - 1) * query.PageSize))
            .Take(query.PageSize)
            .Select(position => new PositionDto(
                position.Id,
                position.Revision,
                position.Name,
                position.SortOrder,
                position.IsEnabled ? "enabled" : "disabled",
                position.Description ?? string.Empty,
                _dbContext.OrganizationUserReferences.Count(user => user.PositionId == position.Id)))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return CreatePage(items, query, total);
    }

    public async Task<OrganizationPageDto<WorkflowPermissionGroupDto>> ListWorkflowGroupsAsync(
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_permission_groups] AS [g]
            WHERE (@search IS NULL OR [g].[name] LIKE @search ESCAPE N'\'
                OR [g].[code] LIKE @search ESCAPE N'\')
              AND (@is_enabled IS NULL OR [g].[is_enabled] = @is_enabled)
              AND (@purpose IS NULL OR EXISTS
                  (SELECT 1 FROM [flowpilot].[workflow_permission_group_purposes] AS [filter_purpose]
                   WHERE [filter_purpose].[group_id] = [g].[id]
                     AND [filter_purpose].[purpose] = @purpose));

            SELECT
                [g].[id], [g].[revision], [g].[code], [g].[name], COALESCE([g].[description], N''),
                [g].[is_enabled], [g].[updated_at],
                COALESCE((SELECT CASE [gp].[purpose]
                        WHEN N'review' THEN N'review-or-accept' ELSE [gp].[purpose] END AS [value]
                    FROM [flowpilot].[workflow_permission_group_purposes] AS [gp]
                    WHERE [gp].[group_id] = [g].[id]
                    ORDER BY [gp].[purpose]
                    FOR JSON PATH), N'[]'),
                COALESCE((SELECT [gu].[user_id] AS [id]
                    FROM [flowpilot].[workflow_group_users] AS [gu]
                    WHERE [gu].[group_id] = [g].[id]
                    ORDER BY [gu].[user_id]
                    FOR JSON PATH), N'[]'),
                COALESCE((SELECT [gr].[role_id] AS [id]
                    FROM [flowpilot].[workflow_group_roles] AS [gr]
                    WHERE [gr].[group_id] = [g].[id]
                    ORDER BY [gr].[role_id]
                    FOR JSON PATH), N'[]'),
                CONVERT(int, (SELECT COUNT_BIG(1) FROM
                    (SELECT [gu].[user_id]
                     FROM [flowpilot].[workflow_group_users] AS [gu]
                     INNER JOIN [flowpilot].[users] AS [direct_user]
                        ON [direct_user].[id] = [gu].[user_id]
                       AND [direct_user].[is_enabled] = 1
                       AND [direct_user].[is_builtin_super_admin] = 0
                     WHERE [gu].[group_id] = [g].[id]
                     UNION
                     SELECT [ur].[user_id]
                     FROM [flowpilot].[workflow_group_roles] AS [gr]
                     INNER JOIN [flowpilot].[roles] AS [role]
                        ON [role].[id] = [gr].[role_id] AND [role].[is_enabled] = 1
                     INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [gr].[role_id]
                     INNER JOIN [flowpilot].[users] AS [role_user]
                        ON [role_user].[id] = [ur].[user_id]
                       AND [role_user].[is_enabled] = 1
                       AND [role_user].[is_builtin_super_admin] = 0
                     WHERE [gr].[group_id] = [g].[id]) AS [effective_members])),
                CONVERT(int, (SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_tasks] AS [task]
                    WHERE [task].[group_id] = [g].[id]
                      AND [task].[status] IN (N'inactive', N'pending'))),
                COALESCE((SELECT DISTINCT [definition].[id], [definition].[code], [definition].[name]
                    FROM [flowpilot].[workflow_version_group_refs] AS [group_ref]
                    INNER JOIN [flowpilot].[workflow_definition_versions] AS [version]
                        ON [version].[id] = [group_ref].[version_id]
                    INNER JOIN [flowpilot].[workflow_definitions] AS [definition]
                        ON [definition].[id] = [version].[definition_id]
                    WHERE [group_ref].[group_id] = [g].[id]
                    FOR JSON PATH), N'[]')
            FROM [flowpilot].[workflow_permission_groups] AS [g]
            WHERE (@search IS NULL OR [g].[name] LIKE @search ESCAPE N'\'
                OR [g].[code] LIKE @search ESCAPE N'\')
              AND (@is_enabled IS NULL OR [g].[is_enabled] = @is_enabled)
              AND (@purpose IS NULL OR EXISTS
                  (SELECT 1 FROM [flowpilot].[workflow_permission_group_purposes] AS [filter_purpose]
                   WHERE [filter_purpose].[group_id] = [g].[id]
                     AND [filter_purpose].[purpose] = @purpose))
            ORDER BY [g].[updated_at] DESC, [g].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """;
        AddSearchAndStatus(command, query);
        AddNullable(command, "@purpose", SqlDbType.NVarChar, ToDatabasePurpose(query.Purpose), 20);
        AddPagingParameters(command, query);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);

        var items = new List<WorkflowPermissionGroupDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            items.Add(ReadWorkflowGroup(reader));
        }

        return CreatePage(items, query, total);
    }

    public async Task<WorkflowPermissionGroupDto?> GetWorkflowGroupAsync(
        Guid groupId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        return await LoadWorkflowGroupAsync(connection, null, groupId, cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<OrganizationPageDto<EffectiveWorkflowMemberDto>?> ListEffectiveMembersAsync(
        Guid groupId,
        OrganizationPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (var exists = CreateCommand(connection))
        {
            exists.CommandText =
                "SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_permission_groups] WHERE [id] = @group_id;";
            Add(exists, "@group_id", SqlDbType.UniqueIdentifier, groupId);
            if (Convert.ToInt64(await exists.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false),
                    System.Globalization.CultureInfo.InvariantCulture) == 0)
            {
                return null;
            }
        }

        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            WITH [effective_member_ids] AS
            (
                SELECT [gu].[user_id]
                FROM [flowpilot].[workflow_group_users] AS [gu]
                WHERE [gu].[group_id] = @group_id
                UNION
                SELECT [ur].[user_id]
                FROM [flowpilot].[workflow_group_roles] AS [gr]
                INNER JOIN [flowpilot].[roles] AS [r]
                    ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [gr].[role_id]
                WHERE [gr].[group_id] = @group_id
            )
            SELECT COUNT_BIG(1)
            FROM [effective_member_ids] AS [member]
            INNER JOIN [flowpilot].[users] AS [u]
                ON [u].[id] = [member].[user_id]
               AND [u].[is_enabled] = 1
               AND [u].[is_builtin_super_admin] = 0
            WHERE @search IS NULL OR [u].[display_name] LIKE @search ESCAPE N'\'
                OR [u].[login_name] LIKE @search ESCAPE N'\';

            WITH [effective_member_ids] AS
            (
                SELECT [gu].[user_id]
                FROM [flowpilot].[workflow_group_users] AS [gu]
                WHERE [gu].[group_id] = @group_id
                UNION
                SELECT [ur].[user_id]
                FROM [flowpilot].[workflow_group_roles] AS [gr]
                INNER JOIN [flowpilot].[roles] AS [r]
                    ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [gr].[role_id]
                WHERE [gr].[group_id] = @group_id
            )
            SELECT
                [u].[id], [u].[display_name], [u].[login_name], [u].[email], COALESCE([d].[path_cache], N''),
                CONVERT(bit, CASE WHEN EXISTS
                    (SELECT 1 FROM [flowpilot].[workflow_group_users] AS [direct]
                     WHERE [direct].[group_id] = @group_id AND [direct].[user_id] = [u].[id])
                    THEN 1 ELSE 0 END),
                COALESCE((SELECT [r].[id], [r].[name]
                    FROM [flowpilot].[workflow_group_roles] AS [gr]
                    INNER JOIN [flowpilot].[roles] AS [r]
                        ON [r].[id] = [gr].[role_id] AND [r].[is_enabled] = 1
                    INNER JOIN [flowpilot].[user_roles] AS [ur]
                        ON [ur].[role_id] = [r].[id] AND [ur].[user_id] = [u].[id]
                    WHERE [gr].[group_id] = @group_id
                    ORDER BY [r].[name], [r].[id]
                    FOR JSON PATH), N'[]')
            FROM [effective_member_ids] AS [member]
            INNER JOIN [flowpilot].[users] AS [u]
                ON [u].[id] = [member].[user_id]
               AND [u].[is_enabled] = 1
               AND [u].[is_builtin_super_admin] = 0
            LEFT JOIN [flowpilot].[departments] AS [d] ON [d].[id] = [u].[department_id]
            WHERE @search IS NULL OR [u].[display_name] LIKE @search ESCAPE N'\'
                OR [u].[login_name] LIKE @search ESCAPE N'\'
            ORDER BY [u].[display_name], [u].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """;
        Add(command, "@group_id", SqlDbType.UniqueIdentifier, groupId);
        AddNullable(command, "@search", SqlDbType.NVarChar,
            query.Search is null ? null : CreateLikePattern(query.Search), 300);
        AddPagingParameters(command, query);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);

        var items = new List<EffectiveWorkflowMemberDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var sources = new List<WorkflowMemberSourceDto>();
            if (reader.GetBoolean(5))
            {
                sources.Add(new WorkflowMemberSourceDto("direct"));
            }

            sources.AddRange(DeserializeArray<RoleRefDto>(reader.GetString(6))
                .Select(role => new WorkflowMemberSourceDto("role", role)));
            items.Add(new EffectiveWorkflowMemberDto(
                new WorkflowMemberUserRefDto(
                    reader.GetGuid(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.GetString(4)),
                sources));
        }

        return CreatePage(items, query, total);
    }

    private static WorkflowPermissionGroupDto ReadWorkflowGroup(SqlDataReader reader) => new(
        reader.GetGuid(0),
        reader.GetInt32(1),
        reader.GetString(2),
        reader.GetString(3),
        reader.GetString(4),
        DeserializeArray<StringRow>(reader.GetString(7)).Select(item => item.Value).ToArray(),
        reader.GetBoolean(5) ? "enabled" : "disabled",
        DeserializeArray<IdRow>(reader.GetString(8)).Select(item => item.Id).ToArray(),
        DeserializeArray<IdRow>(reader.GetString(9)).Select(item => item.Id).ToArray(),
        reader.GetInt32(10),
        reader.GetInt32(11),
        DeserializeArray<ProcessDefinitionRefDto>(reader.GetString(12)),
        AsUtc(reader.GetDateTime(6)));

    private async Task<WorkflowPermissionGroupDto?> LoadWorkflowGroupAsync(
        SqlConnection connection,
        SqlTransaction? transaction,
        Guid groupId,
        CancellationToken cancellationToken)
    {
        await using var command = CreateCommand(connection, transaction);
        command.CommandText =
            """
            SELECT
                [g].[id], [g].[revision], [g].[code], [g].[name], COALESCE([g].[description], N''),
                [g].[is_enabled], [g].[updated_at],
                COALESCE((SELECT CASE [gp].[purpose]
                        WHEN N'review' THEN N'review-or-accept' ELSE [gp].[purpose] END AS [value]
                    FROM [flowpilot].[workflow_permission_group_purposes] AS [gp]
                    WHERE [gp].[group_id] = [g].[id]
                    ORDER BY [gp].[purpose]
                    FOR JSON PATH), N'[]'),
                COALESCE((SELECT [gu].[user_id] AS [id]
                    FROM [flowpilot].[workflow_group_users] AS [gu]
                    WHERE [gu].[group_id] = [g].[id]
                    ORDER BY [gu].[user_id]
                    FOR JSON PATH), N'[]'),
                COALESCE((SELECT [gr].[role_id] AS [id]
                    FROM [flowpilot].[workflow_group_roles] AS [gr]
                    WHERE [gr].[group_id] = [g].[id]
                    ORDER BY [gr].[role_id]
                    FOR JSON PATH), N'[]'),
                CONVERT(int, (SELECT COUNT_BIG(1) FROM
                    (SELECT [gu].[user_id]
                     FROM [flowpilot].[workflow_group_users] AS [gu]
                     INNER JOIN [flowpilot].[users] AS [direct_user]
                        ON [direct_user].[id] = [gu].[user_id]
                       AND [direct_user].[is_enabled] = 1
                       AND [direct_user].[is_builtin_super_admin] = 0
                     WHERE [gu].[group_id] = [g].[id]
                     UNION
                     SELECT [ur].[user_id]
                     FROM [flowpilot].[workflow_group_roles] AS [gr]
                     INNER JOIN [flowpilot].[roles] AS [role]
                        ON [role].[id] = [gr].[role_id] AND [role].[is_enabled] = 1
                     INNER JOIN [flowpilot].[user_roles] AS [ur] ON [ur].[role_id] = [gr].[role_id]
                     INNER JOIN [flowpilot].[users] AS [role_user]
                        ON [role_user].[id] = [ur].[user_id]
                       AND [role_user].[is_enabled] = 1
                       AND [role_user].[is_builtin_super_admin] = 0
                     WHERE [gr].[group_id] = [g].[id]) AS [effective_members])),
                CONVERT(int, (SELECT COUNT_BIG(1) FROM [flowpilot].[workflow_tasks] AS [task]
                    WHERE [task].[group_id] = [g].[id]
                      AND [task].[status] IN (N'inactive', N'pending'))),
                COALESCE((SELECT DISTINCT [definition].[id], [definition].[code], [definition].[name]
                    FROM [flowpilot].[workflow_version_group_refs] AS [group_ref]
                    INNER JOIN [flowpilot].[workflow_definition_versions] AS [version]
                        ON [version].[id] = [group_ref].[version_id]
                    INNER JOIN [flowpilot].[workflow_definitions] AS [definition]
                        ON [definition].[id] = [version].[definition_id]
                    WHERE [group_ref].[group_id] = [g].[id]
                    FOR JSON PATH), N'[]')
            FROM [flowpilot].[workflow_permission_groups] AS [g]
            WHERE [g].[id] = @group_id;
            """;
        Add(command, "@group_id", SqlDbType.UniqueIdentifier, groupId);

        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SingleRow,
            cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadWorkflowGroup(reader)
            : null;
    }

    private static OrganizationPageDto<T> CreatePage<T>(
        IReadOnlyList<T> items,
        OrganizationPageQuery query,
        long total) => new(
            items,
            new OrganizationPageMetaDto(
                query.Page,
                query.PageSize,
                total,
                total == 0 ? 0 : checked((int)Math.Ceiling(total / (double)query.PageSize))));

    private static async Task<long> ReadTotalAsync(
        SqlDataReader reader,
        CancellationToken cancellationToken) =>
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false) ? reader.GetInt64(0) : 0;

    private static T[] DeserializeArray<T>(string json) =>
        JsonSerializer.Deserialize<T[]>(json, JsonOptions) ?? [];

    private static void AddCommonFilters(SqlCommand command, OrganizationPageQuery query)
    {
        AddSearchAndStatus(command, query);
        AddNullable(command, "@department_id", SqlDbType.UniqueIdentifier, query.DepartmentId);
        AddNullable(command, "@position_id", SqlDbType.UniqueIdentifier, query.PositionId);
        AddNullable(command, "@role_id", SqlDbType.UniqueIdentifier, query.RoleId);
        AddNullable(command, "@has_email", SqlDbType.Bit, query.HasEmail);
        AddNullable(command, "@authentication_mode", SqlDbType.NVarChar, query.AuthenticationMode, 20);
    }

    private static void AddSearchAndStatus(SqlCommand command, OrganizationPageQuery query)
    {
        AddNullable(command, "@search", SqlDbType.NVarChar,
            query.Search is null ? null : CreateLikePattern(query.Search), 300);
        AddNullable(command, "@is_enabled", SqlDbType.Bit, query.Status switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => null,
        });
    }

    private static void AddPagingParameters(SqlCommand command, OrganizationPageQuery query)
    {
        Add(command, "@offset", SqlDbType.Int, checked((query.Page - 1) * query.PageSize));
        Add(command, "@page_size", SqlDbType.Int, query.PageSize);
    }

    private static string CreateLikePattern(string value) => string.Concat(
        "%",
        value.Trim()
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal)
            .Replace("[", "\\[", StringComparison.Ordinal),
        "%");

    private static string? ToDatabasePurpose(string? purpose) => purpose switch
    {
        "review-or-accept" => "review",
        "start" or "close" => purpose,
        _ => null,
    };

    private SqlCommand CreateCommand(SqlConnection connection, SqlTransaction? transaction = null)
    {
        var command = connection.CreateCommand();
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Transaction = transaction;
        return command;
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

    private static void Add(
        SqlCommand command,
        string name,
        SqlDbType type,
        object value,
        int size = 0)
    {
        var parameter = size == 0
            ? command.Parameters.Add(name, type)
            : command.Parameters.Add(name, type, size);
        parameter.Value = value;
    }

    private static void AddNullable(
        SqlCommand command,
        string name,
        SqlDbType type,
        object? value,
        int size = 0)
    {
        var parameter = size == 0
            ? command.Parameters.Add(name, type)
            : command.Parameters.Add(name, type, size);
        parameter.Value = value ?? DBNull.Value;
    }

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private sealed record DepartmentRow(
        Guid Id,
        int Revision,
        string Code,
        string Name,
        Guid? ParentId,
        string Path,
        int SortOrder,
        bool IsEnabled,
        string Description,
        int UserCount);

    private sealed record IdRow(Guid Id);

    private sealed record StringRow(string Value);
}
