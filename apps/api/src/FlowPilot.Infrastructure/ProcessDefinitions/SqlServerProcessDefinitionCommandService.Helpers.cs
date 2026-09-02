using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessDefinitions;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionCommandService
{
    private static JsonObject CreateDefaultSnapshot(
        ProcessBasicConfigInput basic,
        DateTimeOffset now)
    {
        var nodes = new JsonArray();
        var edges = new JsonArray();
        if (string.Equals(basic.Type, "approval", StringComparison.Ordinal))
        {
            nodes.Add(CreateFlowNode(
                "start",
                "start",
                "开始",
                80,
                120,
                new JsonObject
                {
                    ["permissionGroupIds"] = GuidArray(basic.StarterGroupIds),
                }));
            nodes.Add(CreateFlowNode("approval-1", "approval", "审批节点", 320, 120));
            nodes.Add(CreateFlowNode("end", "end", "结束", 560, 120));
            edges.Add(new JsonObject
            {
                ["id"] = "edge-start-approval-1",
                ["source"] = "start",
                ["target"] = "approval-1",
            });
            edges.Add(new JsonObject
            {
                ["id"] = "edge-approval-1-end",
                ["source"] = "approval-1",
                ["target"] = "end",
            });
        }

        return new JsonObject
        {
            ["form"] = new JsonObject
            {
                ["fields"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["id"] = "title",
                        ["type"] = "text",
                        ["label"] = "标题",
                        ["description"] = string.Empty,
                        ["placeholder"] = string.Empty,
                        ["required"] = true,
                        ["defaultValue"] = string.Empty,
                        ["listVisible"] = true,
                        ["taskVisible"] = true,
                        ["queryable"] = true,
                        ["exportVisible"] = true,
                        ["inputStage"] = "initiator",
                    },
                },
                ["savedAt"] = JsonValue.Create(now),
            },
            ["flow"] = new JsonObject
            {
                ["nodes"] = nodes,
                ["edges"] = edges,
                ["savedAt"] = JsonValue.Create(now),
                ["meta"] = new JsonObject
                {
                    ["rejectionHandling"] = "resubmit-or-close",
                },
            },
            ["systemFields"] = CreateDefaultSystemFields(),
        };
    }

    private static JsonObject CreateFlowNode(
        string id,
        string kind,
        string label,
        double x,
        double y,
        JsonObject? extraData = null)
    {
        var data = new JsonObject
        {
            ["kind"] = kind,
            ["label"] = label,
            ["specifyAssignee"] = false,
            ["editableFieldIds"] = new JsonArray(),
            ["handlingMode"] = "approval",
            ["allowRepeatedEditing"] = false,
        };
        if (extraData is not null)
        {
            foreach (var property in extraData)
            {
                data[property.Key] = property.Value?.DeepClone();
            }
        }

        return new JsonObject
        {
            ["id"] = id,
            ["position"] = new JsonObject { ["x"] = x, ["y"] = y },
            ["data"] = data,
        };
    }

    private static JsonArray CreateDefaultSystemFields()
    {
        var fields = new JsonArray();
        AddSystemField(fields, "instanceCode", "实例编号", true, true, true);
        AddSystemField(fields, "processName", "流程名称", false, false, false);
        AddSystemField(fields, "processVersion", "版本", false, false, false);
        AddSystemField(fields, "status", "状态", true, true, true);
        AddSystemField(fields, "currentNode", "当前节点", true, true, true);
        AddSystemField(fields, "currentRound", "当前轮次", false, false, false);
        AddSystemField(fields, "initiator", "发起人", true, true, true);
        AddSystemField(fields, "createdAt", "发起时间", true, true, true);
        AddSystemField(fields, "updatedAt", "更新时间", false, false, false);
        return fields;
    }

    private static void AddSystemField(
        JsonArray fields,
        string key,
        string label,
        bool taskVisible,
        bool processListVisible,
        bool exportVisible) => fields.Add(new JsonObject
        {
            ["key"] = key,
            ["label"] = label,
            ["taskVisible"] = taskVisible,
            ["processListVisible"] = processListVisible,
            ["exportVisible"] = exportVisible,
        });

    private static JsonObject CreateBasicNode(ProcessBasicConfigInput basic) => new()
    {
        ["name"] = basic.Name,
        ["instancePrefix"] = basic.InstancePrefix,
        ["type"] = basic.Type,
        ["description"] = basic.Description,
        ["starterGroupIds"] = GuidArray(basic.StarterGroupIds),
        ["assigneeGroupIds"] = GuidArray(basic.AssigneeGroupIds),
        ["closeGroupIds"] = GuidArray(basic.CloseGroupIds),
        ["emailNotificationEnabled"] = basic.EmailNotificationEnabled,
        ["visibleRoleIds"] = GuidArray(basic.VisibleRoleIds),
        ["visibleUserIds"] = GuidArray(basic.VisibleUserIds),
    };

    private static JsonArray GuidArray(IEnumerable<Guid> values) =>
        new(values.Select(value => (JsonNode?)JsonValue.Create(value.ToString("D"))).ToArray());

    private static ProcessBasicConfigInput ParseBasic(string json)
    {
        var source = ParseObject(json, "basic_json");
        return new ProcessBasicConfigInput
        {
            Name = StringValue(source, "name") ?? string.Empty,
            InstancePrefix = StringValue(source, "instancePrefix") ?? string.Empty,
            Type = StringValue(source, "type") ?? string.Empty,
            Description = StringValue(source, "description") ?? string.Empty,
            StarterGroupIds = ReadGuidArray(source, "starterGroupIds"),
            AssigneeGroupIds = ReadGuidArray(source, "assigneeGroupIds"),
            CloseGroupIds = ReadGuidArray(source, "closeGroupIds"),
            EmailNotificationEnabled = source["emailNotificationEnabled"]?.GetValue<bool>() ?? true,
            VisibleRoleIds = ReadGuidArray(source, "visibleRoleIds"),
            VisibleUserIds = ReadGuidArray(source, "visibleUserIds"),
        };
    }

    private static Guid[] ReadGuidArray(JsonObject source, string propertyName) =>
        source[propertyName] is JsonArray values
            ? values
                .Select(value => value is JsonValue item && item.TryGetValue<string>(out var text)
                    && Guid.TryParse(text, out var id)
                        ? id
                        : Guid.Empty)
                .Where(value => value != Guid.Empty)
                .ToArray()
            : [];

    private static ProcessVersionValidationDto ValidateVersion(
        ProcessBasicConfigInput basic,
        JsonObject snapshot,
        ReferenceCatalog catalog,
        DateTimeOffset checkedAt)
    {
        var issues = new List<ProcessDefinitionValidationIssueDto>();
        ValidateGroupReadiness(basic.StarterGroupIds, "start", "basic.starterGroupIds", catalog, issues);
        ValidateGroupReadiness(basic.CloseGroupIds, "close", "basic.closeGroupIds", catalog, issues);

        foreach (var roleId in basic.VisibleRoleIds)
        {
            if (!catalog.Roles.TryGetValue(roleId, out var role))
            {
                AddValidationIssue(issues, "ROLE_NOT_FOUND", $"角色 {roleId:D} 不存在。", "basic.visibleRoleIds");
            }
            else if (!role.IsEnabled)
            {
                AddValidationIssue(issues, "ROLE_DISABLED", $"角色“{role.Name}”已停用。", "basic.visibleRoleIds");
            }
        }

        foreach (var userId in basic.VisibleUserIds)
        {
            if (!catalog.Users.TryGetValue(userId, out var user))
            {
                AddValidationIssue(issues, "USER_NOT_FOUND", $"用户 {userId:D} 不存在。", "basic.visibleUserIds");
            }
            else if (!user.IsEnabled)
            {
                AddValidationIssue(issues, "USER_DISABLED", $"用户“{user.Name}”已停用。", "basic.visibleUserIds");
            }
        }

        var fields = FormFields(snapshot).ToArray();
        ValidateForm(fields, issues);
        ValidateSystemFields(snapshot, issues);
        if (string.Equals(basic.Type, "free", StringComparison.Ordinal))
        {
            ValidateGroupReadiness(basic.AssigneeGroupIds, "review", "basic.assigneeGroupIds", catalog, issues);
        }
        else
        {
            ValidateApprovalFlow(snapshot, fields, catalog, issues);
        }

        return new ProcessVersionValidationDto(
            issues.Count == 0 ? "passed" : "failed",
            checkedAt,
            issues);
    }

    private static void ValidateGroupReadiness(
        IEnumerable<Guid> groupIds,
        string purpose,
        string path,
        ReferenceCatalog catalog,
        List<ProcessDefinitionValidationIssueDto> issues)
    {
        foreach (var groupId in groupIds)
        {
            if (!catalog.Groups.TryGetValue(groupId, out var group))
            {
                AddValidationIssue(issues, "GROUP_NOT_FOUND", $"流程权限组 {groupId:D} 不存在。", path);
                continue;
            }

            if (!group.Purposes.Contains(purpose))
            {
                AddValidationIssue(issues, "GROUP_PURPOSE_MISMATCH", $"流程权限组“{group.Name}”用途不匹配。", path);
            }

            if (!group.IsEnabled)
            {
                AddValidationIssue(issues, "GROUP_DISABLED", $"流程权限组“{group.Name}”已停用。", path);
            }
            else if (!group.HasEffectiveMembers)
            {
                AddValidationIssue(issues, "GROUP_HAS_NO_EFFECTIVE_MEMBERS", $"流程权限组“{group.Name}”没有有效成员。", path);
            }
        }
    }

    private static void ValidateForm(
        JsonObject[] fields,
        List<ProcessDefinitionValidationIssueDto> issues)
    {
        var title = fields.FirstOrDefault(field => string.Equals(StringValue(field, "id"), "title", StringComparison.Ordinal));
        if (title is null || !string.Equals(StringValue(title, "type"), "text", StringComparison.Ordinal))
        {
            AddValidationIssue(issues, "TITLE_FIELD_REQUIRED", "初始表单必须包含固定的标题文本框。", "snapshot.form.fields");
        }
        else
        {
            if (!BoolValue(title, "required"))
            {
                AddValidationIssue(issues, "TITLE_FIELD_MUST_BE_REQUIRED", "标题字段必须为必填。", "snapshot.form.fields.title.required");
            }

            if (!BoolValue(title, "queryable"))
            {
                AddValidationIssue(issues, "TITLE_FIELD_MUST_BE_QUERYABLE", "标题字段必须保持可查询。", "snapshot.form.fields.title.queryable");
            }

            if (string.Equals(StringValue(title, "inputStage"), "reviewer", StringComparison.Ordinal))
            {
                AddValidationIssue(issues, "TITLE_FIELD_INITIATOR_REQUIRED", "标题必须由发起人填写。", "snapshot.form.fields.title.inputStage");
            }
        }

        var fieldById = fields
            .Where(field => !string.IsNullOrWhiteSpace(StringValue(field, "id")))
            .ToDictionary(field => StringValue(field, "id")!, StringComparer.Ordinal);
        var fieldIndex = fields
            .Select((field, index) => (Id: StringValue(field, "id"), Index: index))
            .Where(item => item.Id is not null)
            .ToDictionary(item => item.Id!, item => item.Index, StringComparer.Ordinal);

        for (var index = 0; index < fields.Length; index++)
        {
            var field = fields[index];
            var fieldId = StringValue(field, "id") ?? index.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var fieldType = StringValue(field, "type") ?? string.Empty;
            if (IsChoiceType(fieldType) && !HasValidOptions(field["options"] as JsonArray))
            {
                AddValidationIssue(issues, "FIELD_OPTIONS_INVALID", $"字段“{StringValue(field, "label") ?? fieldId}”的选项不完整或重复。", $"snapshot.form.fields.{fieldId}.options");
            }

            if (string.Equals(fieldType, "table", StringComparison.Ordinal)
                && field["columns"] is JsonArray columns)
            {
                foreach (var column in columns.OfType<JsonObject>())
                {
                    var columnType = StringValue(column, "type") ?? "text";
                    if (!string.Equals(columnType, "text", StringComparison.Ordinal)
                        && !HasValidOptions(column["options"] as JsonArray))
                    {
                        AddValidationIssue(issues, "FIELD_OPTIONS_INVALID", $"表格列“{StringValue(column, "label") ?? StringValue(column, "id") ?? "未命名"}”的选项不完整或重复。", $"snapshot.form.fields.{fieldId}.columns");
                    }
                }
            }

            if (field["displayCondition"] is JsonObject condition
                && (string.Equals(fieldId, "title", StringComparison.Ordinal)
                    || ConditionIsInvalid(condition, fieldById, referencedId =>
                        fieldIndex.TryGetValue(referencedId, out var sourceIndex) && sourceIndex < index)))
            {
                AddValidationIssue(issues, "DISPLAY_CONDITION_INVALID", $"字段“{StringValue(field, "label") ?? fieldId}”的显示条件无效。", $"snapshot.form.fields.{fieldId}.displayCondition");
            }
        }
    }

    private static void ValidateSystemFields(
        JsonObject snapshot,
        List<ProcessDefinitionValidationIssueDto> issues)
    {
        if (snapshot["systemFields"] is not JsonArray fields)
        {
            AddValidationIssue(issues, "SYSTEM_FIELDS_REQUIRED", "系统列表字段配置不完整。", "snapshot.systemFields");
            return;
        }

        var keys = new HashSet<string>(
            fields.OfType<JsonObject>()
                .Select(field => StringValue(field, "key"))
                .Where(key => key is not null)
                .Select(key => key!),
            StringComparer.Ordinal);
        if (!keys.SetEquals(SystemFieldKeys))
        {
            AddValidationIssue(issues, "SYSTEM_FIELDS_INCOMPLETE", "系统列表字段必须保留全部固定字段。", "snapshot.systemFields");
        }
    }

    private static void ValidateApprovalFlow(
        JsonObject snapshot,
        JsonObject[] fields,
        ReferenceCatalog catalog,
        List<ProcessDefinitionValidationIssueDto> issues)
    {
        var nodes = FlowNodes(snapshot).ToArray();
        var edges = FlowEdges(snapshot).ToArray();
        var starts = nodes.Where(node => NodeKind(node) == "start").ToArray();
        var ends = nodes.Where(node => NodeKind(node) == "end").ToArray();
        var approvals = nodes.Where(node => NodeKind(node) == "approval").ToArray();
        if (starts.Length != 1 || ends.Length != 1)
        {
            AddValidationIssue(issues, "FLOW_TERMINALS_INVALID", $"流程必须有且仅有一个开始节点和一个结束节点，当前分别为 {starts.Length}、{ends.Length} 个。", "snapshot.flow.nodes");
        }

        if (approvals.Length == 0)
        {
            AddValidationIssue(issues, "APPROVAL_NODE_REQUIRED", "固定审批流程至少需要一个审批节点。", "snapshot.flow.nodes");
        }

        var nodeById = nodes.ToDictionary(node => StringValue(node, "id")!, StringComparer.Ordinal);
        var adjacency = nodes.ToDictionary(node => StringValue(node, "id")!, _ => new List<string>(), StringComparer.Ordinal);
        var reverse = nodes.ToDictionary(node => StringValue(node, "id")!, _ => new List<string>(), StringComparer.Ordinal);
        var edgePairs = new HashSet<string>(StringComparer.Ordinal);
        var invalidEdge = false;
        foreach (var edge in edges)
        {
            var source = StringValue(edge, "source") ?? string.Empty;
            var target = StringValue(edge, "target") ?? string.Empty;
            if (!nodeById.ContainsKey(source)
                || !nodeById.ContainsKey(target)
                || string.Equals(source, target, StringComparison.Ordinal)
                || !edgePairs.Add($"{source}\n{target}"))
            {
                invalidEdge = true;
                continue;
            }

            adjacency[source].Add(target);
            reverse[target].Add(source);
        }

        if (invalidEdge)
        {
            AddValidationIssue(issues, "FLOW_EDGE_INVALID", "流程图存在悬空、自连接或重复连线。", "snapshot.flow.edges");
        }

        if (HasCycle(adjacency, reverse))
        {
            AddValidationIssue(issues, "FLOW_CYCLE", "流程图不能包含循环连线。", "snapshot.flow.edges");
        }

        if (starts.Length == 1 && ends.Length == 1)
        {
            var fromStart = Visit(starts[0], adjacency);
            var toEnd = Visit(ends[0], reverse);
            var disconnected = nodes.Any(node =>
            {
                var id = StringValue(node, "id")!;
                return !fromStart.Contains(id) || !toEnd.Contains(id);
            });
            var badDirections = nodes.Any(node => NodeKind(node) switch
            {
                "start" => reverse[StringValue(node, "id")!].Count > 0,
                "end" => adjacency[StringValue(node, "id")!].Count > 0,
                "approval" => reverse[StringValue(node, "id")!].Count == 0
                    || adjacency[StringValue(node, "id")!].Count == 0,
                _ => true,
            });
            if (disconnected || badDirections)
            {
                AddValidationIssue(issues, "FLOW_NOT_CONNECTED", "所有节点都必须由开始节点到达并最终流向结束节点。", "snapshot.flow");
            }
        }

        var fieldById = fields
            .Where(field => !string.IsNullOrWhiteSpace(StringValue(field, "id")))
            .ToDictionary(field => StringValue(field, "id")!, StringComparer.Ordinal);
        var editableIds = EditableFieldIds(fields);
        var assignedIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in approvals)
        {
            var nodeId = StringValue(node, "id")!;
            var data = node["data"] as JsonObject ?? new JsonObject();
            var groupText = StringValue(data, "permissionGroupId");
            if (!Guid.TryParse(groupText, out var groupId))
            {
                AddValidationIssue(issues, "APPROVAL_GROUP_REQUIRED", $"审批节点“{NodeLabel(node)}”未选择流程权限组。", $"snapshot.flow.nodes.{nodeId}.data.permissionGroupId");
            }
            else
            {
                ValidateGroupReadiness([groupId], "review", $"snapshot.flow.nodes.{nodeId}.data.permissionGroupId", catalog, issues);
            }

            var nodeEditableIds = ReadStringArray(data["editableFieldIds"]);
            foreach (var fieldId in nodeEditableIds)
            {
                assignedIds.Add(fieldId);
            }

            if (BoolValue(data, "allowRepeatedEditing") && nodeEditableIds.Length == 0)
            {
                AddValidationIssue(issues, "REPEATED_EDITING_FIELDS_REQUIRED", $"审批节点“{NodeLabel(node)}”开启重复修改前必须选择可修改字段。", $"snapshot.flow.nodes.{nodeId}.data.editableFieldIds");
            }

            if (data["activationCondition"] is JsonObject condition
                && ConditionIsInvalid(condition, fieldById, _ => true))
            {
                AddValidationIssue(issues, "NODE_CONDITION_INVALID", $"审批节点“{NodeLabel(node)}”的执行条件无效。", $"snapshot.flow.nodes.{nodeId}.data.activationCondition");
            }

            ValidateEmail(node, data, catalog, issues);
        }

        foreach (var end in ends)
        {
            ValidateEmail(end, end["data"] as JsonObject ?? new JsonObject(), catalog, issues);
        }

        foreach (var field in fields)
        {
            var fieldId = StringValue(field, "id")!;
            if (BoolValue(field, "required")
                && string.Equals(StringValue(field, "inputStage"), "reviewer", StringComparison.Ordinal)
                && !assignedIds.Contains(fieldId))
            {
                AddValidationIssue(issues, "REVIEWER_FIELD_UNASSIGNED", $"审核人必填字段“{StringValue(field, "label") ?? fieldId}”尚未分配审批节点。", $"snapshot.form.fields.{fieldId}");
            }
        }

        ValidateParallelTopology(nodes, adjacency, reverse, editableIds, issues);
    }

    private static void ValidateEmail(
        JsonObject node,
        JsonObject data,
        ReferenceCatalog catalog,
        List<ProcessDefinitionValidationIssueDto> issues)
    {
        if (data["emailNotification"] is not JsonObject email || !BoolValue(email, "enabled"))
        {
            return;
        }

        var nodeId = StringValue(node, "id")!;
        var recipients = ReadGuidArray(email, "extraUserIds");
        if (!BoolValue(email, "notifyReviewers")
            && !BoolValue(email, "notifyInitiator")
            && recipients.Length == 0)
        {
            AddValidationIssue(issues, "EMAIL_RECIPIENT_REQUIRED", $"节点“{NodeLabel(node)}”已启用邮件，但没有收件人。", $"snapshot.flow.nodes.{nodeId}.data.emailNotification");
        }

        foreach (var userId in recipients)
        {
            if (catalog.Users.TryGetValue(userId, out var user) && !user.IsEnabled)
            {
                AddValidationIssue(issues, "EMAIL_USER_DISABLED", $"邮件收件人“{user.Name}”已停用。", $"snapshot.flow.nodes.{nodeId}.data.emailNotification.extraUserIds");
            }
        }
    }

    private static void ValidateParallelTopology(
        JsonObject[] nodes,
        Dictionary<string, List<string>> adjacency,
        Dictionary<string, List<string>> reverse,
        HashSet<string> editableIds,
        List<ProcessDefinitionValidationIssueDto> issues)
    {
        var nodeById = nodes.ToDictionary(node => StringValue(node, "id")!, StringComparer.Ordinal);
        foreach (var split in nodes.Where(node => adjacency[StringValue(node, "id")!].Count >= 2))
        {
            var splitId = StringValue(split, "id")!;
            var branches = adjacency[splitId];
            if (branches.Any(id => !nodeById.TryGetValue(id, out var node) || NodeKind(node) != "approval"))
            {
                AddValidationIssue(issues, "PARALLEL_BRANCH_INVALID", $"节点“{NodeLabel(split)}”的并行分支必须直接连接审批节点。", $"snapshot.flow.nodes.{splitId}");
                continue;
            }

            var distances = branches.Select(branch => ReachableDistances(branch, adjacency)).ToArray();
            var joinId = nodes
                .Select(node => StringValue(node, "id")!)
                .Where(id => reverse[id].Count >= 2 && distances.All(distance => distance.ContainsKey(id)))
                .OrderBy(id => distances.Sum(distance => distance[id]))
                .FirstOrDefault();
            if (joinId is null)
            {
                AddValidationIssue(issues, "PARALLEL_JOIN_REQUIRED", $"节点“{NodeLabel(split)}”的并行分支必须汇聚到同一个后续节点。", $"snapshot.flow.nodes.{splitId}");
                continue;
            }

            var ownerBranches = new Dictionary<string, HashSet<int>>(StringComparer.Ordinal);
            for (var branchIndex = 0; branchIndex < branches.Count; branchIndex++)
            {
                var queue = new Queue<string>();
                var visited = new HashSet<string>(StringComparer.Ordinal);
                queue.Enqueue(branches[branchIndex]);
                while (queue.Count > 0)
                {
                    var current = queue.Dequeue();
                    if (current == joinId || !visited.Add(current))
                    {
                        continue;
                    }

                    if (nodeById.TryGetValue(current, out var node)
                        && node["data"] is JsonObject data
                        && NodeKind(node) == "approval")
                    {
                        foreach (var fieldId in ReadStringArray(data["editableFieldIds"]).Where(editableIds.Contains))
                        {
                            if (!ownerBranches.TryGetValue(fieldId, out var owners))
                            {
                                owners = [];
                                ownerBranches[fieldId] = owners;
                            }

                            owners.Add(branchIndex);
                        }
                    }

                    foreach (var next in adjacency[current])
                    {
                        queue.Enqueue(next);
                    }
                }
            }

            var conflicts = ownerBranches.Where(item => item.Value.Count > 1).Select(item => item.Key).ToArray();
            if (conflicts.Length > 0)
            {
                AddValidationIssue(issues, "PARALLEL_FIELD_CONFLICT", $"并行路径不能同时修改字段：{string.Join("、", conflicts)}。", $"snapshot.flow.nodes.{splitId}");
            }
        }
    }

    private static Dictionary<string, int> ReachableDistances(
        string origin,
        Dictionary<string, List<string>> graph)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        var queue = new Queue<(string Id, int Distance)>();
        queue.Enqueue((origin, 0));
        while (queue.Count > 0)
        {
            var (id, distance) = queue.Dequeue();
            if (!result.TryAdd(id, distance))
            {
                continue;
            }

            foreach (var next in graph[id])
            {
                queue.Enqueue((next, distance + 1));
            }
        }

        return result;
    }

    private static bool HasCycle(
        Dictionary<string, List<string>> adjacency,
        Dictionary<string, List<string>> reverse)
    {
        var indegree = reverse.ToDictionary(item => item.Key, item => item.Value.Count, StringComparer.Ordinal);
        var queue = new Queue<string>(indegree.Where(item => item.Value == 0).Select(item => item.Key));
        var count = 0;
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            count++;
            foreach (var next in adjacency[current])
            {
                indegree[next]--;
                if (indegree[next] == 0)
                {
                    queue.Enqueue(next);
                }
            }
        }

        return count != adjacency.Count;
    }

    private static HashSet<string> Visit(
        JsonObject origin,
        Dictionary<string, List<string>> graph)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>();
        queue.Enqueue(StringValue(origin, "id")!);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (!visited.Add(current))
            {
                continue;
            }

            foreach (var next in graph[current])
            {
                queue.Enqueue(next);
            }
        }

        return visited;
    }

    private static string NodeKind(JsonObject node) =>
        StringValue(node["data"] as JsonObject, "kind") ?? string.Empty;

    private static string NodeLabel(JsonObject node) =>
        StringValue(node["data"] as JsonObject, "label") ?? StringValue(node, "id") ?? "未命名节点";

    private static void AddValidationIssue(
        List<ProcessDefinitionValidationIssueDto> issues,
        string code,
        string message,
        string? path = null)
    {
        if (!issues.Any(issue => issue.Code == code && issue.Message == message && issue.Path == path))
        {
            issues.Add(new ProcessDefinitionValidationIssueDto(code, message, path));
        }
    }

    private static bool IsChoiceType(string fieldType) =>
        fieldType is "select" or "cascader" or "radio" or "checkbox";

    private static bool HasValidOptions(JsonArray? options)
    {
        if (options is null || options.Count == 0)
        {
            return false;
        }

        var labels = new HashSet<string>(StringComparer.Ordinal);
        var allIds = new HashSet<string>(StringComparer.Ordinal);
        return ValidateOptionLevel(options, labels, allIds);
    }

    private static bool ValidateOptionLevel(
        JsonArray options,
        HashSet<string> siblingLabels,
        HashSet<string> allIds)
    {
        foreach (var option in options.OfType<JsonObject>())
        {
            var id = StringValue(option, "id")?.Trim();
            var label = StringValue(option, "label")?.Trim();
            if (string.IsNullOrWhiteSpace(id)
                || string.IsNullOrWhiteSpace(label)
                || !allIds.Add(id)
                || !siblingLabels.Add(label))
            {
                return false;
            }

            if (option["children"] is JsonArray children
                && children.Count > 0
                && !ValidateOptionLevel(children, new HashSet<string>(StringComparer.Ordinal), allIds))
            {
                return false;
            }
        }

        return options.Count > 0 && options.All(item => item is JsonObject);
    }

    private static bool ConditionIsInvalid(
        JsonObject condition,
        Dictionary<string, JsonObject> fieldById,
        Func<string, bool> referenceAllowed)
    {
        if (condition["rules"] is not JsonArray rules || rules.Count == 0)
        {
            return true;
        }

        foreach (var rule in rules.OfType<JsonObject>())
        {
            var fieldId = StringValue(rule, "fieldId") ?? string.Empty;
            var operation = StringValue(rule, "operator") ?? string.Empty;
            if (!fieldById.TryGetValue(fieldId, out var field)
                || !referenceAllowed(fieldId)
                || !ConditionOperatorAllowed(StringValue(field, "type") ?? string.Empty, operation))
            {
                return true;
            }

            if (operation is not ("empty" or "not-empty")
                && (rule["value"] is null || rule["value"] is JsonValue value && IsEmptyJsonValue(value)))
            {
                return true;
            }

            if (IsChoiceType(StringValue(field, "type") ?? string.Empty)
                && operation is not ("empty" or "not-empty")
                && !OptionIds(field["options"] as JsonArray).Contains(JsonScalarText(rule["value"])))
            {
                return true;
            }
        }

        return rules.Any(item => item is not JsonObject);
    }

    private static bool ConditionOperatorAllowed(string fieldType, string operation)
    {
        if (fieldType == "checkbox")
        {
            return operation is "contains" or "not-contains" or "empty" or "not-empty";
        }

        if (fieldType is "text" or "textarea" or "rich-text")
        {
            return operation is "eq" or "neq" or "gt" or "gte" or "lt" or "lte" or "empty" or "not-empty";
        }

        return operation is "eq" or "neq" or "empty" or "not-empty";
    }

    private static bool IsEmptyJsonValue(JsonValue value) =>
        value.TryGetValue<string>(out var text) && string.IsNullOrEmpty(text);

    private static string JsonScalarText(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return string.Empty;
        }

        if (value.TryGetValue<string>(out var text))
        {
            return text;
        }

        return value.ToJsonString();
    }

    private static HashSet<string> OptionIds(JsonArray? options)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (options is null)
        {
            return ids;
        }

        foreach (var option in options.OfType<JsonObject>())
        {
            var id = StringValue(option, "id");
            if (id is not null)
            {
                ids.Add(id);
            }

            if (option["children"] is JsonArray children)
            {
                ids.UnionWith(OptionIds(children));
            }
        }

        return ids;
    }

    private static HashSet<string> EditableFieldIds(IEnumerable<JsonObject> fields)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in fields)
        {
            var id = StringValue(field, "id")!;
            var inputStage = StringValue(field, "inputStage") ?? "initiator";
            if (!string.Equals(StringValue(field, "type"), "table", StringComparison.Ordinal))
            {
                if (inputStage is "both" or "reviewer")
                {
                    result.Add(id);
                }

                continue;
            }

            if (inputStage == "reviewer")
            {
                result.Add(id);
            }
            else if (inputStage == "both" && field["columns"] is JsonArray columns)
            {
                foreach (var column in columns.OfType<JsonObject>().Where(column => BoolValue(column, "reviewEditable")))
                {
                    result.Add($"{id}.{StringValue(column, "id")}");
                }
            }
        }

        return result;
    }

    private static List<RemovedSnapshotReferenceDto> RemoveMissingFlowFieldReferences(
        JsonObject snapshot)
    {
        var fields = FormFields(snapshot).ToArray();
        var allFieldIds = new HashSet<string>(
            fields.Select(field => StringValue(field, "id")!),
            StringComparer.Ordinal);
        var editableIds = EditableFieldIds(fields);
        var removed = new List<RemovedSnapshotReferenceDto>();

        foreach (var field in fields)
        {
            var ownerId = StringValue(field, "id")!;
            RemoveMissingConditionRules(
                field,
                "displayCondition",
                ownerId,
                allFieldIds,
                "condition-field",
                removed);
        }

        foreach (var node in FlowNodes(snapshot).Where(node => NodeKind(node) == "approval"))
        {
            var ownerId = StringValue(node, "id")!;
            if (node["data"] is not JsonObject data)
            {
                continue;
            }

            if (data["editableFieldIds"] is JsonArray values)
            {
                var kept = new JsonArray();
                foreach (var value in values)
                {
                    var fieldId = value is JsonValue item && item.TryGetValue<string>(out var text)
                        ? text
                        : string.Empty;
                    if (editableIds.Contains(fieldId))
                    {
                        kept.Add(fieldId);
                    }
                    else if (!string.IsNullOrWhiteSpace(fieldId))
                    {
                        removed.Add(new RemovedSnapshotReferenceDto(
                            "editable-field",
                            ownerId,
                            fieldId,
                            "引用的表单字段已删除或不再允许审核人编辑。"));
                    }
                }

                data["editableFieldIds"] = kept;
            }

            RemoveMissingConditionRules(
                data,
                "activationCondition",
                ownerId,
                allFieldIds,
                "condition-field",
                removed);
        }

        return removed;
    }

    private static void RemoveMissingConditionRules(
        JsonObject owner,
        string propertyName,
        string ownerId,
        HashSet<string> fieldIds,
        string kind,
        List<RemovedSnapshotReferenceDto> removed)
    {
        if (owner[propertyName] is not JsonObject condition || condition["rules"] is not JsonArray rules)
        {
            return;
        }

        var kept = new JsonArray();
        foreach (var rule in rules.OfType<JsonObject>())
        {
            var fieldId = StringValue(rule, "fieldId") ?? string.Empty;
            if (fieldIds.Contains(fieldId))
            {
                kept.Add(rule.DeepClone());
            }
            else if (!string.IsNullOrWhiteSpace(fieldId))
            {
                removed.Add(new RemovedSnapshotReferenceDto(
                    kind,
                    ownerId,
                    fieldId,
                    "引用的表单字段已删除。"));
            }
        }

        if (kept.Count == 0)
        {
            owner.Remove(propertyName);
        }
        else
        {
            condition["rules"] = kept;
        }
    }

    private static List<ProcessDefinitionInputIssueDto> ValidateSnapshotReferences(
        ProcessBasicConfigInput basic,
        JsonObject snapshot,
        ReferenceCatalog catalog)
    {
        var issues = new List<ProcessDefinitionInputIssueDto>();
        var allFieldIds = new HashSet<string>(
            FormFields(snapshot).Select(field => StringValue(field, "id")!),
            StringComparer.Ordinal);
        allFieldIds.UnionWith(EditableFieldIds(FormFields(snapshot)));

        foreach (var node in FlowNodes(snapshot))
        {
            var nodeId = StringValue(node, "id")!;
            var data = node["data"] as JsonObject;
            if (data is null)
            {
                continue;
            }

            var kind = StringValue(data, "kind");
            var purpose = kind == "start" ? "start" : kind == "approval" ? "review" : null;
            if (purpose is not null && Guid.TryParse(StringValue(data, "permissionGroupId"), out var groupId))
            {
                ValidateGroupReferences([groupId], purpose, $"flow.nodes.{nodeId}.data.permissionGroupId", catalog, issues);
            }

            if (purpose is not null)
            {
                ValidateGroupReferences(
                    ReadGuidArray(data, "permissionGroupIds"),
                    purpose,
                    $"flow.nodes.{nodeId}.data.permissionGroupIds",
                    catalog,
                    issues);
            }

            foreach (var fieldId in ReadStringArray(data["editableFieldIds"]))
            {
                if (!allFieldIds.Contains(fieldId))
                {
                    issues.Add(InputIssue($"flow.nodes.{nodeId}.data.editableFieldIds", "FIELD_NOT_FOUND", $"字段 {fieldId} 不存在。"));
                }
            }

            if (data["activationCondition"] is JsonObject condition && condition["rules"] is JsonArray rules)
            {
                foreach (var rule in rules.OfType<JsonObject>())
                {
                    var fieldId = StringValue(rule, "fieldId") ?? string.Empty;
                    if (!allFieldIds.Contains(fieldId))
                    {
                        issues.Add(InputIssue($"flow.nodes.{nodeId}.data.activationCondition", "FIELD_NOT_FOUND", $"字段 {fieldId} 不存在。"));
                    }
                }
            }

            if (data["emailNotification"] is JsonObject email)
            {
                foreach (var userId in ReadGuidArray(email, "extraUserIds"))
                {
                    if (!catalog.Users.ContainsKey(userId))
                    {
                        issues.Add(InputIssue($"flow.nodes.{nodeId}.data.emailNotification.extraUserIds", "USER_NOT_FOUND", $"用户 {userId:D} 不存在。"));
                    }
                }
            }
        }

        return issues;
    }

    private async Task<ReferenceCatalog> LoadReferenceCatalogAsync(CancellationToken cancellationToken)
    {
        await using var command = CreateCommand();
        command.CommandText =
            """
            SELECT
                [g].[id], [g].[name], [g].[is_enabled], [p].[purpose],
                CASE WHEN EXISTS
                (
                    SELECT 1
                    FROM [flowpilot].[workflow_group_users] AS [gu]
                    INNER JOIN [flowpilot].[users] AS [direct_user]
                        ON [direct_user].[id] = [gu].[user_id]
                       AND [direct_user].[is_enabled] = 1
                    WHERE [gu].[group_id] = [g].[id]
                ) OR EXISTS
                (
                    SELECT 1
                    FROM [flowpilot].[workflow_group_roles] AS [gr]
                    INNER JOIN [flowpilot].[roles] AS [member_role]
                        ON [member_role].[id] = [gr].[role_id]
                       AND [member_role].[is_enabled] = 1
                    INNER JOIN [flowpilot].[user_roles] AS [ur]
                        ON [ur].[role_id] = [member_role].[id]
                    INNER JOIN [flowpilot].[users] AS [role_user]
                        ON [role_user].[id] = [ur].[user_id]
                       AND [role_user].[is_enabled] = 1
                    WHERE [gr].[group_id] = [g].[id]
                ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS [has_effective_members]
            FROM [flowpilot].[workflow_permission_groups] AS [g]
            LEFT JOIN [flowpilot].[workflow_permission_group_purposes] AS [p]
                ON [p].[group_id] = [g].[id]
            ORDER BY [g].[id];

            SELECT [id], [name], [is_enabled]
            FROM [flowpilot].[roles];

            SELECT [id], [display_name], [email], [is_enabled]
            FROM [flowpilot].[users];
            """;

        var groups = new Dictionary<Guid, CatalogGroup>();
        var roles = new Dictionary<Guid, CatalogRole>();
        var users = new Dictionary<Guid, CatalogUser>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var id = reader.GetGuid(0);
            if (!groups.TryGetValue(id, out var group))
            {
                group = new CatalogGroup(
                    reader.GetString(1),
                    reader.GetBoolean(2),
                    [],
                    reader.GetBoolean(4));
                groups[id] = group;
            }

            if (!reader.IsDBNull(3))
            {
                group.Purposes.Add(reader.GetString(3));
            }
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            roles[reader.GetGuid(0)] = new CatalogRole(reader.GetString(1), reader.GetBoolean(2));
        }

        await reader.NextResultAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            users[reader.GetGuid(0)] = new CatalogUser(
                reader.GetString(1),
                reader.GetString(2),
                reader.GetBoolean(3));
        }

        return new ReferenceCatalog(groups, roles, users);
    }

    private static CreateProcessDefinitionResponseDto CreateResponse(
        Guid definitionId,
        Guid versionId,
        string code,
        ProcessBasicConfigInput basic,
        JsonObject snapshot,
        ProcessVersionValidationDto validation,
        ProcessDefinitionMutationActor actor,
        DateTimeOffset now,
        string basicJson,
        string snapshotJson,
        ProcessVersionSourceDto? basedOn = null)
    {
        var user = new ProcessDefinitionUserRefDto(actor.EffectiveUserId, actor.EffectiveUserName);
        var responseBasic = ParseObject(basicJson, "basic_json");
        responseBasic["code"] = code;
        var version = new ProcessVersionDto
        {
            Id = versionId,
            DefinitionId = definitionId,
            Revision = 1,
            VersionNumber = 1,
            VersionLabel = "V1",
            InstanceCount = 0,
            Editable = true,
            Status = validation.Status == "passed" ? "publishable" : "validation-failed",
            Validation = validation,
            Checksum = CreateChecksum(basicJson, snapshotJson),
            CreatedAt = now,
            CreatedBy = user,
            UpdatedAt = now,
            UpdatedBy = user,
            BasedOn = basedOn,
            Basic = responseBasic,
            Snapshot = snapshot.DeepClone().AsObject(),
        };
        var definition = new ProcessDefinitionDto
        {
            Id = definitionId,
            Revision = 1,
            Code = code,
            Name = basic.Name,
            Description = basic.Description,
            Type = basic.Type,
            Disabled = false,
            Status = "unpublished",
            NextVersionNumber = 2,
            VersionCount = 1,
            InstanceCount = 0,
            UpdatedAt = now,
            UpdatedBy = user,
        };
        return new CreateProcessDefinitionResponseDto(definition, version);
    }

    private static string CreateDefinitionCode(string type, Guid definitionId) =>
        $"PROC-{(type == "approval" ? "AP" : "FREE")}-{definitionId:N}".ToUpperInvariant();

    private static string HashRequest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string CreateChecksum(string basicJson, string snapshotJson) =>
        HashRequest(string.Concat(basicJson, "\n", snapshotJson));

    private static string SerializeNode(JsonNode node) => node.ToJsonString(JsonOptions);

    private static string SerializeValidation(ProcessVersionValidationDto validation) =>
        JsonSerializer.Serialize(validation, JsonOptions);

    private static JsonObject ParseObject(string json, string columnName) =>
        JsonNode.Parse(json) as JsonObject
        ?? throw new InvalidDataException($"Database column '{columnName}' must contain a JSON object.");

    private static IEnumerable<JsonObject> FormFields(JsonObject snapshot) =>
        snapshot["form"] is JsonObject form && form["fields"] is JsonArray fields
            ? fields.OfType<JsonObject>()
            : [];

    private static IEnumerable<JsonObject> FlowNodes(JsonObject snapshot) =>
        snapshot["flow"] is JsonObject flow && flow["nodes"] is JsonArray nodes
            ? nodes.OfType<JsonObject>()
            : [];

    private static IEnumerable<JsonObject> FlowEdges(JsonObject snapshot) =>
        snapshot["flow"] is JsonObject flow && flow["edges"] is JsonArray edges
            ? edges.OfType<JsonObject>()
            : [];

    private static string[] ReadStringArray(JsonNode? source) =>
        source is JsonArray values
            ? values
                .Select(value => value is JsonValue item && item.TryGetValue<string>(out var text) ? text : null)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value!)
                .ToArray()
            : [];

    private static string? StringValue(JsonObject? source, string propertyName) =>
        source?[propertyName] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : null;

    private static bool BoolValue(JsonObject? source, string propertyName) =>
        source?[propertyName] is JsonValue value
        && value.TryGetValue<bool>(out var result)
        && result;

    private static int? IntValue(JsonObject? source, string propertyName)
    {
        if (source?[propertyName] is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue<int>(out var integer))
        {
            return integer;
        }

        return value.TryGetValue<long>(out var large) && large is >= int.MinValue and <= int.MaxValue
            ? (int)large
            : null;
    }

    private static double NumberValue(JsonObject? source, string propertyName)
    {
        if (source?[propertyName] is not JsonValue value)
        {
            return 0;
        }

        if (value.TryGetValue<double>(out var number))
        {
            return number;
        }

        return value.TryGetValue<int>(out var integer) ? integer : 0;
    }

    private DateTimeOffset UtcNow() => _timeProvider.GetUtcNow();

    private SqlCommand CreateCommand()
    {
        var command = ((SqlConnection)_dbContext.Database.GetDbConnection()).CreateCommand();
        command.CommandTimeout = _commandTimeoutSeconds;
        if (_dbContext.Database.CurrentTransaction?.GetDbTransaction() is SqlTransaction transaction)
        {
            command.Transaction = transaction;
        }

        return command;
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
        parameter.Value = type == SqlDbType.SmallInt && value is int integer
            ? checked((short)integer)
            : value;
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

    private static ProcessDefinitionInputIssueDto InputIssue(
        string path,
        string code,
        string message) => new(path, code, message);

    private static ProcessDefinitionCommandFailure ValidationFailure(
        string title,
        IReadOnlyList<ProcessDefinitionInputIssueDto> issues) => new(
            ProcessDefinitionCommandError.ValidationFailed,
            "VALIDATION_FAILED",
            title,
            "请求内容包含无法保存的格式或引用错误。",
            issues);

    private sealed record VersionState(
        Guid DefinitionId,
        string DefinitionType,
        Guid? PublishedVersionId,
        int DefinitionRevision,
        Guid VersionId,
        int Revision,
        string BasicJson,
        string SnapshotJson,
        bool HasInstances);

    private sealed record CatalogGroup(
        string Name,
        bool IsEnabled,
        HashSet<string> Purposes,
        bool HasEffectiveMembers);

    private sealed record CatalogRole(string Name, bool IsEnabled);

    private sealed record CatalogUser(string Name, string Email, bool IsEnabled);

    private sealed record ReferenceCatalog(
        IReadOnlyDictionary<Guid, CatalogGroup> Groups,
        IReadOnlyDictionary<Guid, CatalogRole> Roles,
        IReadOnlyDictionary<Guid, CatalogUser> Users);

    private readonly record struct GroupReference(Guid GroupId, string Purpose, string? NodeId);

    private sealed record SavePreparation(
        ProcessBasicConfigInput? Basic,
        JsonObject? Snapshot,
        string? BasicJson,
        string? SnapshotJson,
        IReadOnlyList<RemovedSnapshotReferenceDto> RemovedReferences,
        ProcessDefinitionCommandFailure? Failure)
    {
        public static SavePreparation Ready(
            ProcessBasicConfigInput basic,
            JsonObject snapshot,
            string basicJson,
            string snapshotJson,
            IReadOnlyList<RemovedSnapshotReferenceDto> removedReferences) => new(
                basic,
                snapshot,
                basicJson,
                snapshotJson,
                removedReferences,
                null);

        public static SavePreparation Failed(ProcessDefinitionCommandFailure failure) => new(
            null,
            null,
            null,
            null,
            [],
            failure);
    }

    private sealed record NormalizedForm(
        JsonObject? Form,
        JsonArray? SystemFields,
        ProcessDefinitionCommandFailure? Failure)
    {
        public static NormalizedForm Success(JsonObject form, JsonArray systemFields) =>
            new(form, systemFields, null);

        public static NormalizedForm Failed(ProcessDefinitionCommandFailure failure) =>
            new(null, null, failure);
    }

    private sealed record NormalizedFlow(JsonObject? Value, ProcessDefinitionCommandFailure? Failure)
    {
        public static NormalizedFlow Success(JsonObject value) => new(value, null);

        public static NormalizedFlow Failed(ProcessDefinitionCommandFailure failure) => new(null, failure);
    }

    private sealed record IdempotencyReservation<T>(
        Guid? Id,
        string? LeaseOwner,
        T? ReplayValue,
        int? ReplayRevision,
        ProcessDefinitionCommandFailure? Failure)
    {
        public static IdempotencyReservation<T> Reserved(Guid id, string leaseOwner) =>
            new(id, leaseOwner, default, null, null);

        public static IdempotencyReservation<T> Replayed(T value, int revision) =>
            new(null, null, value, revision, null);

        public static IdempotencyReservation<T> Rejected(ProcessDefinitionCommandFailure failure) =>
            new(null, null, default, null, failure);
    }
}
