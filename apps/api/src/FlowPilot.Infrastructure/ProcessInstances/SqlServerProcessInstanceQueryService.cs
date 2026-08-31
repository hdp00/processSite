using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceQueryService(
    FlowPilotDbContext dbContext) : IProcessInstanceQueryService
{
    private readonly FlowPilotDbContext _dbContext = dbContext;

    public async Task<ProcessInstanceQueryResult> GetAsync(
        Guid instanceId,
        ProcessInstanceQueryActor actor,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);

        var instance = await _dbContext.WorkflowInstances
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == instanceId, cancellationToken)
            .ConfigureAwait(false);
        if (instance is null)
        {
            return new ProcessInstanceQueryResult(null, ProcessInstanceQueryError.NotFound);
        }

        var definition = await _dbContext.RuntimeWorkflowDefinitions
            .AsNoTracking()
            .SingleAsync(item => item.Id == instance.DefinitionId, cancellationToken)
            .ConfigureAwait(false);
        var version = await _dbContext.RuntimeWorkflowVersions
            .AsNoTracking()
            .SingleAsync(item => item.Id == instance.VersionId, cancellationToken)
            .ConfigureAwait(false);
        var basic = ParseObject(version.BasicJson);
        var snapshot = ParseObject(version.SnapshotJson);
        var effectiveGroupIds = await LoadEffectiveGroupIdsAsync(actor.UserId, cancellationToken)
            .ConfigureAwait(false);
        if (!await CanViewAsync(
                instance,
                version.Id,
                basic,
                actor,
                effectiveGroupIds,
                cancellationToken).ConfigureAwait(false))
        {
            return new ProcessInstanceQueryResult(null, ProcessInstanceQueryError.Forbidden);
        }

        var tasks = await _dbContext.WorkflowTasks
            .AsNoTracking()
            .Where(item => item.InstanceId == instance.Id)
            .OrderBy(item => item.Round)
            .ThenBy(item => item.ActivatedAt)
            .ThenBy(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var events = await _dbContext.WorkflowEvents
            .AsNoTracking()
            .Where(item => item.InstanceId == instance.Id)
            .OrderBy(item => item.OccurredAt)
            .ThenBy(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var freeTimeline = await _dbContext.FreeTimelineEntries
            .AsNoTracking()
            .Where(item => item.InstanceId == instance.Id)
            .OrderBy(item => item.OccurredAt)
            .ThenBy(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var attachmentReferences = await _dbContext.AttachmentReferences
            .AsNoTracking()
            .Where(item => item.InstanceId == instance.Id)
            .OrderBy(item => item.CreatedAt)
            .ThenBy(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var attachmentIds = attachmentReferences.Select(item => item.AttachmentId).Distinct().ToArray();
        var participantIds = await _dbContext.FreeParticipants
            .AsNoTracking()
            .Where(item => item.InstanceId == instance.Id)
            .OrderBy(item => item.FirstParticipatedAt)
            .Select(item => item.UserId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var attachments = await _dbContext.RuntimeAttachments
            .AsNoTracking()
            .Where(item => attachmentIds.Contains(item.Id)
                && (item.State == "staged" || item.State == "active" || item.State == "cleanup-pending"))
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var fields = await _dbContext.RuntimeVersionFields
            .AsNoTracking()
            .Where(item => item.VersionId == version.Id && item.IsListed)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);

        var userIds = new[]
            {
                instance.InitiatorUserId,
                instance.CurrentAssigneeId,
            }
            .Concat(tasks.SelectMany(item => new[]
            {
                item.AssigneeId,
                item.DefaultAssigneeId,
                item.ActualAssigneeId,
            }))
            .Concat(events.SelectMany(item => new Guid?[]
            {
                item.OperatorUserId,
                item.EffectiveUserId,
            }))
            .Concat(freeTimeline.SelectMany(item => new[]
            {
                (Guid?)item.ActorUserId,
                item.AssigneeId,
                item.PreviousAssigneeId,
                item.EditedBy,
            }))
            .Concat(attachments.Select(item => (Guid?)item.UploadedBy))
            .Concat(participantIds.Select(item => (Guid?)item))
            .Where(item => item.HasValue)
            .Select(item => item!.Value)
            .Distinct()
            .ToArray();
        var users = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(item => userIds.Contains(item.Id))
            .ToDictionaryAsync(
                item => item.Id,
                item => new TaskCenterUserRefDto(item.Id, item.DisplayName),
                cancellationToken)
            .ConfigureAwait(false);
        var initiator = users[instance.InitiatorUserId];
        var initiatorUser = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .SingleAsync(item => item.Id == instance.InitiatorUserId, cancellationToken)
            .ConfigureAwait(false);
        var departmentPath = initiatorUser.DepartmentId.HasValue
            ? await _dbContext.Departments
                .AsNoTracking()
                .Where(item => item.Id == initiatorUser.DepartmentId)
                .Select(item => item.Path)
                .SingleOrDefaultAsync(cancellationToken)
                .ConfigureAwait(false)
            : null;
        initiator = initiator with { DepartmentPath = departmentPath ?? string.Empty };

        var formValues = ParseObject(instance.FormValuesJson);
        var fieldRevisions = ParseObject(instance.FieldRevisionsJson);
        var detail = BuildDetail(new DetailSource(
            instance,
            definition,
            version,
            snapshot,
            formValues,
            fieldRevisions,
            fields,
            tasks,
            events,
            freeTimeline,
            attachmentReferences,
            attachments,
            users,
            initiator,
            participantIds,
            effectiveGroupIds,
            actor));
        return new ProcessInstanceQueryResult(detail, null);
    }

    private async Task<bool> CanViewAsync(
        WorkflowInstanceEntity instance,
        Guid versionId,
        JsonObject basic,
        ProcessInstanceQueryActor actor,
        IReadOnlySet<Guid> effectiveGroupIds,
        CancellationToken cancellationToken)
    {
        if (actor.IsSuperAdmin || actor.CanViewAllInstances)
        {
            return true;
        }

        if (instance.InitiatorUserId == actor.UserId
            || instance.ActualInitiatorUserId == actor.UserId
            || instance.CurrentAssigneeId == actor.UserId)
        {
            return true;
        }

        if (await _dbContext.FreeParticipants.AsNoTracking().AnyAsync(
                item => item.InstanceId == instance.Id && item.UserId == actor.UserId,
                cancellationToken).ConfigureAwait(false)
            || await _dbContext.WorkflowTasks.AsNoTracking().AnyAsync(
                item => item.InstanceId == instance.Id
                    && (item.AssigneeId == actor.UserId
                        || item.DefaultAssigneeId == actor.UserId
                        || item.ActualAssigneeId == actor.UserId),
                cancellationToken).ConfigureAwait(false))
        {
            return true;
        }

        var referencedGroupIds = await _dbContext.RuntimeWorkflowGroupReferences
            .AsNoTracking()
            .Where(item => item.VersionId == versionId
                && (item.Purpose == "start" || item.Purpose == "review" || item.Purpose == "close"))
            .Select(item => item.GroupId)
            .Distinct()
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (referencedGroupIds.Any(effectiveGroupIds.Contains))
        {
            return true;
        }

        var visibleUserIds = ReadGuidArray(basic, "visibleUserIds");
        if (visibleUserIds.Contains(actor.UserId))
        {
            return true;
        }

        var visibleRoleIds = await _dbContext.RuntimeWorkflowRoleReferences
            .AsNoTracking()
            .Where(item => item.VersionId == versionId && item.Purpose == "visible")
            .Select(item => item.RoleId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return await (
                from userRole in _dbContext.RuntimeUserRoles.AsNoTracking()
                join role in _dbContext.RuntimeRoles.AsNoTracking()
                    on userRole.RoleId equals role.Id
                where userRole.UserId == actor.UserId
                    && role.IsEnabled
                    && visibleRoleIds.Contains(role.Id)
                select role.Id)
            .AnyAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<HashSet<Guid>> LoadEffectiveGroupIdsAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        var direct = await (
                from member in _dbContext.RuntimeWorkflowGroupUsers.AsNoTracking()
                join workflowGroup in _dbContext.RuntimeWorkflowGroups.AsNoTracking()
                    on member.GroupId equals workflowGroup.Id
                where member.UserId == userId && workflowGroup.IsEnabled
                select member.GroupId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        var throughRoles = await (
                from userRole in _dbContext.RuntimeUserRoles.AsNoTracking()
                join role in _dbContext.RuntimeRoles.AsNoTracking()
                    on userRole.RoleId equals role.Id
                join groupRole in _dbContext.RuntimeWorkflowGroupRoles.AsNoTracking()
                    on role.Id equals groupRole.RoleId
                join workflowGroup in _dbContext.RuntimeWorkflowGroups.AsNoTracking()
                    on groupRole.GroupId equals workflowGroup.Id
                where userRole.UserId == userId && role.IsEnabled && workflowGroup.IsEnabled
                select groupRole.GroupId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return direct.Concat(throughRoles).ToHashSet();
    }

    private static JsonObject ParseObject(string json)
    {
        try
        {
            return JsonNode.Parse(json) as JsonObject
                ?? throw new InvalidDataException("Stored process JSON is not an object.");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("Stored process JSON is invalid.", exception);
        }
    }

    private static HashSet<Guid> ReadGuidArray(JsonObject source, string propertyName) =>
        source[propertyName] is JsonArray values
            ? values
                .Select(value => Guid.TryParse(value?.GetValue<string?>(), out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .ToHashSet()
            : [];

    private sealed record DetailSource(
        WorkflowInstanceEntity Instance,
        RuntimeWorkflowDefinition Definition,
        RuntimeWorkflowVersion Version,
        JsonObject Snapshot,
        JsonObject FormValues,
        JsonObject FieldRevisions,
        IReadOnlyList<RuntimeVersionField> Fields,
        IReadOnlyList<WorkflowTaskEntity> Tasks,
        IReadOnlyList<WorkflowEventEntity> Events,
        IReadOnlyList<FreeTimelineEntryEntity> FreeTimeline,
        IReadOnlyList<AttachmentReferenceEntity> AttachmentReferences,
        IReadOnlyList<RuntimeAttachment> Attachments,
        IReadOnlyDictionary<Guid, TaskCenterUserRefDto> Users,
        TaskCenterUserRefDto Initiator,
        IReadOnlyList<Guid> ParticipantIds,
        IReadOnlySet<Guid> EffectiveGroupIds,
        ProcessInstanceQueryActor Actor);
}
