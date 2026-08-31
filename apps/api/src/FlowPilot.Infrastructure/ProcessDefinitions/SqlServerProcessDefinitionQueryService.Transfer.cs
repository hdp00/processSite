using System.Data;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionQueryService
{
    public async Task<JsonObject?> ExportAsync(
        Guid definitionId,
        CancellationToken cancellationToken = default)
    {
        var definition = await GetAsync(definitionId, cancellationToken).ConfigureAwait(false);
        if (definition is null) return null;

        var summaries = await ListVersionsAsync(definitionId, cancellationToken).ConfigureAwait(false)
            ?? [];
        var versions = new List<Application.ProcessDefinitions.ProcessVersionDto>(summaries.Count);
        foreach (var summary in summaries)
        {
            var version = await GetVersionAsync(definitionId, summary.Id, cancellationToken)
                .ConfigureAwait(false);
            if (version is not null) versions.Add(version);
        }

        var references = await LoadTransferReferenceNamesAsync(cancellationToken).ConfigureAwait(false);
        return ProcessDefinitionTransferMapper.Export(
            definition,
            versions,
            references,
            _timeProvider.GetUtcNow());
    }

    private async Task<ProcessDefinitionTransferMapper.ReferenceNames> LoadTransferReferenceNamesAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = CreateCommand(connection);
        command.CommandText =
            """
            SELECT [id], [name]
            FROM [flowpilot].[workflow_permission_groups]
            ORDER BY [name], [id];

            SELECT [id], [name]
            FROM [flowpilot].[roles]
            WHERE [is_builtin] = 0
            ORDER BY [name], [id];

            SELECT [id], [display_name]
            FROM [flowpilot].[users]
            WHERE [is_builtin_super_admin] = 0
            ORDER BY [display_name], [id];
            """;
        var groups = new Dictionary<Guid, string>();
        var roles = new Dictionary<Guid, string>();
        var users = new Dictionary<Guid, string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        await ReadNamesAsync(reader, groups, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        await ReadNamesAsync(reader, roles, cancellationToken).ConfigureAwait(false);
        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        await ReadNamesAsync(reader, users, cancellationToken).ConfigureAwait(false);
        return new ProcessDefinitionTransferMapper.ReferenceNames(groups, roles, users);
    }

    private static async Task ReadNamesAsync(
        SqlDataReader reader,
        Dictionary<Guid, string> target,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            target[reader.GetGuid(0)] = reader.GetString(1);
        }
    }
}
