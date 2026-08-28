using FlowPilot.Application.ProcessInstances;
using FlowPilot.Application.TaskCenter;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceQueryService
{
    public async Task<WorkflowTaskQueryResult> GetTaskAsync(
        Guid taskId,
        ProcessInstanceQueryActor actor,
        CancellationToken cancellationToken = default)
    {
        var instanceId = await _dbContext.WorkflowTasks
            .AsNoTracking()
            .Where(task => task.Id == taskId)
            .Select(task => (Guid?)task.InstanceId)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!instanceId.HasValue)
        {
            return new WorkflowTaskQueryResult(null, ProcessInstanceQueryError.NotFound);
        }

        var instanceResult = await GetAsync(instanceId.Value, actor, cancellationToken)
            .ConfigureAwait(false);
        if (instanceResult.Error is not null)
        {
            return new WorkflowTaskQueryResult(null, instanceResult.Error);
        }

        var instance = instanceResult.Instance!;
        var task = instance.Tasks.Single(item => item.Id == taskId);
        return new WorkflowTaskQueryResult(
            new WorkflowTaskDetailDto(task, ToSummary(instance)),
            null);
    }

    private static ProcessInstanceSummaryDto ToSummary(ProcessInstanceDetailDto instance) => new()
    {
        Id = instance.Id,
        Revision = instance.Revision,
        DefinitionId = instance.DefinitionId,
        VersionId = instance.VersionId,
        Code = instance.Code,
        Title = instance.Title,
        ProcessName = instance.ProcessName,
        VersionLabel = instance.VersionLabel,
        WorkflowType = instance.WorkflowType,
        Status = instance.Status,
        Round = instance.Round,
        CurrentNodeNames = instance.CurrentNodeNames,
        CurrentAssignee = instance.CurrentAssignee,
        Initiator = instance.Initiator,
        CreatedAt = instance.CreatedAt,
        UpdatedAt = instance.UpdatedAt,
        ListValues = instance.ListValues,
    };
}
