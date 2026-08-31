using System.Text.Json;
using FlowPilot.Application.Exports;
using FlowPilot.Infrastructure.Exports;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.SqlServerTests;

public sealed class ProcessInstanceExportIntegrationTests
{
    [Fact]
    public async Task SqlQueryAppliesVisibilityTypedFiltersAndDynamicSorting()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateAsync(cancellationToken);
        var visibleUserId = await scope.AddUserAsync("export@example.test", cancellationToken);
        var now = new DateTimeOffset(2026, 8, 31, 4, 0, 0, TimeSpan.Zero);
        var seed = await AddExportRuntimeAsync(scope, visibleUserId, now, cancellationToken);
        var service = new SqlServerProcessInstanceExportService(scope.Context, TimeProvider.System);

        var visibleResult = await service.CreateDatasetAsync(
            CreateFilter(
                seed.Definition.Id,
                DynamicFilters(("amount", "20")),
                [new ProcessInstanceExportSortDto("form-amount", "desc")]),
            new ProcessInstanceExportActor(visibleUserId, visibleUserId, CanViewAllInstances: false),
            "export-visible",
            cancellationToken);

        Assert.Null(visibleResult.Error);
        var visibleDataset = Assert.IsType<ProcessExcelDatasetDto>(visibleResult.Dataset);
        var visibleRow = Assert.Single(visibleDataset.Rows);
        Assert.Equal(seed.VisibleInstanceNumber, visibleRow[0]);
        Assert.Equal(20m, visibleRow[2]);
        Assert.Equal("高", visibleRow[3]);

        var allResult = await service.CreateDatasetAsync(
            CreateFilter(
                seed.Definition.Id,
                null,
                [new ProcessInstanceExportSortDto("form-amount", "desc")]),
            new ProcessInstanceExportActor(
                scope.AdministratorUserId,
                scope.AdministratorUserId,
                CanViewAllInstances: true),
            "export-all",
            cancellationToken);

        Assert.Null(allResult.Error);
        var allRows = Assert.IsType<ProcessExcelDatasetDto>(allResult.Dataset).Rows;
        Assert.Equal(4, allRows.Count);
        Assert.Equal([30m, 20m, 10m], allRows.Take(3).Select(row => row[2]));
        Assert.Equal("V1", allRows[3][1]);
        Assert.Null(allRows[3][2]);

