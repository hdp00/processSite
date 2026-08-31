using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using FlowPilot.Application.Authentication;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Domain.Common;
using Microsoft.AspNetCore.Mvc;

namespace FlowPilot.Api.Controllers;

[ApiController]
public sealed class ProcessDefinitionsController(
    IAuthService authService,
    IProcessDefinitionQueryService queryService,
    IProcessDefinitionCommandService commandService) : ControllerBase
{
    private const string DefinitionViewPermission = "config-definition:查看";
    private const string DefinitionEditPermission = "config-definition:编辑";
    private const string DefinitionPublishPermission = "config-definition:发布";
    private const string DefinitionDeletePermission = "config-definition:删除";
    private const string FormEditPermission = "config-form:编辑";
    private const string ProcessLaunchViewPermission = "work-launch:查看";
    private const string ProcessLaunchPermission = "work-launch:发起";
    private const string ProcessListViewPermission = "work-list:查看";
    private const string TaskViewPermission = "work-task:查看";
    private const string ProcessMonitorPermission = "system-monitor:查看";

    private static readonly HashSet<string> DefinitionTypes = ["approval", "free"];
    private static readonly HashSet<string> DefinitionStatuses =
        ["unpublished", "published", "disabled"];

    [HttpGet("process-definitions")]
    [ProducesResponseType<ProcessDefinitionPageDto<ProcessDefinitionDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<ProcessDefinitionPageDto<ProcessDefinitionDto>>> List(
        [FromQuery] ProcessDefinitionListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionViewPermission))
        {
            return Forbidden("当前账号没有查看流程定义的权限。");
        }

        var type = NormalizeOptional(parameters.Type);
        if (type is not null && !DefinitionTypes.Contains(type))
        {
            return BadRequestProblem("type 必须是 approval 或 free。");
        }

        var status = NormalizeOptional(parameters.Status);
        if (status is not null && !DefinitionStatuses.Contains(status))
        {
            return BadRequestProblem("status 必须是 unpublished、published 或 disabled。");
        }

        var page = await queryService.ListAsync(
            new ProcessDefinitionPageQuery(
                parameters.Page,
                parameters.PageSize,
                NormalizeOptional(parameters.Q),
                type,
                status),
            cancellationToken).ConfigureAwait(false);
        return Ok(page);
    }

    [HttpPost("process-definitions")]
    [ProducesResponseType<CreateProcessDefinitionResponseDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<CreateProcessDefinitionResponseDto>> Create(
        [FromBody] CreateProcessDefinitionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有创建流程定义的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.CreateAsync(
            request.Basic,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value
            ?? throw new InvalidOperationException("Process definition command returned no result.");
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        var location = $"{ApiConstants.PathBase}/process-definitions/{value.Response.Definition.Id:D}";
        return Created(location, value.Response);
    }

    [HttpPost("process-definitions/imports")]
    [ProducesResponseType<ProcessDefinitionWithVersionsDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<ProcessDefinitionWithVersionsDto>> Import(
        [FromBody] ImportProcessDefinitionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有导入流程定义的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.ImportAsync(
            request,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);

        var value = result.Value!;
        var imported = await LoadDefinitionWithVersionsAsync(value.DefinitionId, cancellationToken)
            .ConfigureAwait(false);
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        var location = $"{ApiConstants.PathBase}/process-definitions/{value.DefinitionId:D}";
        return Created(location, imported);
    }

    [HttpGet("me/launchable-process-definitions")]
    [ProducesResponseType<IReadOnlyList<LaunchableProcessDefinitionDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<IReadOnlyList<LaunchableProcessDefinitionDto>>> ListLaunchable(
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, ProcessLaunchViewPermission))
        {
            return Forbidden("当前账号没有查看流程发起中心的权限。");
        }

        var items = await queryService.ListLaunchableAsync(
            new ProcessDefinitionActor(session.User.Id, session.SuperAdmin, false),
            cancellationToken).ConfigureAwait(false);
        return Ok(items);
    }

    [HttpGet("me/visible-process-definitions")]
    [ProducesResponseType<ProcessDefinitionPageDto<VisibleProcessDefinitionDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<ProcessDefinitionPageDto<VisibleProcessDefinitionDto>>> ListVisible(
        [FromQuery] VisibleProcessDefinitionListParameters parameters,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasAnyPermission(
                session,
                ProcessLaunchViewPermission,
                ProcessListViewPermission,
                TaskViewPermission,
                ProcessMonitorPermission))
        {
            return Forbidden("当前账号没有查看流程发起、任务中心、流程清单或实例监控的权限。");
        }

        var page = await queryService.ListVisibleAsync(
            new ProcessDefinitionActor(
                session.User.Id,
                session.SuperAdmin,
                session.SuperAdmin || HasPermission(session, ProcessMonitorPermission)),
            new VisibleProcessDefinitionPageQuery(parameters.Page, parameters.PageSize),
            cancellationToken).ConfigureAwait(false);
        return Ok(page);
    }

    [HttpGet("process-definitions/{definitionId:guid}")]
    [ProducesResponseType<ProcessDefinitionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProcessDefinitionDto>> Get(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionViewPermission))
        {
            return Forbidden("当前账号没有查看流程定义的权限。");
        }

        var definition = await queryService.GetAsync(definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return NotFoundProblem("DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。");
        }

        Response.Headers.ETag = new Revision(definition.Revision).ToStrongEntityTag();
        return Ok(definition);
    }

    [HttpPatch("process-definitions/{definitionId:guid}")]
    [ProducesResponseType<ProcessDefinitionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessDefinitionDto>> UpdateAvailability(
        Guid definitionId,
        [FromBody] UpdateProcessDefinitionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有启用或停用流程定义的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.UpdateAvailabilityAsync(
            definitionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);

        var definition = await queryService.GetAsync(definitionId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Updated process definition could not be reloaded.");
        Response.Headers.ETag = new Revision(result.Value!.Revision).ToStrongEntityTag();
        return Ok(definition);
    }

    [HttpDelete("process-definitions/{definitionId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeleteDefinition(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionDeletePermission))
        {
            return Forbidden("当前账号没有删除流程定义的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.DeleteDefinitionAsync(
            definitionId,
            expectedRevision,
            CreateMutationActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpPost("process-definitions/{definitionId:guid}/copies")]
    [ProducesResponseType<CreateProcessDefinitionResponseDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<CreateProcessDefinitionResponseDto>> Copy(
        Guid definitionId,
        [FromBody] CopyProcessDefinitionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有复制流程定义的权限。");
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.CopyAsync(
            definitionId,
            request,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);

        var value = result.Value!;
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        var location = $"{ApiConstants.PathBase}/process-definitions/{value.Response.Definition.Id:D}";
        return Created(location, value.Response);
    }

    [HttpGet("process-definitions/{definitionId:guid}/export")]
    [ProducesResponseType<System.Text.Json.Nodes.JsonObject>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<System.Text.Json.Nodes.JsonObject>> Export(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionViewPermission))
        {
            return Forbidden("当前账号没有导出流程定义的权限。");
        }

        var document = await queryService.ExportAsync(definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (document is null)
        {
            return NotFoundProblem("DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。");
        }

        var definition = await queryService.GetAsync(definitionId, cancellationToken)
            .ConfigureAwait(false);
        var fileName = Uri.EscapeDataString($"{definition!.Name}_流程定义.json");
        Response.Headers.ContentDisposition = $"attachment; filename*=UTF-8''{fileName}";
        return Ok(document);
    }

    [HttpGet("process-definitions/{definitionId:guid}/launch-config")]
    [ProducesResponseType<ProcessLaunchConfigDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ProcessLaunchConfigDto>> GetLaunchConfig(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, ProcessLaunchPermission))
        {
            return Forbidden("当前账号没有发起流程的权限。");
        }

        var result = await queryService.GetLaunchConfigAsync(
            definitionId,
            new ProcessDefinitionActor(session.User.Id, session.SuperAdmin, false),
            cancellationToken).ConfigureAwait(false);
        if (result.Config is not null)
        {
            Response.Headers.ETag = new Revision(result.Config.Version.Revision).ToStrongEntityTag();
            return Ok(result.Config);
        }

        return result.Error switch
        {
            ProcessLaunchConfigError.NotFound => NotFoundProblem(
                "DEFINITION_NOT_FOUND",
                "流程定义不存在",
                "未找到指定的流程定义。"),
            ProcessLaunchConfigError.Forbidden => ProblemResponse(
                StatusCodes.Status403Forbidden,
                "LAUNCH_FORBIDDEN",
                "无权发起该流程",
                "当前用户不属于该流程的发起权限组。"),
            ProcessLaunchConfigError.NotLaunchable => ProblemResponse(
                StatusCodes.Status409Conflict,
                "DEFINITION_NOT_LAUNCHABLE",
                "流程暂不可发起",
                "流程未发布、已经停用，或发布版本的外部依赖当前不可用。"),
            _ => throw new InvalidOperationException("Process launch query returned no result."),
        };
    }

    [HttpGet("process-definitions/{definitionId:guid}/versions")]
    [ProducesResponseType<IReadOnlyList<ProcessVersionSummaryDto>>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IReadOnlyList<ProcessVersionSummaryDto>>> ListVersions(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionViewPermission))
        {
            return Forbidden("当前账号没有查看流程定义的权限。");
        }

        var versions = await queryService.ListVersionsAsync(definitionId, cancellationToken)
            .ConfigureAwait(false);
        return versions is null
            ? NotFoundProblem("DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。")
            : Ok(versions);
    }

    [HttpPost("process-definitions/{definitionId:guid}/versions")]
    [ProducesResponseType<ProcessVersionDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessVersionDto>> CreateVersion(
        Guid definitionId,
        [FromBody] CreateProcessVersionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有创建流程版本的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.CreateVersionAsync(
            definitionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded) return CommandFailure(result.Failure!);

        var version = result.Value!.Version;
        Response.Headers.ETag = new Revision(version.Revision).ToStrongEntityTag();
        var location = $"{ApiConstants.PathBase}/process-definitions/{definitionId:D}/versions/{version.Id:D}";
        return Created(location, version);
    }

    [HttpGet("process-definitions/{definitionId:guid}/versions/{versionId:guid}")]
    [ProducesResponseType<ProcessVersionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProcessVersionDto>> GetVersion(
        Guid definitionId,
        Guid versionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionViewPermission))
        {
            return Forbidden("当前账号没有查看流程定义的权限。");
        }

        var version = await queryService.GetVersionAsync(definitionId, versionId, cancellationToken)
            .ConfigureAwait(false);
        if (version is null)
        {
            return NotFoundProblem("VERSION_NOT_FOUND", "流程版本不存在", "未找到指定的流程版本。");
        }

        Response.Headers.ETag = new Revision(version.Revision).ToStrongEntityTag();
        return Ok(version);
    }

    [HttpDelete("process-definitions/{definitionId:guid}/versions/{versionId:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<IActionResult> DeleteVersion(
        Guid definitionId,
        Guid versionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null) return AuthenticationRequired();
        if (!HasPermission(session, DefinitionDeletePermission))
        {
            return Forbidden("当前账号没有删除流程版本的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.DeleteVersionAsync(
            definitionId,
            versionId,
            expectedRevision,
            CreateMutationActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return result.Succeeded ? NoContent() : CommandFailure(result.Failure!);
    }

    [HttpPut("process-definitions/{definitionId:guid}/versions/{versionId:guid}/basic")]
    [ProducesResponseType<SaveProcessVersionResponseDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<SaveProcessVersionResponseDto>> SaveBasic(
        Guid definitionId,
        Guid versionId,
        [FromBody] ProcessBasicConfigInput request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有编辑流程基本信息的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.SaveBasicAsync(
            definitionId,
            versionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return await SavedVersionResponseAsync(
            definitionId,
            versionId,
            result,
            cancellationToken).ConfigureAwait(false);
    }

    [HttpPut("process-definitions/{definitionId:guid}/versions/{versionId:guid}/form-designer")]
    [ProducesResponseType<SaveProcessVersionResponseDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<SaveProcessVersionResponseDto>> SaveForm(
        Guid definitionId,
        Guid versionId,
        [FromBody] SaveFormDesignerRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, FormEditPermission))
        {
            return Forbidden("当前账号没有编辑表单设计的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.SaveFormAsync(
            definitionId,
            versionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return await SavedVersionResponseAsync(
            definitionId,
            versionId,
            result,
            cancellationToken).ConfigureAwait(false);
    }

    [HttpPut("process-definitions/{definitionId:guid}/versions/{versionId:guid}/flow-designer")]
    [ProducesResponseType<SaveProcessVersionResponseDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<SaveProcessVersionResponseDto>> SaveFlow(
        Guid definitionId,
        Guid versionId,
        [FromBody] SaveFlowDesignerRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionEditPermission))
        {
            return Forbidden("当前账号没有编辑流程设计的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var headerProblem))
        {
            return headerProblem!;
        }

        var result = await commandService.SaveFlowAsync(
            definitionId,
            versionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        return await SavedVersionResponseAsync(
            definitionId,
            versionId,
            result,
            cancellationToken).ConfigureAwait(false);
    }

    [HttpPost("process-definitions/{definitionId:guid}/versions/{versionId:guid}/validate")]
    [ProducesResponseType<ProcessVersionValidationDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessVersionValidationDto>> Validate(
        Guid definitionId,
        Guid versionId,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionPublishPermission))
        {
            return Forbidden("当前账号没有校验流程版本的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.ValidateAsync(
            definitionId,
            versionId,
            expectedRevision,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value
            ?? throw new InvalidOperationException("Process validation command returned no result.");
        Response.Headers.ETag = new Revision(value.Revision).ToStrongEntityTag();
        return Ok(value.Validation);
    }

    [HttpPost("process-definitions/{definitionId:guid}/versions/{versionId:guid}/publish")]
    [ProducesResponseType<PublishProcessVersionResponseDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<PublishProcessVersionResponseDto>> Publish(
        Guid definitionId,
        Guid versionId,
        [FromBody] PublishProcessVersionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionPublishPermission))
        {
            return Forbidden("当前账号没有发布流程版本的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.PublishAsync(
            definitionId,
            versionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value
            ?? throw new InvalidOperationException("Process publish command returned no result.");
        var definition = await queryService.GetAsync(definitionId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Published process definition could not be reloaded.");
        var version = await queryService.GetVersionAsync(definitionId, versionId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Published process version could not be reloaded.");

        Response.Headers.ETag = new Revision(value.DefinitionRevision).ToStrongEntityTag();
        return Ok(new PublishProcessVersionResponseDto(
            definition,
            version,
            value.PreviousPublishedVersionId));
    }

    [HttpPost("process-definitions/{definitionId:guid}/versions/{versionId:guid}/unpublish")]
    [ProducesResponseType<ProcessDefinitionDto>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status403Forbidden)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status428PreconditionRequired)]
    public async Task<ActionResult<ProcessDefinitionDto>> Unpublish(
        Guid definitionId,
        Guid versionId,
        [FromBody] UnpublishProcessVersionRequest request,
        CancellationToken cancellationToken)
    {
        var session = await GetCurrentSessionAsync(cancellationToken).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationRequired();
        }

        if (!HasPermission(session, DefinitionPublishPermission))
        {
            return Forbidden("当前账号没有取消发布流程版本的权限。");
        }

        if (!TryGetExpectedRevision(out var expectedRevision, out var revisionProblem))
        {
            return revisionProblem!;
        }

        if (!TryGetIdempotencyKey(out var idempotencyKey, out var idempotencyProblem))
        {
            return idempotencyProblem!;
        }

        var result = await commandService.UnpublishAsync(
            definitionId,
            versionId,
            request,
            expectedRevision,
            CreateMutationActor(session),
            idempotencyKey,
            GetTraceId(),
            cancellationToken).ConfigureAwait(false);
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value
            ?? throw new InvalidOperationException("Process unpublish command returned no result.");
        var definition = await queryService.GetAsync(definitionId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Unpublished process definition could not be reloaded.");

        Response.Headers.ETag = new Revision(value.DefinitionRevision).ToStrongEntityTag();
        return Ok(definition);
    }

    private async Task<ActionResult<SaveProcessVersionResponseDto>> SavedVersionResponseAsync(
        Guid definitionId,
        Guid versionId,
        ProcessDefinitionCommandResult<SaveProcessVersionCommandValue> result,
        CancellationToken cancellationToken)
    {
        if (!result.Succeeded)
        {
            return CommandFailure(result.Failure!);
        }

        var value = result.Value
            ?? throw new InvalidOperationException("Process version command returned no result.");
        var version = await queryService.GetVersionAsync(
            definitionId,
            versionId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Saved process version could not be reloaded.");

        Response.Headers.ETag = new Revision(version.Revision).ToStrongEntityTag();
        return Ok(new SaveProcessVersionResponseDto(version, value.RemovedReferences));
    }

    private bool TryGetExpectedRevision(
        out int expectedRevision,
        out ObjectResult? problem)
    {
        expectedRevision = default;
        problem = null;

        var values = Request.Headers.IfMatch;
        if (values.Count == 0)
        {
            problem = ProblemResponse(
                StatusCodes.Status428PreconditionRequired,
                "BAD_REQUEST",
                "缺少并发版本",
                "请求必须携带上次读取资源时获得的 If-Match 强 ETag。");
            return false;
        }

        if (values.Count != 1
            || !Revision.TryParseStrongEntityTag(values[0], out var revision))
        {
            problem = ProblemResponse(
                StatusCodes.Status400BadRequest,
                "BAD_REQUEST",
                "并发版本格式无效",
                "If-Match 必须是单个强 ETag，例如 \"12\"。");
            return false;
        }

        expectedRevision = revision.Value;
        return true;
    }

    private bool TryGetIdempotencyKey(
        out string idempotencyKey,
        out ObjectResult? problem)
    {
        idempotencyKey = string.Empty;
        problem = null;

        var values = Request.Headers["Idempotency-Key"];
        if (values.Count != 1)
        {
            problem = ProblemResponse(
                StatusCodes.Status400BadRequest,
                "BAD_REQUEST",
                "缺少幂等键",
                "请求必须携带一个 Idempotency-Key。");
            return false;
        }

        var value = values[0]?.Trim() ?? string.Empty;
        if (value.Length is < 16 or > 100)
        {
            problem = ProblemResponse(
                StatusCodes.Status400BadRequest,
                "BAD_REQUEST",
                "幂等键格式无效",
                "Idempotency-Key 的长度必须为 16 到 100 个字符。");
            return false;
        }

        idempotencyKey = value;
        return true;
    }

    private ObjectResult CommandFailure(ProcessDefinitionCommandFailure failure)
    {
        var status = failure.Error switch
        {
            ProcessDefinitionCommandError.NotFound => StatusCodes.Status404NotFound,
            ProcessDefinitionCommandError.RevisionMismatch =>
                StatusCodes.Status412PreconditionFailed,
            ProcessDefinitionCommandError.ValidationFailed =>
                StatusCodes.Status422UnprocessableEntity,
            ProcessDefinitionCommandError.VersionNotEditable
                or ProcessDefinitionCommandError.Conflict
                or ProcessDefinitionCommandError.IdempotencyKeyReused
                or ProcessDefinitionCommandError.IdempotencyRequestInProgress =>
                StatusCodes.Status409Conflict,
            _ => throw new InvalidOperationException("Unsupported process definition failure."),
        };

        string? currentEtag = null;
        if (failure.Error == ProcessDefinitionCommandError.RevisionMismatch
            && failure.CurrentRevision is { } currentRevision)
        {
            currentEtag = new Revision(currentRevision).ToStrongEntityTag();
            Response.Headers.ETag = currentEtag;
        }

        return ProblemResponse(
            status,
            failure.Code,
            failure.Title,
            failure.Detail,
            failure.Issues,
            currentEtag);
    }

    private static ProcessDefinitionMutationActor CreateMutationActor(SessionDto session) =>
        new(session.User.Id, session.OperatorUser.Id, session.User.Name);

    private string GetTraceId() => Activity.Current?.TraceId.ToString()
        ?? HttpContext.TraceIdentifier;

    private async Task<SessionDto?> GetCurrentSessionAsync(CancellationToken cancellationToken)
    {
        Request.Cookies.TryGetValue(ApiConstants.SessionCookieName, out var sessionToken);
        var result = await authService.GetCurrentSessionAsync(sessionToken, cancellationToken)
            .ConfigureAwait(false);
        return result.Session;
    }

    private async Task<ProcessDefinitionWithVersionsDto> LoadDefinitionWithVersionsAsync(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var definition = await queryService.GetAsync(definitionId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Imported process definition could not be reloaded.");
        var summaries = await queryService.ListVersionsAsync(definitionId, cancellationToken)
            .ConfigureAwait(false)
            ?? [];
        var versions = new List<ProcessVersionDto>(summaries.Count);
        foreach (var summary in summaries)
        {
            var version = await queryService.GetVersionAsync(definitionId, summary.Id, cancellationToken)
                .ConfigureAwait(false);
            if (version is not null) versions.Add(version);
        }

        return new ProcessDefinitionWithVersionsDto
        {
            Id = definition.Id,
            Revision = definition.Revision,
            Code = definition.Code,
            Name = definition.Name,
            Description = definition.Description,
            Type = definition.Type,
            Disabled = definition.Disabled,
            Status = definition.Status,
            PublishedVersionId = definition.PublishedVersionId,
            PublishedVersion = definition.PublishedVersion,
            PublishedInstancePrefix = definition.PublishedInstancePrefix,
            NextVersionNumber = definition.NextVersionNumber,
            VersionCount = definition.VersionCount,
            InstanceCount = definition.InstanceCount,
            UpdatedAt = definition.UpdatedAt,
            UpdatedBy = definition.UpdatedBy,
            Versions = versions,
        };
    }

    private static bool HasPermission(SessionDto session, string permission) =>
        session.SuperAdmin || session.Permissions.Contains(permission, StringComparer.Ordinal);

    private static bool HasAnyPermission(SessionDto session, params string[] permissions) =>
        session.SuperAdmin || permissions.Any(permission =>
            session.Permissions.Contains(permission, StringComparer.Ordinal));

    private static string? NormalizeOptional(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private ObjectResult AuthenticationRequired() => ProblemResponse(
        StatusCodes.Status401Unauthorized,
        "AUTHENTICATION_REQUIRED",
        "尚未登录",
        "当前会话不存在或已失效，请重新登录。");

    private ObjectResult Forbidden(string detail) => ProblemResponse(
        StatusCodes.Status403Forbidden,
        "PERMISSION_DENIED",
        "没有操作权限",
        detail);

    private ObjectResult BadRequestProblem(string detail) => ProblemResponse(
        StatusCodes.Status400BadRequest,
        "BAD_REQUEST",
        "查询条件无效",
        detail);

    private ObjectResult NotFoundProblem(string code, string title, string detail) =>
        ProblemResponse(StatusCodes.Status404NotFound, code, title, detail);

    private ObjectResult ProblemResponse(
        int status,
        string code,
        string title,
        string detail,
        IReadOnlyList<ProcessDefinitionInputIssueDto>? errors = null,
        string? currentEtag = null)
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

        if (currentEtag is not null)
        {
            problem.Extensions["currentEtag"] = currentEtag;
        }

        return StatusCode(status, problem);
    }
}

public sealed class ProcessDefinitionListParameters
{
    [Range(1, 1_000_000)]
    public int Page { get; init; } = 1;

    [Range(1, 200)]
    public int PageSize { get; init; } = 20;

    [StringLength(100)]
    public string? Q { get; init; }

    public string? Type { get; init; }

    public string? Status { get; init; }
}

public sealed class VisibleProcessDefinitionListParameters
{
    [Range(1, 1_000_000)]
    public int Page { get; init; } = 1;

    [Range(1, 200)]
    public int PageSize { get; init; } = 20;
}
