using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Domain.Common;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class TaskCenterController(
    IAuthService authService,
    ITaskCenterQueryService queryService,
    IProcessInstanceCommandService commandService,
    IProcessInstanceQueryService instanceQueryService) : ControllerBase
{
    private const string TaskViewPermission = "work-task:查看";
    private const string TaskReviewPermission = "work-task:审核";
    private const string TaskClosePermission = "work-task:关闭";
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

    [HttpGet("workflow-tasks/{taskId:guid}")]
    [ProducesResponseType<WorkflowTaskDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<WorkflowTaskDetailDto>> GetWorkflowTask(
        Guid taskId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, TaskViewPermission))
        {
            return Forbidden("当前账号没有查看任务的权限。");
        }

        var result = await instanceQueryService.GetTaskAsync(
            taskId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        if (result.Error == ProcessInstanceQueryError.NotFound)
        {
            return ProblemResponse(404, "TASK_NOT_FOUND", "任务不存在", "指定的任务不存在。");
        }

        if (result.Error == ProcessInstanceQueryError.Forbidden)
        {
            return Forbidden("当前账号不在该任务所属流程的数据可见范围内。");
        }

        Response.Headers.ETag = new Revision(result.Detail!.Task.Revision).ToStrongEntityTag();
        return Ok(result.Detail);
    }

    [HttpPost("workflow-tasks/{taskId:guid}/decision")]
    [ProducesResponseType<TaskDecisionResponseDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<TaskDecisionResponseDto>> DecideWorkflowTask(
        Guid taskId,
        [FromBody] TaskDecisionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, TaskReviewPermission))
        {
            return Forbidden("当前账号没有处理审核任务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.DecideTaskAsync(
            taskId,
            request,
            CreateProcessActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!;
        var instanceResult = await instanceQueryService.GetAsync(
            value.InstanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var instance = instanceResult.Instance
            ?? throw new InvalidOperationException("Processed workflow task could not be read.");
        var task = instance.Tasks.Single(item => item.Id == value.TaskId);
        Response.Headers.ETag = new Revision(task.Revision).ToStrongEntityTag();
        return Ok(new TaskDecisionResponseDto(
            instance,
            task,
            value.ActivatedTaskIds,
            value.CancelledTaskIds));
    }

    [HttpPost("workflow-tasks/{taskId:guid}/field-revisions")]
    [ProducesResponseType<ReviseTaskFieldsResponseDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ReviseTaskFieldsResponseDto>> ReviseWorkflowTaskFields(
        Guid taskId,
        [FromBody] ReviseTaskFieldsRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, TaskReviewPermission))
        {
            return Forbidden("当前账号没有处理审核任务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.ReviseTaskFieldsAsync(
            taskId,
            request,
            CreateProcessActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!;
        var instanceResult = await instanceQueryService.GetAsync(
            value.InstanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var instance = instanceResult.Instance
            ?? throw new InvalidOperationException("Revised workflow task could not be read.");
        var task = instance.Tasks.Single(item => item.Id == value.TaskId);
        Response.Headers.ETag = new Revision(task.Revision).ToStrongEntityTag();
        return StatusCode(
            StatusCodes.Status201Created,
            new ReviseTaskFieldsResponseDto(instance, task, value.Revision));
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

    private static ProcessInstanceActor CreateProcessActor(SessionDto session) => new(
        session.User.Id,
        session.OperatorUser.Id,
        session.SuperAdmin,
        false,
        HasPermission(session, TaskReviewPermission),
        HasPermission(session, TaskClosePermission),
        session.User.Name,
        session.User.Department?.Path ?? string.Empty);

    private static ProcessInstanceQueryActor CreateQueryActor(SessionDto session) => new(
        session.User.Id,
        session.SuperAdmin,
        HasPermission(session, TaskReviewPermission),
        HasPermission(session, ProcessLaunchPermission),
        HasPermission(session, ProcessMonitorPermission));

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

    private ObjectResult CommandFailure(ProcessInstanceCommandFailure failure)
    {
        var status = failure.Error switch
        {
            ProcessInstanceCommandError.NotFound => 404,
            ProcessInstanceCommandError.Forbidden => 403,
            ProcessInstanceCommandError.ValidationFailed => 422,
            ProcessInstanceCommandError.PreconditionFailed => 412,
            ProcessInstanceCommandError.Conflict
                or ProcessInstanceCommandError.IdempotencyKeyReused => 409,
            _ => throw new InvalidOperationException("Unsupported task decision failure."),
        };
        return ProblemResponse(status, failure.Code, failure.Title, failure.Detail, failure.Issues);
    }

    private bool TryGetExpectedRevision(out int revision, out ObjectResult? problem)
    {
        revision = default;
        problem = null;
        var values = Request.Headers.IfMatch;
        if (values.Count == 0)
        {
            problem = ProblemResponse(428, "IF_MATCH_REQUIRED", "缺少并发版本", "请求必须携带 If-Match。");
            return false;
        }

        if (values.Count != 1 || !Revision.TryParseStrongEntityTag(values[0], out var parsed))
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "If-Match 格式无效", "If-Match 必须是单个强 ETag。");
            return false;
        }

        revision = parsed.Value;
        return true;
    }

    private bool TryGetIdempotencyKey(out string key, out ObjectResult? problem)
    {
        key = string.Empty;
        problem = null;
        var values = Request.Headers["Idempotency-Key"];
        if (values.Count != 1)
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "缺少幂等键", "请求必须携带一个 Idempotency-Key。");
            return false;
        }

        key = values[0]?.Trim() ?? string.Empty;
        if (key.Length is < 16 or > 100)
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "幂等键格式无效", "Idempotency-Key 的长度必须为 16 到 100 个字符。");
            return false;
        }

        return true;
    }

    private string GetTraceId() => Activity.Current?.TraceId.ToString()
        ?? HttpContext.TraceIdentifier;

    private ObjectResult ProblemResponse(
        int status,
        string code,
        string title,
        string detail,
        IReadOnlyList<ProcessInstanceInputIssueDto>? errors = null)
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
        if (errors is not null)
        {
            problem.Extensions["errors"] = errors;
        }
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
