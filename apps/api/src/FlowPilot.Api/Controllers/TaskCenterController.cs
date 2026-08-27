using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.TaskCenter;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class TaskCenterController(
    IAuthService authService,
    ITaskCenterQueryService queryService) : ControllerBase
{
    private const string TaskViewPermission = "work-task:查看";
    private const string TaskReviewPermission = "work-task:审核";
    private const string ProcessLaunchPermission = "work-launch:发起";
    private const string ProcessListPermission = "work-list:查看";
    private const string ProcessMonitorPermission = "system-monitor:查看";

    private static readonly HashSet<string> InstanceStatuses =
    [
        "reviewing",
        "rejected-pending",
        "completed",
        "in-progress",
        "closed",
    ];

    [HttpGet("me/workflow-tasks")]
    [ProducesResponseType<PageDto<TaskCenterListItemDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<PageDto<TaskCenterListItemDto>>> ListMyWorkflowTasks(
        [FromQuery] WorkflowTaskListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, TaskViewPermission))
        {
            return Forbidden("当前账号没有查看任务中心的权限。");
        }

        var view = parameters.View?.Trim();
        if (view is not ("pending" or "substitutable"))
        {
            return BadRequestProblem("view 必须是 pending 或 substitutable。");
        }

        var actor = CreateActor(session);
        var page = await queryService.ListTasksAsync(
            actor,
            new WorkflowTaskPageQuery(
                parameters.Page,
                parameters.PageSize,
                view,
                NormalizeSearch(parameters.Q),
                parameters.DefinitionId),
            cancellationToken).ConfigureAwait(false);
        return Ok(page);
    }

    [HttpGet("process-instances")]
    [ProducesResponseType<PageDto<ProcessInstanceSummaryDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<PageDto<ProcessInstanceSummaryDto>>> ListProcessInstances(
        [FromQuery] ProcessInstanceListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (parameters.DateFrom is null || parameters.DateTo is null)
        {
            return BadRequestProblem("dateFrom 和 dateTo 不能为空。");
        }

        if (parameters.DateTo < parameters.DateFrom)
        {
            return BadRequestProblem("dateTo 不能早于 dateFrom。");
        }

        if (parameters.DateTo == DateOnly.MaxValue)
        {
            return BadRequestProblem("dateTo 超出支持的日期范围。");
        }

        if (parameters.DateFrom == DateOnly.MinValue)
        {
            return BadRequestProblem("dateFrom 超出支持的日期范围。");
        }

        var status = NormalizeOptional(parameters.Status);
        if (status is not null && !InstanceStatuses.Contains(status))
        {
            return BadRequestProblem("status 不是有效的流程实例状态。");
        }

        if (Request.Query.Keys.Any(IsDynamicFilterKey))
        {
            return BadRequestProblem("当前只读切片尚不支持 dynamicFilters，请先使用公共查询条件。");
        }

        var isOwnActiveTaskView = parameters.ActiveOnly
            && parameters.InitiatorId == session.User.Id;
        var canUseProcessList = HasPermission(session, ProcessListPermission)
            || HasPermission(session, ProcessMonitorPermission);
        if (!canUseProcessList
            && !(isOwnActiveTaskView && HasPermission(session, TaskViewPermission)))
        {
            return Forbidden("当前账号没有查看流程清单的权限。");
        }

        var actor = CreateActor(session);
        var page = await queryService.ListInstancesAsync(
            actor,
            new ProcessInstancePageQuery(
                parameters.Page,
                parameters.PageSize,
                parameters.DateFrom.Value,
                parameters.DateTo.Value,
                NormalizeSearch(parameters.Q),
                parameters.DefinitionId,
                status,
                parameters.InitiatorId,
                parameters.ActiveOnly,
                NormalizeOptional(parameters.CurrentNode),
                isOwnActiveTaskView),
            cancellationToken).ConfigureAwait(false);
        return Ok(page);
    }

    private async Task<SessionDto?> GetCurrentSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.GetCurrentSessionAsync(
            sessionToken,
            cancellationToken).ConfigureAwait(false);
        return result.Session;
    }

    private static TaskCenterActor CreateActor(SessionDto session) => new(
        session.User.Id,
        session.SuperAdmin,
        HasPermission(session, TaskReviewPermission),
        HasPermission(session, ProcessLaunchPermission),
        session.SuperAdmin || HasPermission(session, ProcessMonitorPermission));

    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);

    private static string? NormalizeSearch(string? value)
    {
        var normalized = NormalizeOptional(value);
        return normalized is { Length: > 0 } ? normalized : null;
    }

    private static string? NormalizeOptional(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static bool IsDynamicFilterKey(string key) =>
        key.StartsWith("dynamicFilters", StringComparison.OrdinalIgnoreCase);

    private ObjectResult AuthenticationRequired() => ProblemResponse(
        StatusCodes.Status401Unauthorized,
        "AUTHENTICATION_REQUIRED",
        "尚未登录",
        "当前会话不存在或已失效，请重新登录。");

    private ObjectResult Forbidden(string detail) => ProblemResponse(
        StatusCodes.Status403Forbidden,
        "FORBIDDEN",
        "没有操作权限",
        detail);

    private ObjectResult BadRequestProblem(string detail) => ProblemResponse(
        StatusCodes.Status400BadRequest,
        "BAD_REQUEST",
        "查询条件无效",
        detail);

    private ObjectResult ProblemResponse(
        int status,
        string code,
        string title,
        string detail)
    {
        var problem = new ProblemDetails
        {
            Status = status,
            Type = $"/problems/{code.ToLowerInvariant().Replace('_', '-')}",
            Title = title,
            Detail = detail,
            Instance = Request.Path,
        };
        problem.Extensions["code"] = code;
        problem.Extensions["traceId"] = Activity.Current?.TraceId.ToString()
            ?? HttpContext.TraceIdentifier;
        return StatusCode(status, problem);
    }
}

public sealed class WorkflowTaskListParameters
{
    [Range(1, int.MaxValue)]
    public int Page { get; init; } = 1;

    [Range(1, 200)]
    public int PageSize { get; init; } = 20;

    [StringLength(100)]
    public string? Q { get; init; }

    public string? View { get; init; }

    public Guid? DefinitionId { get; init; }
}

public sealed class ProcessInstanceListParameters
{
    [Range(1, int.MaxValue)]
    public int Page { get; init; } = 1;

    [Range(1, 200)]
    public int PageSize { get; init; } = 20;

    [StringLength(100)]
    public string? Q { get; init; }

    public DateOnly? DateFrom { get; init; }

    public DateOnly? DateTo { get; init; }

    public Guid? DefinitionId { get; init; }

    public string? Status { get; init; }

    public Guid? InitiatorId { get; init; }

    public bool ActiveOnly { get; init; }

    [StringLength(500)]
    public string? CurrentNode { get; init; }
}