        var auditTraceIds = await scope.Context.RuntimeAuditEvents
            .Where(item => item.ResourceId == seed.Definition.Id && item.Action == "request-export-data")
            .Select(item => item.TraceId)
            .ToArrayAsync(cancellationToken);
        Assert.Contains("export-visible", auditTraceIds);
        Assert.Contains("export-all", auditTraceIds);
    }

    [Fact]
    public async Task InvalidOrUnauthorizedDynamicFilterReturnsAnEmptyResult()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var scope = await SqlServerRuntimeTestScope.CreateAsync(cancellationToken);
        var visibleUserId = await scope.AddUserAsync("filter@example.test", cancellationToken);
        var now = new DateTimeOffset(2026, 8, 31, 5, 0, 0, TimeSpan.Zero);
        var seed = await AddExportRuntimeAsync(scope, visibleUserId, now, cancellationToken);
        var service = new SqlServerProcessInstanceExportService(scope.Context, TimeProvider.System);

        var invalidNumber = await service.CreateDatasetAsync(
            CreateFilter(seed.Definition.Id, DynamicFilters(("amount", "not-a-number")), null),
            new ProcessInstanceExportActor(visibleUserId, visibleUserId, CanViewAllInstances: false),
            "invalid-number",
            cancellationToken);
        var unknownField = await service.CreateDatasetAsync(
            CreateFilter(seed.Definition.Id, DynamicFilters(("unknown", "value")), null),
            new ProcessInstanceExportActor(visibleUserId, visibleUserId, CanViewAllInstances: false),
            "unknown-field",
            cancellationToken);
        var invisibleValue = await service.CreateDatasetAsync(
            CreateFilter(seed.Definition.Id, DynamicFilters(("amount", "30")), null),
            new ProcessInstanceExportActor(visibleUserId, visibleUserId, CanViewAllInstances: false),
            "invisible-value",
            cancellationToken);

        Assert.Equal(ProcessInstanceExportError.EmptyResult, invalidNumber.Error);
        Assert.Equal(ProcessInstanceExportError.EmptyResult, unknownField.Error);
        Assert.Equal(ProcessInstanceExportError.EmptyResult, invisibleValue.Error);
    }

    private static ProcessInstanceExportFilterDto CreateFilter(
        Guid definitionId,
        IReadOnlyDictionary<string, JsonElement>? dynamicFilters,
        IReadOnlyList<ProcessInstanceExportSortDto>? sort) => new(
            new DateOnly(2026, 8, 31),
            new DateOnly(2026, 8, 31),
            definitionId,
            null,
            null,
            null,
            null,
            dynamicFilters,
            sort);

    private static Dictionary<string, JsonElement> DynamicFilters(
        params (string Key, string Value)[] values) => values.ToDictionary(
            item => item.Key,
            item => JsonSerializer.SerializeToElement(item.Value),
            StringComparer.Ordinal);

    private static async Task<ExportSeed> AddExportRuntimeAsync(
        SqlServerRuntimeTestScope scope,
        Guid visibleUserId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var snapshot =
            """
            {
              "systemFields": [
                { "key": "code", "label": "编号", "exportVisible": true },
                { "key": "templateVersion", "label": "版本", "exportVisible": true }
              ],
              "form": { "fields": [
                { "id": "amount", "label": "金额", "type": "number", "exportVisible": true },
                { "id": "priority", "label": "优先级", "type": "select", "exportVisible": true,
                  "options": [
                    { "id": "low", "label": "低" },
                    { "id": "high", "label": "高" }
                  ] }
              ] }
            }
            """;
        var definition = new RuntimeWorkflowDefinition
        {
            Id = Guid.NewGuid(),
            Code = $"EXPORT-{Guid.NewGuid():N}",
            NormalizedCode = $"EXPORT-{Guid.NewGuid():N}",
            Name = "导出测试流程",
            Type = "approval",
            NextVersionNumber = 3,
            Revision = 1,
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        };
        scope.Context.RuntimeWorkflowDefinitions.Add(definition);
        await scope.Context.SaveChangesAsync(cancellationToken);
        var oldVersion = CreateVersion(definition.Id, 1, "V1", "{\"systemFields\":[]}", scope, now);
        var currentVersion = CreateVersion(definition.Id, 2, "V2", snapshot, scope, now);
        scope.Context.RuntimeWorkflowVersions.AddRange(oldVersion, currentVersion);
        await scope.Context.SaveChangesAsync(cancellationToken);
        definition.PublishedVersionId = currentVersion.Id;
        await scope.Context.SaveChangesAsync(cancellationToken);
        await AddFieldCatalogAsync(scope, currentVersion.Id, "amount", "金额", "number", cancellationToken);
        await AddFieldCatalogAsync(scope, currentVersion.Id, "priority", "优先级", "select", cancellationToken);

        var first = CreateInstance(definition.Id, currentVersion.Id, scope.AdministratorUserId, "EXP10", 10, "low", now);
        var visible = CreateInstance(definition.Id, currentVersion.Id, visibleUserId, "EXP20", 20, "high", now);
        var third = CreateInstance(definition.Id, currentVersion.Id, scope.AdministratorUserId, "EXP30", 30, "low", now);
        var historical = CreateHistoricalInstance(definition.Id, oldVersion.Id, scope.AdministratorUserId, "EXP00", now);
        scope.Context.WorkflowInstances.AddRange(first.Instance, visible.Instance, third.Instance, historical);
        await scope.Context.SaveChangesAsync(cancellationToken);
        scope.Context.InstanceFieldValues.AddRange(
            first.Amount, first.Priority,
            visible.Amount, visible.Priority,
            third.Amount, third.Priority);
        await scope.Context.SaveChangesAsync(cancellationToken);
        return new ExportSeed(definition, visible.Instance.InstanceNumber);
    }

    private static RuntimeWorkflowVersion CreateVersion(
        Guid definitionId,
        int number,
        string label,
        string snapshot,
        SqlServerRuntimeTestScope scope,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            DefinitionId = definitionId,
            VersionNumber = number,
            VersionLabel = label,
            BasicJson = "{}",
            SnapshotJson = snapshot,
            InstanceCount = 1,
            Revision = 1,
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CreatedBy = scope.AdministratorUserId,
            UpdatedBy = scope.AdministratorUserId,
        };

    private static async Task AddFieldCatalogAsync(
        SqlServerRuntimeTestScope scope,
        Guid versionId,
        string fieldId,
        string name,
        string type,
        CancellationToken cancellationToken) =>
        await scope.Context.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO [flowpilot].[workflow_version_field_catalog]
                ([id], [version_id], [field_id], [table_field_id], [column_id], [name], [field_type],
                 [is_queryable], [is_listed], [is_exportable], [input_stage])
            VALUES
                ({Guid.NewGuid()}, {versionId}, {fieldId}, NULL, NULL, {name}, {type}, 1, 1, 1, {"initiator"});
            """,
            cancellationToken);

    private static ProjectedInstance CreateInstance(
        Guid definitionId,
        Guid versionId,
        Guid initiatorId,
        string number,
        decimal amount,
        string priority,
        DateTimeOffset now)
    {
        var instance = new WorkflowInstanceEntity
        {
            Id = Guid.NewGuid(),
            InstanceNumber = number + Guid.NewGuid().ToString("N")[..8],
            DefinitionId = definitionId,
            VersionId = versionId,
            InitiatorUserId = initiatorId,
            ActualInitiatorUserId = initiatorId,
            Title = number,
            Status = "reviewing",
            CurrentRound = 1,
            CurrentNodeSummary = "审核",
            FormValuesJson = JsonSerializer.Serialize(new { title = number, amount, priority }),
            FieldRevisionsJson = "{}",
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            Revision = 1,
        };
        return new ProjectedInstance(
            instance,
            new InstanceFieldValueEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instance.Id,
                DefinitionId = definitionId,
                VersionId = versionId,
                FieldId = "amount",
                ValueType = "number",
                NumberValue = amount,
            },
            new InstanceFieldValueEntity
            {
                Id = Guid.NewGuid(),
                InstanceId = instance.Id,
                DefinitionId = definitionId,
                VersionId = versionId,
                FieldId = "priority",
                ValueType = "option",
                OptionId = priority,
            });
    }

    private static WorkflowInstanceEntity CreateHistoricalInstance(
        Guid definitionId,
        Guid versionId,
        Guid initiatorId,
        string number,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            InstanceNumber = number + Guid.NewGuid().ToString("N")[..8],
            DefinitionId = definitionId,
            VersionId = versionId,
            InitiatorUserId = initiatorId,
            ActualInitiatorUserId = initiatorId,
            Title = number,
            Status = "completed",
            CurrentRound = 1,
            CurrentNodeSummary = "流程结束",
            FormValuesJson = JsonSerializer.Serialize(new { title = number }),
            FieldRevisionsJson = "{}",
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            Revision = 1,
        };

    private sealed record ProjectedInstance(
        WorkflowInstanceEntity Instance,
        InstanceFieldValueEntity Amount,
        InstanceFieldValueEntity Priority);

    private sealed record ExportSeed(RuntimeWorkflowDefinition Definition, string VisibleInstanceNumber);
}
