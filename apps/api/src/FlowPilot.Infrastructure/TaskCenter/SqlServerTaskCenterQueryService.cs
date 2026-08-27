using System.Data;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Configuration;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.TaskCenter;

public sealed class SqlServerTaskCenterQueryService : ITaskCenterQueryService
{
    private static readonly TimeSpan ChinaStandardTimeOffset = TimeSpan.FromHours(8);
    private static readonly char[] NodeNameSeparators = ['、', ',', '，', ';', '；'];

    private readonly string? _connectionString;
    private readonly int _commandTimeoutSeconds;

    public SqlServerTaskCenterQueryService(
        IConfiguration configuration,
        FlowPilotDatabaseOptions databaseOptions)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(databaseOptions);

        _connectionString = configuration.GetConnectionString("FlowPilot");
        _commandTimeoutSeconds = databaseOptions.ApplicationCommandTimeoutSeconds;
    }

    public async Task<PageDto<TaskCenterListItemDto>> ListTasksAsync(
        TaskCenterActor actor,
        WorkflowTaskPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateTaskListCommand(connection, actor, query);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);

        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);

        var rows = new List<TaskRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(ReadTaskRow(reader));
        }

        await reader.CloseAsync().ConfigureAwait(false);
        var instances = await LoadInstanceSummariesAsync(
            connection,
            rows.Select(row => row.Instance),
            cancellationToken).ConfigureAwait(false);

        var items = rows
            .GroupBy(row => row.Instance.Id)
            .Select(group => new TaskCenterListItemDto(
                group.Select(row => CreateTaskDto(row, actor)).ToArray(),
                instances[group.Key]))
            .ToArray();

        return new PageDto<TaskCenterListItemDto>(
            items,
            CreatePageMeta(query.Page, query.PageSize, total));
    }

    public async Task<PageDto<ProcessInstanceSummaryDto>> ListInstancesAsync(
        TaskCenterActor actor,
        ProcessInstancePageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateInstanceListCommand(connection, actor, query);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);

        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);

        var rows = new List<InstanceRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(ReadInstanceRow(reader));
        }

        await reader.CloseAsync().ConfigureAwait(false);
        var instances = await LoadInstanceSummariesAsync(
            connection,
            rows,
            cancellationToken).ConfigureAwait(false);

        return new PageDto<ProcessInstanceSummaryDto>(
            rows.Select(row => instances[row.Id]).ToArray(),
            CreatePageMeta(query.Page, query.PageSize, total));
    }

    private SqlCommand CreateTaskListCommand(
        SqlConnection connection,
        TaskCenterActor actor,
        WorkflowTaskPageQuery query)
    {
        var taskFilters = new StringBuilder(
            """
            [t].[status] = N'pending'
            AND
            (
                ([t].[task_type] = N'approval' AND [i].[status] = N'reviewing')
                OR ([t].[task_type] = N'free-collaboration' AND [i].[status] = N'in-progress')
                OR ([t].[task_type] = N'resubmission' AND [i].[status] = N'rejected-pending')
            )
            """);

        if (query.DefinitionId.HasValue)
        {
            taskFilters.AppendLine().Append("AND [i].[definition_id] = @definition_id");
        }

        taskFilters.AppendLine().Append(BuildTaskVisibilityFilter(actor, query.View));
        var pageFilters = new StringBuilder(taskFilters.ToString());
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            pageFilters.AppendLine().Append(
                """
                AND
                (
                    [i].[instance_number] LIKE @search ESCAPE N'\'
                    OR [i].[title] LIKE @search ESCAPE N'\'
                    OR [d].[name] LIKE @search ESCAPE N'\'
                    OR [initiator].[display_name] LIKE @search ESCAPE N'\'
                    OR [t].[node_name_snapshot] LIKE @search ESCAPE N'\'
                )
                """);
        }

        const string commonTableExpression =
            """
            WITH [effective_groups] AS
            (
                SELECT [gu].[group_id]
                FROM [flowpilot].[workflow_group_users] AS [gu]
                INNER JOIN [flowpilot].[workflow_permission_groups] AS [direct_group]
                    ON [direct_group].[id] = [gu].[group_id]
                   AND [direct_group].[is_enabled] = 1
                WHERE [gu].[user_id] = @user_id
                UNION
                SELECT [gr].[group_id]
                FROM [flowpilot].[user_roles] AS [ur]
                INNER JOIN [flowpilot].[roles] AS [r]
                    ON [r].[id] = [ur].[role_id]
                   AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[workflow_group_roles] AS [gr]
                    ON [gr].[role_id] = [r].[id]
                INNER JOIN [flowpilot].[workflow_permission_groups] AS [role_group]
                    ON [role_group].[id] = [gr].[group_id]
                   AND [role_group].[is_enabled] = 1
                WHERE [ur].[user_id] = @user_id
            )
            """;

        const string source =
            """
            FROM [flowpilot].[workflow_tasks] AS [t]
            INNER JOIN [flowpilot].[workflow_instances] AS [i]
                ON [i].[id] = [t].[instance_id]
               AND [i].[version_id] = [t].[version_id]
            INNER JOIN [flowpilot].[workflow_definitions] AS [d]
                ON [d].[id] = [i].[definition_id]
            INNER JOIN [flowpilot].[workflow_definition_versions] AS [v]
                ON [v].[id] = [i].[version_id]
               AND [v].[definition_id] = [i].[definition_id]
            INNER JOIN [flowpilot].[users] AS [initiator]
                ON [initiator].[id] = [i].[initiator_user_id]
            INNER JOIN [flowpilot].[departments] AS [initiator_department]
                ON [initiator_department].[id] = [initiator].[department_id]
            LEFT JOIN [flowpilot].[users] AS [current_assignee]
                ON [current_assignee].[id] = [i].[current_assignee_id]
            LEFT JOIN [flowpilot].[users] AS [task_assignee]
                ON [task_assignee].[id] = [t].[assignee_id]
            LEFT JOIN [flowpilot].[users] AS [default_assignee]
                ON [default_assignee].[id] = [t].[default_assignee_id]
            LEFT JOIN [flowpilot].[users] AS [actual_assignee]
                ON [actual_assignee].[id] = [t].[actual_assignee_id]
            WHERE
            """;

        const string columns =
            """
            [t].[id] AS [task_id],
            [t].[revision] AS [task_revision],
            [t].[task_type],
            [t].[assignee_id] AS [task_assignee_id],
            [task_assignee].[display_name] AS [task_assignee_name],
            [t].[node_id],
            [t].[node_name_snapshot],
            [t].[group_id],
            [t].[default_assignee_id],
            [default_assignee].[display_name] AS [default_assignee_name],
            [t].[actual_assignee_id],
            [actual_assignee].[display_name] AS [actual_assignee_name],
            [t].[status] AS [task_status],
            [t].[action] AS [task_action],
            [t].[result_comment],
            [t].[round] AS [task_round],
            [t].[activated_at],
            [t].[completed_at] AS [task_completed_at],
            [v].[snapshot_json],
            [i].[id] AS [instance_id],
            [i].[revision] AS [instance_revision],
            [i].[definition_id],
            [i].[version_id],
            [i].[instance_number],
            [i].[title] AS [instance_title],
            COALESCE(JSON_VALUE([v].[basic_json], N'$.name'), [d].[name]) AS [process_name],
            [v].[version_label],
            [d].[type] AS [workflow_type],
            [i].[status] AS [instance_status],
            [i].[current_round],
            [i].[current_node_summary],
            [i].[current_assignee_id],
            [current_assignee].[display_name] AS [current_assignee_name],
            [initiator].[id] AS [initiator_id],
            [initiator].[display_name] AS [initiator_name],
            [initiator_department].[path_cache] AS [initiator_department_path],
            [i].[created_at] AS [instance_created_at],
            [i].[updated_at] AS [instance_updated_at],
            [i].[form_values_json],
            [i].[version_id] AS [list_version_id]
            """;

        var pageFilterText = pageFilters.ToString();
        var taskFilterText = taskFilters.ToString();
        var command = CreateCommand(connection);
        command.CommandText = string.Concat(
            "SET NOCOUNT ON;\n",
            "CREATE TABLE [#page_instances] ([instance_id] uniqueidentifier NOT NULL PRIMARY KEY, [sort_at] datetime2(3) NOT NULL);\n",
            commonTableExpression,
            "\nINSERT INTO [#page_instances] ([instance_id], [sort_at])\n",
            "SELECT [i].[id], MAX([t].[activated_at])\n",
            source,
            "\n",
            pageFilterText,
            "\nGROUP BY [i].[id]\n",
            "ORDER BY MAX([t].[activated_at]) DESC, [i].[id] DESC\n",
            "OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;\n",
            commonTableExpression,
            "\nSELECT COUNT_BIG(DISTINCT [i].[id])\n",
            source,
            "\n",
            pageFilterText,
            ";\n",
            commonTableExpression,
            "\nSELECT ",
            columns,
            "\n",
            source,
            "\n",
            taskFilterText,
            "\nAND [i].[id] IN (SELECT [page].[instance_id] FROM [#page_instances] AS [page])\n",
            "ORDER BY\n",
            "    (SELECT [page].[sort_at] FROM [#page_instances] AS [page] WHERE [page].[instance_id] = [i].[id]) DESC,\n",
            "    [i].[id] DESC, [t].[activated_at] DESC, [t].[id] DESC;");

        AddCommonListParameters(command, actor.UserId, query.Page, query.PageSize, query.Search);
        if (query.DefinitionId.HasValue)
        {
            command.Parameters.Add("@definition_id", SqlDbType.UniqueIdentifier).Value =
                query.DefinitionId.Value;
        }

        return command;
    }

    private SqlCommand CreateInstanceListCommand(
        SqlConnection connection,
        TaskCenterActor actor,
        ProcessInstancePageQuery query)
    {
        var filters = new StringBuilder("1 = 1");

        if (!(query.ForceCurrentUser && query.ActiveOnly))
        {
            filters.AppendLine().Append(
                "AND [i].[created_at] >= @date_from AND [i].[created_at] < @date_to_exclusive");
        }

        if (query.DefinitionId.HasValue)
        {
            filters.AppendLine().Append("AND [i].[definition_id] = @definition_id");
        }

        if (!string.IsNullOrWhiteSpace(query.Status))
        {
            filters.AppendLine().Append("AND [i].[status] = @status");
        }

        if (query.InitiatorId.HasValue || query.ForceCurrentUser)
        {
            filters.AppendLine().Append("AND [i].[initiator_user_id] = @initiator_id");
        }

        if (query.ActiveOnly)
        {
            filters.AppendLine().Append(
                "AND [i].[status] IN (N'reviewing', N'rejected-pending', N'in-progress')");
        }

        if (!string.IsNullOrWhiteSpace(query.CurrentNode))
        {
            filters.AppendLine().Append(
                """
                AND
                (
                    [i].[current_node_summary] LIKE @current_node ESCAPE N'\'
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_tasks] AS [current_task]
                        WHERE [current_task].[instance_id] = [i].[id]
                          AND [current_task].[task_type] = N'approval'
                          AND [current_task].[status] = N'pending'
                          AND [current_task].[node_name_snapshot] LIKE @current_node ESCAPE N'\'
                    )
                )
                """);
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            filters.AppendLine().Append(
                """
                AND
                (
                    [i].[instance_number] LIKE @search ESCAPE N'\'
                    OR [i].[title] LIKE @search ESCAPE N'\'
                    OR [d].[name] LIKE @search ESCAPE N'\'
                    OR [initiator].[display_name] LIKE @search ESCAPE N'\'
                    OR [i].[current_node_summary] LIKE @search ESCAPE N'\'
                )
                """);
        }

        if (!query.ForceCurrentUser && !actor.CanViewAllInstances)
        {
            filters.AppendLine().Append(
                """
                AND
                (
                    [i].[initiator_user_id] = @user_id
                    OR [i].[actual_initiator_user_id] = @user_id
                    OR [i].[current_assignee_id] = @user_id
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[free_participants] AS [fp]
                        WHERE [fp].[instance_id] = [i].[id]
                          AND [fp].[user_id] = @user_id
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_tasks] AS [participant_task]
                        WHERE [participant_task].[instance_id] = [i].[id]
                          AND
                          (
                              [participant_task].[assignee_id] = @user_id
                              OR [participant_task].[default_assignee_id] = @user_id
                              OR [participant_task].[actual_assignee_id] = @user_id
                          )
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_version_group_refs] AS [group_ref]
                        INNER JOIN [effective_groups] AS [effective_group]
                            ON [effective_group].[group_id] = [group_ref].[group_id]
                        WHERE [group_ref].[version_id] = [i].[version_id]
                          AND [group_ref].[purpose] IN (N'start', N'review', N'close')
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_version_role_refs] AS [role_ref]
                        INNER JOIN [flowpilot].[user_roles] AS [user_role]
                            ON [user_role].[role_id] = [role_ref].[role_id]
                           AND [user_role].[user_id] = @user_id
                        INNER JOIN [flowpilot].[roles] AS [visible_role]
                            ON [visible_role].[id] = [role_ref].[role_id]
                           AND [visible_role].[is_enabled] = 1
                        WHERE [role_ref].[version_id] = [i].[version_id]
                          AND [role_ref].[purpose] = N'visible'
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM OPENJSON([v].[basic_json], N'$.visibleUserIds') AS [visible_user]
                        WHERE TRY_CONVERT(uniqueidentifier, [visible_user].[value]) = @user_id
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM OPENJSON([v].[basic_json], N'$.visibleUsers') AS [legacy_visible_user]
                        WHERE TRY_CONVERT(uniqueidentifier, [legacy_visible_user].[value]) = @user_id
                    )
                )
                """);
        }

        const string commonTableExpression =
            """
            WITH [effective_groups] AS
            (
                SELECT [gu].[group_id]
                FROM [flowpilot].[workflow_group_users] AS [gu]
                INNER JOIN [flowpilot].[workflow_permission_groups] AS [direct_group]
                    ON [direct_group].[id] = [gu].[group_id]
                   AND [direct_group].[is_enabled] = 1
                WHERE [gu].[user_id] = @user_id
                UNION
                SELECT [gr].[group_id]
                FROM [flowpilot].[user_roles] AS [ur]
                INNER JOIN [flowpilot].[roles] AS [r]
                    ON [r].[id] = [ur].[role_id]
                   AND [r].[is_enabled] = 1
                INNER JOIN [flowpilot].[workflow_group_roles] AS [gr]
                    ON [gr].[role_id] = [r].[id]
                INNER JOIN [flowpilot].[workflow_permission_groups] AS [role_group]
                    ON [role_group].[id] = [gr].[group_id]
                   AND [role_group].[is_enabled] = 1
                WHERE [ur].[user_id] = @user_id
            )
            """;

        const string source =
            """
            FROM [flowpilot].[workflow_instances] AS [i]
            INNER JOIN [flowpilot].[workflow_definitions] AS [d]
                ON [d].[id] = [i].[definition_id]
            INNER JOIN [flowpilot].[workflow_definition_versions] AS [v]
                ON [v].[id] = [i].[version_id]
               AND [v].[definition_id] = [i].[definition_id]
            INNER JOIN [flowpilot].[users] AS [initiator]
                ON [initiator].[id] = [i].[initiator_user_id]
            INNER JOIN [flowpilot].[departments] AS [initiator_department]
                ON [initiator_department].[id] = [initiator].[department_id]
            LEFT JOIN [flowpilot].[users] AS [current_assignee]
                ON [current_assignee].[id] = [i].[current_assignee_id]
            WHERE
            """;

        const string columns =
            """
            [i].[id] AS [instance_id],
            [i].[revision] AS [instance_revision],
            [i].[definition_id],
            [i].[version_id],
            [i].[instance_number],
            [i].[title] AS [instance_title],
            COALESCE(JSON_VALUE([v].[basic_json], N'$.name'), [d].[name]) AS [process_name],
            [v].[version_label],
            [d].[type] AS [workflow_type],
            [i].[status] AS [instance_status],
            [i].[current_round],
            [i].[current_node_summary],
            [i].[current_assignee_id],
            [current_assignee].[display_name] AS [current_assignee_name],
            [initiator].[id] AS [initiator_id],
            [initiator].[display_name] AS [initiator_name],
            [initiator_department].[path_cache] AS [initiator_department_path],
            [i].[created_at] AS [instance_created_at],
            [i].[updated_at] AS [instance_updated_at],
            [i].[form_values_json],
            COALESCE([d].[published_version_id], [i].[version_id]) AS [list_version_id]
            """;

        var filterText = filters.ToString();
        var command = CreateCommand(connection);
        command.CommandText = string.Concat(
            commonTableExpression,
            "\nSELECT COUNT_BIG(1)\n",
            source,
            "\n",
            filterText,
            ";\n",
            commonTableExpression,
            "\nSELECT ",
            columns,
            "\n",
            source,
            "\n",
            filterText,
            "\nORDER BY [i].[created_at] DESC, [i].[id] DESC\n",
            "OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;");

        AddCommonListParameters(command, actor.UserId, query.Page, query.PageSize, query.Search);
        AddUtcDateParameter(command, "@date_from", query.DateFrom);
        AddUtcDateParameter(command, "@date_to_exclusive", query.DateTo.AddDays(1));

        if (query.DefinitionId.HasValue)
        {
            command.Parameters.Add("@definition_id", SqlDbType.UniqueIdentifier).Value =
                query.DefinitionId.Value;
        }

        if (!string.IsNullOrWhiteSpace(query.Status))
        {
            command.Parameters.Add("@status", SqlDbType.NVarChar, 40).Value = query.Status;
        }

        if (query.InitiatorId.HasValue || query.ForceCurrentUser)
        {
            command.Parameters.Add("@initiator_id", SqlDbType.UniqueIdentifier).Value =
                query.ForceCurrentUser ? actor.UserId : query.InitiatorId!.Value;
        }

        if (!string.IsNullOrWhiteSpace(query.CurrentNode))
        {
            command.Parameters.Add("@current_node", SqlDbType.NVarChar, 1004).Value =
                CreateLikePattern(query.CurrentNode);
        }

        return command;
    }

    private static string BuildTaskVisibilityFilter(TaskCenterActor actor, string view)
    {
        if (string.Equals(view, "substitutable", StringComparison.Ordinal))
        {
            return actor.IsSuperAdmin
                ? "AND 1 = 0"
                :
                    """
                    AND [t].[task_type] = N'approval'
                    AND [t].[default_assignee_id] IS NOT NULL
                    AND [t].[default_assignee_id] <> @user_id
                    AND EXISTS
                    (
                        SELECT 1
                        FROM [effective_groups] AS [effective_group]
                        WHERE [effective_group].[group_id] = [t].[group_id]
                    )
                    """;
        }

        return actor.IsSuperAdmin
            ?
                """
                AND
                (
                    [t].[task_type] IN (N'approval', N'free-collaboration')
                    OR ([t].[task_type] = N'resubmission' AND [t].[assignee_id] = @user_id)
                )
                """
            :
                """
                AND
                (
                    (
                        [t].[task_type] = N'approval'
                        AND ([t].[default_assignee_id] IS NULL OR [t].[default_assignee_id] = @user_id)
                        AND EXISTS
                        (
                            SELECT 1
                            FROM [effective_groups] AS [effective_group]
                            WHERE [effective_group].[group_id] = [t].[group_id]
                        )
                    )
                    OR
                    (
                        [t].[task_type] = N'free-collaboration'
                        AND [t].[assignee_id] = @user_id
                        AND EXISTS
                        (
                            SELECT 1
                            FROM [flowpilot].[workflow_version_group_refs] AS [assignee_group_ref]
                            INNER JOIN [effective_groups] AS [assignee_group]
                                ON [assignee_group].[group_id] = [assignee_group_ref].[group_id]
                            WHERE [assignee_group_ref].[version_id] = [t].[version_id]
                              AND [assignee_group_ref].[purpose] = N'review'
                        )
                    )
                    OR
                    (
                        [t].[task_type] = N'resubmission'
                        AND [t].[assignee_id] = @user_id
                    )
                )
                """;
    }

    private async Task<Dictionary<Guid, ProcessInstanceSummaryDto>> LoadInstanceSummariesAsync(
        SqlConnection connection,
        IEnumerable<InstanceRow> sourceRows,
        CancellationToken cancellationToken)
    {
        var rows = sourceRows.DistinctBy(row => row.Id).ToArray();
        if (rows.Length == 0)
        {
            return [];
        }

        var nodeNames = rows.ToDictionary(row => row.Id, _ => new List<string>());
        var catalogs = new Dictionary<Guid, List<FieldCatalogRow>>();
        await using var command = CreateProjectionCommand(connection, rows);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var instanceId = reader.GetGuid(0);
            var nodeName = reader.GetString(1);
            if (!nodeNames[instanceId].Contains(nodeName, StringComparer.Ordinal))
            {
                nodeNames[instanceId].Add(nodeName);
            }
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var versionId = reader.GetGuid(0);
            if (!catalogs.TryGetValue(versionId, out var fields))
            {
                fields = [];
                catalogs.Add(versionId, fields);
            }

            fields.Add(new FieldCatalogRow(
                reader.GetString(1),
                GetNullableString(reader, 2),
                GetNullableString(reader, 3)));
        }

        return rows.ToDictionary(
            row => row.Id,
            row => CreateInstanceDto(
                row,
                nodeNames[row.Id],
                catalogs.GetValueOrDefault(row.ListVersionId) ?? []));
    }

    private SqlCommand CreateProjectionCommand(SqlConnection connection, IReadOnlyList<InstanceRow> rows)
    {
        var command = CreateCommand(connection);
        var instanceParameters = AddGuidParameters(
            command,
            rows.Select(row => row.Id).Distinct(),
            "@instance");
        var versionParameters = AddGuidParameters(
            command,
            rows.Select(row => row.ListVersionId).Distinct(),
            "@version");

        command.CommandText = $"""
            SELECT [t].[instance_id], [t].[node_name_snapshot]
            FROM [flowpilot].[workflow_tasks] AS [t]
            WHERE [t].[instance_id] IN ({string.Join(", ", instanceParameters)})
              AND [t].[task_type] = N'approval'
              AND [t].[status] = N'pending'
            ORDER BY [t].[instance_id], [t].[activated_at], [t].[id];

            SELECT [f].[version_id], [f].[field_id], [f].[table_field_id], [f].[column_id]
            FROM [flowpilot].[workflow_version_field_catalog] AS [f]
            WHERE [f].[version_id] IN ({string.Join(", ", versionParameters)})
              AND [f].[is_listed] = 1
            ORDER BY [f].[version_id], [f].[table_field_id], [f].[field_id], [f].[column_id];
            """;
        return command;
    }

    private static List<string> AddGuidParameters(
        SqlCommand command,
        IEnumerable<Guid> values,
        string prefix)
    {
        var names = new List<string>();
        var index = 0;
        foreach (var value in values)
        {
            var name = string.Concat(prefix, index.ToString(CultureInfo.InvariantCulture));
            command.Parameters.Add(name, SqlDbType.UniqueIdentifier).Value = value;
            names.Add(name);
            index++;
        }

        return names;
    }

    private static TaskCenterTaskDto CreateTaskDto(TaskRow row, TaskCenterActor actor)
    {
        var isApproval = string.Equals(row.TaskType, "approval", StringComparison.Ordinal);
        var isResubmission = string.Equals(row.TaskType, "resubmission", StringComparison.Ordinal);
        var node = isApproval
            ? ReadNodeSettings(row.SnapshotJson, row.NodeId)
            : NodeSettings.Default;

        IReadOnlyList<string> allowedActions = row.TaskType switch
        {
            "approval" when actor.CanReview =>
                node.HandlingMode == "confirmation" ? ["confirm"] : ["pass", "reject"],
            "free-collaboration" when actor.CanReview => ["reply", "change-assignee"],
            "resubmission" when actor.CanResubmit && row.TaskAssigneeId == actor.UserId => ["resubmit"],
            _ => [],
        };

        return new TaskCenterTaskDto
        {
            Id = row.TaskId,
            Revision = row.TaskRevision,
            InstanceId = row.Instance.Id,
            DefinitionId = row.Instance.DefinitionId,
            VersionId = row.Instance.VersionId,
            TaskType = row.TaskType,
            NodeId = isApproval ? row.NodeId : null,
            NodeName = isApproval ? row.NodeName : null,
            HandlingMode = isApproval ? node.HandlingMode : null,
            PermissionGroupId = isApproval ? row.GroupId : null,
            Assignee = row.TaskAssigneeId.HasValue && row.TaskAssigneeName is not null
                ? new TaskCenterUserRefDto(row.TaskAssigneeId.Value, row.TaskAssigneeName)
                : null,
            DefaultAssignee = row.DefaultAssigneeId.HasValue && row.DefaultAssigneeName is not null
                ? new TaskCenterUserRefDto(row.DefaultAssigneeId.Value, row.DefaultAssigneeName)
                : null,
            CompletedBy = row.ActualAssigneeId.HasValue && row.ActualAssigneeName is not null
                ? new TaskCenterUserRefDto(row.ActualAssigneeId.Value, row.ActualAssigneeName)
                : null,
            Status = row.Status,
            Action = row.Action,
            ResultStatus = row.Action switch
            {
                "pass" => "passed",
                "confirm" => "confirmed",
                "reject" => "rejected",
                _ => null,
            },
            Comment = row.Comment,
            Round = isApproval || isResubmission ? row.Round : null,
            EditableFieldIds = isApproval ? node.EditableFieldIds : null,
            AllowRepeatedEditing = isApproval ? node.AllowRepeatedEditing : null,
            AllowedActions = allowedActions,
            CreatedAt = AsUtc(row.ActivatedAt),
            CompletedAt = row.CompletedAt.HasValue ? AsUtc(row.CompletedAt.Value) : null,
        };
    }

    private static ProcessInstanceSummaryDto CreateInstanceDto(
        InstanceRow row,
        List<string> currentNodeNames,
        IReadOnlyList<FieldCatalogRow> catalog)
    {
        var resolvedNodeNames = currentNodeNames.Count > 0
            ? currentNodeNames.ToArray()
            : SplitCurrentNodeSummary(row.CurrentNodeSummary);

        return new ProcessInstanceSummaryDto
        {
            Id = row.Id,
            Revision = row.Revision,
            DefinitionId = row.DefinitionId,
            VersionId = row.VersionId,
            Code = row.Code,
            Title = row.Title,
            ProcessName = row.ProcessName,
            VersionLabel = row.VersionLabel,
            WorkflowType = row.WorkflowType,
            Status = row.Status,
            Round = row.Round,
            CurrentNodeNames = resolvedNodeNames,
            CurrentAssignee = row.CurrentAssigneeId.HasValue && row.CurrentAssigneeName is not null
                ? new TaskCenterUserRefDto(row.CurrentAssigneeId.Value, row.CurrentAssigneeName)
                : null,
            Initiator = new TaskCenterUserRefDto(
                row.InitiatorId,
                row.InitiatorName,
                row.InitiatorDepartmentPath),
            CreatedAt = AsUtc(row.CreatedAt),
            UpdatedAt = AsUtc(row.UpdatedAt),
            ListValues = ProjectListValues(row.FormValuesJson, catalog),
        };
    }

    private static JsonObject ProjectListValues(
        string formValuesJson,
        IReadOnlyList<FieldCatalogRow> catalog)
    {
        if (catalog.Count == 0)
        {
            return [];
        }

        JsonObject? source;
        try
        {
            source = JsonNode.Parse(formValuesJson) as JsonObject;
        }
        catch (JsonException)
        {
            return [];
        }

        if (source is null)
        {
            return [];
        }

        var result = new JsonObject();
        foreach (var field in catalog.Where(field => field.TableFieldId is null))
        {
            if (source.TryGetPropertyValue(field.FieldId, out var value))
            {
                result[field.FieldId] = value?.DeepClone();
            }
        }

        foreach (var table in catalog
                     .Where(field => field.TableFieldId is not null && field.ColumnId is not null)
                     .GroupBy(field => field.TableFieldId!, StringComparer.Ordinal))
        {
            if (source[table.Key] is not JsonArray sourceRows)
            {
                continue;
            }

            var allowedColumns = table
                .Select(field => field.ColumnId!)
                .ToHashSet(StringComparer.Ordinal);
            var projectedRows = new JsonArray();
            foreach (var sourceRow in sourceRows.OfType<JsonObject>())
            {
                var projectedRow = new JsonObject();
                foreach (var property in sourceRow)
                {
                    if (allowedColumns.Contains(property.Key)
                        || property.Key is "id" or "rowId" or "key")
                    {
                        projectedRow[property.Key] = property.Value?.DeepClone();
                    }
                }

                projectedRows.Add(projectedRow);
            }

            result[table.Key] = projectedRows;
        }

        return result;
    }

    private static NodeSettings ReadNodeSettings(string snapshotJson, string? nodeId)
    {
        if (string.IsNullOrWhiteSpace(nodeId))
        {
            return NodeSettings.Default;
        }

        try
        {
            using var document = JsonDocument.Parse(snapshotJson);
            if (!document.RootElement.TryGetProperty("flow", out var flow)
                || !flow.TryGetProperty("nodes", out var nodes)
                || nodes.ValueKind != JsonValueKind.Array)
            {
                return NodeSettings.Default;
            }

            foreach (var candidate in nodes.EnumerateArray())
            {
                if (!candidate.TryGetProperty("id", out var id)
                    || !string.Equals(id.GetString(), nodeId, StringComparison.Ordinal)
                    || !candidate.TryGetProperty("data", out var data))
                {
                    continue;
                }

                var handlingMode = data.TryGetProperty("handlingMode", out var mode)
                    && string.Equals(mode.GetString(), "confirmation", StringComparison.Ordinal)
                        ? "confirmation"
                        : "approval";
                var editableFields = ReadStringArray(data, "editableFieldIds");
                if (editableFields.Length == 0)
                {
                    editableFields = ReadStringArray(data, "editableFields");
                }

                var allowRepeatedEditing = data.TryGetProperty("allowRepeatedEditing", out var repeated)
                    && repeated.ValueKind is JsonValueKind.True;
                return new NodeSettings(handlingMode, editableFields, allowRepeatedEditing);
            }
        }
        catch (JsonException)
        {
            return NodeSettings.Default;
        }

        return NodeSettings.Default;
    }

    private static string[] ReadStringArray(JsonElement source, string propertyName)
    {
        if (!source.TryGetProperty(propertyName, out var values)
            || values.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return values.EnumerateArray()
            .Where(value => value.ValueKind == JsonValueKind.String)
            .Select(value => value.GetString())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static string[] SplitCurrentNodeSummary(string? summary) =>
        string.IsNullOrWhiteSpace(summary)
            ? []
            : summary.Split(
                NodeNameSeparators,
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static TaskRow ReadTaskRow(SqlDataReader reader) => new()
    {
        TaskId = reader.GetGuid(reader.GetOrdinal("task_id")),
        TaskRevision = reader.GetInt32(reader.GetOrdinal("task_revision")),
        TaskType = reader.GetString(reader.GetOrdinal("task_type")),
        TaskAssigneeId = GetNullableGuid(reader, "task_assignee_id"),
        TaskAssigneeName = GetNullableString(reader, "task_assignee_name"),
        NodeId = GetNullableString(reader, "node_id"),
        NodeName = GetNullableString(reader, "node_name_snapshot"),
        GroupId = GetNullableGuid(reader, "group_id"),
        DefaultAssigneeId = GetNullableGuid(reader, "default_assignee_id"),
        DefaultAssigneeName = GetNullableString(reader, "default_assignee_name"),
        ActualAssigneeId = GetNullableGuid(reader, "actual_assignee_id"),
        ActualAssigneeName = GetNullableString(reader, "actual_assignee_name"),
        Status = reader.GetString(reader.GetOrdinal("task_status")),
        Action = GetNullableString(reader, "task_action"),
        Comment = GetNullableString(reader, "result_comment"),
        Round = reader.GetInt32(reader.GetOrdinal("task_round")),
        ActivatedAt = reader.GetDateTime(reader.GetOrdinal("activated_at")),
        CompletedAt = GetNullableDateTime(reader, "task_completed_at"),
        SnapshotJson = reader.GetString(reader.GetOrdinal("snapshot_json")),
        Instance = ReadInstanceRow(reader),
    };

    private static InstanceRow ReadInstanceRow(SqlDataReader reader) => new()
    {
        Id = reader.GetGuid(reader.GetOrdinal("instance_id")),
        Revision = reader.GetInt32(reader.GetOrdinal("instance_revision")),
        DefinitionId = reader.GetGuid(reader.GetOrdinal("definition_id")),
        VersionId = reader.GetGuid(reader.GetOrdinal("version_id")),
        Code = reader.GetString(reader.GetOrdinal("instance_number")),
        Title = reader.GetString(reader.GetOrdinal("instance_title")),
        ProcessName = reader.GetString(reader.GetOrdinal("process_name")),
        VersionLabel = reader.GetString(reader.GetOrdinal("version_label")),
        WorkflowType = reader.GetString(reader.GetOrdinal("workflow_type")),
        Status = reader.GetString(reader.GetOrdinal("instance_status")),
        Round = reader.GetInt32(reader.GetOrdinal("current_round")),
        CurrentNodeSummary = GetNullableString(reader, "current_node_summary"),
        CurrentAssigneeId = GetNullableGuid(reader, "current_assignee_id"),
        CurrentAssigneeName = GetNullableString(reader, "current_assignee_name"),
        InitiatorId = reader.GetGuid(reader.GetOrdinal("initiator_id")),
        InitiatorName = reader.GetString(reader.GetOrdinal("initiator_name")),
        InitiatorDepartmentPath = reader.GetString(reader.GetOrdinal("initiator_department_path")),
        CreatedAt = reader.GetDateTime(reader.GetOrdinal("instance_created_at")),
        UpdatedAt = reader.GetDateTime(reader.GetOrdinal("instance_updated_at")),
        FormValuesJson = reader.GetString(reader.GetOrdinal("form_values_json")),
        ListVersionId = reader.GetGuid(reader.GetOrdinal("list_version_id")),
    };

    private static async Task<long> ReadTotalAsync(
        SqlDataReader reader,
        CancellationToken cancellationToken) =>
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? reader.GetInt64(0)
            : 0;

    private static PageMetaDto CreatePageMeta(int page, int pageSize, long total)
    {
        var pages = total == 0 ? 0 : ((total - 1) / pageSize) + 1;
        return new PageMetaDto(
            page,
            pageSize,
            total,
            pages > int.MaxValue ? int.MaxValue : (int)pages);
    }

    private static void AddCommonListParameters(
        SqlCommand command,
        Guid userId,
        int page,
        int pageSize,
        string? search)
    {
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = userId;
        command.Parameters.Add("@offset", SqlDbType.BigInt).Value = ((long)page - 1) * pageSize;
        command.Parameters.Add("@page_size", SqlDbType.Int).Value = pageSize;
        if (!string.IsNullOrWhiteSpace(search))
        {
            command.Parameters.Add("@search", SqlDbType.NVarChar, 204).Value =
                CreateLikePattern(search);
        }
    }

    private static void AddUtcDateParameter(SqlCommand command, string name, DateOnly date)
    {
        var value = new DateTimeOffset(date.ToDateTime(TimeOnly.MinValue), ChinaStandardTimeOffset);
        var parameter = command.Parameters.Add(name, SqlDbType.DateTime2);
        parameter.Scale = 3;
        parameter.Value = value.UtcDateTime;
    }

    private static string CreateLikePattern(string value) =>
        string.Concat(
            "%",
            value.Trim()
                .Replace("\\", "\\\\", StringComparison.Ordinal)
                .Replace("%", "\\%", StringComparison.Ordinal)
                .Replace("_", "\\_", StringComparison.Ordinal)
                .Replace("[", "\\[", StringComparison.Ordinal),
            "%");

    private SqlCommand CreateCommand(SqlConnection connection)
    {
        var command = connection.CreateCommand();
        command.CommandTimeout = _commandTimeoutSeconds;
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

    private static Guid? GetNullableGuid(SqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal);
    }

    private static string? GetNullableString(SqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return GetNullableString(reader, ordinal);
    }

    private static string? GetNullableString(SqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static DateTime? GetNullableDateTime(SqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetDateTime(ordinal);
    }

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private sealed record NodeSettings(
        string HandlingMode,
        IReadOnlyList<string> EditableFieldIds,
        bool AllowRepeatedEditing)
    {
        public static NodeSettings Default { get; } = new("approval", [], false);
    }

    private sealed record FieldCatalogRow(
        string FieldId,
        string? TableFieldId,
        string? ColumnId);

    private sealed record TaskRow
    {
        public required Guid TaskId { get; init; }

        public required int TaskRevision { get; init; }

        public required string TaskType { get; init; }

        public Guid? TaskAssigneeId { get; init; }

        public string? TaskAssigneeName { get; init; }

        public string? NodeId { get; init; }

        public string? NodeName { get; init; }

        public Guid? GroupId { get; init; }

        public Guid? DefaultAssigneeId { get; init; }

        public string? DefaultAssigneeName { get; init; }

        public Guid? ActualAssigneeId { get; init; }

        public string? ActualAssigneeName { get; init; }

        public required string Status { get; init; }

        public string? Action { get; init; }

        public string? Comment { get; init; }

        public required int Round { get; init; }

        public required DateTime ActivatedAt { get; init; }

        public DateTime? CompletedAt { get; init; }

        public required string SnapshotJson { get; init; }

        public required InstanceRow Instance { get; init; }
    }

    private sealed record InstanceRow
    {
        public required Guid Id { get; init; }

        public required int Revision { get; init; }

        public required Guid DefinitionId { get; init; }

        public required Guid VersionId { get; init; }

        public required string Code { get; init; }

        public required string Title { get; init; }

        public required string ProcessName { get; init; }

        public required string VersionLabel { get; init; }

        public required string WorkflowType { get; init; }

        public required string Status { get; init; }

        public required int Round { get; init; }

        public string? CurrentNodeSummary { get; init; }

        public Guid? CurrentAssigneeId { get; init; }

        public string? CurrentAssigneeName { get; init; }

        public required Guid InitiatorId { get; init; }

        public required string InitiatorName { get; init; }

        public required string InitiatorDepartmentPath { get; init; }

        public required DateTime CreatedAt { get; init; }

        public required DateTime UpdatedAt { get; init; }

        public required string FormValuesJson { get; init; }

        public required Guid ListVersionId { get; init; }
    }
}
