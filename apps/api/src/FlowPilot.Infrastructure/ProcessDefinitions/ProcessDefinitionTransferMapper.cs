using System.Globalization;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessDefinitions;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

internal static class ProcessDefinitionTransferMapper
{
    internal sealed record ReferenceNames(
        IReadOnlyDictionary<Guid, string> Groups,
        IReadOnlyDictionary<Guid, string> Roles,
        IReadOnlyDictionary<Guid, string> Users)
    {
        public IReadOnlyDictionary<string, Guid> GroupIds { get; } = Reverse(Groups);
        public IReadOnlyDictionary<string, Guid> RoleIds { get; } = Reverse(Roles);
        public IReadOnlyDictionary<string, Guid> UserIds { get; } = Reverse(Users);

        private static Dictionary<string, Guid> Reverse(IReadOnlyDictionary<Guid, string> source) =>
            source
                .GroupBy(item => item.Value, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First().Key, StringComparer.Ordinal);
    }

    internal sealed record ImportedVersion(
        int VersionNumber,
        string VersionLabel,
        string? ChangeNote,
        ProcessBasicConfigInput Basic,
        JsonObject Snapshot);

    internal sealed record ImportedDefinition(
        string Name,
        string Description,
        string Type,
        IReadOnlyList<ImportedVersion> Versions);

