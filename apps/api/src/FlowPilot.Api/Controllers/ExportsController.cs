using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Exports;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class ExportsController(
    IAuthService authService,
    IProcessInstanceExportService exportService) : ControllerBase
{
    private const string ProcessListPermission = "work-list:查看";
    private const string ProcessMonitorPermission = "system-monitor:查看";
    private static readonly HashSet<string> InstanceStatuses =
    [
        "reviewing", "rejected-pending", "in-progress", "completed", "closed",
    ];

    [HttpPost("exports/process-instances/data")]
    [ProducesResponseType<ProcessExcelDatasetDto>(StatusCodes.Status200OK)]
    public async Task<ActionResult<ProcessExcelDatasetDto>> GetProcessInstanceData(
        [FromBody] ProcessInstanceExportDataRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }
        if (!HasPermission(session, ProcessListPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有导出流程清单的权限。");
        }

        var validation = Validate(request.Filter);
        if (validation is not null) return validation;

        var result = await exportService.CreateDatasetAsync(
            request.Filter,
            new ProcessInstanceExportActor(
                session.User.Id,
                session.OperatorUser.Id,
                session.SuperAdmin || HasPermission(session, ProcessMonitorPermission)),
            Activity.Current?.TraceId.ToString() ?? HttpContext.TraceIdentifier,
            cancellationToken).ConfigureAwait(false);
        return result.Error switch
        {
            ProcessInstanceExportError.DefinitionNotFound => ProblemResponse(404, "DEFINITION_NOT_FOUND", "流程定义不存在", "未找到可用于导出的发布版本。"),
            ProcessInstanceExportError.NoColumns => ProblemResponse(422, "EXPORT_NO_COLUMNS", "没有配置导出字段", "请先在流程当前发布版本中配置至少一个导出字段。"),
            ProcessInstanceExportError.EmptyResult => ProblemResponse(422, "EXPORT_EMPTY_RESULT", "当前查询没有可导出数据", "请调整查询条件后重试。"),
            ProcessInstanceExportError.RowLimitExceeded => ProblemResponse(422, "EXPORT_ROW_LIMIT_EXCEEDED", "导出数据量超过上限", "单次最多导出 10000 条，请缩小查询范围。"),
            null when result.Dataset is not null => Ok(result.Dataset),
            _ => throw new InvalidOperationException("Process instance export returned no result."),
        };
    }

    private static ObjectResult? Validate(ProcessInstanceExportFilterDto filter)
    {
        if (filter.DateTo < filter.DateFrom)
        {
            return ProblemResponse(422, "DATE_RANGE_INVALID", "导出时间范围无效", "开始日期不能晚于结束日期。");
        }
        if (filter.DateTo == DateOnly.MaxValue)
        {
            return ProblemResponse(422, "DATE_RANGE_INVALID", "导出时间范围无效", "结束日期超出支持范围。");
        }
        if (filter.Q?.Length > 100)
        {
            return ProblemResponse(400, "VALIDATION_FAILED", "查询条件无效", "关键词最多 100 个字符。");
        }
        if (filter.Status is not null && !InstanceStatuses.Contains(filter.Status))
        {
            return ProblemResponse(400, "VALIDATION_FAILED", "查询条件无效", "流程状态不正确。");
        }
        if (filter.Sort?.Any(item => item.Direction is not ("asc" or "desc")) == true)
        {
            return ProblemResponse(400, "VALIDATION_FAILED", "排序条件无效", "排序方向只能是 asc 或 desc。");
        }
        return null;
    }

    private async Task<SessionDto?> GetCurrentSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        return (await authService.GetCurrentSessionAsync(sessionToken, cancellationToken).ConfigureAwait(false)).Session;
    }

    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);

    private static ObjectResult ProblemResponse(int status, string code, string title, string detail) => new(new ProblemDetails
    {
        Status = status,
        Title = title,
        Detail = detail,
        Extensions = { ["code"] = code },
    })
    { StatusCode = status };
}
