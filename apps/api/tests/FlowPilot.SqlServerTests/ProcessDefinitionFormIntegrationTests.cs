using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.ProcessDefinitions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace FlowPilot.SqlServerTests;

public sealed class ProcessDefinitionFormIntegrationTests
{
    [Fact]
    public async Task FormFieldWithEmptyLabelCanBeSavedValidatedPublishedAndReadBack()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateIsolatedAsync(cancellationToken);
        var memberId = await scope.AddUserAsync("empty-field-label@example.test", cancellationToken);
        var groupId = await scope.AddWorkflowGroupAsync(
            cancellationToken,
            ["start", "close"],
            [memberId]);
        var assigneeGroupId = await scope.AddWorkflowGroupAsync(
            cancellationToken,
            ["review"],
            [memberId]);
        var commandService = new SqlServerProcessDefinitionCommandService(
            scope.Context,
            FlowPilotDatabaseOptions.Default,
            TimeProvider.System);
        var actor = new ProcessDefinitionMutationActor(
            scope.AdministratorUserId,
            scope.AdministratorUserId,
            "超级管理员");
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var created = await commandService.CreateAsync(
            new ProcessBasicConfigInput
            {
                Name = $"空字段名称-{suffix}",
                InstancePrefix = $"E{suffix}",
                Type = "free",
                Description = "验证字段名称可留空。",
                StarterGroupIds = [groupId],
                AssigneeGroupIds = [assigneeGroupId],
                CloseGroupIds = [groupId],
            },
            actor,
            Guid.NewGuid().ToString("N"),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(created.Succeeded, created.Failure?.Detail);

        var response = created.Value!.Response;
        var form = response.Version.Snapshot["form"]!.DeepClone().AsObject();
        var fields = form["fields"]!.AsArray();
        fields.Single(field => field!["id"]!.GetValue<string>() == "title")!["label"] = "";
        fields.Add(JsonNode.Parse(
            """
            {
              "id": "acknowledgements",
              "type": "checkbox",
              "label": "",
              "required": false,
              "listVisible": false,
              "taskVisible": false,
              "queryable": false,
              "exportVisible": false,
              "inputStage": "initiator",
              "options": [
                { "id": "confirmed", "label": "我已确认以上内容" }
              ]
            }
            """)!.AsObject());

        var saveResult = await commandService.SaveFormAsync(
            response.Definition.Id,
            response.Version.Id,
            new SaveFormDesignerRequest
            {
                Form = form,
                SystemFields = response.Version.Snapshot["systemFields"]!.DeepClone().AsArray(),
            },
            response.Version.Revision,
            actor,
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(saveResult.Succeeded, saveResult.Failure?.Detail);

        var validationResult = await commandService.ValidateAsync(
            response.Definition.Id,
            response.Version.Id,
            saveResult.Value!.Revision,
            actor,
            Guid.NewGuid().ToString("N"),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(validationResult.Succeeded, validationResult.Failure?.Detail);
        Assert.Equal("passed", validationResult.Value!.Validation.Status);

        var publishResult = await commandService.PublishAsync(
            response.Definition.Id,
            response.Version.Id,
            new PublishProcessVersionRequest { ChangeNote = "空字段名称发布验证" },
            validationResult.Value.Revision,
            actor,
            Guid.NewGuid().ToString("N"),
            Guid.NewGuid().ToString("N"),
            cancellationToken);
        Assert.True(publishResult.Succeeded, publishResult.Failure?.Detail);

        var queryService = CreateQueryService(scope);
        var persisted = await queryService.GetVersionAsync(
            response.Definition.Id,
            response.Version.Id,
            cancellationToken);
        Assert.NotNull(persisted);
        var persistedFields = persisted.Snapshot["form"]!["fields"]!.AsArray();
        Assert.Equal(
            "",
            persistedFields.Single(field => field!["id"]!.GetValue<string>() == "title")!["label"]!.GetValue<string>());
        var checkbox = persistedFields.Single(
            field => field!["id"]!.GetValue<string>() == "acknowledgements");
        Assert.Equal("", checkbox!["label"]!.GetValue<string>());
        Assert.Equal(
            "我已确认以上内容",
            checkbox["options"]![0]!["label"]!.GetValue<string>());
    }

    private static SqlServerProcessDefinitionQueryService CreateQueryService(SqlServerRuntimeTestScope scope)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:FlowPilot"] = scope.Context.Database.GetConnectionString(),
            })
            .Build();
        return new SqlServerProcessDefinitionQueryService(
            configuration,
            FlowPilotDatabaseOptions.Default,
            TimeProvider.System);
    }
}
