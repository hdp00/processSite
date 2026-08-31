using System.Globalization;
using System.Linq.Expressions;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using FlowPilot.Application.Exports;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Exports;

public sealed partial class SqlServerProcessInstanceExportService(
    FlowPilotDbContext dbContext,
    TimeProvider timeProvider) : IProcessInstanceExportService
{
    private const int MaximumRows = 10_000;
    private readonly FlowPilotDbContext _dbContext = dbContext;
    private readonly TimeProvider _timeProvider = timeProvider;

    public async Task<ProcessInstanceExportResult> CreateDatasetAsync(
        ProcessInstanceExportFilterDto filter,
        ProcessInstanceExportActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        var definition = await _dbContext.RuntimeWorkflowDefinitions.AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == filter.DefinitionId, cancellationToken)
            .ConfigureAwait(false);
        if (definition?.PublishedVersionId is not Guid publishedVersionId)
        {
            return new(null, ProcessInstanceExportError.DefinitionNotFound);
        }

        var publishedVersion = await _dbContext.RuntimeWorkflowVersions.AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == publishedVersionId, cancellationToken)
            .ConfigureAwait(false);
        if (publishedVersion is null)
        {
            return new(null, ProcessInstanceExportError.DefinitionNotFound);
        }

        var columns = ReadColumns(publishedVersion.SnapshotJson);
        if (columns.Count == 0)
        {
            return new(null, ProcessInstanceExportError.NoColumns);
        }
        var fieldCatalog = await _dbContext.RuntimeVersionFields.AsNoTracking()
            .Where(item => item.VersionId == publishedVersionId && item.TableFieldId == null)
            .ToDictionaryAsync(item => item.FieldId, StringComparer.Ordinal, cancellationToken)
            .ConfigureAwait(false);

        var dateFrom = filter.DateFrom.ToDateTime(TimeOnly.MinValue);
        var dateToExclusive = filter.DateTo.AddDays(1).ToDateTime(TimeOnly.MinValue);
        var source = _dbContext.WorkflowInstances.AsNoTracking()
            .Where(item => item.DefinitionId == filter.DefinitionId
                && item.CreatedAt >= dateFrom
                && item.CreatedAt < dateToExclusive);
        if (!string.IsNullOrWhiteSpace(filter.Status)) source = source.Where(item => item.Status == filter.Status);
        if (filter.InitiatorId.HasValue) source = source.Where(item => item.InitiatorUserId == filter.InitiatorId);

        source = await ApplyVisibilityAsync(source, filter.DefinitionId, actor, cancellationToken).ConfigureAwait(false);
        source = ApplyTextFilters(source, filter);
        source = ApplyDynamicFilters(source, filter.DynamicFilters, fieldCatalog);
        source = ApplySort(source, filter.Sort, fieldCatalog);

        var filteredIds = await source
            .Select(item => item.Id)
            .Take(MaximumRows + 1)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (filteredIds.Length == 0) return new(null, ProcessInstanceExportError.EmptyResult);
        if (filteredIds.Length > MaximumRows) return new(null, ProcessInstanceExportError.RowLimitExceeded);

        var filtered = await source.Take(MaximumRows).ToArrayAsync(cancellationToken).ConfigureAwait(false);

        var users = await LoadUsersAsync(filtered, cancellationToken).ConfigureAwait(false);
        var visibleVersionIds = filtered.Select(item => item.VersionId).Distinct().ToArray();
        var versionLabels = await _dbContext.RuntimeWorkflowVersions.AsNoTracking()
            .Where(item => visibleVersionIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, item => item.VersionLabel, cancellationToken)
            .ConfigureAwait(false);
        var rows = filtered.Select(instance => (IReadOnlyList<object?>)columns
            .Select(column => ReadCell(column, instance, definition, users, versionLabels))
            .ToArray()).ToArray();
        var now = _timeProvider.GetUtcNow();
        var dataset = new ProcessExcelDatasetDto(
            definition.Id,
            definition.Name,
            publishedVersion.Id,
            publishedVersion.VersionLabel,
            now,
            rows.Length,
            columns.Select(item => new ProcessExcelDatasetColumnDto(item.Key, item.Label, item.DataType)).ToArray(),
            rows);

        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "process-definition",
            ResourceId = definition.Id,
            Action = "request-export-data",
            FieldIdentifiersJson = JsonSerializer.Serialize(new { rowCount = rows.Length, columnCount = columns.Count }),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.UserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return new(dataset, null);
    }

    private async Task<IQueryable<WorkflowInstanceEntity>> ApplyVisibilityAsync(
        IQueryable<WorkflowInstanceEntity> source,
        Guid definitionId,
        ProcessInstanceExportActor actor,
        CancellationToken cancellationToken)
    {
        if (actor.CanViewAllInstances) return source;

        var groups = await LoadEffectiveGroupIdsAsync(actor.UserId, cancellationToken).ConfigureAwait(false);
        var versions = await _dbContext.RuntimeWorkflowVersions.AsNoTracking()
            .Where(item => item.DefinitionId == definitionId)
            .Select(item => new { item.Id, item.BasicJson })
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var versionIds = versions.Select(item => item.Id).ToArray();
        var groupVersions = await _dbContext.RuntimeWorkflowGroupReferences.AsNoTracking()
            .Where(item => versionIds.Contains(item.VersionId) && groups.Contains(item.GroupId)
                && (item.Purpose == "start" || item.Purpose == "review" || item.Purpose == "close"))
            .Select(item => item.VersionId).Distinct().ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var roles = await _dbContext.RuntimeUserRoles.AsNoTracking()
            .Where(item => item.UserId == actor.UserId)
            .Join(_dbContext.RuntimeRoles.AsNoTracking().Where(item => item.IsEnabled), item => item.RoleId, role => role.Id, (_, role) => role.Id)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var roleVersions = await _dbContext.RuntimeWorkflowRoleReferences.AsNoTracking()
            .Where(item => versionIds.Contains(item.VersionId) && item.Purpose == "visible" && roles.Contains(item.RoleId))
            .Select(item => item.VersionId).Distinct().ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var explicitlyVisibleVersions = versions
            .Where(item => IsExplicitlyVisible(item.BasicJson, actor.UserId))
            .Select(item => item.Id);
        var visibleVersionIds = groupVersions
            .Concat(roleVersions)
            .Concat(explicitlyVisibleVersions)
            .Distinct()
            .ToArray();

        return source.Where(item =>
            item.InitiatorUserId == actor.UserId
            || item.ActualInitiatorUserId == actor.UserId
            || item.CurrentAssigneeId == actor.UserId
            || _dbContext.FreeParticipants.Any(participant =>
                participant.InstanceId == item.Id && participant.UserId == actor.UserId)
            || _dbContext.WorkflowTasks.Any(task =>
                task.InstanceId == item.Id
                && (task.AssigneeId == actor.UserId
                    || task.DefaultAssigneeId == actor.UserId
                    || task.ActualAssigneeId == actor.UserId))
            || visibleVersionIds.Contains(item.VersionId));
    }

    private async Task<HashSet<Guid>> LoadEffectiveGroupIdsAsync(Guid userId, CancellationToken cancellationToken)
    {
        var direct = await _dbContext.RuntimeWorkflowGroupUsers.AsNoTracking()
            .Where(item => item.UserId == userId)
            .Join(_dbContext.RuntimeWorkflowGroups.AsNoTracking().Where(item => item.IsEnabled), item => item.GroupId, group => group.Id, (_, group) => group.Id)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var inherited = await _dbContext.RuntimeUserRoles.AsNoTracking()
            .Where(item => item.UserId == userId)
            .Join(_dbContext.RuntimeRoles.AsNoTracking().Where(item => item.IsEnabled), item => item.RoleId, role => role.Id, (_, role) => role.Id)
            .Join(_dbContext.RuntimeWorkflowGroupRoles.AsNoTracking(), roleId => roleId, item => item.RoleId, (_, item) => item.GroupId)
            .Join(_dbContext.RuntimeWorkflowGroups.AsNoTracking().Where(item => item.IsEnabled), groupId => groupId, group => group.Id, (_, group) => group.Id)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        return direct.Concat(inherited).ToHashSet();
    }

    private async Task<IReadOnlyDictionary<Guid, UserSnapshot>> LoadUsersAsync(
        IReadOnlyList<WorkflowInstanceEntity> instances,
        CancellationToken cancellationToken)
    {
        var ids = instances.SelectMany(item => new[] { (Guid?)item.InitiatorUserId, item.CurrentAssigneeId })
            .Where(item => item.HasValue).Select(item => item!.Value).Distinct().ToArray();
        var rows = await _dbContext.OrganizationUserReferences.AsNoTracking()
            .Where(item => ids.Contains(item.Id)).ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var departmentIds = rows.Where(item => item.DepartmentId.HasValue).Select(item => item.DepartmentId!.Value).Distinct().ToArray();
        var paths = await _dbContext.Departments.AsNoTracking()
            .Where(item => departmentIds.Contains(item.Id))
            .ToDictionaryAsync(item => item.Id, item => item.Path, cancellationToken).ConfigureAwait(false);
        return rows.ToDictionary(item => item.Id,
            item => new UserSnapshot(item.DisplayName, item.DepartmentId.HasValue ? paths.GetValueOrDefault(item.DepartmentId.Value) : null));
    }

    private IQueryable<WorkflowInstanceEntity> ApplyTextFilters(
        IQueryable<WorkflowInstanceEntity> source,
        ProcessInstanceExportFilterDto filter)
    {
        var search = filter.Q?.Trim();
        var currentNode = filter.CurrentNode?.Trim();
        if (!string.IsNullOrEmpty(search))
        {
            source = source.Where(instance =>
                instance.InstanceNumber.Contains(search)
                || instance.Title.Contains(search)
                || (instance.CurrentNodeSummary != null && instance.CurrentNodeSummary.Contains(search))
                || _dbContext.OrganizationUserReferences.Any(user =>
                    user.Id == instance.InitiatorUserId && user.DisplayName.Contains(search)));
        }

        return string.IsNullOrEmpty(currentNode)
            ? source
            : source.Where(instance => instance.CurrentNodeSummary != null
                && instance.CurrentNodeSummary.Contains(currentNode));
    }

    private IQueryable<WorkflowInstanceEntity> ApplyDynamicFilters(
        IQueryable<WorkflowInstanceEntity> source,
        IReadOnlyDictionary<string, JsonElement>? filters,
        Dictionary<string, RuntimeVersionField> fieldCatalog)
    {
        foreach (var item in filters ?? new Dictionary<string, JsonElement>())
        {
            var text = FilterText(item.Value);
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            if (!fieldCatalog.TryGetValue(item.Key, out var field) || !field.IsQueryable)
            {
                return source.Where(_ => false);
            }

            var fieldId = item.Key;
            if (field.FieldType is "select" or "radio")
            {
                source = source.Where(instance => _dbContext.InstanceFieldValues.Any(value =>
                    value.InstanceId == instance.Id && value.FieldId == fieldId && value.OptionId == text));
            }
            else if (field.FieldType == "number")
            {
                if (!decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out var number))
                {
                    return source.Where(_ => false);
                }

                source = source.Where(instance => _dbContext.InstanceFieldValues.Any(value =>
                    value.InstanceId == instance.Id && value.FieldId == fieldId && value.NumberValue == number));
            }
            else if (field.FieldType is "date" or "datetime")
            {
                if (!DateTime.TryParse(
                    text,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var date))
                {
                    return source.Where(_ => false);
                }

                var end = date.Date.AddDays(1);
                var start = date.Date;
                source = source.Where(instance => _dbContext.InstanceFieldValues.Any(value =>
                    value.InstanceId == instance.Id
                    && value.FieldId == fieldId
                    && value.DatetimeValue >= start
                    && value.DatetimeValue < end));
            }
            else if (field.FieldType == "boolean")
            {
                if (!bool.TryParse(text, out var boolean))
                {
                    return source.Where(_ => false);
                }

                source = source.Where(instance => _dbContext.InstanceFieldValues.Any(value =>
                    value.InstanceId == instance.Id && value.FieldId == fieldId && value.BooleanValue == boolean));
            }
            else
            {
                source = source.Where(instance => _dbContext.InstanceFieldValues.Any(value =>
                    value.InstanceId == instance.Id
                    && value.FieldId == fieldId
                    && value.TextValue != null
                    && value.TextValue.Contains(text)));
            }
        }

        return source;
    }

    private IQueryable<WorkflowInstanceEntity> ApplySort(
        IQueryable<WorkflowInstanceEntity> source,
        IReadOnlyList<ProcessInstanceExportSortDto>? sort,
        Dictionary<string, RuntimeVersionField> fieldCatalog)
    {
        IOrderedQueryable<WorkflowInstanceEntity>? ordered = null;
        foreach (var item in sort ?? [])
        {
            var descending = string.Equals(item.Direction, "desc", StringComparison.OrdinalIgnoreCase);
            switch (item.Field)
            {
                case "code":
                    ordered = Order(source, ordered, row => row.InstanceNumber, descending);
                    break;
                case "status":
                    ordered = Order(source, ordered, row => row.Status, descending);
                    break;
                case "currentNode":
                    ordered = Order(source, ordered, row => row.CurrentNodeSummary, descending);
                    break;
                case "createdAt":
                    ordered = Order(source, ordered, row => row.CreatedAt, descending);
                    break;
                case "updatedAt":
                    ordered = Order(source, ordered, row => row.UpdatedAt, descending);
                    break;
                default:
                    ordered = ApplyDynamicSort(source, ordered, item.Field, descending, fieldCatalog);
                    break;
            }
        }

        return (ordered ?? source.OrderByDescending(item => item.UpdatedAt))
            .ThenByDescending(item => item.Id);
    }

    private IOrderedQueryable<WorkflowInstanceEntity>? ApplyDynamicSort(
        IQueryable<WorkflowInstanceEntity> source,
        IOrderedQueryable<WorkflowInstanceEntity>? ordered,
        string sortField,
        bool descending,
        Dictionary<string, RuntimeVersionField> fieldCatalog)
    {
        if (!sortField.StartsWith("form-", StringComparison.Ordinal)
            || !fieldCatalog.TryGetValue(sortField[5..], out var field))
        {
            return ordered;
        }

        var fieldId = field.FieldId;
        return field.FieldType switch
        {
            "number" => Order(source, ordered, row => _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == row.Id && value.FieldId == fieldId)
                .Select(value => value.NumberValue).FirstOrDefault(), descending),
            "date" or "datetime" => Order(source, ordered, row => _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == row.Id && value.FieldId == fieldId)
                .Select(value => value.DatetimeValue).FirstOrDefault(), descending),
            "boolean" => Order(source, ordered, row => _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == row.Id && value.FieldId == fieldId)
                .Select(value => value.BooleanValue).FirstOrDefault(), descending),
            _ => Order(source, ordered, row => _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == row.Id && value.FieldId == fieldId)
                .Select(value => value.TextValue ?? value.OptionId).FirstOrDefault(), descending),
        };
    }

    private static IOrderedQueryable<WorkflowInstanceEntity> Order<TKey>(
        IQueryable<WorkflowInstanceEntity> source,
        IOrderedQueryable<WorkflowInstanceEntity>? ordered,
        Expression<Func<WorkflowInstanceEntity, TKey>> selector,
        bool descending) => ordered is null
            ? descending ? source.OrderByDescending(selector) : source.OrderBy(selector)
            : descending ? ordered.ThenByDescending(selector) : ordered.ThenBy(selector);

    private static string? FilterText(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.String => value.GetString()?.Trim(),
        _ => value.GetRawText().Trim(),
    };

    private static List<ExportColumn> ReadColumns(string snapshotJson)
    {
        var snapshot = ParseObject(snapshotJson);
        var result = new List<ExportColumn>();
        foreach (var field in (snapshot["systemFields"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (!ReadBoolean(field, "exportVisible") && !ReadBoolean(field, "processListVisible")) continue;
            var key = ReadText(field, "key");
            if (key is not null) result.Add(new($"system-{key}", ReadText(field, "label") ?? key, key is "createdAt" or "updatedAt" ? "date" : "text", key, true));
        }
        foreach (var field in (snapshot["form"]?["fields"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (!ReadBoolean(field, "exportVisible") && (field.ContainsKey("exportVisible") || !ReadBoolean(field, "listVisible"))) continue;
            var id = ReadText(field, "id");
            if (id is not null) result.Add(new(
                $"form-{id}",
                ReadText(field, "label") ?? id,
                "text",
                id,
                false,
                ReadOptionLabels(field)));
        }
        return result;
    }

    private static object? ReadCell(
        ExportColumn column,
        WorkflowInstanceEntity instance,
        RuntimeWorkflowDefinition definition,
        IReadOnlyDictionary<Guid, UserSnapshot> users,
        IReadOnlyDictionary<Guid, string> versionLabels)
    {
        if (!column.IsSystem) return ReadScalar(ParseObject(instance.FormValuesJson)[column.SourceKey], column.OptionLabels);
        return column.SourceKey switch
        {
            "code" => instance.InstanceNumber,
            "template" => definition.Name,
            "templateVersion" => versionLabels.GetValueOrDefault(instance.VersionId),
            "status" => TranslateStatus(instance.Status),
            "currentNode" => instance.CurrentNodeSummary,
            "round" => $"第 {instance.CurrentRound} 轮",
            "initiator" => FormatInitiator(users.GetValueOrDefault(instance.InitiatorUserId)),
            "createdAt" => DateTime.SpecifyKind(instance.CreatedAt, DateTimeKind.Utc).ToString("O", CultureInfo.InvariantCulture),
            "updatedAt" => DateTime.SpecifyKind(instance.UpdatedAt, DateTimeKind.Utc).ToString("O", CultureInfo.InvariantCulture),
            _ => null,
        };
    }

    private static bool IsExplicitlyVisible(string? basicJson, Guid userId) =>
        !string.IsNullOrWhiteSpace(basicJson)
        && ParseObject(basicJson)["visibleUserIds"] is JsonArray values
        && values.Any(item => Guid.TryParse(item?.GetValue<string>(), out var id) && id == userId);

    private static object? ReadScalar(JsonNode? value, IReadOnlyDictionary<string, string>? optionLabels = null)
    {
        if (value is null) return null;
        if (value is JsonValue scalar)
        {
            if (scalar.TryGetValue<bool>(out var boolean)) return boolean;
            if (scalar.TryGetValue<decimal>(out var number)) return number;
            if (scalar.TryGetValue<string>(out var text))
            {
                return optionLabels?.GetValueOrDefault(text) ?? StripHtml(text);
            }
        }
        if (value is JsonArray array) return string.Join("、", array.Select(item => ReadScalar(item, optionLabels)).Where(item => item is not null));
        return value.ToJsonString();
    }

    private static Dictionary<string, string>? ReadOptionLabels(JsonObject field)
    {
        var type = ReadText(field, "type");
        if (type is not ("select" or "radio" or "checkbox" or "cascader")) return null;
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);
        AddOptionLabels(field["options"] as JsonArray, labels);
        return labels;
    }

    private static void AddOptionLabels(JsonArray? options, Dictionary<string, string> labels)
    {
        foreach (var option in options?.OfType<JsonObject>() ?? [])
        {
            var id = ReadText(option, "id") ?? ReadText(option, "value");
            var label = ReadText(option, "label") ?? ReadText(option, "name");
            if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(label)) labels[id] = label;
            AddOptionLabels(option["children"] as JsonArray, labels);
        }
    }

    private static JsonObject ParseObject(string json)
    {
        try { return JsonNode.Parse(json) as JsonObject ?? new JsonObject(); }
        catch (JsonException) { return new JsonObject(); }
    }

    private static string? ReadText(JsonObject source, string key) => source[key]?.GetValue<string>();
    private static bool ReadBoolean(JsonObject source, string key) => source[key]?.GetValue<bool>() == true;
    private static string StripHtml(string value) => HtmlTagRegex().Replace(value, " ").Trim();
    private static string? FormatInitiator(UserSnapshot? user) => user is null ? null : string.IsNullOrWhiteSpace(user.DepartmentPath) ? user.Name : $"{user.Name}（{user.DepartmentPath}）";
    private static string TranslateStatus(string value) => value switch
    {
        "reviewing" => "审核中",
        "rejected-pending" => "驳回待处理",
        "in-progress" => "进行中",
        "completed" => "已完成",
        "closed" => "已关闭",
        _ => value,
    };

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex HtmlTagRegex();

    private sealed record ExportColumn(
        string Key,
        string Label,
        string DataType,
        string SourceKey,
        bool IsSystem,
        IReadOnlyDictionary<string, string>? OptionLabels = null);
    private sealed record UserSnapshot(string Name, string? DepartmentPath);
}
