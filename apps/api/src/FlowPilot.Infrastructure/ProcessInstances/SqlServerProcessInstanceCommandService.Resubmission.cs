using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlowPilot.Application.ProcessInstances;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private const string ResubmitRouteScope = "POST /process-instances/{instanceId}/resubmissions";

    public async Task<ProcessInstanceCommandResult<ResubmitProcessInstanceCommandValue>> ResubmitAsync(
        Guid instanceId,
        UpdateProcessInstanceSubmissionRequest request,
        ProcessInstanceActor actor,
        int expectedRevision,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);

        var requestFailure = ValidateResubmissionRequest(request);
        if (requestFailure is not null)
        {
            return ResubmitFailed(requestFailure);
        }

        var requestHash = Convert.ToHexStringLower(SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(new { instanceId, request }, JsonOptions)));
        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var replay = await LoadResubmissionReplayAsync(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return replay;
            }

            var instance = await _dbContext.WorkflowInstances
                .SingleOrDefaultAsync(item => item.Id == instanceId, cancellationToken)
                .ConfigureAwait(false);
            var stateFailure = ValidateRejectedInstance(instance, actor, expectedRevision);
            if (stateFailure is not null)
            {
                return await RollbackResubmitFailureAsync(transaction, stateFailure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var rejectedInstance = instance!;
            var version = await _dbContext.RuntimeWorkflowVersions
                .SingleAsync(item => item.Id == rejectedInstance.VersionId, cancellationToken)
                .ConfigureAwait(false);
            var definition = await _dbContext.RuntimeWorkflowDefinitions
                .SingleAsync(item => item.Id == rejectedInstance.DefinitionId, cancellationToken)
                .ConfigureAwait(false);
            if (definition.Type != "approval" || !TryParseVersion(version, out _, out var snapshot))
            {
                return await RollbackResubmitFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "LOCKED_VERSION_INVALID",
                        "流程版本不可用",
                        "实例锁定的审批流程版本配置无法读取。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var lockedSnapshot = snapshot!;
            if (ReadString(lockedSnapshot["flow"]?["meta"] as JsonObject, "rejectionHandling") == "auto-close")
            {
                return await RollbackResubmitFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "RESUBMISSION_NOT_ALLOWED",
                        "不能重新提交",
                        "实例锁定版本配置为驳回后自动关闭。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var resubmissionTask = await _dbContext.WorkflowTasks
                .SingleOrDefaultAsync(task => task.InstanceId == rejectedInstance.Id
                    && task.TaskType == "resubmission"
                    && task.Status == "pending",
                    cancellationToken)
                .ConfigureAwait(false);
            if (resubmissionTask is null
                || resubmissionTask.AssigneeId != rejectedInstance.InitiatorUserId
                || resubmissionTask.Round != rejectedInstance.CurrentRound)
            {
                return await RollbackResubmitFailureAsync(
                    transaction,
                    Failure(
                        ProcessInstanceCommandError.Conflict,
                        "RESUBMISSION_TASK_UNAVAILABLE",
                        "待重新提交任务不可用",
                        "实例没有与当前轮次匹配的待重新提交任务，请刷新后重试。"),
                    cancellationToken).ConfigureAwait(false);
            }

            var oldValues = ParseStoredObject(rejectedInstance.FormValuesJson);
            var form = NormalizeAndValidateForm(request.FormValues!, lockedSnapshot, oldValues);
            if (form.Failure is not null)
            {
                return await RollbackResubmitFailureAsync(transaction, form.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var currentReferences = await _dbContext.AttachmentReferences
                .Where(reference => reference.InstanceId == rejectedInstance.Id
                    && reference.ReferenceType == "form-field")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var attachments = await ValidateUpdatedAttachmentsAsync(
                request,
                lockedSnapshot,
                actor.EffectiveUserId,
                currentReferences,
                cancellationToken).ConfigureAwait(false);
            if (attachments.Failure is not null)
            {
                return await RollbackResubmitFailureAsync(transaction, attachments.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var previousTasks = await _dbContext.WorkflowTasks
                .Where(task => task.InstanceId == rejectedInstance.Id
                    && task.Round == rejectedInstance.CurrentRound
                    && task.TaskType == "approval")
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            var now = _timeProvider.GetUtcNow();
            var nextRound = checked(rejectedInstance.CurrentRound + 1);
            var runtime = BuildResubmissionRuntime(
                lockedSnapshot,
                form.Values!,
                previousTasks,
                nextRound,
                now);
            if (runtime.Failure is not null)
            {
                return await RollbackResubmitFailureAsync(transaction, runtime.Failure, cancellationToken)
                    .ConfigureAwait(false);
            }

            var changedFieldIds = ChangedFieldIds(oldValues, form.Values!);
            var changedAttachmentFieldIds = await ReplaceAttachmentReferencesAsync(
                rejectedInstance.Id,
                currentReferences,
                attachments.Value!,
                actor.EffectiveUserId,
                now,
                cancellationToken).ConfigureAwait(false);
            var revisedFieldIds = changedFieldIds
                .Concat(changedAttachmentFieldIds)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            var fieldRevisions = UpdateFieldRevisions(
                ParseStoredObject(rejectedInstance.FieldRevisionsJson),
                revisedFieldIds);

            foreach (var task in runtime.Value!.Tasks)
            {
                task.InstanceId = rejectedInstance.Id;
            }

            _dbContext.WorkflowTasks.AddRange(runtime.Value.Tasks);
            resubmissionTask.Status = "completed";
            resubmissionTask.CompletedAt = now.UtcDateTime;
            resubmissionTask.Revision = checked(resubmissionTask.Revision + 1);

            rejectedInstance.Title = ReadRequiredString(form.Values!, "title");
            rejectedInstance.FormValuesJson = form.Values!.ToJsonString(JsonOptions);
            rejectedInstance.FieldRevisionsJson = fieldRevisions.ToJsonString(JsonOptions);
            rejectedInstance.Status = runtime.Value.Status;
            rejectedInstance.CurrentRound = nextRound;
            rejectedInstance.CurrentNodeSummary = string.Join("、", runtime.Value.CurrentNodeNames);
            rejectedInstance.SubmittedAt = now.UtcDateTime;
            rejectedInstance.CompletedAt = runtime.Value.CompletedAt?.UtcDateTime;
            rejectedInstance.UpdatedAt = now.UtcDateTime;
            rejectedInstance.Revision = checked(rejectedInstance.Revision + 1);

            var projections = await _dbContext.InstanceFieldValues
                .Where(value => value.InstanceId == rejectedInstance.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            _dbContext.InstanceFieldValues.RemoveRange(projections);
            await AddFieldProjectionsAsync(rejectedInstance, form.Values!, cancellationToken)
                .ConfigureAwait(false);

            AddResubmissionFacts(
                rejectedInstance,
                lockedSnapshot,
                resubmissionTask.Id,
                revisedFieldIds,
                actor,
                traceId,
                now);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await _emailOutboxWriter.EnqueueAsync(
                rejectedInstance,
                definition,
                version,
                lockedSnapshot,
                runtime.Value.Tasks,
                now,
                cancellationToken).ConfigureAwait(false);
            var value = new ResubmitProcessInstanceCommandValue(
                rejectedInstance.Id,
                rejectedInstance.Revision,
                false);
            _dbContext.IdempotencyRecords.Add(CreateResubmissionIdempotencyRecord(
                actor.EffectiveUserId,
                idempotencyKey,
                requestHash,
                value,
                now));

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ProcessInstanceCommandResult<ResubmitProcessInstanceCommandValue>(value, null);
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return ResubmitFailed(RevisionMismatch());
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessInstanceCommandResult<ResubmitProcessInstanceCommandValue>?> LoadResubmissionReplayAsync(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var existing = await _dbContext.IdempotencyRecords
            .FromSqlInterpolated(
                $"""
                SELECT * FROM [flowpilot].[idempotency_records] WITH (UPDLOCK, HOLDLOCK)
                WHERE [actor_id] = {actorId}
                  AND [route_scope] = {ResubmitRouteScope}
                  AND [idempotency_key] = {idempotencyKey}
                """)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(existing.RequestHash),
                Encoding.ASCII.GetBytes(requestHash)))
        {
            return ResubmitFailed(Failure(
                ProcessInstanceCommandError.IdempotencyKeyReused,
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于其他请求",
                "请为不同的重新提交请求生成新的 Idempotency-Key。"));
        }

        if (existing.Status != "completed" || string.IsNullOrWhiteSpace(existing.ResponseBodyJson))
        {
            return ResubmitFailed(Failure(
                ProcessInstanceCommandError.Conflict,
                "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                "相同请求正在处理中",
                "请稍后使用相同的 Idempotency-Key 重试。"));
        }

        var stored = JsonSerializer.Deserialize<ResubmitProcessInstanceCommandValue>(
            existing.ResponseBodyJson,
            JsonOptions) ?? throw new InvalidDataException("Stored resubmission response is invalid.");
        return new ProcessInstanceCommandResult<ResubmitProcessInstanceCommandValue>(
            stored with { Replayed = true },
            null);
    }

    private static ProcessInstanceCommandFailure? ValidateResubmissionRequest(
        UpdateProcessInstanceSubmissionRequest request)
    {
        var issues = new List<ProcessInstanceInputIssueDto>();
        if (request.FormValues is null)
        {
            issues.Add(Issue("formValues", "REQUIRED", "请填写流程表单。"));
        }

        if (request.AssigneeByNode.Count > 0)
        {
            issues.Add(Issue(
                "assigneeByNode",
                "ASSIGNEE_CHANGE_NOT_ALLOWED",
                "驳回后的重新提交不能修改默认责任人。"));
        }

        return issues.Count == 0
            ? null
            : Failure(
                ProcessInstanceCommandError.ValidationFailed,
                "VALIDATION_FAILED",
                "重新提交数据不完整",
                "请检查表单内容和默认责任人设置。",
                issues);
    }

    private static ProcessInstanceCommandFailure? ValidateRejectedInstance(
        WorkflowInstanceEntity? instance,
        ProcessInstanceActor actor,
        int expectedRevision)
    {
        if (instance is null)
        {
            return Failure(
                ProcessInstanceCommandError.NotFound,
                "INSTANCE_NOT_FOUND",
                "流程实例不存在",
                "指定的流程实例不存在。");
        }

        if (instance.Revision != expectedRevision)
        {
            return RevisionMismatch();
        }

        if (!actor.IsSuperAdmin && instance.InitiatorUserId != actor.EffectiveUserId)
        {
            return Failure(
                ProcessInstanceCommandError.Forbidden,
                "INSTANCE_RESUBMIT_FORBIDDEN",
                "不能重新提交该流程",
                "只有该实例的实际创建人可以重新提交。");
        }

        return instance.Status != "rejected-pending"
            ? Failure(
                ProcessInstanceCommandError.Conflict,
                "INSTANCE_NOT_REJECTED",
                "流程当前不能重新提交",
                "只有驳回待处理状态的流程实例可以重新提交。")
            : null;
    }

    private static ResubmissionRuntimePreparation BuildResubmissionRuntime(
        JsonObject snapshot,
        JsonObject formValues,
        IReadOnlyList<WorkflowTaskEntity> previousTasks,
        int round,
        DateTimeOffset now)
    {
        var nodes = ReadFlowNodes(snapshot)
            .Where(node => ReadString(node["data"] as JsonObject, "kind") == "approval")
            .Select(CreateNodePlan)
            .ToArray();
        var previousByNode = previousTasks
            .Where(task => !string.IsNullOrWhiteSpace(task.NodeId))
            .ToDictionary(task => task.NodeId!, StringComparer.Ordinal);
        if (previousByNode.Count != nodes.Length || nodes.Any(node => !previousByNode.ContainsKey(node.Id)))
        {
            return ResubmissionRuntimePreparation.Failed(Failure(
                ProcessInstanceCommandError.Conflict,
                "INSTANCE_RUNTIME_INVALID",
                "流程运行数据不完整",
                "上一轮任务与实例锁定版本不一致，不能创建新的审核轮次。"));
        }

        var plans = nodes.Select(node =>
        {
            var previous = previousByNode[node.Id];
            var task = new WorkflowTaskEntity
            {
                Id = Guid.NewGuid(),
                TaskType = "approval",
                VersionId = previous.VersionId,
                Round = round,
                Status = "inactive",
                ActivatedAt = now.UtcDateTime,
                Revision = 1,
                NodeId = node.Id,
                NodeNameSnapshot = node.Name,
                GroupId = node.GroupId,
                DefaultAssigneeId = previous.DefaultAssigneeId,
            };
            return new RuntimeTask(
                task,
                node.Id,
                node.Name,
                node.HandlingMode,
                node.EditableFieldIds,
                node.AllowRepeatedEditing,
                null,
                node.ActivationCondition);
        }).ToArray();

        ActivateReadyTasks(plans, ReadFlowEdges(snapshot), formValues, now);
        var pending = plans.Where(plan => plan.Entity.Status == "pending").ToArray();
        var completed = plans.Length > 0 && plans.All(plan => plan.Entity.Status == "skipped");
        return ResubmissionRuntimePreparation.Succeeded(new RuntimeValue(
            plans,
            completed ? "completed" : "reviewing",
            completed ? ["流程结束"] : pending.Select(plan => plan.NodeName!).ToArray(),
            null,
            completed ? now : null,
            null,
            null,
            Guid.Empty));
    }

    private void AddResubmissionFacts(
        WorkflowInstanceEntity instance,
        JsonObject snapshot,
        Guid resubmissionTaskId,
        IReadOnlyList<string> changedFieldIds,
        ProcessInstanceActor actor,
        string traceId,
        DateTimeOffset now)
    {
        var labels = ReadFormFields(snapshot).ToDictionary(
            field => ReadRequiredString(field, "id"),
            field => ReadString(field, "label") ?? ReadRequiredString(field, "id"),
            StringComparer.Ordinal);
        var metadata = new JsonObject
        {
            ["round"] = instance.CurrentRound,
            ["fieldIds"] = new JsonArray(changedFieldIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
            ["fieldNames"] = new JsonArray(changedFieldIds.Select(id => (JsonNode?)JsonValue.Create(labels.GetValueOrDefault(id, id))).ToArray()),
        };
        _dbContext.WorkflowEvents.Add(new WorkflowEventEntity
        {
            Id = Guid.NewGuid(),
            EventType = "instance-resubmitted",
            InstanceId = instance.Id,
            TaskId = resubmissionTaskId,
            Round = instance.CurrentRound,
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            OccurredAt = now.UtcDateTime,
            MetadataJson = metadata.ToJsonString(JsonOptions),
        });
        _dbContext.RuntimeAuditEvents.Add(new RuntimeAuditEvent
        {
            Id = Guid.NewGuid(),
            ResourceType = "process-instance",
            ResourceId = instance.Id,
            Action = "resubmit",
            FieldIdentifiersJson = JsonSerializer.Serialize(changedFieldIds, JsonOptions),
            OperatorUserId = actor.OperatorUserId,
            EffectiveUserId = actor.EffectiveUserId,
            TraceId = traceId,
            Result = "success",
            OccurredAt = now.UtcDateTime,
        });
    }

    private static IdempotencyRecordEntity CreateResubmissionIdempotencyRecord(
        Guid actorId,
        string idempotencyKey,
        string requestHash,
        ResubmitProcessInstanceCommandValue value,
        DateTimeOffset now) => new()
        {
            Id = Guid.NewGuid(),
            ActorId = actorId,
            RouteScope = ResubmitRouteScope,
            IdempotencyKey = idempotencyKey,
            RequestHash = requestHash,
            Status = "completed",
            FirstHttpStatus = 200,
            ReplayHeadersJson = new JsonObject
            {
                ["etag"] = $"\"{value.Revision}\"",
            }.ToJsonString(JsonOptions),
            ResponseBodyJson = JsonSerializer.Serialize(value, JsonOptions),
            CreatedAt = now.UtcDateTime,
            CompletedAt = now.UtcDateTime,
            ExpiresAt = now.AddDays(7).UtcDateTime,
        };

    private static ProcessInstanceCommandResult<ResubmitProcessInstanceCommandValue> ResubmitFailed(
        ProcessInstanceCommandFailure failure) => new(null, failure);

    private static async Task<ProcessInstanceCommandResult<ResubmitProcessInstanceCommandValue>> RollbackResubmitFailureAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        ProcessInstanceCommandFailure failure,
        CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
        return ResubmitFailed(failure);
    }

    private sealed record ResubmissionRuntimePreparation(
        RuntimeValue? Value,
        ProcessInstanceCommandFailure? Failure)
    {
        public static ResubmissionRuntimePreparation Succeeded(RuntimeValue value) => new(value, null);

        public static ResubmissionRuntimePreparation Failed(ProcessInstanceCommandFailure failure) => new(null, failure);
    }
}
