using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Infrastructure.Configuration;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionQueryService : IProcessDefinitionQueryService
{
    private const string EffectiveGroupsCte =
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
            INNER JOIN [flowpilot].[roles] AS [role]
                ON [role].[id] = [ur].[role_id]
               AND [role].[is_enabled] = 1
            INNER JOIN [flowpilot].[workflow_group_roles] AS [gr]
                ON [gr].[role_id] = [role].[id]
            INNER JOIN [flowpilot].[workflow_permission_groups] AS [role_group]
                ON [role_group].[id] = [gr].[group_id]
               AND [role_group].[is_enabled] = 1
            WHERE [ur].[user_id] = @user_id
        )
        """;

    private const string VisibleInstancePredicate =
        """
        (
            @is_super_admin = 1
            OR @can_view_all_instances = 1
            OR [i].[initiator_user_id] = @user_id
            OR [i].[actual_initiator_user_id] = @user_id
            OR [i].[current_assignee_id] = @user_id
            OR EXISTS
            (
                SELECT 1
                FROM [flowpilot].[free_participants] AS [free_participant]
                WHERE [free_participant].[instance_id] = [i].[id]
                  AND [free_participant].[user_id] = @user_id
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
                FROM [flowpilot].[workflow_version_group_refs] AS [instance_group_ref]
                INNER JOIN [effective_groups] AS [instance_group]
                    ON [instance_group].[group_id] = [instance_group_ref].[group_id]
                WHERE [instance_group_ref].[version_id] = [i].[version_id]
                  AND [instance_group_ref].[purpose] IN (N'start', N'review', N'close')
            )
            OR EXISTS
            (
                SELECT 1
                FROM [flowpilot].[workflow_version_role_refs] AS [instance_role_ref]
                INNER JOIN [flowpilot].[user_roles] AS [instance_user_role]
                    ON [instance_user_role].[role_id] = [instance_role_ref].[role_id]
                   AND [instance_user_role].[user_id] = @user_id
                INNER JOIN [flowpilot].[roles] AS [instance_role]
                    ON [instance_role].[id] = [instance_role_ref].[role_id]
                   AND [instance_role].[is_enabled] = 1
                WHERE [instance_role_ref].[version_id] = [i].[version_id]
                  AND [instance_role_ref].[purpose] = N'visible'
            )
            OR EXISTS
            (
                SELECT 1
                FROM OPENJSON([iv].[basic_json], N'$.visibleUserIds') AS [visible_user]
                WHERE TRY_CONVERT(uniqueidentifier, [visible_user].[value]) = @user_id
            )
            OR EXISTS
            (
                SELECT 1
                FROM OPENJSON([iv].[basic_json], N'$.visibleUsers') AS [legacy_visible_user]
                WHERE TRY_CONVERT(uniqueidentifier, [legacy_visible_user].[value]) = @user_id
            )
        )
        """;

    private const string VisibleDefinitionPredicate =
        """
        (
            @is_super_admin = 1
            OR
            (
                [d].[published_version_id] IS NOT NULL
                AND
                (
                    EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_version_group_refs] AS [published_group_ref]
                        INNER JOIN [effective_groups] AS [published_group]
                            ON [published_group].[group_id] = [published_group_ref].[group_id]
                        WHERE [published_group_ref].[version_id] = [d].[published_version_id]
                          AND [published_group_ref].[purpose] IN (N'start', N'review', N'close')
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_version_role_refs] AS [published_role_ref]
                        INNER JOIN [flowpilot].[user_roles] AS [published_user_role]
                            ON [published_user_role].[role_id] = [published_role_ref].[role_id]
                           AND [published_user_role].[user_id] = @user_id
                        INNER JOIN [flowpilot].[roles] AS [published_role]
                            ON [published_role].[id] = [published_role_ref].[role_id]
                           AND [published_role].[is_enabled] = 1
                        WHERE [published_role_ref].[version_id] = [d].[published_version_id]
                          AND [published_role_ref].[purpose] = N'visible'
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_definition_versions] AS [published_version]
                        CROSS APPLY OPENJSON(
                            [published_version].[basic_json],
                            N'$.visibleUserIds') AS [visible_user]
                        WHERE [published_version].[id] = [d].[published_version_id]
                          AND TRY_CONVERT(uniqueidentifier, [visible_user].[value]) = @user_id
                    )
                    OR EXISTS
                    (
                        SELECT 1
                        FROM [flowpilot].[workflow_definition_versions] AS [published_version]
                        CROSS APPLY OPENJSON(
                            [published_version].[basic_json],
                            N'$.visibleUsers') AS [legacy_visible_user]
                        WHERE [published_version].[id] = [d].[published_version_id]
                          AND TRY_CONVERT(uniqueidentifier, [legacy_visible_user].[value]) = @user_id
                    )
                )
            )
            OR EXISTS
            (
                SELECT 1
                FROM [flowpilot].[workflow_instances] AS [i]
                INNER JOIN [flowpilot].[workflow_definition_versions] AS [iv]
                    ON [iv].[id] = [i].[version_id]
                   AND [iv].[definition_id] = [i].[definition_id]
                WHERE [i].[definition_id] = [d].[id]
                  AND
        """ + VisibleInstancePredicate +
        """
            )
        )
        """;

    private const string DefinitionJoins =
        """
        INNER JOIN [flowpilot].[users] AS [definition_updated_by]
            ON [definition_updated_by].[id] = [d].[updated_by]
        LEFT JOIN [flowpilot].[workflow_definition_versions] AS [pv]
            ON [pv].[id] = [d].[published_version_id]
           AND [pv].[definition_id] = [d].[id]
        LEFT JOIN [flowpilot].[users] AS [pv_created_by]
            ON [pv_created_by].[id] = [pv].[created_by]
        LEFT JOIN [flowpilot].[users] AS [pv_updated_by]
            ON [pv_updated_by].[id] = [pv].[updated_by]
        LEFT JOIN [flowpilot].[users] AS [pv_first_published_by]
            ON [pv_first_published_by].[id] = [pv].[first_published_by]
        LEFT JOIN [flowpilot].[users] AS [pv_unpublished_by]
            ON [pv_unpublished_by].[id] = [pv].[unpublished_by]
        """;

    private const string DefinitionColumns =
        """
        [d].[id] AS [definition_id],
        [d].[revision] AS [definition_revision],
        [d].[code] AS [definition_code],
        [d].[name] AS [definition_name],
        [d].[description] AS [definition_description],
        [d].[type] AS [definition_type],
        [d].[is_disabled] AS [definition_is_disabled],
        [d].[published_version_id],
        [d].[next_version_number],
        CONVERT(int, (SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_instances] AS [definition_instance]
            WHERE [definition_instance].[definition_id] = [d].[id])) AS [definition_instance_count],
        [d].[updated_at] AS [definition_updated_at],
        [d].[updated_by] AS [definition_updated_by_id],
        [definition_updated_by].[display_name] AS [definition_updated_by_name],
        (SELECT COUNT_BIG(1)
         FROM [flowpilot].[workflow_definition_versions] AS [definition_version]
         WHERE [definition_version].[definition_id] = [d].[id]) AS [version_count],
        JSON_VALUE([pv].[basic_json], N'$.instancePrefix') AS [published_instance_prefix],
        [pv].[id] AS [pv_id],
        [pv].[definition_id] AS [pv_definition_id],
        [pv].[revision] AS [pv_revision],
        [pv].[version_number] AS [pv_version_number],
        [pv].[version_label] AS [pv_version_label],
        CONVERT(int, (SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_instances] AS [published_instance]
            WHERE [published_instance].[version_id] = [pv].[id])) AS [pv_instance_count],
        [pv].[validation_status] AS [pv_validation_status],
        [pv].[validation_json] AS [pv_validation_json],
        [pv].[validated_at] AS [pv_validated_at],
        [pv].[basic_json] AS [pv_basic_json],
        [pv].[snapshot_json] AS [pv_snapshot_json],
        [pv].[created_at] AS [pv_created_at],
        [pv].[created_by] AS [pv_created_by_id],
        [pv_created_by].[display_name] AS [pv_created_by_name],
        [pv].[updated_at] AS [pv_updated_at],
        [pv].[updated_by] AS [pv_updated_by_id],
        [pv_updated_by].[display_name] AS [pv_updated_by_name],
        [pv].[first_published_at] AS [pv_first_published_at],
        [pv].[first_published_by] AS [pv_first_published_by_id],
        [pv_first_published_by].[display_name] AS [pv_first_published_by_name],
        [pv].[latest_published_at] AS [pv_latest_published_at],
        [pv].[change_note] AS [pv_change_note],
        [pv].[unpublished_at] AS [pv_unpublished_at],
        [pv].[unpublished_by] AS [pv_unpublished_by_id],
        [pv_unpublished_by].[display_name] AS [pv_unpublished_by_name],
        [pv].[unpublished_reason] AS [pv_unpublished_reason]
        """;

    private const string VersionJoins =
        """
        INNER JOIN [flowpilot].[workflow_definitions] AS [d]
            ON [d].[id] = [v].[definition_id]
        INNER JOIN [flowpilot].[users] AS [version_created_by]
            ON [version_created_by].[id] = [v].[created_by]
        INNER JOIN [flowpilot].[users] AS [version_updated_by]
            ON [version_updated_by].[id] = [v].[updated_by]
        LEFT JOIN [flowpilot].[users] AS [version_first_published_by]
            ON [version_first_published_by].[id] = [v].[first_published_by]
        LEFT JOIN [flowpilot].[users] AS [version_unpublished_by]
            ON [version_unpublished_by].[id] = [v].[unpublished_by]
        """;

    private const string VersionColumns =
        """
        [v].[id] AS [version_id],
        [v].[definition_id] AS [version_definition_id],
        [d].[code] AS [version_definition_code],
        [d].[published_version_id] AS [definition_published_version_id],
        [v].[revision] AS [version_revision],
        [v].[version_number],
        [v].[version_label],
        CONVERT(int, (SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_instances] AS [version_instance]
            WHERE [version_instance].[version_id] = [v].[id])) AS [version_instance_count],
        [v].[validation_status],
        [v].[validation_json],
        [v].[validated_at],
        [v].[basic_json],
        [v].[snapshot_json],
        [v].[created_at] AS [version_created_at],
        [v].[created_by] AS [version_created_by_id],
        [version_created_by].[display_name] AS [version_created_by_name],
        [v].[updated_at] AS [version_updated_at],
        [v].[updated_by] AS [version_updated_by_id],
        [version_updated_by].[display_name] AS [version_updated_by_name],
        [v].[first_published_at],
        [v].[first_published_by] AS [version_first_published_by_id],
        [version_first_published_by].[display_name] AS [version_first_published_by_name],
        [v].[latest_published_at],
        [v].[change_note],
        [v].[unpublished_at],
        [v].[unpublished_by] AS [version_unpublished_by_id],
        [version_unpublished_by].[display_name] AS [version_unpublished_by_name],
        [v].[unpublished_reason]
        """;

    private readonly string? _connectionString;
    private readonly int _commandTimeoutSeconds;

    public SqlServerProcessDefinitionQueryService(
        IConfiguration configuration,
        FlowPilotDatabaseOptions databaseOptions)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(databaseOptions);

        _connectionString = configuration.GetConnectionString("FlowPilot");
        _commandTimeoutSeconds = databaseOptions.ApplicationCommandTimeoutSeconds;
    }

    public async Task<ProcessDefinitionPageDto<ProcessDefinitionDto>> ListAsync(
        ProcessDefinitionPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        var where = BuildManagementFilters(command, query);
        command.CommandText =
            $"""
            SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_definitions] AS [d]
            WHERE {where};

            SELECT {DefinitionColumns}
            FROM [flowpilot].[workflow_definitions] AS [d]
            {DefinitionJoins}
            WHERE {where}
            ORDER BY [d].[updated_at] DESC, [d].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """;
        AddPagingParameters(command, query.Page, query.PageSize);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        var items = new List<ProcessDefinitionDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            items.Add(ReadDefinition(reader));
        }

        return new ProcessDefinitionPageDto<ProcessDefinitionDto>(
            items,
            CreatePageMeta(query.Page, query.PageSize, total));
    }

    public async Task<ProcessDefinitionPageDto<VisibleProcessDefinitionDto>> ListVisibleAsync(
        ProcessDefinitionActor actor,
        VisibleProcessDefinitionPageQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);
        ArgumentNullException.ThrowIfNull(query);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            $"""
            {EffectiveGroupsCte}
            SELECT COUNT_BIG(1)
            FROM [flowpilot].[workflow_definitions] AS [d]
            WHERE {VisibleDefinitionPredicate};

            {EffectiveGroupsCte}
            SELECT {DefinitionColumns}
            FROM [flowpilot].[workflow_definitions] AS [d]
            {DefinitionJoins}
            WHERE {VisibleDefinitionPredicate}
            ORDER BY [d].[updated_at] DESC, [d].[id]
            OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
            """;
        AddActorParameters(command, actor);
        AddPagingParameters(command, query.Page, query.PageSize);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var total = await ReadTotalAsync(reader, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        var definitions = new List<ProcessDefinitionDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            definitions.Add(ReadDefinition(reader));
        }

        await reader.CloseAsync().ConfigureAwait(false);
        var versions = await LoadVisibleVersionsAsync(
            connection,
            actor,
            definitions.Select(definition => definition.Id).ToArray(),
            cancellationToken).ConfigureAwait(false);
        var items = definitions.Select(definition => ToVisible(
            definition,
            versions.GetValueOrDefault(definition.Id) ?? [])).ToArray();

        return new ProcessDefinitionPageDto<VisibleProcessDefinitionDto>(
            items,
            CreatePageMeta(query.Page, query.PageSize, total));
    }

    public async Task<ProcessDefinitionDto?> GetAsync(
        Guid definitionId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            $"""
            SELECT {DefinitionColumns}
            FROM [flowpilot].[workflow_definitions] AS [d]
            {DefinitionJoins}
            WHERE [d].[id] = @definition_id;
            """;
        command.Parameters.Add("@definition_id", SqlDbType.UniqueIdentifier).Value = definitionId;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadDefinition(reader)
            : null;
    }

    public async Task<IReadOnlyList<ProcessVersionSummaryDto>?> ListVersionsAsync(
        Guid definitionId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            $"""
            SELECT CASE WHEN EXISTS
            (
                SELECT 1
                FROM [flowpilot].[workflow_definitions]
                WHERE [id] = @definition_id
            ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END;

            SELECT {VersionColumns}
            FROM [flowpilot].[workflow_definition_versions] AS [v]
            {VersionJoins}
            WHERE [v].[definition_id] = @definition_id
            ORDER BY [v].[version_number] DESC, [v].[id];
            """;
        command.Parameters.Add("@definition_id", SqlDbType.UniqueIdentifier).Value = definitionId;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var exists = await reader.ReadAsync(cancellationToken).ConfigureAwait(false) && reader.GetBoolean(0);
        if (!exists)
        {
            return null;
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        var items = new List<ProcessVersionSummaryDto>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            items.Add(ReadVersionRow(reader).ToSummary());
        }

        return items;
    }

    public async Task<ProcessVersionDto?> GetVersionAsync(
        Guid definitionId,
        Guid versionId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            $"""
            SELECT {VersionColumns}
            FROM [flowpilot].[workflow_definition_versions] AS [v]
            {VersionJoins}
            WHERE [v].[definition_id] = @definition_id
              AND [v].[id] = @version_id;
            """;
        command.Parameters.Add("@definition_id", SqlDbType.UniqueIdentifier).Value = definitionId;
        command.Parameters.Add("@version_id", SqlDbType.UniqueIdentifier).Value = versionId;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadVersionRow(reader).ToDto()
            : null;
    }

    private async Task<Dictionary<Guid, IReadOnlyList<VisibleProcessVersionDto>>> LoadVisibleVersionsAsync(
        SqlConnection connection,
        ProcessDefinitionActor actor,
        Guid[] definitionIds,
        CancellationToken cancellationToken)
    {
        if (definitionIds.Length == 0)
        {
            return [];
        }

        await using var command = CreateCommand(connection);
        var definitionParameters = new List<string>(definitionIds.Length);
        for (var index = 0; index < definitionIds.Length; index++)
        {
            var name = $"@definition_id_{index}";
            definitionParameters.Add(name);
            command.Parameters.Add(name, SqlDbType.UniqueIdentifier).Value = definitionIds[index];
        }

        command.CommandText =
            $"""
            {EffectiveGroupsCte}
            SELECT {VersionColumns}
            FROM [flowpilot].[workflow_definition_versions] AS [v]
            {VersionJoins}
            WHERE [v].[definition_id] IN ({string.Join(", ", definitionParameters)})
              AND
              (
                  [v].[id] = [d].[published_version_id]
                  OR EXISTS
                  (
                      SELECT 1
                      FROM [flowpilot].[workflow_instances] AS [i]
                      INNER JOIN [flowpilot].[workflow_definition_versions] AS [iv]
                          ON [iv].[id] = [i].[version_id]
                         AND [iv].[definition_id] = [i].[definition_id]
                      WHERE [i].[version_id] = [v].[id]
                        AND {VisibleInstancePredicate}
                  )
              )
            ORDER BY [v].[definition_id], [v].[version_number] DESC, [v].[id];
            """;
        AddActorParameters(command, actor);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var rows = new List<VersionRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(ReadVersionRow(reader));
        }

        return rows
            .GroupBy(row => row.DefinitionId)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<VisibleProcessVersionDto>)group
                    .Select(row => ToVisibleVersion(row.ToDto()))
                    .ToArray());
    }

    private static string BuildManagementFilters(
        SqlCommand command,
        ProcessDefinitionPageQuery query)
    {
        var filters = new List<string>();
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            filters.Add(
                "([d].[code] LIKE @search ESCAPE N'\\' OR [d].[name] LIKE @search ESCAPE N'\\' OR [d].[description] LIKE @search ESCAPE N'\\' OR EXISTS (SELECT 1 FROM [flowpilot].[workflow_definition_versions] AS [search_version] WHERE [search_version].[id] = [d].[published_version_id] AND JSON_VALUE([search_version].[basic_json], N'$.instancePrefix') LIKE @search ESCAPE N'\\'))");
            command.Parameters.Add("@search", SqlDbType.NVarChar, 204).Value =
                CreateLikePattern(query.Search);
        }

        if (!string.IsNullOrWhiteSpace(query.Type))
        {
            filters.Add("[d].[type] = @type");
            command.Parameters.Add("@type", SqlDbType.NVarChar, 20).Value = query.Type;
        }

        if (!string.IsNullOrWhiteSpace(query.Status))
        {
            filters.Add(
                "CASE WHEN [d].[is_disabled] = 1 THEN N'disabled' WHEN [d].[published_version_id] IS NOT NULL THEN N'published' ELSE N'unpublished' END = @status");
            command.Parameters.Add("@status", SqlDbType.NVarChar, 20).Value = query.Status;
        }

        return filters.Count == 0 ? "1 = 1" : string.Join(" AND ", filters);
    }

    private static ProcessDefinitionDto ReadDefinition(SqlDataReader reader)
    {
        var publishedVersionId = GetNullableGuid(reader, "published_version_id");
        var publishedVersion = GetNullableGuid(reader, "pv_id").HasValue
            ? ReadPublishedVersionRow(reader).ToSummary()
            : null;
        var disabled = reader.GetBoolean(reader.GetOrdinal("definition_is_disabled"));
        return new ProcessDefinitionDto
        {
            Id = reader.GetGuid(reader.GetOrdinal("definition_id")),
            Revision = reader.GetInt32(reader.GetOrdinal("definition_revision")),
            Code = reader.GetString(reader.GetOrdinal("definition_code")),
            Name = reader.GetString(reader.GetOrdinal("definition_name")),
            Description = GetNullableString(reader, "definition_description") ?? string.Empty,
            Type = reader.GetString(reader.GetOrdinal("definition_type")),
            Disabled = disabled,
            Status = disabled ? "disabled" : publishedVersionId.HasValue ? "published" : "unpublished",
            PublishedVersionId = publishedVersionId,
            PublishedVersion = publishedVersion,
            PublishedInstancePrefix = GetNullableString(reader, "published_instance_prefix"),
            NextVersionNumber = reader.GetInt32(reader.GetOrdinal("next_version_number")),
            VersionCount = checked((int)reader.GetInt64(reader.GetOrdinal("version_count"))),
            InstanceCount = reader.GetInt32(reader.GetOrdinal("definition_instance_count")),
            UpdatedAt = AsUtc(reader.GetDateTime(reader.GetOrdinal("definition_updated_at"))),
            UpdatedBy = new ProcessDefinitionUserRefDto(
                reader.GetGuid(reader.GetOrdinal("definition_updated_by_id")),
                reader.GetString(reader.GetOrdinal("definition_updated_by_name"))),
        };
    }

    private static VisibleProcessDefinitionDto ToVisible(
        ProcessDefinitionDto definition,
        IReadOnlyList<VisibleProcessVersionDto> versions) => new()
    {
        Id = definition.Id,
        Code = definition.Code,
        Name = definition.Name,
        Description = definition.Description,
        Type = definition.Type,
        Disabled = definition.Disabled,
        Status = definition.Status,
        PublishedVersionId = definition.PublishedVersionId,
        PublishedInstancePrefix = definition.PublishedInstancePrefix,
        Versions = versions,
    };

    private static VisibleProcessVersionDto ToVisibleVersion(ProcessVersionDto version) => new()
    {
        Id = version.Id,
        DefinitionId = version.DefinitionId,
        VersionNumber = version.VersionNumber,
        VersionLabel = version.VersionLabel,
        Checksum = version.Checksum,
        Basic = version.Basic,
        Snapshot = version.Snapshot,
    };

    private static VersionRow ReadPublishedVersionRow(SqlDataReader reader) => new(
        reader.GetGuid(reader.GetOrdinal("pv_id")),
        reader.GetGuid(reader.GetOrdinal("pv_definition_id")),
        reader.GetString(reader.GetOrdinal("definition_code")),
        reader.GetGuid(reader.GetOrdinal("pv_id")),
        reader.GetInt32(reader.GetOrdinal("pv_revision")),
        reader.GetInt32(reader.GetOrdinal("pv_version_number")),
        reader.GetString(reader.GetOrdinal("pv_version_label")),
        reader.GetInt32(reader.GetOrdinal("pv_instance_count")),
        GetNullableString(reader, "pv_validation_status"),
        GetNullableString(reader, "pv_validation_json"),
        GetNullableDateTime(reader, "pv_validated_at"),
        reader.GetString(reader.GetOrdinal("pv_basic_json")),
        reader.GetString(reader.GetOrdinal("pv_snapshot_json")),
        reader.GetDateTime(reader.GetOrdinal("pv_created_at")),
        ReadUserRef(reader, "pv_created_by_id", "pv_created_by_name"),
        reader.GetDateTime(reader.GetOrdinal("pv_updated_at")),
        ReadUserRef(reader, "pv_updated_by_id", "pv_updated_by_name"),
        GetNullableDateTime(reader, "pv_first_published_at"),
        ReadNullableUserRef(reader, "pv_first_published_by_id", "pv_first_published_by_name"),
        GetNullableDateTime(reader, "pv_latest_published_at"),
        GetNullableString(reader, "pv_change_note"),
        GetNullableDateTime(reader, "pv_unpublished_at"),
        ReadNullableUserRef(reader, "pv_unpublished_by_id", "pv_unpublished_by_name"),
        GetNullableString(reader, "pv_unpublished_reason"));

    private static VersionRow ReadVersionRow(SqlDataReader reader) => new(
        reader.GetGuid(reader.GetOrdinal("version_id")),
        reader.GetGuid(reader.GetOrdinal("version_definition_id")),
        reader.GetString(reader.GetOrdinal("version_definition_code")),
        GetNullableGuid(reader, "definition_published_version_id"),
        reader.GetInt32(reader.GetOrdinal("version_revision")),
        reader.GetInt32(reader.GetOrdinal("version_number")),
        reader.GetString(reader.GetOrdinal("version_label")),
        reader.GetInt32(reader.GetOrdinal("version_instance_count")),
        GetNullableString(reader, "validation_status"),
        GetNullableString(reader, "validation_json"),
        GetNullableDateTime(reader, "validated_at"),
        reader.GetString(reader.GetOrdinal("basic_json")),
        reader.GetString(reader.GetOrdinal("snapshot_json")),
        reader.GetDateTime(reader.GetOrdinal("version_created_at")),
        ReadUserRef(reader, "version_created_by_id", "version_created_by_name"),
        reader.GetDateTime(reader.GetOrdinal("version_updated_at")),
        ReadUserRef(reader, "version_updated_by_id", "version_updated_by_name"),
        GetNullableDateTime(reader, "first_published_at"),
        ReadNullableUserRef(
            reader,
            "version_first_published_by_id",
            "version_first_published_by_name"),
        GetNullableDateTime(reader, "latest_published_at"),
        GetNullableString(reader, "change_note"),
        GetNullableDateTime(reader, "unpublished_at"),
        ReadNullableUserRef(reader, "version_unpublished_by_id", "version_unpublished_by_name"),
        GetNullableString(reader, "unpublished_reason"));

    private static ProcessVersionValidationDto CreateValidation(
        string? status,
        string? validationJson,
        DateTime? validatedAt)
    {
        if (status is null || !validatedAt.HasValue)
        {
            throw new InvalidDataException(
                "A persisted process version must have a completed validation result.");
        }

        var issues = new List<ProcessDefinitionValidationIssueDto>();
        if (!string.IsNullOrWhiteSpace(validationJson))
        {
            using var document = JsonDocument.Parse(validationJson);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("issues", out var issueItems)
                && issueItems.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in issueItems.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String)
                    {
                        issues.Add(new ProcessDefinitionValidationIssueDto(
                            "DESIGNER_VALIDATION",
                            item.GetString() ?? "流程设计校验未通过。"));
                        continue;
                    }

                    if (item.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    var code = GetJsonString(item, "code") ?? "DESIGNER_VALIDATION";
                    var message = GetJsonString(item, "message") ?? code;
                    issues.Add(new ProcessDefinitionValidationIssueDto(
                        code,
                        message,
                        GetJsonString(item, "path")));
                }
            }
        }

        if (!string.Equals(status, "passed", StringComparison.Ordinal) && issues.Count == 0)
        {
            issues.Add(new ProcessDefinitionValidationIssueDto(
                "DESIGNER_VALIDATION",
                "流程版本校验未通过。"));
        }

        return new ProcessVersionValidationDto(
            string.Equals(status, "passed", StringComparison.Ordinal) ? "passed" : "failed",
            AsUtc(validatedAt.Value),
            issues);
    }

    private static string? GetJsonString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static JsonObject ParseObject(string json, string columnName) =>
        JsonNode.Parse(json) as JsonObject
        ?? throw new InvalidDataException($"Database column '{columnName}' must contain a JSON object.");

    private static string CreateChecksum(string basicJson, string snapshotJson)
    {
        var bytes = Encoding.UTF8.GetBytes(string.Concat(basicJson, "\n", snapshotJson));
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    private static ProcessDefinitionUserRefDto ReadUserRef(
        SqlDataReader reader,
        string idName,
        string displayName) => new(
            reader.GetGuid(reader.GetOrdinal(idName)),
            reader.GetString(reader.GetOrdinal(displayName)));

    private static ProcessDefinitionUserRefDto? ReadNullableUserRef(
        SqlDataReader reader,
        string idName,
        string displayName)
    {
        var id = GetNullableGuid(reader, idName);
        var name = GetNullableString(reader, displayName);
        return id.HasValue && name is not null
            ? new ProcessDefinitionUserRefDto(id.Value, name)
            : null;
    }

    private static Guid? GetNullableGuid(SqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal);
    }

    private static string? GetNullableString(SqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static DateTime? GetNullableDateTime(SqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetDateTime(ordinal);
    }

    private static async Task<long> ReadTotalAsync(
        SqlDataReader reader,
        CancellationToken cancellationToken) =>
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? reader.GetInt64(0)
            : 0;

    private static ProcessDefinitionPageMetaDto CreatePageMeta(int page, int pageSize, long total)
    {
        var pages = total == 0 ? 0 : ((total - 1) / pageSize) + 1;
        return new ProcessDefinitionPageMetaDto(
            page,
            pageSize,
            total,
            pages > int.MaxValue ? int.MaxValue : (int)pages);
    }

    private static void AddPagingParameters(SqlCommand command, int page, int pageSize)
    {
        command.Parameters.Add("@offset", SqlDbType.BigInt).Value = ((long)page - 1) * pageSize;
        command.Parameters.Add("@page_size", SqlDbType.Int).Value = pageSize;
    }

    private static void AddActorParameters(SqlCommand command, ProcessDefinitionActor actor)
    {
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = actor.UserId;
        command.Parameters.Add("@is_super_admin", SqlDbType.Bit).Value = actor.IsSuperAdmin;
        command.Parameters.Add("@can_view_all_instances", SqlDbType.Bit).Value =
            actor.CanViewAllInstances;
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

    private static DateTimeOffset AsUtc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private sealed record VersionRow(
        Guid Id,
        Guid DefinitionId,
        string DefinitionCode,
        Guid? PublishedVersionId,
        int Revision,
        int VersionNumber,
        string VersionLabel,
        int InstanceCount,
        string? ValidationStatus,
        string? ValidationJson,
        DateTime? ValidatedAt,
        string BasicJson,
        string SnapshotJson,
        DateTime CreatedAt,
        ProcessDefinitionUserRefDto CreatedBy,
        DateTime UpdatedAt,
        ProcessDefinitionUserRefDto UpdatedBy,
        DateTime? FirstPublishedAt,
        ProcessDefinitionUserRefDto? FirstPublishedBy,
        DateTime? LatestPublishedAt,
        string? ChangeNote,
        DateTime? UnpublishedAt,
        ProcessDefinitionUserRefDto? UnpublishedBy,
        string? UnpublishedReason)
    {
        public ProcessVersionSummaryDto ToSummary() => new()
        {
            Id = Id,
            DefinitionId = DefinitionId,
            Revision = Revision,
            VersionNumber = VersionNumber,
            VersionLabel = VersionLabel,
            InstanceCount = InstanceCount,
            Editable = InstanceCount == 0 && PublishedVersionId != Id,
            Status = PublishedVersionId == Id
                ? "published"
                : string.Equals(ValidationStatus, "passed", StringComparison.Ordinal)
                    ? "publishable"
                    : "validation-failed",
            Validation = CreateValidation(ValidationStatus, ValidationJson, ValidatedAt),
            Checksum = CreateChecksum(BasicJson, SnapshotJson),
            CreatedAt = AsUtc(CreatedAt),
            CreatedBy = CreatedBy,
            UpdatedAt = AsUtc(UpdatedAt),
            UpdatedBy = UpdatedBy,
            FirstPublishedAt = FirstPublishedAt.HasValue ? AsUtc(FirstPublishedAt.Value) : null,
            FirstPublishedBy = FirstPublishedBy,
            PublishedAt = LatestPublishedAt.HasValue ? AsUtc(LatestPublishedAt.Value) : null,
            ChangeNote = ChangeNote,
            LastUnpublishedAt = UnpublishedAt.HasValue ? AsUtc(UnpublishedAt.Value) : null,
            LastUnpublishedBy = UnpublishedBy,
            LastUnpublishReason = UnpublishedReason,
        };

        public ProcessVersionDto ToDto()
        {
            var summary = ToSummary();
            var basic = ParseObject(BasicJson, "basic_json");
            basic["code"] = DefinitionCode;
            return new ProcessVersionDto
            {
                Id = summary.Id,
                DefinitionId = summary.DefinitionId,
                Revision = summary.Revision,
                VersionNumber = summary.VersionNumber,
                VersionLabel = summary.VersionLabel,
                InstanceCount = summary.InstanceCount,
                Editable = summary.Editable,
                Status = summary.Status,
                Validation = summary.Validation,
                Checksum = summary.Checksum,
                CreatedAt = summary.CreatedAt,
                CreatedBy = summary.CreatedBy,
                UpdatedAt = summary.UpdatedAt,
                UpdatedBy = summary.UpdatedBy,
                FirstPublishedAt = summary.FirstPublishedAt,
                FirstPublishedBy = summary.FirstPublishedBy,
                PublishedAt = summary.PublishedAt,
                ChangeNote = summary.ChangeNote,
                LastUnpublishedAt = summary.LastUnpublishedAt,
                LastUnpublishedBy = summary.LastUnpublishedBy,
                LastUnpublishReason = summary.LastUnpublishReason,
                Basic = basic,
                Snapshot = ParseObject(SnapshotJson, "snapshot_json"),
            };
        }
    }
}
