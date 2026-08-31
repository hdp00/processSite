using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.Governance;
using FlowPilot.Domain.Common;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class GovernanceController(
    IAuthService authService,
    IGovernanceService governanceService) : ControllerBase
{
    private static readonly HashSet<string> EmailStatuses =
        ["pending", "processing", "sent", "retry-wait", "dead-letter"];
    private static readonly HashSet<string> AuditCategories =
        ["authentication", "definition", "instance", "task", "identity"];
    private static readonly HashSet<string> AuditResults = ["success", "failure"];

    [HttpGet("email-outbox")]
    public async Task<ActionResult<GovernancePageDto<EmailOutboxMessageDto>>> ListEmailOutbox(
        [FromQuery] EmailOutboxParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "system-monitor:查看"))
        {
            return Forbidden("当前账号没有查看邮件投递状态的权限。");
        }

        var range = NormalizeDateRange(parameters.DateFrom, parameters.DateTo);
        if (range is null) return BadRequestProblem("dateFrom 不能晚于 dateTo，且 dateTo 不能为 9999-12-31。");
        var status = Normalize(parameters.Status);
        if (status is not null && !EmailStatuses.Contains(status))
        {
            return BadRequestProblem("status 不是有效的邮件状态。");
        }

        return Ok(await governanceService.ListEmailOutboxAsync(new EmailOutboxQuery(
            parameters.Page,
            parameters.PageSize,
            range.Value.From,
            range.Value.To,
            status,
            parameters.InstanceId,
            parameters.TaskId), cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("email-outbox/{messageId:guid}")]
    public async Task<ActionResult<EmailOutboxMessageDto>> GetEmailOutbox(
        Guid messageId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "system-monitor:查看"))
        {
            return Forbidden("当前账号没有查看邮件投递状态的权限。");
        }

        var message = await governanceService.GetEmailOutboxAsync(messageId, cancellationToken)
            .ConfigureAwait(false);
        if (message is null) return NotFoundProblem("EMAIL_OUTBOX_NOT_FOUND", "邮件记录不存在", "未找到指定的邮件投递记录。");
        Response.Headers.ETag = new Revision(message.Revision).ToStrongEntityTag();
        return Ok(message);
    }

    [HttpPost("email-outbox/{messageId:guid}/retry")]
    public async Task<ActionResult<EmailOutboxMessageDto>> RetryEmail(
        Guid messageId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "system-monitor:查看"))
        {
            return Forbidden("当前账号没有重试邮件投递的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var problem)) return problem!;
        if (!TryGetIdempotencyKey(out var idempotencyKey, out problem)) return problem!;
        var result = await governanceService.RetryEmailAsync(
            messageId,
            expectedRevision,
            idempotencyKey,
            session.OperatorUser.Id,
            session.User.Id,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);
        Response.Headers.ETag = new Revision(result.Value!.Revision).ToStrongEntityTag();
        return Accepted(result.Value);
    }

    [HttpGet("audit-events")]
    public async Task<ActionResult<GovernancePageDto<AuditEventDto>>> ListAuditEvents(
        [FromQuery] AuditEventParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "system-audit:查看"))
        {
            return Forbidden("当前账号没有查看操作审计的权限。");
        }

        var range = NormalizeDateRange(parameters.DateFrom, parameters.DateTo);
        if (range is null) return BadRequestProblem("dateFrom 不能晚于 dateTo，且 dateTo 不能为 9999-12-31。");
        var category = Normalize(parameters.Category);
        var result = Normalize(parameters.Result);
        if (category is not null && !AuditCategories.Contains(category))
        {
            return BadRequestProblem("category 不是有效的审计分类。");
        }
        if (result is not null && !AuditResults.Contains(result))
        {
            return BadRequestProblem("result 只能是 success 或 failure。");
        }

        return Ok(await governanceService.ListAuditEventsAsync(new AuditEventQuery(
            parameters.Page,
            parameters.PageSize,
            range.Value.From,
            range.Value.To,
            Normalize(parameters.Q),
            category,
            result,
            parameters.ActorId,
            Normalize(parameters.Action),
            Normalize(parameters.AggregateType),
            parameters.AggregateId,
            Normalize(parameters.TraceId)), cancellationToken).ConfigureAwait(false));
    }

    [HttpGet("audit-events/{auditEventId:guid}")]
    public async Task<ActionResult<AuditEventDto>> GetAuditEvent(
        Guid auditEventId,
        CancellationToken cancellationToken)
    {
        var session = await RequireSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, "system-audit:查看"))
        {
            return Forbidden("当前账号没有查看操作审计的权限。");
        }

        var item = await governanceService.GetAuditEventAsync(auditEventId, cancellationToken)
            .ConfigureAwait(false);
        return item is null
            ? NotFoundProblem("AUDIT_EVENT_NOT_FOUND", "审计事件不存在", "未找到指定的审计事件。")
            : Ok(item);
    }

    private async Task<SessionDto?> RequireSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var token);
        return (await authService.GetCurrentSessionAsync(token, cancellationToken).ConfigureAwait(false)).Session;
    }

    private bool TryGetExpectedRevision(out int revision, out ObjectResult? problem)
    {
        revision = default;
        problem = null;
        if (Request.Headers.IfMatch.Count == 0)
        {
            problem = ProblemResponse(428, "BAD_REQUEST", "缺少并发版本", "请求必须携带 If-Match 强 ETag。");
            return false;
        }
        if (Request.Headers.IfMatch.Count != 1
            || !Revision.TryParseStrongEntityTag(Request.Headers.IfMatch[0], out var parsed))
        {
            problem = ProblemResponse(400, "BAD_REQUEST", "并发版本格式无效", "If-Match 必须是单个强 ETag，例如 \"12\"。");
            return false;
        }
        revision = parsed.Value;
        return true;
    }

    private bool TryGetIdempotencyKey(out string idempotencyKey, out ObjectResult? problem)
    {
        idempotencyKey = Request.Headers["Idempotency-Key"].ToString().Trim();
        problem = null;
        if (idempotencyKey.Length is >= 16 and <= 100) return true;
        problem = ProblemResponse(400, "BAD_REQUEST", "幂等键格式无效", "Idempotency-Key 长度必须为 16 到 100 个字符。");
        return false;
    }

    private ObjectResult CommandFailure(GovernanceCommandFailure failure)
    {
        var status = failure.Error switch
        {
            GovernanceCommandError.NotFound => 404,
            GovernanceCommandError.RevisionMismatch => 412,
            _ => 409,
        };
        if (failure.CurrentRevision.HasValue)
        {
            Response.Headers.ETag = new Revision(failure.CurrentRevision.Value).ToStrongEntityTag();
        }
        return ProblemResponse(status, failure.Code, failure.Title, failure.Detail);
    }

    private static (DateOnly From, DateOnly To)? NormalizeDateRange(DateOnly? from, DateOnly? to)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var result = (From: from ?? today.AddDays(-30), To: to ?? today);
        return result.From <= result.To && result.To != DateOnly.MaxValue ? result : null;
    }

    private static string? Normalize(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);
    private string GetTraceId() => Activity.Current?.TraceId.ToString() ?? HttpContext.TraceIdentifier;
    private ObjectResult AuthenticationRequired() => ProblemResponse(401, "AUTHENTICATION_REQUIRED", "尚未登录", "当前会话不存在或已失效，请重新登录。");
    private ObjectResult Forbidden(string detail) => ProblemResponse(403, "PERMISSION_DENIED", "没有操作权限", detail);
    private ObjectResult BadRequestProblem(string detail) => ProblemResponse(400, "BAD_REQUEST", "查询条件无效", detail);
    private ObjectResult NotFoundProblem(string code, string title, string detail) => ProblemResponse(404, code, title, detail);

    private ObjectResult ProblemResponse(int status, string code, string title, string detail)
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
        return StatusCode(status, problem);
    }
}

public class GovernancePageParameters
{
    [Range(1, 1_000_000)] public int Page { get; init; } = 1;
    [Range(1, 200)] public int PageSize { get; init; } = 20;
    public DateOnly? DateFrom { get; init; }
    public DateOnly? DateTo { get; init; }
}

public sealed class EmailOutboxParameters : GovernancePageParameters
{
    public string? Status { get; init; }
    public Guid? InstanceId { get; init; }
    public Guid? TaskId { get; init; }
}

public sealed class AuditEventParameters : GovernancePageParameters
{
    [StringLength(100)] public string? Q { get; init; }
    public string? Category { get; init; }
    public string? Result { get; init; }
    public Guid? ActorId { get; init; }
    public string? Action { get; init; }
    public string? AggregateType { get; init; }
    public Guid? AggregateId { get; init; }
    public string? TraceId { get; init; }
}
