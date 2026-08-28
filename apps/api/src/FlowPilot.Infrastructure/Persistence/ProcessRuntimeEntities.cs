namespace FlowPilot.Infrastructure.Persistence;

internal sealed class RuntimeWorkflowDefinition
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public bool IsDisabled { get; set; }
    public Guid? PublishedVersionId { get; set; }
    public int InstanceCount { get; set; }
    public int Revision { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid UpdatedBy { get; set; }
}

internal sealed class RuntimeWorkflowVersion
{
    public Guid Id { get; set; }
    public Guid DefinitionId { get; set; }
    public string VersionLabel { get; set; } = string.Empty;
    public string BasicJson { get; set; } = string.Empty;
    public string SnapshotJson { get; set; } = string.Empty;
    public string? ValidationStatus { get; set; }
    public int InstanceCount { get; set; }
    public int Revision { get; set; }
}

internal sealed class RuntimeWorkflowGroupReference
{
    public Guid Id { get; set; }
    public Guid VersionId { get; set; }
    public Guid GroupId { get; set; }
    public string Purpose { get; set; } = string.Empty;
    public string? NodeId { get; set; }
}

internal sealed class RuntimeWorkflowRoleReference
{
    public Guid VersionId { get; set; }
    public Guid RoleId { get; set; }
    public string Purpose { get; set; } = string.Empty;
}

internal sealed class RuntimeWorkflowGroup
{
    public Guid Id { get; set; }
    public bool IsEnabled { get; set; }
}

internal sealed class RuntimeWorkflowGroupUser
{
    public Guid GroupId { get; set; }
    public Guid UserId { get; set; }
}

internal sealed class RuntimeWorkflowGroupRole
{
    public Guid GroupId { get; set; }
    public Guid RoleId { get; set; }
}

internal sealed class RuntimeRole
{
    public Guid Id { get; set; }
    public bool IsEnabled { get; set; }
}

internal sealed class RuntimeUserRole
{
    public Guid UserId { get; set; }
    public Guid RoleId { get; set; }
}

internal sealed class RuntimeVersionField
{
    public Guid Id { get; set; }
    public Guid VersionId { get; set; }
    public string FieldId { get; set; } = string.Empty;
    public string? TableFieldId { get; set; }
    public string? ColumnId { get; set; }
    public string FieldType { get; set; } = string.Empty;
    public bool IsQueryable { get; set; }
    public bool IsListed { get; set; }
}