    private static readonly IReadOnlyDictionary<string, string> FieldTypeToLabel =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["text"] = "文本框",
            ["textarea"] = "文本框",
            ["rich-text"] = "富文本编辑框",
            ["richtext"] = "富文本编辑框",
            ["select"] = "下拉框",
            ["cascader"] = "多级下拉框",
            ["radio"] = "单选框",
            ["checkbox"] = "复选框",
            ["attachment"] = "附件上传",
            ["table"] = "表格",
        };
    private static readonly IReadOnlyDictionary<string, string> LabelToFieldType =
        FieldTypeToLabel
            .GroupBy(item => item.Value, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().Key, StringComparer.Ordinal);
    private static readonly IReadOnlyDictionary<string, string> OperatorToLabel =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["eq"] = "等于",
            ["neq"] = "不等于",
            ["gt"] = "大于",
            ["gte"] = "大于等于",
            ["lt"] = "小于",
            ["lte"] = "小于等于",
            ["contains"] = "包含",
            ["not-contains"] = "不包含",
            ["empty"] = "为空",
            ["not-empty"] = "不为空",
        };
    private static readonly IReadOnlyDictionary<string, string> LabelToOperator =
        OperatorToLabel.ToDictionary(item => item.Value, item => item.Key, StringComparer.Ordinal);

    public static JsonObject Export(
        ProcessDefinitionDto definition,
        IReadOnlyList<ProcessVersionDto> versions,
        ReferenceNames references,
        DateTimeOffset exportedAt)
    {
        var exportedVersions = new JsonArray();
        foreach (var version in versions.OrderBy(item => item.VersionNumber))
        {
            exportedVersions.Add(ExportVersion(definition, version, references));
        }

        return new JsonObject
        {
            ["文件类型"] = "FlowPilot 流程定义",
            ["格式版本"] = "1.0",
            ["导出时间"] = exportedAt.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture),
            ["流程定义"] = new JsonObject
            {
                ["名称"] = definition.Name,
                ["类型"] = definition.Type == "free" ? "自由协作" : "固定审批",
                ["说明"] = definition.Description,
                ["原状态"] = definition.Disabled ? "已停用" : definition.PublishedVersionId.HasValue ? "已发布" : "未发布",
                ["版本"] = exportedVersions,
            },
        };
    }

    public static ImportedDefinition Import(JsonObject document, ReferenceNames references)
    {
        if (Text(document, "文件类型") != "FlowPilot 流程定义")
        {
            throw new InvalidDataException("这不是 FlowPilot 流程定义导出文件。");
        }

        var source = Object(document["流程定义"])
            ?? throw new InvalidDataException("导入文件缺少流程定义。");
        var name = Text(source, "名称")?.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new InvalidDataException("导入文件缺少流程名称。");
        }

        var rawVersions = Array(source["版本"]);
        if (rawVersions is null || !rawVersions.OfType<JsonObject>().Any())
        {
            throw new InvalidDataException("导入文件没有可用版本。");
        }

        var type = Text(source, "类型") == "自由协作" ? "free" : "approval";
        var description = Text(source, "说明") ?? string.Empty;
        var fieldRegistry = new Dictionary<string, (string Id, string Type)>(StringComparer.Ordinal);
        var columnRegistry = new Dictionary<string, (string Id, string Type)>(StringComparer.Ordinal);
        var usedNumbers = new HashSet<int>();
        var imported = new List<ImportedVersion>();
        var nextFallbackNumber = 1;
        foreach (var raw in rawVersions.OfType<JsonObject>())
        {
            var requestedNumber = ParseVersionNumber(Text(raw, "版本"));
            var versionNumber = requestedNumber > 0 && usedNumbers.Add(requestedNumber)
                ? requestedNumber
                : NextAvailableNumber(usedNumbers, ref nextFallbackNumber);
            usedNumbers.Add(versionNumber);

            var basicSource = Object(raw["基本信息"])
                ?? throw new InvalidDataException($"V{versionNumber} 缺少基本信息。");
            var versionType = Text(basicSource, "流程类型") == "自由协作" ? "free" : type;
            var form = ImportForm(raw["初始表单"], fieldRegistry, columnRegistry);
            var basic = new ProcessBasicConfigInput
            {
                Name = name,
                InstancePrefix = Text(basicSource, "实例编号前缀")?.Trim() ?? string.Empty,
                Type = versionType,
                Description = Text(basicSource, "流程说明") ?? description,
                StarterGroupIds = ResolveNames(basicSource["发起权限组"], references.GroupIds),
                AssigneeGroupIds = ResolveNames(basicSource["审批受理权限组"], references.GroupIds),
                CloseGroupIds = ResolveNames(basicSource["关闭权限组"], references.GroupIds),
                EmailNotificationEnabled = Bool(basicSource, "邮件通知", true),
                VisibleRoleIds = ResolveNames(basicSource["额外可见角色"], references.RoleIds),
                VisibleUserIds = ResolveNames(basicSource["额外可见用户"], references.UserIds),
            };
            var snapshot = new JsonObject
            {
                ["form"] = new JsonObject { ["fields"] = form.Fields },
                ["systemFields"] = form.SystemFields,
                ["flow"] = ImportFlow(raw["流程设计"], versionType, form.FieldIds, references),
            };
            imported.Add(new ImportedVersion(
                versionNumber,
                $"V{versionNumber}",
                Text(raw, "变更说明"),
                basic,
                snapshot));
        }

        return new ImportedDefinition(name, description, type, imported.OrderBy(item => item.VersionNumber).ToArray());
    }

    private static JsonObject ExportVersion(
        ProcessDefinitionDto definition,
        ProcessVersionDto version,
        ReferenceNames references)
    {
        var fieldArray = Array(Object(version.Snapshot["form"])?["fields"])
            ?? Array(version.Snapshot["form"])
            ?? new JsonArray();
        var fieldNames = CreateReadableNames(fieldArray.OfType<JsonObject>(), "label");
        var nodeArray = Array(Object(version.Snapshot["flow"])?["nodes"]) ?? new JsonArray();
        var nodeNames = CreateReadableNames(nodeArray.OfType<JsonObject>(), "data", "label");

        var exportedFields = new JsonArray();
        foreach (var field in fieldArray.OfType<JsonObject>())
        {
            exportedFields.Add(ExportField(field, fieldNames));
        }

        var exportedSystemFields = new JsonArray();
        foreach (var field in (Array(version.Snapshot["systemFields"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            exportedSystemFields.Add(new JsonObject
            {
                ["名称"] = Text(field, "label") ?? Text(field, "key") ?? string.Empty,
                ["任务中心显示"] = Bool(field, "taskVisible"),
                ["流程清单显示"] = Bool(field, "processListVisible"),
                ["Excel导出"] = Bool(field, "exportVisible"),
            });
        }

        var basic = version.Basic;
        return new JsonObject
        {
            ["版本"] = version.VersionLabel,
            ["原版本状态"] = definition.PublishedVersionId == version.Id
                ? "已发布"
                : version.Validation.Status == "passed" ? "校验通过" : "校验未通过",
            ["变更说明"] = version.ChangeNote ?? string.Empty,
            ["基本信息"] = new JsonObject
            {
                ["流程名称"] = Text(basic, "name") ?? definition.Name,
                ["流程类型"] = (Text(basic, "type") ?? definition.Type) == "free" ? "自由协作" : "固定审批",
                ["流程说明"] = Text(basic, "description") ?? definition.Description,
                ["实例编号前缀"] = Text(basic, "instancePrefix") ?? string.Empty,
                ["发起权限组"] = NameArray(GuidValues(basic["starterGroupIds"]), references.Groups),
                ["关闭权限组"] = NameArray(GuidValues(basic["closeGroupIds"]), references.Groups),
                ["审批受理权限组"] = NameArray(GuidValues(basic["assigneeGroupIds"]), references.Groups),
                ["邮件通知"] = Bool(basic, "emailNotificationEnabled", true),
                ["额外可见角色"] = NameArray(GuidValues(basic["visibleRoleIds"]), references.Roles),
                ["额外可见用户"] = NameArray(GuidValues(basic["visibleUserIds"]), references.Users),
            },
            ["初始表单"] = new JsonObject
            {
                ["字段"] = exportedFields,
                ["系统列表字段"] = exportedSystemFields,
            },
            ["流程设计"] = ExportFlow(version.Snapshot, definition.Type, fieldNames, nodeNames, references),
        };
    }

    private static JsonObject ExportField(JsonObject field, IReadOnlyDictionary<string, string> fieldNames)
    {
        var id = Text(field, "id") ?? string.Empty;
        var type = Text(field, "type") ?? "text";
        var label = Text(field, "label") ?? "未命名字段";
        var result = new JsonObject
        {
            ["名称"] = label,
            ["引用名称"] = fieldNames.GetValueOrDefault(id, label),
            ["类型"] = FieldTypeToLabel.GetValueOrDefault(type, type),
            ["字段说明"] = Text(field, "description") ?? string.Empty,
            ["提示文字"] = Text(field, "placeholder") ?? string.Empty,
            ["必填"] = Bool(field, "required"),
            ["默认值"] = DisplayChoiceValue(field["defaultValue"], Array(field["options"])),
            ["输入权限"] = Text(field, "inputStage") switch
            {
                "reviewer" => "审核人",
                "both" => "发起人/审核人",
                _ => "发起人",
            },
            ["任务中心显示"] = Bool(field, "taskVisible"),
            ["流程清单显示"] = Bool(field, "listVisible"),
            ["作为查询条件"] = Bool(field, "queryable"),
            ["Excel导出"] = Bool(field, "exportVisible"),
        };
        if (type is "select" or "radio" or "checkbox" or "cascader")
        {
            result["选项"] = ExportOptions(Array(field["options"]), type == "cascader");
        }

        if (type == "text") result["多行显示"] = Bool(field, "multiline");
        if (field["displayCondition"] is JsonObject condition)
        {
            result["显示条件"] = ExportCondition(condition, fieldNames);
        }

        if (type == "attachment" && field["attachment"] is JsonObject attachment)
        {
            result["附件设置"] = new JsonObject
            {
                ["最多文件数"] = Int(attachment, "maxCount", 20),
                ["单个文件上限MB"] = Int(attachment, "maxSizeMb", 100),
                ["PDF页面内显示"] = Bool(attachment, "inlinePdf", true),
                ["允许扩展名"] = string.Join("、", TextValues(attachment["allowedExtensions"])),
                ["Excel转PDF"] = Bool(attachment, "excelToPdf"),
                ["转换最大页数"] = Int(attachment, "maxPreviewPages", 1),
            };
        }

        if (type == "table")
        {
            var columns = new JsonArray();
            foreach (var column in (Array(field["columns"]) ?? new JsonArray()).OfType<JsonObject>())
            {
                columns.Add(new JsonObject
                {
                    ["名称"] = Text(column, "label") ?? string.Empty,
                    ["类型"] = FieldTypeToLabel.GetValueOrDefault(Text(column, "type") ?? "text", "文本框"),
                    ["必填"] = Bool(column, "required"),
                    ["默认值"] = DisplayChoiceValue(column["defaultValue"], Array(column["options"])),
                    ["列宽"] = Int(column, "width", 160),
                    ["对齐"] = Text(column, "align") switch { "center" => "居中", "right" => "右对齐", _ => "左对齐" },
                    ["审核人可输入"] = Bool(column, "reviewEditable"),
                    ["选项"] = ExportOptions(Array(column["options"]), false),
                });
            }
            result["表格列"] = columns;
        }

        return result;
    }

    private static JsonObject ExportFlow(
        JsonObject snapshot,
        string definitionType,
        IReadOnlyDictionary<string, string> fieldNames,
        Dictionary<string, string> nodeNames,
        ReferenceNames references)
    {
        if (definitionType == "free")
        {
            return new JsonObject { ["类型"] = "自由协作", ["说明"] = "发起或受理权限组成员可指定下一位受理人，直到手动关闭。" };
        }

        var flow = Object(snapshot["flow"]) ?? new JsonObject();
        var nodes = new JsonArray();
        foreach (var node in (Array(flow["nodes"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var id = Text(node, "id") ?? string.Empty;
            var data = Object(node["data"]) ?? new JsonObject();
            var kind = Text(data, "kind") ?? "approval";
            var label = Text(data, "label") ?? "未命名节点";
            var exported = new JsonObject
            {
                ["名称"] = label,
                ["连接引用"] = nodeNames.GetValueOrDefault(id, label),
                ["类型"] = kind switch { "start" => "开始", "end" => "结束", _ => "审批" },
                ["节点说明"] = Text(data, "description") ?? string.Empty,
            };
            if (kind == "start")
            {
                exported["发起权限组"] = NameArray(GuidValues(data["permissionGroupIds"]), references.Groups);
            }
            else if (kind == "approval")
            {
                exported["执行权限组"] = Name(GuidValue(data["permissionGroupId"]), references.Groups);
                exported["发起时可指定人员"] = Bool(data, "specifyAssignee");
                exported["处理方式"] = Text(data, "handlingMode") == "confirmation" ? "确认（只能确认）" : "审批（可通过或驳回）";
                exported["可修改字段"] = new JsonArray(TextValues(data["editableFieldIds"])
                    .Select(fieldId => (JsonNode?)fieldNames.GetValueOrDefault(fieldId, fieldId)).ToArray());
                exported["允许重复修改"] = Bool(data, "allowRepeatedEditing");
                if (data["activationCondition"] is JsonObject condition)
                {
                    exported["执行条件"] = ExportCondition(condition, fieldNames);
                }
            }

            if (data["emailNotification"] is JsonObject email)
            {
                exported["邮件通知"] = new JsonObject
                {
                    ["启用"] = Bool(email, "enabled"),
                    ["通知审核人"] = Bool(email, "notifyReviewers"),
                    ["通知发起人"] = Bool(email, "notifyInitiator"),
                    ["额外通知用户"] = NameArray(GuidValues(email["extraUserIds"]), references.Users),
                };
            }
            nodes.Add(exported);
        }

        var edges = new JsonArray();
        foreach (var edge in (Array(flow["edges"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var source = Text(edge, "source");
            var target = Text(edge, "target");
            if (source is not null && target is not null
                && nodeNames.TryGetValue(source, out var sourceName)
                && nodeNames.TryGetValue(target, out var targetName))
            {
                edges.Add(new JsonObject { ["从"] = sourceName, ["到"] = targetName });
            }
        }

        var rejection = Text(Object(flow["meta"]), "rejectionHandling") switch
        {
            "resubmit-only" => "仅允许重新提交",
            "auto-close" => "驳回后自动关闭",
            _ => "重新提交或关闭",
        };
        return new JsonObject { ["类型"] = "固定审批", ["驳回处理"] = rejection, ["节点"] = nodes, ["连接"] = edges };
    }

    private sealed record ImportedForm(JsonArray Fields, JsonArray SystemFields, IReadOnlyDictionary<string, string> FieldIds);

    private static ImportedForm ImportForm(
        JsonNode? value,
        IDictionary<string, (string Id, string Type)> fieldRegistry,
        IDictionary<string, (string Id, string Type)> columnRegistry)
    {
        var source = Object(value) ?? throw new InvalidDataException("初始表单格式不正确。");
        var rawFields = (Array(source["字段"]) ?? new JsonArray()).OfType<JsonObject>().ToArray();
        var fields = new JsonArray();
        var fieldIds = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in rawFields)
        {
            var label = Text(raw, "名称")?.Trim() ?? "未命名字段";
            var reference = Text(raw, "引用名称")?.Trim() ?? label;
            var type = LabelToFieldType.GetValueOrDefault(Text(raw, "类型") ?? string.Empty, "text");
            if (type == "textarea") type = "text";
            var id = label == "标题" && !fieldIds.ContainsKey("标题")
                ? "title"
                : ReuseOrCreateId(fieldRegistry, reference, type, "field");
            fieldIds[reference] = id;
            fieldIds.TryAdd(label, id);
            var options = ImportOptions(raw["选项"], id, type == "cascader");
            var field = new JsonObject
            {
                ["id"] = id,
                ["type"] = type,
                ["label"] = label,
                ["description"] = Text(raw, "字段说明") ?? string.Empty,
                ["placeholder"] = Text(raw, "提示文字") ?? string.Empty,
                ["required"] = id == "title" || Bool(raw, "必填"),
                ["defaultValue"] = ImportChoiceValue(raw["默认值"], options, type),
                ["inputStage"] = Text(raw, "输入权限") switch { "审核人" => "reviewer", "发起人/审核人" => "both", _ => "initiator" },
                ["taskVisible"] = Bool(raw, "任务中心显示"),
                ["listVisible"] = Bool(raw, "流程清单显示"),
                ["queryable"] = id == "title" || Bool(raw, "作为查询条件"),
                ["exportVisible"] = Bool(raw, "Excel导出"),
                ["multiline"] = Bool(raw, "多行显示"),
                ["options"] = options,
            };
            if (type == "attachment" && raw["附件设置"] is JsonObject attachment)
            {
                field["attachment"] = new JsonObject
                {
                    ["maxCount"] = Int(attachment, "最多文件数", 20),
                    ["maxSizeMb"] = Int(attachment, "单个文件上限MB", 100),
                    ["inlinePdf"] = Bool(attachment, "PDF页面内显示", true),
                    ["allowedExtensions"] = new JsonArray((Text(attachment, "允许扩展名") ?? string.Empty)
                        .Split(['、', ',', '，', ' '], StringSplitOptions.RemoveEmptyEntries)
                        .Select(item => (JsonNode?)item.TrimStart('.').ToLowerInvariant()).ToArray()),
                    ["excelToPdf"] = Bool(attachment, "Excel转PDF"),
                    ["maxPreviewPages"] = Int(attachment, "转换最大页数", 1),
                };
            }

            if (type == "table")
            {
                var columns = new JsonArray();
                foreach (var rawColumn in (Array(raw["表格列"]) ?? new JsonArray()).OfType<JsonObject>())
                {
                    var columnLabel = Text(rawColumn, "名称")?.Trim() ?? "未命名列";
                    var columnType = LabelToFieldType.GetValueOrDefault(Text(rawColumn, "类型") ?? string.Empty, "text");
                    var columnReference = $"{reference} / {columnLabel}";
                    var columnId = ReuseOrCreateId(columnRegistry, columnReference, columnType, "column");
                    fieldIds[columnReference] = $"{id}.{columnId}";
                    var columnOptions = ImportOptions(rawColumn["选项"], $"{id}.{columnId}", false);
                    columns.Add(new JsonObject
                    {
                        ["id"] = columnId,
                        ["label"] = columnLabel,
                        ["type"] = columnType,
                        ["required"] = Bool(rawColumn, "必填"),
                        ["defaultValue"] = ImportChoiceValue(rawColumn["默认值"], columnOptions, columnType),
                        ["width"] = Int(rawColumn, "列宽", 160),
                        ["align"] = Text(rawColumn, "对齐") switch { "居中" => "center", "右对齐" => "right", _ => "left" },
                        ["reviewEditable"] = Bool(rawColumn, "审核人可输入"),
                        ["options"] = columnOptions,
                    });
                }
                field["columns"] = columns;
            }
            fields.Add(field);
        }

        for (var index = 0; index < rawFields.Length; index++)
        {
            if (rawFields[index]["显示条件"] is JsonObject condition
                && fields[index] is JsonObject field)
            {
                field["displayCondition"] = ImportCondition(condition, fieldIds);
            }
        }

        if (!fields.OfType<JsonObject>().Any(field => Text(field, "id") == "title"))
        {
            fields.Insert(0, CreateTitleField());
            fieldIds["标题"] = "title";
        }

        var systemFields = CreateSystemFields();
        foreach (var raw in (Array(source["系统列表字段"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var label = Text(raw, "名称");
            var target = systemFields.OfType<JsonObject>().FirstOrDefault(field => Text(field, "label") == label);
            if (target is null) continue;
            target["taskVisible"] = Bool(raw, "任务中心显示");
            target["processListVisible"] = Bool(raw, "流程清单显示");
            target["exportVisible"] = Bool(raw, "Excel导出");
        }
        return new ImportedForm(fields, systemFields, fieldIds);
    }

    private static JsonObject ImportFlow(
        JsonNode? value,
        string type,
        IReadOnlyDictionary<string, string> fieldIds,
        ReferenceNames references)
    {
        if (type == "free")
        {
            return new JsonObject { ["nodes"] = new JsonArray(), ["edges"] = new JsonArray(), ["meta"] = new JsonObject { ["rejectionHandling"] = "resubmit-or-close" } };
        }

        var source = Object(value) ?? throw new InvalidDataException("流程设计格式不正确。");
        var nodes = new JsonArray();
        var nodeIds = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in (Array(source["节点"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var label = Text(raw, "名称")?.Trim() ?? "未命名节点";
            var reference = Text(raw, "连接引用")?.Trim() ?? label;
            var id = $"node-{Guid.NewGuid():N}";
            nodeIds[reference] = id;
            nodeIds.TryAdd(label, id);
            var kind = Text(raw, "类型") switch { "开始" => "start", "结束" => "end", _ => "approval" };
            var data = new JsonObject
            {
                ["kind"] = kind,
                ["label"] = label,
                ["description"] = Text(raw, "节点说明") ?? string.Empty,
                ["specifyAssignee"] = kind == "approval" && Bool(raw, "发起时可指定人员"),
                ["handlingMode"] = Text(raw, "处理方式") == "确认（只能确认）" ? "confirmation" : "approval",
                ["editableFieldIds"] = ResolveFieldNames(raw["可修改字段"], fieldIds),
                ["allowRepeatedEditing"] = kind == "approval" && Bool(raw, "允许重复修改"),
            };
            if (kind == "start") data["permissionGroupIds"] = GuidArray(ResolveNames(raw["发起权限组"], references.GroupIds));
            if (kind == "approval"
                && ResolveNames(raw["执行权限组"], references.GroupIds).FirstOrDefault() is { } groupId
                && groupId != Guid.Empty)
            {
                data["permissionGroupId"] = groupId.ToString("D");
            }
            if (raw["执行条件"] is JsonObject condition) data["activationCondition"] = ImportCondition(condition, fieldIds);
            if (kind is "approval" or "end")
            {
                var email = raw["邮件通知"] as JsonObject ?? new JsonObject();
                data["emailNotification"] = new JsonObject
                {
                    ["enabled"] = Bool(email, "启用", true),
                    ["notifyReviewers"] = kind == "approval" && Bool(email, "通知审核人", true),
                    ["notifyInitiator"] = kind == "end" && Bool(email, "通知发起人", true),
                    ["extraUserIds"] = GuidArray(ResolveNames(email["额外通知用户"], references.UserIds)),
                };
            }
            nodes.Add(new JsonObject
            {
                ["id"] = id,
                ["position"] = new JsonObject { ["x"] = 80 + nodes.Count % 3 * 300, ["y"] = 120 + nodes.Count / 3 * 190 },
                ["data"] = data,
            });
        }

        var edges = new JsonArray();
        foreach (var raw in (Array(source["连接"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var from = Text(raw, "从");
            var to = Text(raw, "到");
            if (from is not null && to is not null
                && nodeIds.TryGetValue(from, out var sourceId)
                && nodeIds.TryGetValue(to, out var targetId))
            {
                edges.Add(new JsonObject { ["id"] = $"edge-{Guid.NewGuid():N}", ["source"] = sourceId, ["target"] = targetId });
            }
        }
        var rejection = Text(source, "驳回处理") switch
        {
            "仅允许重新提交" => "resubmit-only",
            "驳回后自动关闭" => "auto-close",
            _ => "resubmit-or-close",
        };
        return new JsonObject { ["nodes"] = nodes, ["edges"] = edges, ["meta"] = new JsonObject { ["rejectionHandling"] = rejection } };
    }

    private static JsonObject? ExportCondition(JsonObject condition, IReadOnlyDictionary<string, string> fieldNames)
    {
        var rules = new JsonArray();
        foreach (var rule in (Array(condition["rules"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var fieldId = Text(rule, "fieldId");
            if (fieldId is null || !fieldNames.TryGetValue(fieldId, out var fieldName)) continue;
            var op = Text(rule, "operator") ?? "eq";
            rules.Add(new JsonObject
            {
                ["字段"] = fieldName,
                ["比较方式"] = OperatorToLabel.GetValueOrDefault(op, "等于"),
                ["比较值"] = rule["value"]?.DeepClone(),
            });
        }
        return rules.Count == 0 ? null : new JsonObject
        {
            ["规则关系"] = Text(condition, "mode") == "any" ? "满足任意规则" : "满足全部规则",
            ["规则"] = rules,
        };
    }

    private static JsonObject? ImportCondition(JsonObject condition, IReadOnlyDictionary<string, string> fieldIds)
    {
        var rules = new JsonArray();
        foreach (var raw in (Array(condition["规则"]) ?? new JsonArray()).OfType<JsonObject>())
        {
            var fieldName = Text(raw, "字段");
            if (fieldName is null || !fieldIds.TryGetValue(fieldName, out var fieldId)) continue;
            rules.Add(new JsonObject
            {
                ["id"] = $"condition-{Guid.NewGuid():N}",
                ["fieldId"] = fieldId,
                ["operator"] = LabelToOperator.GetValueOrDefault(Text(raw, "比较方式") ?? string.Empty, "eq"),
                ["value"] = raw["比较值"]?.DeepClone(),
            });
        }
        return rules.Count == 0 ? null : new JsonObject
        {
            ["mode"] = Text(condition, "规则关系") == "满足任意规则" ? "any" : "all",
            ["rules"] = rules,
        };
    }

    private static JsonArray ImportOptions(JsonNode? value, string ownerId, bool hierarchical)
    {
        var labels = TextValues(value).ToArray();
        if (!hierarchical)
        {
            return new JsonArray(labels.Select(label => (JsonNode?)new JsonObject
            {
                ["id"] = $"option-{Guid.NewGuid():N}",
                ["label"] = label,
            }).ToArray());
        }

        var roots = new JsonArray();
        foreach (var path in labels)
        {
            var current = roots;
            foreach (var label in path.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var item = current.OfType<JsonObject>().FirstOrDefault(option => Text(option, "label") == label);
                if (item is null)
                {
                    item = new JsonObject { ["id"] = $"option-{Guid.NewGuid():N}", ["label"] = label, ["children"] = new JsonArray() };
                    current.Add(item);
                }
                current = Array(item["children"])!;
            }
        }
        return roots;
    }

    private static JsonNode? ImportChoiceValue(JsonNode? value, JsonArray options, string type)
    {
        if (type is not ("select" or "radio" or "checkbox" or "cascader")) return value?.DeepClone();
        var labels = value is JsonArray ? TextValues(value).ToArray() : (TextNode(value) ?? string.Empty).Split(['、', '/'], StringSplitOptions.RemoveEmptyEntries);
        var ids = labels.Select(label => FindOptionId(options, label)).Where(id => id is not null).Select(id => id!).ToArray();
        return type is "checkbox" or "cascader"
            ? new JsonArray(ids.Select(id => (JsonNode?)id).ToArray())
            : ids.FirstOrDefault();
    }

    private static string? FindOptionId(JsonArray options, string label)
    {
        foreach (var option in options.OfType<JsonObject>())
        {
            if (Text(option, "label") == label) return Text(option, "id");
            if (option["children"] is JsonArray children && FindOptionId(children, label) is { } childId) return childId;
        }
        return null;
    }

    private static JsonArray ExportOptions(JsonArray? options, bool paths)
    {
        var values = new JsonArray();
        ExportOptions(options ?? new JsonArray(), string.Empty, paths, values);
        return values;
    }

    private static void ExportOptions(JsonArray options, string parent, bool paths, JsonArray target)
    {
        foreach (var option in options.OfType<JsonObject>())
        {
            var label = Text(option, "label") ?? string.Empty;
            var path = string.IsNullOrEmpty(parent) ? label : $"{parent}/{label}";
            if (option["children"] is JsonArray children && children.Count > 0)
            {
                ExportOptions(children, path, paths, target);
            }
            else
            {
                target.Add(paths ? path : label);
            }
        }
    }

    private static JsonNode? DisplayChoiceValue(JsonNode? value, JsonArray? options)
    {
        if (value is JsonArray array)
        {
            return new JsonArray(array.Select(item => (JsonNode?)(FindOptionLabel(options, TextNode(item)) ?? TextNode(item) ?? string.Empty)).ToArray());
        }
        var text = TextNode(value);
        return text is null ? value?.DeepClone() : FindOptionLabel(options, text) ?? text;
    }

    private static string? FindOptionLabel(JsonArray? options, string? id)
    {
        if (id is null || options is null) return null;
        foreach (var option in options.OfType<JsonObject>())
        {
            if (Text(option, "id") == id) return Text(option, "label");
            if (FindOptionLabel(Array(option["children"]), id) is { } label) return label;
        }
        return null;
    }

    private static Dictionary<string, string> CreateReadableNames(
        IEnumerable<JsonObject> values,
        params string[] labelPath)
    {
        var rows = values.Select(value =>
        {
            var labelSource = value;
            for (var index = 0; index < labelPath.Length - 1; index++)
            {
                labelSource = Object(labelSource[labelPath[index]]) ?? new JsonObject();
            }
            return (Id: Text(value, "id") ?? string.Empty, Label: Text(labelSource, labelPath[^1]) ?? "未命名");
        }).ToArray();
        var totals = rows.GroupBy(row => row.Label).ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        return rows.ToDictionary(row => row.Id, row =>
        {
            seen[row.Label] = seen.GetValueOrDefault(row.Label) + 1;
            return totals[row.Label] == 1 ? row.Label : $"{row.Label}（第{seen[row.Label]}个）";
        }, StringComparer.Ordinal);
    }

    private static string ReuseOrCreateId(
        IDictionary<string, (string Id, string Type)> registry,
        string reference,
        string type,
        string prefix)
    {
        if (registry.TryGetValue(reference, out var previous) && previous.Type == type) return previous.Id;
        var id = $"{prefix}-{Guid.NewGuid():N}";
        registry[reference] = (id, type);
        return id;
    }

    private static JsonObject CreateTitleField() => new()
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
    };

    private static JsonArray CreateSystemFields()
    {
        var result = new JsonArray();
        AddSystemField(result, "instanceCode", "实例编号", true, true, true);
        AddSystemField(result, "processName", "流程名称", false, false, false);
        AddSystemField(result, "processVersion", "版本", false, false, false);
        AddSystemField(result, "status", "状态", true, true, true);
        AddSystemField(result, "currentNode", "当前节点", true, true, true);
        AddSystemField(result, "currentRound", "当前轮次", false, false, false);
        AddSystemField(result, "initiator", "发起人", true, true, true);
        AddSystemField(result, "createdAt", "发起时间", true, true, true);
        AddSystemField(result, "updatedAt", "更新时间", false, false, false);
        return result;
    }

    private static void AddSystemField(JsonArray target, string key, string label, bool task, bool list, bool export) =>
        target.Add(new JsonObject { ["key"] = key, ["label"] = label, ["taskVisible"] = task, ["processListVisible"] = list, ["exportVisible"] = export });

    private static JsonArray ResolveFieldNames(JsonNode? source, IReadOnlyDictionary<string, string> ids) =>
        new(TextValues(source).Where(ids.ContainsKey).Select(name => (JsonNode?)ids[name]).ToArray());

    private static Guid[] ResolveNames(JsonNode? source, IReadOnlyDictionary<string, Guid> ids) =>
        TextValues(source).Where(ids.ContainsKey).Select(name => ids[name]).Distinct().ToArray();

    private static JsonArray GuidArray(IEnumerable<Guid> values) =>
        new(values.Select(value => (JsonNode?)value.ToString("D")).ToArray());

    private static JsonArray NameArray(IEnumerable<Guid> ids, IReadOnlyDictionary<Guid, string> names) =>
        new(ids.Where(names.ContainsKey).Select(id => (JsonNode?)names[id]).ToArray());

    private static string Name(Guid? id, IReadOnlyDictionary<Guid, string> names) =>
        id.HasValue && names.TryGetValue(id.Value, out var name) ? name : string.Empty;

    private static IEnumerable<Guid> GuidValues(JsonNode? source) =>
        TextValues(source).Select(text => Guid.TryParse(text, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty);

    private static Guid? GuidValue(JsonNode? source) => Guid.TryParse(TextNode(source), out var id) ? id : null;

    private static int ParseVersionNumber(string? label) =>
        label is { Length: > 1 } && label[0] is 'V' or 'v' && int.TryParse(label.AsSpan(1), out var number) ? number : 0;

    private static int NextAvailableNumber(HashSet<int> used, ref int next)
    {
        while (used.Contains(next)) next++;
        return next++;
    }

    private static JsonObject? Object(JsonNode? node) => node as JsonObject;
    private static JsonArray? Array(JsonNode? node) => node as JsonArray;
    private static string? Text(JsonObject? source, string name) => source is null ? null : TextNode(source[name]);
    private static string? TextNode(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private static IEnumerable<string> TextValues(JsonNode? source) =>
        source is JsonArray values
            ? values.Select(TextNode).Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => value!)
            : TextNode(source) is { } value ? [value] : [];
    private static bool Bool(JsonObject source, string name, bool fallback = false) =>
        source[name] is JsonValue value && value.TryGetValue<bool>(out var result) ? result : fallback;
    private static int Int(JsonObject source, string name, int fallback) =>
        source[name] is JsonValue value && value.TryGetValue<int>(out var result) ? result : fallback;
}
