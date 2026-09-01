using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.BackgroundJobs;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.ProcessDefinitions;
using FlowPilot.Infrastructure.ProcessInstances;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class WorkflowLifecycleIntegrationTests
{
    [Fact]
    public async Task DefinitionPublishLaunchDecisionAndNotificationCompleteAgainstSqlServer()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var runId = Guid.NewGuid().ToString("N");
        var keyPrefix = $"workflow-lifecycle-{runId}-";

        var initiatorId = await scope.AddUserAsync($"initiator-{runId}@example.test", cancellationToken);
        var reviewerId = await scope.AddUserAsync($"reviewer-{runId}@example.test", cancellationToken);
        var starterGroupId = await scope.AddWorkflowGroupAsync(
                cancellationToken,
                ["start", "close"],
                [initiatorId]);
        var reviewerGroupId = await scope.AddWorkflowGroupAsync(
                cancellationToken,
                ["review"],
                [reviewerId]);

        var definitionService = new SqlServerProcessDefinitionCommandService(
            scope.Context,
            FlowPilotDatabaseOptions.Default,
            TimeProvider.System);
        var definitionActor = new ProcessDefinitionMutationActor(
            scope.AdministratorUserId,
            scope.AdministratorUserId,
            "超级管理员");
        var basic = new ProcessBasicConfigInput
        {
            Name = $"完整链路测试-{runId[..8]}",
            InstancePrefix = $"T{runId[..6]}",
            Type = "approval",
            Description = "验证定义保存、发布、发起、审核和通知的真实数据库链路。",
            StarterGroupIds = [starterGroupId],
            CloseGroupIds = [starterGroupId],
        };

        var created = await definitionService.CreateAsync(
            basic,
            definitionActor,
            keyPrefix + "create",
            keyPrefix + "create",
            cancellationToken);
        Assert.True(created.Succeeded, created.Failure?.Detail);
        var definitionId = created.Value!.Response.Definition.Id;
        var versionId = created.Value.Response.Version.Id;

        var form = JsonNode.Parse(
            """
                {
                  "fields": [
                    { "id": "title", "type": "text", "label": "标题", "required": true,
                      "listVisible": true, "taskVisible": true, "queryable": true,
                      "exportVisible": true, "inputStage": "initiator" },
                    { "id": "summary", "type": "textarea", "label": "详细说明",
                      "description": "多行文本", "placeholder": "请输入详细说明", "required": true,
                      "defaultValue": "默认说明", "listVisible": true, "taskVisible": true,
                      "queryable": true, "exportVisible": true, "inputStage": "both" },
                    { "id": "priority", "type": "select", "label": "优先级", "inputStage": "initiator",
                      "defaultValue": "high", "options": [
                        { "id": "normal", "label": "普通" }, { "id": "high", "label": "紧急" }
                      ] },
                    { "id": "product", "type": "cascader", "label": "产品分类", "inputStage": "initiator",
                      "defaultValue": ["motor", "stepper"], "options": [
                        { "id": "motor", "label": "电机", "children": [
                          { "id": "stepper", "label": "步进电机" }
                        ] }
                      ] },
                    { "id": "result", "type": "radio", "label": "预检结果", "inputStage": "initiator",
                      "options": [{ "id": "pass", "label": "通过" }, { "id": "fail", "label": "不通过" }] },
                    { "id": "departments", "type": "checkbox", "label": "会签部门", "inputStage": "initiator",
                      "options": [{ "id": "rd", "label": "研发" }, { "id": "qa", "label": "质量" }] },
                    { "id": "conditional-note", "type": "text", "label": "紧急说明", "inputStage": "initiator",
                      "displayCondition": { "mode": "all", "rules": [
                        { "id": "show-on-high", "fieldId": "priority", "operator": "eq", "value": "high" }
                      ] } },
                    { "id": "rich-content", "type": "rich-text", "label": "富文本内容",
                      "defaultValue": "<p>默认内容</p>", "inputStage": "initiator" },
                    { "id": "evidence", "type": "attachment", "label": "受控附件", "inputStage": "initiator",
                      "attachment": { "maxSizeMb": 25, "maxCount": 1, "inlinePdf": true,
                        "allowedExtensions": ["pdf", "xlsx"], "excelToPdf": true, "maxPreviewPages": 12 } },
                    { "id": "items", "type": "table", "label": "明细表", "inputStage": "both",
                      "columns": [
                        { "id": "name", "label": "名称", "type": "text", "required": true,
                          "width": 180, "align": "left", "reviewEditable": false },
                        { "id": "category", "label": "类别", "type": "select", "defaultValue": "a",
                          "width": 130, "align": "center", "reviewEditable": true,
                          "options": [{ "id": "a", "label": "A 类" }, { "id": "b", "label": "B 类" }] },
                        { "id": "decision", "label": "结论", "type": "radio", "reviewEditable": true,
                          "options": [{ "id": "yes", "label": "是" }, { "id": "no", "label": "否" }] },
                        { "id": "tags", "label": "标签", "type": "checkbox", "reviewEditable": false,
                          "options": [{ "id": "safe", "label": "安全" }, { "id": "urgent", "label": "加急" }] }
                      ] },
                    { "id": "review-note", "type": "text", "label": "审核补充", "inputStage": "reviewer" }
                  ]
                }
                """)!.AsObject();
        var systemFields = created.Value.Response.Version.Snapshot["systemFields"]!.DeepClone().AsArray();
        systemFields[0]!["taskVisible"] = false;
        systemFields[0]!["processListVisible"] = true;
        systemFields[0]!["exportVisible"] = false;
        var savedForm = await definitionService.SaveFormAsync(
            definitionId,
            versionId,
            new SaveFormDesignerRequest { Form = form, SystemFields = systemFields },
            expectedRevision: 1,
            definitionActor,
            keyPrefix + "save-form",
            cancellationToken);
        Assert.True(savedForm.Succeeded, savedForm.Failure?.Detail);

        var flow = created.Value.Response.Version.Snapshot["flow"]!.DeepClone().AsObject();
        var nodes = flow["nodes"]!.AsArray();
        var approval = nodes
            .Select(node => node!.AsObject())
            .Single(node => node["data"]?["kind"]?.GetValue<string>() == "approval");
        approval["data"]!["permissionGroupId"] = reviewerGroupId.ToString();
        approval["data"]!["specifyAssignee"] = true;
        approval["data"]!["editableFieldIds"] = new JsonArray("review-note", "items.category", "items.decision");
        approval["data"]!["handlingMode"] = "approval";
        approval["data"]!["allowRepeatedEditing"] = true;
        approval["data"]!["activationCondition"] = new JsonObject
        {
            ["mode"] = "all",
            ["rules"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["id"] = "activate-on-high",
                        ["fieldId"] = "priority",
                        ["operator"] = "eq",
                        ["value"] = "high",
                    },
                },
        };
        approval["data"]!["emailNotification"] = new JsonObject
        {
            ["enabled"] = true,
            ["notifyReviewers"] = true,
            ["notifyInitiator"] = false,
            ["extraUserIds"] = new JsonArray(),
        };
        var end = nodes
            .Select(node => node!.AsObject())
            .Single(node => node["data"]?["kind"]?.GetValue<string>() == "end");
        end["data"]!["emailNotification"] = new JsonObject
        {
            ["enabled"] = true,
            ["notifyReviewers"] = false,
            ["notifyInitiator"] = true,
            ["extraUserIds"] = new JsonArray(),
        };
        flow["meta"]!["rejectionHandling"] = "resubmit-only";

        var saved = await definitionService.SaveFlowAsync(
            definitionId,
            versionId,
            new SaveFlowDesignerRequest
            {
                BasicPatch = new ProcessFlowBasicPatch
                {
                    Name = basic.Name,
                    StarterGroupIds = basic.StarterGroupIds,
                },
                Flow = flow,
            },
            expectedRevision: savedForm.Value!.Revision,
            definitionActor,
            keyPrefix + "save-flow",
            cancellationToken);
        Assert.True(saved.Succeeded, saved.Failure?.Detail);

        var staleSave = await definitionService.SaveFlowAsync(
            definitionId,
            versionId,
            new SaveFlowDesignerRequest
            {
                BasicPatch = new ProcessFlowBasicPatch
                {
                    Name = basic.Name,
                    StarterGroupIds = basic.StarterGroupIds,
                },
                Flow = flow,
            },
            expectedRevision: 1,
            definitionActor,
            keyPrefix + "stale-save",
            cancellationToken);
        Assert.Equal(ProcessDefinitionCommandError.RevisionMismatch, staleSave.Failure?.Error);

        var published = await definitionService.PublishAsync(
            definitionId,
            versionId,
            new PublishProcessVersionRequest { ChangeNote = "完整链路测试发布" },
            saved.Value!.Revision,
            definitionActor,
            keyPrefix + "publish",
            keyPrefix + "publish",
            cancellationToken);
        Assert.True(published.Succeeded, published.Failure?.Detail);

        var instanceService = new SqlServerProcessInstanceCommandService(
            scope.Context,
            TimeProvider.System,
            new EmailOutboxWriter(scope.Context));
        var initiator = new ProcessInstanceActor(
            initiatorId,
            initiatorId,
            IsSuperAdmin: false,
            CanCopyCompletedInstance: false,
            CanReview: false,
            CanClose: true,
            EffectiveUserName: "链路发起人",
            EffectiveUserDepartmentPath: "测试部");
        var instanceFormValues = new JsonObject
        {
            ["title"] = "真实数据库完整链路",
            ["summary"] = "覆盖所有表单设置",
            ["priority"] = "high",
            ["product"] = new JsonArray("motor", "stepper"),
            ["result"] = "pass",
            ["departments"] = new JsonArray("rd", "qa"),
            ["conditional-note"] = "当天完成",
            ["rich-content"] = "<p>完整配置</p>",
            ["evidence"] = new JsonArray(),
            ["items"] = new JsonArray
            {
                new JsonObject
                {
                    ["key"] = "row-1",
                    ["name"] = "物料",
                    ["category"] = "a",
                    ["decision"] = "yes",
                    ["tags"] = new JsonArray("safe"),
                },
            },
            ["review-note"] = string.Empty,
        };
        var createdInstance = await instanceService.CreateAsync(
            new CreateProcessInstanceRequest
            {
                DefinitionId = definitionId,
                FormValues = instanceFormValues,
                AssigneeByNode = new Dictionary<string, Guid?>
                {
                    [approval["id"]!.GetValue<string>()] = reviewerId,
                },
            },
            initiator,
            keyPrefix + "launch",
            "https://flowpilot.example/flowpilot",
            keyPrefix + "launch",
            cancellationToken);
        Assert.True(createdInstance.Succeeded, createdInstance.Failure?.Detail);
        var instanceId = createdInstance.Value!.Instance.Id;
        var createdTask = Assert.Single(createdInstance.Value.Instance.Tasks);
        Assert.Equal("pending", createdTask.Status);
        Assert.Equal(reviewerId, createdTask.DefaultAssignee?.Id);
        scope.Context.ChangeTracker.Clear();

        var updatedFormValues = instanceFormValues.DeepClone().AsObject();
        updatedFormValues["summary"] = "审核前由发起人补充的说明";
        var updatedSubmission = await instanceService.UpdateSubmissionAsync(
            instanceId,
            new UpdateProcessInstanceSubmissionRequest
            {
                FormValues = updatedFormValues,
            },
            initiator,
            createdInstance.Value.Instance.Revision,
            keyPrefix + "update-submission",
            cancellationToken);
        Assert.True(updatedSubmission.Succeeded, updatedSubmission.Failure?.Detail);
        instanceFormValues = updatedFormValues;
        scope.Context.ChangeTracker.Clear();
        var task = await scope.Context.WorkflowTasks
            .SingleAsync(item => item.Id == createdTask.Id, cancellationToken);

        var reviewer = new ProcessInstanceActor(
            reviewerId,
            reviewerId,
            IsSuperAdmin: false,
            CanCopyCompletedInstance: false,
            CanReview: true,
            CanClose: false,
            EffectiveUserName: "链路审核人",
            EffectiveUserDepartmentPath: "测试部");
        var rejection = await instanceService.DecideTaskAsync(
            task.Id,
            new TaskDecisionRequest
            {
                Action = "reject",
                Comment = "先驳回以验证重新提交",
            },
            reviewer,
            task.Revision,
            keyPrefix + "reject",
            keyPrefix + "reject",
            cancellationToken);
        Assert.True(rejection.Succeeded, rejection.Failure?.Detail);

        scope.Context.ChangeTracker.Clear();
        var rejectedInstance = await scope.Context.WorkflowInstances
            .SingleAsync(item => item.Id == instanceId, cancellationToken);
        Assert.Equal("rejected-pending", rejectedInstance.Status);
        var resubmissionTask = await scope.Context.WorkflowTasks
            .SingleAsync(item => item.InstanceId == instanceId
                && item.TaskType == "resubmission"
                && item.Status == "pending", cancellationToken);
        Assert.Equal(initiatorId, resubmissionTask.AssigneeId);

        var resubmitted = await instanceService.ResubmitAsync(
            instanceId,
            new UpdateProcessInstanceSubmissionRequest
            {
                FormValues = instanceFormValues.DeepClone().AsObject(),
            },
            initiator,
            rejectedInstance.Revision,
            keyPrefix + "resubmit",
            keyPrefix + "resubmit",
            cancellationToken);
        Assert.True(resubmitted.Succeeded, resubmitted.Failure?.Detail);

        scope.Context.ChangeTracker.Clear();
        var nextTask = await scope.Context.WorkflowTasks
            .SingleAsync(item => item.InstanceId == instanceId
                && item.TaskType == "approval"
                && item.Round == 2
                && item.Status == "pending", cancellationToken);
        var instanceBeforeDecision = await scope.Context.WorkflowInstances
            .AsNoTracking()
            .SingleAsync(item => item.Id == instanceId, cancellationToken);
        var fieldRevisions = JsonNode.Parse(instanceBeforeDecision.FieldRevisionsJson)!.AsObject();
        var reviewNoteRevision = fieldRevisions["review-note"]?.GetValue<int>() ?? 0;
        var decision = await instanceService.DecideTaskAsync(
            nextTask.Id,
            new TaskDecisionRequest
            {
                Action = "pass",
                Comment = "重新提交后审核通过",
                FieldValues = new JsonObject
                {
                    ["review-note"] = "审核人只提交节点授权字段",
                },
                BaseFieldRevisions = new Dictionary<string, int>
                {
                    ["review-note"] = reviewNoteRevision,
                },
            },
            reviewer,
            nextTask.Revision,
            keyPrefix + "pass",
            keyPrefix + "pass",
            cancellationToken);
        Assert.True(decision.Succeeded, decision.Failure?.Detail);

        scope.Context.ChangeTracker.Clear();
        var persisted = await scope.Context.WorkflowInstances
            .SingleAsync(item => item.Id == instanceId, cancellationToken);
        Assert.Equal("completed", persisted.Status);
        Assert.NotNull(persisted.CompletedAt);
        Assert.Equal(
            "审核人只提交节点授权字段",
            JsonNode.Parse(persisted.FormValuesJson)?["review-note"]?.GetValue<string>());
        var outbox = await scope.Context.RuntimeEmailOutboxMessages
            .Where(item => item.InstanceId == instanceId)
            .OrderBy(item => item.CreatedAt)
            .ToArrayAsync(cancellationToken);
        Assert.Contains(outbox, message => message.EventType == "task-activated" && message.RecipientUserId == reviewerId);
        Assert.Contains(outbox, message => message.EventType == "process-completed" && message.RecipientUserId == initiatorId);

        scope.Context.ChangeTracker.Clear();
        var completedTask = await scope.Context.WorkflowTasks
            .AsNoTracking()
            .SingleAsync(item => item.Id == nextTask.Id, cancellationToken);
        var completedInstance = await scope.Context.WorkflowInstances
            .AsNoTracking()
            .SingleAsync(item => item.Id == instanceId, cancellationToken);
        var completedFieldRevisions = JsonNode.Parse(completedInstance.FieldRevisionsJson)!.AsObject();
        var revised = await instanceService.ReviseTaskFieldsAsync(
            completedTask.Id,
            new ReviseTaskFieldsRequest
            {
                FieldValues = new JsonObject
                {
                    ["review-note"] = "审核完成后的补充修订",
                },
                BaseFieldRevisions = new Dictionary<string, int>
                {
                    ["review-note"] = completedFieldRevisions["review-note"]?.GetValue<int>() ?? 0,
                },
                Comment = "验证允许重复修改的真实数据库链路",
            },
            reviewer,
            completedTask.Revision,
            keyPrefix + "revise-fields",
            keyPrefix + "revise-fields",
            cancellationToken);
        Assert.True(revised.Succeeded, revised.Failure?.Detail);

        scope.Context.ChangeTracker.Clear();
        var revisedInstance = await scope.Context.WorkflowInstances
            .SingleAsync(item => item.Id == instanceId, cancellationToken);
        Assert.Equal(
            "审核完成后的补充修订",
            JsonNode.Parse(revisedInstance.FormValuesJson)?["review-note"]?.GetValue<string>());
        Assert.Contains(
            await scope.Context.WorkflowEvents
                .Where(item => item.InstanceId == instanceId)
                .ToArrayAsync(cancellationToken),
            item => item.EventType == "task-fields-revised" && item.TaskId == completedTask.Id);
    }
}
