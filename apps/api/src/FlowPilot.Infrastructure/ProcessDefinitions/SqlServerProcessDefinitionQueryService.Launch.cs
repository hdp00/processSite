using System.Data;
using FlowPilot.Application.ProcessDefinitions;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionQueryService
{
    private const string PublishedVersionReadyPredicate =
        """
        [pv].[validation_status] = N'passed'
        AND NOT EXISTS
        (
            SELECT 1
            FROM [flowpilot].[workflow_version_group_refs] AS [required_group_ref]
            INNER JOIN [flowpilot].[workflow_permission_groups] AS [required_group]
                ON [required_group].[id] = [required_group_ref].[group_id]
            WHERE [required_group_ref].[version_id] = [pv].[id]
              AND
              (
                  [required_group].[is_enabled] = 0
                  OR NOT EXISTS
                  (
                      SELECT 1
                      FROM [flowpilot].[users] AS [effective_user]
                      WHERE [effective_user].[is_enabled] = 1
                        AND
                        (
                            EXISTS
                            (
                                SELECT 1
                                FROM [flowpilot].[workflow_group_users] AS [direct_member]
                                WHERE [direct_member].[group_id] = [required_group].[id]
                                  AND [direct_member].[user_id] = [effective_user].[id]
                            )
                            OR EXISTS
                            (
                                SELECT 1
                                FROM [flowpilot].[workflow_group_roles] AS [group_role]
                                INNER JOIN [flowpilot].[roles] AS [effective_role]
                                    ON [effective_role].[id] = [group_role].[role_id]
                                   AND [effective_role].[is_enabled] = 1
                                INNER JOIN [flowpilot].[user_roles] AS [role_member]
                                    ON [role_member].[role_id] = [effective_role].[id]
                                   AND [role_member].[user_id] = [effective_user].[id]
                                WHERE [group_role].[group_id] = [required_group].[id]
                            )
                        )
                  )
              )
        )
        AND NOT EXISTS
        (
            SELECT 1
            FROM [flowpilot].[workflow_version_role_refs] AS [required_role_ref]
            INNER JOIN [flowpilot].[roles] AS [required_role]
                ON [required_role].[id] = [required_role_ref].[role_id]
            WHERE [required_role_ref].[version_id] = [pv].[id]
              AND [required_role].[is_enabled] = 0
        )
        AND NOT EXISTS
        (
            SELECT 1
            FROM OPENJSON([pv].[basic_json], N'$.visibleUserIds') AS [visible_user]
            LEFT JOIN [flowpilot].[users] AS [required_user]
                ON [required_user].[id] = TRY_CONVERT(uniqueidentifier, [visible_user].[value])
            WHERE [required_user].[id] IS NULL
               OR [required_user].[is_enabled] = 0
        )
        """;

    public async Task<IReadOnlyList<LaunchableProcessDefinitionDto>> ListLaunchableAsync(
        ProcessDefinitionActor actor,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);

        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            $"""
            {EffectiveGroupsCte}
            SELECT DISTINCT
                [d].[id] AS [definition_id],
                [d].[code],
                [d].[name],
                [d].[type],
                [pv].[id] AS [version_id],
                [pv].[version_label],
                [d].[description],
                [starter_group].[id] AS [starter_group_id],
                [starter_group].[name] AS [starter_group_name]
            FROM [flowpilot].[workflow_definitions] AS [d]
            INNER JOIN [flowpilot].[workflow_definition_versions] AS [pv]
                ON [pv].[id] = [d].[published_version_id]
               AND [pv].[definition_id] = [d].[id]
            INNER JOIN [flowpilot].[workflow_version_group_refs] AS [starter_ref]
                ON [starter_ref].[version_id] = [pv].[id]
               AND [starter_ref].[purpose] = N'start'
            INNER JOIN [flowpilot].[workflow_permission_groups] AS [starter_group]
                ON [starter_group].[id] = [starter_ref].[group_id]
            WHERE [d].[is_disabled] = 0
              AND {PublishedVersionReadyPredicate}
              AND
              (
                  @is_super_admin = 1
                  OR EXISTS
                  (
                      SELECT 1
                      FROM [flowpilot].[workflow_version_group_refs] AS [launch_ref]
                      INNER JOIN [effective_groups] AS [launch_group]
                          ON [launch_group].[group_id] = [launch_ref].[group_id]
                      WHERE [launch_ref].[version_id] = [pv].[id]
                        AND [launch_ref].[purpose] = N'start'
                  )
              )
            ORDER BY [d].[name], [d].[id], [starter_group].[name], [starter_group].[id];
            """;
        AddLaunchActorParameters(command, actor);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var rows = new List<LaunchableRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new LaunchableRow(
                reader.GetGuid(reader.GetOrdinal("definition_id")),
                reader.GetString(reader.GetOrdinal("code")),
                reader.GetString(reader.GetOrdinal("name")),
                reader.GetString(reader.GetOrdinal("type")),
                reader.GetGuid(reader.GetOrdinal("version_id")),
                reader.GetString(reader.GetOrdinal("version_label")),
                GetNullableString(reader, "description") ?? string.Empty,
                new ProcessDefinitionGroupRefDto(
                    reader.GetGuid(reader.GetOrdinal("starter_group_id")),
                    reader.GetString(reader.GetOrdinal("starter_group_name")))));
        }

        return rows
            .GroupBy(row => row.DefinitionId)
            .Select(group =>
            {
                var first = group.First();
                return new LaunchableProcessDefinitionDto(
                    first.DefinitionId,
                    first.Code,
                    first.Name,
                    first.Type,
                    first.VersionId,
                    first.VersionLabel,
                    first.Description,
                    group.Select(row => row.StarterGroup).DistinctBy(item => item.Id).ToArray());
            })
            .ToArray();
    }

    public async Task<ProcessLaunchConfigResult> GetLaunchConfigAsync(
        Guid definitionId,
        ProcessDefinitionActor actor,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);

        var definition = await GetAsync(definitionId, cancellationToken).ConfigureAwait(false);
        if (definition is null)
        {
            return new ProcessLaunchConfigResult(null, ProcessLaunchConfigError.NotFound);
        }

        if (definition.Disabled || definition.PublishedVersionId is null)
        {
            return new ProcessLaunchConfigResult(null, ProcessLaunchConfigError.NotLaunchable);
        }

        var version = await GetVersionAsync(
            definitionId,
            definition.PublishedVersionId.Value,
            cancellationToken).ConfigureAwait(false);
        if (version is null || !string.Equals(version.Validation.Status, "passed", StringComparison.Ordinal))
        {
            return new ProcessLaunchConfigResult(null, ProcessLaunchConfigError.NotLaunchable);
        }

        var access = await LoadLaunchAccessAsync(version.Id, actor, cancellationToken)
            .ConfigureAwait(false);
        if (!access.DependenciesReady)
        {
            return new ProcessLaunchConfigResult(null, ProcessLaunchConfigError.NotLaunchable);
        }

        if (!actor.IsSuperAdmin && !access.CanLaunch)
        {
            return new ProcessLaunchConfigResult(null, ProcessLaunchConfigError.Forbidden);
        }

        var candidatesByNode = access.GroupReferences
            .Where(reference => reference.Purpose == "review" && reference.NodeId is not null)
            .GroupBy(reference => reference.NodeId!, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<ProcessDefinitionUserRefDto>)group
                    .SelectMany(reference => access.MembersByGroup.GetValueOrDefault(reference.GroupId) ?? [])
                    .DistinctBy(user => user.Id)
                    .OrderBy(user => user.Name, StringComparer.Ordinal)
                    .ToArray(),
                StringComparer.Ordinal);
        var firstAssigneeCandidates = string.Equals(definition.Type, "free", StringComparison.Ordinal)
            ? access.GroupReferences
                .Where(reference => reference.Purpose == "review")
                .SelectMany(reference => access.MembersByGroup.GetValueOrDefault(reference.GroupId) ?? [])
                .DistinctBy(user => user.Id)
                .OrderBy(user => user.Name, StringComparer.Ordinal)
                .ToArray()
            : [];

        return new ProcessLaunchConfigResult(
            new ProcessLaunchConfigDto(
                definition,
                version,
                candidatesByNode,
                firstAssigneeCandidates),
            null);
    }

    private async Task<LaunchAccess> LoadLaunchAccessAsync(
        Guid versionId,
        ProcessDefinitionActor actor,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            SELECT
                [reference].[group_id],
                [reference].[purpose],
                [reference].[node_id],
                [group].[is_enabled]
            FROM [flowpilot].[workflow_version_group_refs] AS [reference]
            INNER JOIN [flowpilot].[workflow_permission_groups] AS [group]
                ON [group].[id] = [reference].[group_id]
            WHERE [reference].[version_id] = @version_id;

            WITH [referenced_groups] AS
            (
                SELECT DISTINCT [group_id]
                FROM [flowpilot].[workflow_version_group_refs]
                WHERE [version_id] = @version_id
            )
            SELECT DISTINCT
                [referenced_group].[group_id],
                [user].[id],
                [user].[display_name]
            FROM [referenced_groups] AS [referenced_group]
            INNER JOIN [flowpilot].[users] AS [user]
                ON [user].[is_enabled] = 1
               AND
               (
                   EXISTS
                   (
                       SELECT 1
                       FROM [flowpilot].[workflow_group_users] AS [direct_member]
                       WHERE [direct_member].[group_id] = [referenced_group].[group_id]
                         AND [direct_member].[user_id] = [user].[id]
                   )
                   OR EXISTS
                   (
                       SELECT 1
                       FROM [flowpilot].[workflow_group_roles] AS [group_role]
                       INNER JOIN [flowpilot].[roles] AS [role]
                           ON [role].[id] = [group_role].[role_id]
                          AND [role].[is_enabled] = 1
                       INNER JOIN [flowpilot].[user_roles] AS [role_member]
                           ON [role_member].[role_id] = [role].[id]
                          AND [role_member].[user_id] = [user].[id]
                       WHERE [group_role].[group_id] = [referenced_group].[group_id]
                   )
               );

            SELECT CASE WHEN
                NOT EXISTS
                (
                    SELECT 1
                    FROM [flowpilot].[workflow_version_role_refs] AS [role_ref]
                    INNER JOIN [flowpilot].[roles] AS [role]
                        ON [role].[id] = [role_ref].[role_id]
                    WHERE [role_ref].[version_id] = @version_id
                      AND [role].[is_enabled] = 0
                )
                AND NOT EXISTS
                (
                    SELECT 1
                    FROM [flowpilot].[workflow_definition_versions] AS [version]
                    CROSS APPLY OPENJSON([version].[basic_json], N'$.visibleUserIds') AS [visible_user]
                    LEFT JOIN [flowpilot].[users] AS [user]
                        ON [user].[id] = TRY_CONVERT(uniqueidentifier, [visible_user].[value])
                    WHERE [version].[id] = @version_id
                      AND ([user].[id] IS NULL OR [user].[is_enabled] = 0)
                )
                THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END;
            """;
        command.Parameters.Add("@version_id", SqlDbType.UniqueIdentifier).Value = versionId;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var references = new List<LaunchGroupReference>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            references.Add(new LaunchGroupReference(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.GetBoolean(3)));
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        var membersByGroup = new Dictionary<Guid, List<ProcessDefinitionUserRefDto>>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var groupId = reader.GetGuid(0);
            if (!membersByGroup.TryGetValue(groupId, out var members))
            {
                members = [];
                membersByGroup[groupId] = members;
            }

            members.Add(new ProcessDefinitionUserRefDto(reader.GetGuid(1), reader.GetString(2)));
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        var sharedDependenciesReady = await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            && reader.GetBoolean(0);
        var readonlyMembers = membersByGroup.ToDictionary(
            pair => pair.Key,
            pair => (IReadOnlyList<ProcessDefinitionUserRefDto>)pair.Value);
        var dependenciesReady = sharedDependenciesReady
            && references.Count > 0
            && references.All(reference =>
                reference.Enabled
                && readonlyMembers.TryGetValue(reference.GroupId, out var members)
                && members.Count > 0);
        var canLaunch = references
            .Where(reference => reference.Purpose == "start")
            .Any(reference =>
                readonlyMembers.TryGetValue(reference.GroupId, out var members)
                && members.Any(user => user.Id == actor.UserId));

        return new LaunchAccess(references, readonlyMembers, dependenciesReady, canLaunch);
    }

    private static void AddLaunchActorParameters(SqlCommand command, ProcessDefinitionActor actor)
    {
        command.Parameters.Add("@user_id", SqlDbType.UniqueIdentifier).Value = actor.UserId;
        command.Parameters.Add("@is_super_admin", SqlDbType.Bit).Value = actor.IsSuperAdmin;
    }

    private sealed record LaunchableRow(
        Guid DefinitionId,
        string Code,
        string Name,
        string Type,
        Guid VersionId,
        string VersionLabel,
        string Description,
        ProcessDefinitionGroupRefDto StarterGroup);

    private sealed record LaunchGroupReference(
        Guid GroupId,
        string Purpose,
        string? NodeId,
        bool Enabled);

    private sealed record LaunchAccess(
        IReadOnlyList<LaunchGroupReference> GroupReferences,
        IReadOnlyDictionary<Guid, IReadOnlyList<ProcessDefinitionUserRefDto>> MembersByGroup,
        bool DependenciesReady,
        bool CanLaunch);
}
