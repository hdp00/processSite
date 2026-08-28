using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Domain.Common;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class ProcessInstancesController(
    IAuthService authService,
    IProcessInstanceCommandService commandService,
    IProcessInstanceQueryService queryService) : ControllerBase
{
    private const string LaunchPermission = "work-launch:发起";
    private const string CopyPermission = "work-list:复制新建";
    private const string ReviewPermission = "work-task:审核";
    private const string ClosePermission = "work-task:关闭";
    private const string TaskViewPermission = "work-task:查看";
    private const string ProcessListPermission = "work-list:查看";
    private const string ProcessMonitorPermission = "system-monitor:查看";

    [HttpGet("process-instances/{instanceId:guid}")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> Get(
        Guid instanceId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasAnyPermission(
                session,
                ProcessListPermission,
                TaskViewPermission,
                ProcessMonitorPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有查看流程实例详情的页面权限。");
        }

        var result = await queryService.GetAsync(
            instanceId,
            new ProcessInstanceQueryActor(
                session.User.Id,
                session.SuperAdmin,
                HasPermission(session, ReviewPermission),
                HasPermission(session, LaunchPermission),
                HasPermission(session, ProcessMonitorPermission)),
            cancellationToken).ConfigureAwait(false);
        if (result.Error == ProcessInstanceQueryError.NotFound)
        {
            return ProblemResponse(404, "INSTANCE_NOT_FOUND", "流程实例不存在", "指定的流程实例不存在。");
        }

        if (result.Error == ProcessInstanceQueryError.Forbidden)
        {
            return ProblemResponse(403, "INSTANCE_VIEW_FORBIDDEN", "不能查看该流程实例", "当前账号不在该实例的数据可见范围内。");
        }

        var detail = result.Instance
            ?? throw new InvalidOperationException("Process instance query returned no result.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPost("process-instances")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> Create(
        [FromBody] CreateProcessInstanceRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, LaunchPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有发起流程的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.CreateAsync(
            request,
            CreateActor(session),
            idempotencyKey,
            $"{Request.Scheme}://{Request.Host.Value}/flowpilot",
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value
            ?? throw new InvalidOperationException("Process instance command returned no result.");
        Response.Headers.ETag = new Revision(value.Instance.Revision).ToStrongEntityTag();
        var location = $"{ApiConstants.PathBase}/process-instances/{value.Instance.Id:D}";
        return Created(location, value.Instance);
    }

    [HttpPatch("process-instances/{instanceId:guid}/submission")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> UpdateSubmission(
        Guid instanceId,
        [FromBody] UpdateProcessInstanceSubmissionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, LaunchPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有修改发起内容的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.UpdateSubmissionAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Updated process instance could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPost("process-instances/{instanceId:guid}/resubmissions")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> Resubmit(
        Guid instanceId,
        [FromBody] UpdateProcessInstanceSubmissionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, LaunchPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有重新提交流程的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.ResubmitAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Resubmitted process instance could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPost("process-instances/{instanceId:guid}/close")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> Close(
        Guid instanceId,
        [FromBody] CloseInstanceRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, ClosePermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有关闭流程的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.CloseAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Closed process instance could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPost("process-instances/{instanceId:guid}/free-collaboration/replies")]
    [ProducesResponseType<FreeTimelineEntryDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<FreeTimelineEntryDto>> AddFreeReply(
        Guid instanceId,
        [FromBody] CreateFreeReplyRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, TaskViewPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有查看和参与任务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.AddFreeReplyAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!;
        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Updated free-collaboration instance could not be read.");
        var entry = detail.FreeTimeline.Single(item => item.Id == value.EntryId);
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return StatusCode(StatusCodes.Status201Created, entry);
    }

    [HttpPatch("process-instances/{instanceId:guid}/free-collaboration/initial-form")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> UpdateFreeInitialForm(
        Guid instanceId,
        [FromBody] UpdateProcessInstanceSubmissionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, LaunchPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有修改发起内容的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await commandService.UpdateFreeInitialFormAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Updated free-collaboration initial form could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPatch("process-instances/{instanceId:guid}/free-collaboration/replies/{entryId:guid}")]
    [ProducesResponseType<FreeTimelineEntryDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<FreeTimelineEntryDto>> EditFreeReply(
        Guid instanceId,
        Guid entryId,
        [FromBody] EditFreeReplyRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, TaskViewPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有查看和参与任务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        var result = await commandService.EditFreeReplyAsync(
            instanceId,
            entryId,
            request,
            CreateActor(session),
            expectedRevision,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value!;
        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Edited free-collaboration instance could not be read.");
        var entry = detail.FreeTimeline.Single(item => item.Id == value.EntryId);
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(entry);
    }

    [HttpPost("process-instances/{instanceId:guid}/free-collaboration/transfers")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> TransferFree(
        Guid instanceId,
        [FromBody] TransferFreeCollaborationRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, TaskViewPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有查看和参与任务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.TransferFreeAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Transferred free-collaboration instance could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPost("process-instances/{instanceId:guid}/free-collaboration/close")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> CloseFree(
        Guid instanceId,
        [FromBody] CloseInstanceRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, ClosePermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有关闭流程的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.CloseFreeAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Closed free-collaboration instance could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    [HttpPost("process-instances/{instanceId:guid}/free-collaboration/reopen")]
    [ProducesResponseType<ProcessInstanceDetailDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessInstanceDetailDto>> ReopenFree(
        Guid instanceId,
        [FromBody] ReopenFreeCollaborationRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
        }

        if (!HasPermission(session, TaskViewPermission))
        {
            return ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有查看和参与任务的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.ReopenFreeAsync(
            instanceId,
            request,
            CreateActor(session),
            expectedRevision,
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var queryResult = await queryService.GetAsync(
            instanceId,
            CreateQueryActor(session),
            cancellationToken).ConfigureAwait(false);
        var detail = queryResult.Instance
            ?? throw new InvalidOperationException("Reopened free-collaboration instance could not be read.");
        Response.Headers.ETag = new Revision(detail.Revision).ToStrongEntityTag();
        return Ok(detail);
    }

    private static ProcessInstanceActor CreateActor(SessionDto session) => new(
        session.User.Id,
        session.OperatorUser.Id,
        session.SuperAdmin,
        HasPermission(session, CopyPermission),
        HasPermission(session, ReviewPermission),
        HasPermission(session, ClosePermission),
        session.User.Name,
        session.User.Department?.Path ?? string.Empty);

    private static ProcessInstanceQueryActor CreateQueryActor(SessionDto session) => new(
        session.User.Id,
        session.SuperAdmin,
        HasPermission(session, ReviewPermission),
        HasPermission(session, LaunchPermission),
        HasPermission(session, ProcessMonitorPermission));

    private ObjectResult CommandFailure(ProcessInstanceCommandFailure failure)
    {
        var status = failure.Error switch
        {
            ProcessInstanceCommandError.NotFound => 404,
            ProcessInstanceCommandError.Forbidden => 403,
            ProcessInstanceCommandError.ValidationFailed => 422,
            ProcessInstanceCommandError.PreconditionFailed => 412,
            ProcessInstanceCommandError.NotLaunchable
                or ProcessInstanceCommandError.Conflict
                or ProcessInstanceCommandError.IdempotencyKeyReused => 409,
            _ => throw new InvalidOperationException("Unsupported process instance failure."),
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

    private async Task<SessionDto?> GetCurrentSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.GetCurrentSessionAsync(sessionToken, cancellationToken)
            .ConfigureAwait(false);
        return result.Session;
    }

    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);

    private static bool HasAnyPermission(SessionDto session, params string[] permissions) =>
        session.SuperAdmin || permissions.Any(permission =>
            session.Permissions.Contains(permission, StringComparer.Ordinal));

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
        problem.Extensions["traceId"] = GetTraceId();
        if (errors is not null)
        {
            problem.Extensions["errors"] = errors;
        }

        return StatusCode(status, problem);
    }
}