internal sealed class WorkflowInstanceEntity
{
    public Guid Id { get; set; }
    public string InstanceNumber { get; set; } = string.Empty;
    public Guid DefinitionId { get; set; }
    public Guid VersionId { get; set; }
    public Guid InitiatorUserId { get; set; }
    public Guid ActualInitiatorUserId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public int CurrentRound { get; set; }
    public string? CurrentNodeSummary { get; set; }
    public Guid? CurrentAssigneeId { get; set; }
    public string? VerifiedEntryBaseUrl { get; set; }
    public string FormValuesJson { get; set; } = string.Empty;
    public string FieldRevisionsJson { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? SubmittedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public int Revision { get; set; }
}

internal sealed class WorkflowTaskEntity
{
    public Guid Id { get; set; }
    public string TaskType { get; set; } = string.Empty;
    public Guid InstanceId { get; set; }
    public Guid VersionId { get; set; }
    public Guid? AssigneeId { get; set; }
    public int Round { get; set; }
    public string Status { get; set; } = string.Empty;
    public DateTime ActivatedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public int Revision { get; set; }
    public string? NodeId { get; set; }
    public string? NodeNameSnapshot { get; set; }
    public Guid? GroupId { get; set; }
    public Guid? DefaultAssigneeId { get; set; }
    public Guid? ActualAssigneeId { get; set; }
    public string? Action { get; set; }
    public string? ResultComment { get; set; }
}

internal sealed class WorkflowEventEntity
{
    public Guid Id { get; set; }
    public string EventType { get; set; } = string.Empty;
    public Guid InstanceId { get; set; }
    public Guid? TaskId { get; set; }
    public string? NodeId { get; set; }
    public int? Round { get; set; }
    public Guid OperatorUserId { get; set; }
    public Guid EffectiveUserId { get; set; }
    public DateTime OccurredAt { get; set; }
    public string? MetadataJson { get; set; }
}

internal sealed class RuntimeAuditEvent
{
    public Guid Id { get; set; }
    public string ResourceType { get; set; } = string.Empty;
    public Guid ResourceId { get; set; }
    public string Action { get; set; } = string.Empty;
    public string? FieldIdentifiersJson { get; set; }
    public Guid OperatorUserId { get; set; }
    public Guid EffectiveUserId { get; set; }
    public string TraceId { get; set; } = string.Empty;
    public string Result { get; set; } = string.Empty;
    public DateTime OccurredAt { get; set; }
}

internal sealed class FreeTimelineEntryEntity
{
    public Guid Id { get; set; }
    public Guid InstanceId { get; set; }
    public string EntryType { get; set; } = string.Empty;
    public Guid ActorUserId { get; set; }
    public Guid? RelatedEntryId { get; set; }
    public string? Content { get; set; }
    public Guid? PreviousAssigneeId { get; set; }
    public Guid? AssigneeId { get; set; }
    public string? Reason { get; set; }
    public string? FieldChangesJson { get; set; }
    public DateTime OccurredAt { get; set; }
    public Guid? EditedBy { get; set; }
    public DateTime? EditedAt { get; set; }
    public int Revision { get; set; }
}

internal sealed class FreeParticipantEntity
{
    public Guid InstanceId { get; set; }
    public Guid UserId { get; set; }
    public int SourceFlags { get; set; }
    public DateTime FirstParticipatedAt { get; set; }
    public DateTime LastParticipatedAt { get; set; }
}

internal sealed class NumberCounterEntity
{
    public string Prefix { get; set; } = string.Empty;
    public string YearMonth { get; set; } = string.Empty;
    public long NextValue { get; set; }
    public int Revision { get; set; }
    public DateTime UpdatedAt { get; set; }
}

internal sealed class InstanceFieldValueEntity
{
    public Guid Id { get; set; }
    public Guid InstanceId { get; set; }
    public Guid DefinitionId { get; set; }
    public Guid VersionId { get; set; }
    public string FieldId { get; set; } = string.Empty;
    public string? TableFieldId { get; set; }
    public string? ColumnId { get; set; }
    public string? RowId { get; set; }
    public string ValueType { get; set; } = string.Empty;
    public string? TextValue { get; set; }
    public byte[]? TextValueHash { get; set; }
    public decimal? NumberValue { get; set; }
    public DateTime? DatetimeValue { get; set; }
    public bool? BooleanValue { get; set; }
    public string? OptionId { get; set; }
}

internal sealed class RuntimeAttachment
{
    public Guid Id { get; set; }
    public string State { get; set; } = string.Empty;
    public short StorageYear { get; set; }
    public string StorageKey { get; set; } = string.Empty;
    public string OriginalFileName { get; set; } = string.Empty;
    public string Extension { get; set; } = string.Empty;
    public string? DeclaredContentType { get; set; }
    public string? DetectedContentType { get; set; }
    public long? SizeBytes { get; set; }
    public string? Sha256 { get; set; }
    public string Purpose { get; set; } = string.Empty;
    public Guid UploadedBy { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? StagedAt { get; set; }
    public DateTime? CleanupAfter { get; set; }
    public string? LastError { get; set; }
    public int Revision { get; set; }
}

internal sealed class AttachmentReferenceEntity
{
    public Guid Id { get; set; }
    public Guid AttachmentId { get; set; }
    public Guid InstanceId { get; set; }
    public string? FieldId { get; set; }
    public string? TableRowId { get; set; }
    public Guid? FreeTimelineEntryId { get; set; }
    public string ReferenceType { get; set; } = string.Empty;
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
}

internal sealed class IdempotencyRecordEntity
{
    public Guid Id { get; set; }
    public Guid ActorId { get; set; }
    public string RouteScope { get; set; } = string.Empty;
    public string IdempotencyKey { get; set; } = string.Empty;
    public string RequestHash { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public short? FirstHttpStatus { get; set; }
    public string? ReplayHeadersJson { get; set; }
    public string? ResponseBodyJson { get; set; }
    public string? LeaseOwner { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
}
