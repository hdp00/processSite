using System.Text.Json;

namespace FlowPilot.Application.Exports;

public sealed record ProcessInstanceExportSortDto(string Field, string Direction);

public sealed record ProcessInstanceExportFilterDto(
    DateOnly DateFrom,
    DateOnly DateTo,
    Guid DefinitionId,
    string? Q,
    string? Status,
    Guid? InitiatorId,
    string? CurrentNode,
    IReadOnlyDictionary<string, JsonElement>? DynamicFilters,
    IReadOnlyList<ProcessInstanceExportSortDto>? Sort);

public sealed record ProcessInstanceExportDataRequest(ProcessInstanceExportFilterDto Filter);

public sealed record ProcessExcelDatasetColumnDto(string Key, string Label, string DataType);

public sealed record ProcessExcelDatasetDto(
    Guid DefinitionId,
    string DefinitionName,
    Guid VersionId,
    string VersionLabel,
    DateTimeOffset GeneratedAt,
    int RowCount,
    IReadOnlyList<ProcessExcelDatasetColumnDto> Columns,
    IReadOnlyList<IReadOnlyList<object?>> Rows);

public sealed record ProcessInstanceExportActor(
    Guid UserId,
    Guid OperatorUserId,
    bool CanViewAllInstances);

public enum ProcessInstanceExportError
{
    DefinitionNotFound,
    NoColumns,
    EmptyResult,
    RowLimitExceeded,
}

public sealed record ProcessInstanceExportResult(
    ProcessExcelDatasetDto? Dataset,
    ProcessInstanceExportError? Error);

public interface IProcessInstanceExportService
{
    Task<ProcessInstanceExportResult> CreateDatasetAsync(
        ProcessInstanceExportFilterDto filter,
        ProcessInstanceExportActor actor,
        string traceId,
        CancellationToken cancellationToken = default);
}
