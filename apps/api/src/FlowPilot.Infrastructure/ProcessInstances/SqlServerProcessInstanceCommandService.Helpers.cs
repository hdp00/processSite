using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private static bool TryParseVersion(
        RuntimeWorkflowVersion version,
        out JsonObject? basic,
        out JsonObject? snapshot)
    {
        try
        {
            basic = JsonNode.Parse(version.BasicJson) as JsonObject;
            snapshot = JsonNode.Parse(version.SnapshotJson) as JsonObject;
            return basic is not null && snapshot is not null;
        }
        catch (JsonException)
        {
            basic = null;
            snapshot = null;
            return false;
        }
    }

    private async Task<RuntimeAccess> LoadRuntimeAccessAsync(
        Guid versionId,
        JsonObject basic,
        CancellationToken cancellationToken)
    {
        var references = await _dbContext.RuntimeWorkflowGroupReferences
            .AsNoTracking()
            .Where(item => item.VersionId == versionId)
            .Select(item => new RuntimeGroupReference(item.GroupId, item.Purpose, item.NodeId))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var groupIds = references.Select(item => item.GroupId).Distinct().ToArray();
        var enabledGroupIds = await _dbContext.RuntimeWorkflowGroups
            .AsNoTracking()
            .Where(item => groupIds.Contains(item.Id) && item.IsEnabled)
            .Select(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);

        var directMemberIds = await _dbContext.RuntimeWorkflowGroupUsers
            .AsNoTracking()
            .Where(item => enabledGroupIds.Contains(item.GroupId))
            .Select(item => new { item.GroupId, item.UserId })
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var roleMembers = await (
                from groupRole in _dbContext.RuntimeWorkflowGroupRoles.AsNoTracking()
                join role in _dbContext.RuntimeRoles.AsNoTracking()
                    on groupRole.RoleId equals role.Id
                join userRole in _dbContext.RuntimeUserRoles.AsNoTracking()
                    on role.Id equals userRole.RoleId
                where enabledGroupIds.Contains(groupRole.GroupId) && role.IsEnabled
                select new { groupRole.GroupId, userRole.UserId })
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var memberPairs = directMemberIds
            .Concat(roleMembers)
            .DistinctBy(item => (item.GroupId, item.UserId))
            .ToArray();
        var memberUserIds = memberPairs.Select(item => item.UserId).Distinct().ToArray();
        var users = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(item => memberUserIds.Contains(item.Id) && item.IsEnabled)
            .Select(item => new TaskCenterUserRefDto(item.Id, item.DisplayName))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var usersById = users.ToDictionary(item => item.Id);
        var membersByGroup = memberPairs
            .Where(item => usersById.ContainsKey(item.UserId))
            .GroupBy(item => item.GroupId)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<TaskCenterUserRefDto>)group
                    .Select(item => usersById[item.UserId])
                    .DistinctBy(item => item.Id)
                    .OrderBy(item => item.Name, StringComparer.Ordinal)
                    .ToArray());

        var referencedRoleIds = await _dbContext.RuntimeWorkflowRoleReferences
            .AsNoTracking()
            .Where(item => item.VersionId == versionId)
            .Select(item => item.RoleId)
            .Distinct()
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var enabledReferencedRoleCount = await _dbContext.RuntimeRoles
            .AsNoTracking()
            .CountAsync(item => referencedRoleIds.Contains(item.Id) && item.IsEnabled, cancellationToken)
            .ConfigureAwait(false);
        var visibleUserIds = ReadGuidArray(basic, "visibleUserIds");
        var enabledVisibleUserCount = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .CountAsync(item => visibleUserIds.Contains(item.Id) && item.IsEnabled, cancellationToken)
            .ConfigureAwait(false);
        var visibleRoleIds = ReadGuidArray(basic, "visibleRoleIds");

        var dependenciesReady = references.Length > 0
            && enabledGroupIds.Length == groupIds.Length
            && references.All(reference =>
                membersByGroup.TryGetValue(reference.GroupId, out var members) && members.Count > 0)
            && enabledReferencedRoleCount == referencedRoleIds.Length
            && enabledVisibleUserCount == visibleUserIds.Count;
        return new RuntimeAccess(
            references,
            membersByGroup,
            visibleUserIds,
            visibleRoleIds,
            dependenciesReady);
    }

    private async Task<ProcessInstanceCommandFailure?> ValidateCopySourceAsync(
        CreateProcessInstanceRequest request,
        RuntimeWorkflowDefinition definition,
        ProcessInstanceActor actor,
        RuntimeAccess currentAccess,
        CancellationToken cancellationToken)
    {
        if (request.CopySourceInstanceId is null)
        {
            return null;
        }

        if (!actor.IsSuperAdmin && !actor.CanCopyCompletedInstance)
        {
            return Failure(
                ProcessInstanceCommandError.Forbidden,
                "COPY_SOURCE_FORBIDDEN",
                "不能复制该流程",
                "当前账号没有复制新建权限。");
        }

        var source = await _dbContext.WorkflowInstances
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == request.CopySourceInstanceId, cancellationToken)
            .ConfigureAwait(false);
        if (source is null
            || source.DefinitionId != definition.Id
            || source.Status != "completed"
            || definition.Type != "approval")
        {
            return Failure(
                ProcessInstanceCommandError.Conflict,
                "COPY_SOURCE_INVALID",
                "复制来源不可用",
                "来源必须是同一审批流程中仍然存在的已完成实例。");
        }

        if (actor.IsSuperAdmin || source.InitiatorUserId == actor.EffectiveUserId)
        {
            return null;
        }

        var sourceVersion = await _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .SingleAsync(item => item.Id == source.VersionId, cancellationToken)
            .ConfigureAwait(false);
        if (!TryParseVersion(sourceVersion, out var sourceBasic, out _))
        {
            return Failure(
                ProcessInstanceCommandError.Conflict,
                "COPY_SOURCE_INVALID",
                "复制来源不可用",
                "来源实例的版本配置无法读取。");
        }

        var sourceAccess = source.VersionId == definition.PublishedVersionId
            ? currentAccess
            : await LoadRuntimeAccessAsync(source.VersionId, sourceBasic!, cancellationToken)
                .ConfigureAwait(false);
        if (sourceAccess.ContainsMember(actor.EffectiveUserId)
            || sourceAccess.VisibleUserIds.Contains(actor.EffectiveUserId))
        {
            return null;
        }

        var actorRoleIds = await (
                from userRole in _dbContext.RuntimeUserRoles.AsNoTracking()
                join role in _dbContext.RuntimeRoles.AsNoTracking()
                    on userRole.RoleId equals role.Id
                where userRole.UserId == actor.EffectiveUserId && role.IsEnabled
                select userRole.RoleId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return sourceAccess.VisibleRoleIds.Intersect(actorRoleIds).Any()
            ? null
            : Failure(
                ProcessInstanceCommandError.Forbidden,
                "COPY_SOURCE_FORBIDDEN",
                "不能复制该流程",
                "当前账号已失去来源实例的查看权限。");
    }

    private static FormPreparation NormalizeAndValidateForm(JsonObject input, JsonObject snapshot)
    {
        var fields = ReadFormFields(snapshot);
        var allowedIds = fields
            .Select(field => ReadRequiredString(field, "id"))
            .ToHashSet(StringComparer.Ordinal);
        var issues = input
            .Where(property => !allowedIds.Contains(property.Key))
            .Select(property => Issue(
                $"formValues.{property.Key}",
                "FIELD_NOT_FOUND",
                "字段不属于当前发布版本。"))
            .ToList();
        var values = new JsonObject();
        foreach (var field in fields)
        {
            var fieldId = ReadRequiredString(field, "id");
            var inputStage = ReadString(field, "inputStage") ?? "initiator";
            JsonNode? value = inputStage == "reviewer"
                ? field["defaultValue"]?.DeepClone()
                : input[fieldId]?.DeepClone() ?? field["defaultValue"]?.DeepClone();
            values[fieldId] = value;
        }

        foreach (var field in fields)
        {
            var fieldId = ReadRequiredString(field, "id");
            if (!ConditionMatches(field["displayCondition"] as JsonObject, values))
            {
                values.Remove(fieldId);
                continue;
            }

            if (ReadBool(field, "required") && IsEmpty(values[fieldId]))
            {
                issues.Add(Issue(
                    $"formValues.{fieldId}",
                    "REQUIRED",
                    $"请填写{ReadString(field, "label") ?? fieldId}。"));
            }

            if (ReadString(field, "type") == "table" && values[fieldId] is JsonArray rows)
            {
                ValidateRequiredTableCells(field, rows, issues);
            }
        }

        var title = values["title"] is JsonValue titleValue
            && titleValue.TryGetValue<string>(out var titleText)
                ? titleText.Trim()
                : null;
        if (string.IsNullOrWhiteSpace(title))
        {
            issues.Add(Issue("formValues.title", "REQUIRED", "请填写流程标题。"));
        }
        else if (title.Length > 500)
        {
            issues.Add(Issue("formValues.title", "INVALID_LENGTH", "流程标题不能超过 500 个字符。"));
        }
        else
        {
            values["title"] = title;
        }

        if (issues.Count > 0)
        {
            return new FormPreparation(
                null,
                null,
                Failure(
                    ProcessInstanceCommandError.ValidationFailed,
                    "FORM_VALIDATION_FAILED",
                    "表单校验未通过",
                    "请根据提示补充或修正表单内容。",
                    issues));
        }

        var revisions = new JsonObject(fields.ToDictionary(
            field => ReadRequiredString(field, "id"),
            _ => (JsonNode?)JsonValue.Create(0),
            StringComparer.Ordinal));
        return new FormPreparation(values, revisions, null);
    }

    private static void ValidateRequiredTableCells(
        JsonObject field,
        JsonArray rows,
        List<ProcessInstanceInputIssueDto> issues)
    {
        if (field["columns"] is not JsonArray columns)
        {
            return;
        }

        for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
        {
            if (rows[rowIndex] is not JsonObject row)
            {
                issues.Add(Issue($"formValues.{ReadRequiredString(field, "id")}.{rowIndex}", "INVALID_VALUE", "表格行格式不正确。"));
                continue;
            }

            foreach (var column in columns.OfType<JsonObject>().Where(item => ReadBool(item, "required")))
            {
                var columnId = ReadRequiredString(column, "id");
                if (IsEmpty(row[columnId]))
                {
                    issues.Add(Issue(
                        $"formValues.{ReadRequiredString(field, "id")}.{rowIndex}.{columnId}",
                        "REQUIRED",
                        $"请填写{ReadString(column, "label") ?? columnId}。"));
                }
            }
        }
    }

    private static RuntimePreparation BuildInitialRuntime(
        string workflowType,
        Guid versionId,
        JsonObject snapshot,
        JsonObject formValues,
        CreateProcessInstanceRequest request,
        RuntimeAccess access,
        DateTimeOffset now)
    {
        return workflowType == "free"
            ? BuildFreeRuntime(versionId, request, access, now)
            : BuildApprovalRuntime(versionId, snapshot, formValues, request, access, now);
    }

    private static RuntimePreparation BuildFreeRuntime(
        Guid versionId,
        CreateProcessInstanceRequest request,
        RuntimeAccess access,
        DateTimeOffset now)
    {
        if (request.FirstAssigneeId is null
            || !access.References
                .Where(item => item.Purpose == "review")
                .Any(item => access.IsGroupMember(item.GroupId, request.FirstAssigneeId.Value)))
        {
            return RuntimePreparation.Failed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "FIRST_ASSIGNEE_INVALID",
                "首位受理人无效",
                "请选择当前审批/受理权限组中的有效用户。",
                [Issue("firstAssigneeId", "INVALID_REFERENCE", "首位受理人不在允许的权限组中。")]));
        }

        var assignee = access.User(request.FirstAssigneeId.Value)!;
        var task = new WorkflowTaskEntity
        {
            Id = Guid.NewGuid(),
            TaskType = "free-collaboration",
            VersionId = versionId,
            AssigneeId = assignee.Id,
            Round = 1,
            Status = "pending",
            ActivatedAt = now.UtcDateTime,
            Revision = 1,
        };
        return RuntimePreparation.Succeeded(new RuntimeValue(
            [new RuntimeTask(task, null, null, "approval", [], false, assignee)],
            "in-progress",
            [assignee.Name],
            assignee,
            null,
            assignee,
            Guid.NewGuid(),
            Guid.NewGuid()));
    }

    private static RuntimePreparation BuildApprovalRuntime(
        Guid versionId,
        JsonObject snapshot,
        JsonObject formValues,
        CreateProcessInstanceRequest request,
        RuntimeAccess access,
        DateTimeOffset now)
    {
        var nodes = ReadFlowNodes(snapshot)
            .Where(node => ReadString(node["data"] as JsonObject, "kind") == "approval")
            .Select(node => CreateNodePlan(node))
            .ToArray();
        var issues = new List<ProcessInstanceInputIssueDto>();
        var tasks = new List<RuntimeTask>();
        foreach (var node in nodes)
        {
            TaskCenterUserRefDto? defaultAssignee = null;
            if (node.SpecifyAssignee)
            {
                if (!request.AssigneeByNode.TryGetValue(node.Id, out var assigneeId)
                    || !assigneeId.HasValue
                    || !access.IsGroupMember(node.GroupId, assigneeId.Value))
                {
                    issues.Add(Issue(
                        $"assigneeByNode.{node.Id}",
                        "INVALID_REFERENCE",
                        $"请选择“{node.Name}”权限组中的有效默认责任人。"));
                }
                else
                {
                    defaultAssignee = access.User(assigneeId.Value);
                }
            }

            var entity = new WorkflowTaskEntity
            {
                Id = Guid.NewGuid(),
                TaskType = "approval",
                VersionId = versionId,
                Round = 1,
                Status = "inactive",
                ActivatedAt = now.UtcDateTime,
                Revision = 1,
                NodeId = node.Id,
                NodeNameSnapshot = node.Name,
                GroupId = node.GroupId,
                DefaultAssigneeId = defaultAssignee?.Id,
            };
            tasks.Add(new RuntimeTask(
                entity,
                node.Id,
                node.Name,
                node.HandlingMode,
                node.EditableFieldIds,
                node.AllowRepeatedEditing,
                defaultAssignee,
                node.ActivationCondition));
        }

        if (issues.Count > 0)
        {
            return RuntimePreparation.Failed(Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "ASSIGNEE_VALIDATION_FAILED",
                "默认责任人校验未通过",
                "请重新选择当前有效的默认责任人。",
                issues));
        }

        var edges = ReadFlowEdges(snapshot).ToArray();
        ActivateReadyTasks(tasks, edges, formValues, now);
        var pending = tasks.Where(task => task.Entity.Status == "pending").ToArray();
        var completed = tasks.Count > 0 && tasks.All(task => task.Entity.Status == "skipped");
        return RuntimePreparation.Succeeded(new RuntimeValue(
            tasks,
            completed ? "completed" : "reviewing",
            completed ? ["流程结束"] : pending.Select(task => task.NodeName!).ToArray(),
            null,
            completed ? now : null,
            null,
            null,
            Guid.NewGuid()));
    }

    private static void ActivateReadyTasks(
        IReadOnlyList<RuntimeTask> tasks,
        IReadOnlyList<FlowEdge> edges,
        JsonObject formValues,
        DateTimeOffset now)
    {
        var approvalIds = tasks.Select(task => task.NodeId!).ToHashSet(StringComparer.Ordinal);
        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var task in tasks.Where(item => item.Entity.Status == "inactive"))
            {
                var predecessors = edges
                    .Where(edge => edge.Target == task.NodeId && approvalIds.Contains(edge.Source))
                    .Select(edge => edge.Source)
                    .ToArray();
                var ready = predecessors.All(predecessor => tasks.Any(candidate =>
                    candidate.NodeId == predecessor && candidate.Entity.Status == "skipped"));
                if (!ready)
                {
                    continue;
                }

                changed = true;
                if (ConditionMatches(task.ActivationCondition, formValues))
                {
                    task.Entity.Status = "pending";
                }
                else
                {
                    task.Entity.Status = "skipped";
                    task.Entity.CompletedAt = now.UtcDateTime;
                    task.ConditionSummary = "节点条件不满足";
                    task.ConditionEvaluatedAt = now;
                }
            }
        }
    }

    private sealed record RuntimeGroupReference(Guid GroupId, string Purpose, string? NodeId);

    private sealed record RuntimeAccess(
        IReadOnlyList<RuntimeGroupReference> References,
        IReadOnlyDictionary<Guid, IReadOnlyList<TaskCenterUserRefDto>> MembersByGroup,
        IReadOnlySet<Guid> VisibleUserIds,
        IReadOnlySet<Guid> VisibleRoleIds,
        bool DependenciesReady)
    {
        public bool IsStarter(Guid userId) => References
            .Where(item => item.Purpose == "start")
            .Any(item => IsGroupMember(item.GroupId, userId));

        public bool ContainsMember(Guid userId) => MembersByGroup.Values
            .Any(members => members.Any(user => user.Id == userId));

        public bool IsGroupMember(Guid groupId, Guid userId) =>
            MembersByGroup.TryGetValue(groupId, out var members)
            && members.Any(user => user.Id == userId);

        public TaskCenterUserRefDto? User(Guid userId) => MembersByGroup.Values
            .SelectMany(members => members)
            .FirstOrDefault(user => user.Id == userId);
    }

    private sealed record FormPreparation(
        JsonObject? Values,
        JsonObject? FieldRevisions,
        ProcessInstanceCommandFailure? Failure);

    private sealed record RuntimePreparation(
        RuntimeValue? Value,
        ProcessInstanceCommandFailure? Failure)
    {
        public static RuntimePreparation Succeeded(RuntimeValue value) => new(value, null);
        public static RuntimePreparation Failed(ProcessInstanceCommandFailure failure) => new(null, failure);
    }

    private sealed record RuntimeValue(
        IReadOnlyList<RuntimeTask> TaskPlans,
        string Status,
        IReadOnlyList<string> CurrentNodeNames,
        TaskCenterUserRefDto? CurrentAssignee,
        DateTimeOffset? CompletedAt,
        TaskCenterUserRefDto? FirstAssignee,
        Guid? FreeTimelineId,
        Guid CreatedEventId)
    {
        public IReadOnlyList<WorkflowTaskEntity> Tasks => TaskPlans.Select(item => item.Entity).ToArray();
    }

    private sealed class RuntimeTask(
        WorkflowTaskEntity entity,
        string? nodeId,
        string? nodeName,
        string handlingMode,
        IReadOnlyList<string> editableFieldIds,
        bool allowRepeatedEditing,
        TaskCenterUserRefDto? assignee,
        JsonObject? activationCondition = null)
    {
        public WorkflowTaskEntity Entity { get; } = entity;
        public string? NodeId { get; } = nodeId;
        public string? NodeName { get; } = nodeName;
        public string HandlingMode { get; } = handlingMode;
        public IReadOnlyList<string> EditableFieldIds { get; } = editableFieldIds;
        public bool AllowRepeatedEditing { get; } = allowRepeatedEditing;
        public TaskCenterUserRefDto? Assignee { get; } = assignee;
        public JsonObject? ActivationCondition { get; } = activationCondition;
        public string? ConditionSummary { get; set; }
        public DateTimeOffset? ConditionEvaluatedAt { get; set; }
    }

    private sealed record NodePlan(
        string Id,
        string Name,
        Guid GroupId,
        bool SpecifyAssignee,
        string HandlingMode,
        IReadOnlyList<string> EditableFieldIds,
        bool AllowRepeatedEditing,
        JsonObject? ActivationCondition);

    private sealed record FlowEdge(string Source, string Target);
}
