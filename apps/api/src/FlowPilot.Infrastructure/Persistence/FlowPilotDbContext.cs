using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FlowPilot.Infrastructure.Persistence;

public sealed class FlowPilotDbContext(DbContextOptions<FlowPilotDbContext> options) : DbContext(options)
{
    public const string DefaultSchema = "flowpilot";
    public const int SqlServerCompatibilityLevel = 130;

    internal DbSet<DepartmentEntity> Departments => Set<DepartmentEntity>();
    internal DbSet<PositionEntity> Positions => Set<PositionEntity>();
    internal DbSet<OrganizationUserReference> OrganizationUserReferences => Set<OrganizationUserReference>();
    internal DbSet<RuntimeWorkflowDefinition> RuntimeWorkflowDefinitions => Set<RuntimeWorkflowDefinition>();
    internal DbSet<RuntimeWorkflowVersion> RuntimeWorkflowVersions => Set<RuntimeWorkflowVersion>();
    internal DbSet<RuntimeWorkflowGroupReference> RuntimeWorkflowGroupReferences => Set<RuntimeWorkflowGroupReference>();
    internal DbSet<RuntimeWorkflowRoleReference> RuntimeWorkflowRoleReferences => Set<RuntimeWorkflowRoleReference>();
    internal DbSet<RuntimeWorkflowGroup> RuntimeWorkflowGroups => Set<RuntimeWorkflowGroup>();
    internal DbSet<RuntimeWorkflowGroupUser> RuntimeWorkflowGroupUsers => Set<RuntimeWorkflowGroupUser>();
    internal DbSet<RuntimeWorkflowGroupRole> RuntimeWorkflowGroupRoles => Set<RuntimeWorkflowGroupRole>();
    internal DbSet<RuntimeRole> RuntimeRoles => Set<RuntimeRole>();
    internal DbSet<RuntimeUserRole> RuntimeUserRoles => Set<RuntimeUserRole>();
    internal DbSet<RuntimeVersionField> RuntimeVersionFields => Set<RuntimeVersionField>();
    internal DbSet<WorkflowInstanceEntity> WorkflowInstances => Set<WorkflowInstanceEntity>();
    internal DbSet<WorkflowTaskEntity> WorkflowTasks => Set<WorkflowTaskEntity>();
    internal DbSet<WorkflowEventEntity> WorkflowEvents => Set<WorkflowEventEntity>();
    internal DbSet<RuntimeAuditEvent> RuntimeAuditEvents => Set<RuntimeAuditEvent>();
    internal DbSet<RuntimeEmailOutboxMessage> RuntimeEmailOutboxMessages => Set<RuntimeEmailOutboxMessage>();
    internal DbSet<RuntimeEmailDeliveryAttempt> RuntimeEmailDeliveryAttempts => Set<RuntimeEmailDeliveryAttempt>();
    internal DbSet<FreeTimelineEntryEntity> FreeTimelineEntries => Set<FreeTimelineEntryEntity>();
    internal DbSet<FreeParticipantEntity> FreeParticipants => Set<FreeParticipantEntity>();
    internal DbSet<NumberCounterEntity> NumberCounters => Set<NumberCounterEntity>();
    internal DbSet<InstanceFieldValueEntity> InstanceFieldValues => Set<InstanceFieldValueEntity>();
    internal DbSet<RuntimeAttachment> RuntimeAttachments => Set<RuntimeAttachment>();
    internal DbSet<AttachmentReferenceEntity> AttachmentReferences => Set<AttachmentReferenceEntity>();
    internal DbSet<IdempotencyRecordEntity> IdempotencyRecords => Set<IdempotencyRecordEntity>();
    internal DbSet<RuntimeSessionEntity> RuntimeSessions => Set<RuntimeSessionEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.HasDefaultSchema(DefaultSchema);

        ConfigureDepartment(modelBuilder.Entity<DepartmentEntity>());
        ConfigurePosition(modelBuilder.Entity<PositionEntity>());
        ConfigureOrganizationUserReference(modelBuilder.Entity<OrganizationUserReference>());
        ConfigureProcessRuntime(modelBuilder);
        ConfigureRuntimeSession(modelBuilder.Entity<RuntimeSessionEntity>());

        base.OnModelCreating(modelBuilder);
    }

    private static void ConfigureRuntimeSession(EntityTypeBuilder<RuntimeSessionEntity> entity)
    {
        entity.ToTable("sessions");
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.TokenHash).HasColumnName("token_hash");
        entity.Property(item => item.OperatorUserId).HasColumnName("operator_user_id");
        entity.Property(item => item.EffectiveUserId).HasColumnName("effective_user_id");
        entity.Property(item => item.ImpersonationRecordId).HasColumnName("impersonation_record_id");
        entity.Property(item => item.PermissionSnapshotVersion).HasColumnName("permission_snapshot_version");
        entity.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        entity.Property(item => item.LastAccessedAt).HasColumnName("last_accessed_at").HasPrecision(3);
        entity.Property(item => item.IdleExpiresAt).HasColumnName("idle_expires_at").HasPrecision(3);
        entity.Property(item => item.AbsoluteExpiresAt).HasColumnName("absolute_expires_at").HasPrecision(3);
        entity.Property(item => item.RevokedAt).HasColumnName("revoked_at").HasPrecision(3);
        entity.Property(item => item.RevocationReason).HasColumnName("revocation_reason");
    }

    private static void ConfigureDepartment(EntityTypeBuilder<DepartmentEntity> entity)
    {
        entity.ToTable("departments", table => table.UseSqlOutputClause(false));
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.Code).HasColumnName("code").HasMaxLength(100);
        entity.Property(item => item.NormalizedCode).HasColumnName("normalized_code").HasMaxLength(100);
        entity.Property(item => item.Name).HasColumnName("name").HasMaxLength(200);
        entity.Property(item => item.ParentId).HasColumnName("parent_id");
        entity.Property(item => item.Path).HasColumnName("path_cache").HasMaxLength(1000);
        entity.Property(item => item.SortOrder).HasColumnName("sort_order");
        entity.Property(item => item.IsEnabled).HasColumnName("is_enabled");
        entity.Property(item => item.Description).HasColumnName("description").HasMaxLength(1000);
        entity.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        entity.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        entity.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        entity.Property(item => item.CreatedBy).HasColumnName("created_by");
        entity.Property(item => item.UpdatedBy).HasColumnName("updated_by");
        entity.HasIndex(item => item.NormalizedCode).IsUnique();
        entity.HasIndex(item => new { item.ParentId, item.SortOrder, item.Id });
    }

    private static void ConfigurePosition(EntityTypeBuilder<PositionEntity> entity)
    {
        entity.ToTable("positions");
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.Code).HasColumnName("code").HasMaxLength(100);
        entity.Property(item => item.NormalizedCode).HasColumnName("normalized_code").HasMaxLength(100);
        entity.Property(item => item.Name).HasColumnName("name").HasMaxLength(200);
        entity.Property(item => item.NormalizedName).HasColumnName("normalized_name").HasMaxLength(200);
        entity.Property(item => item.SortOrder).HasColumnName("sort_order");
        entity.Property(item => item.IsEnabled).HasColumnName("is_enabled");
        entity.Property(item => item.Description).HasColumnName("description").HasMaxLength(1000);
        entity.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        entity.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        entity.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        entity.Property(item => item.CreatedBy).HasColumnName("created_by");
        entity.Property(item => item.UpdatedBy).HasColumnName("updated_by");
        entity.HasIndex(item => item.NormalizedCode).IsUnique();
        entity.HasIndex(item => item.NormalizedName).IsUnique();
    }

    private static void ConfigureOrganizationUserReference(
        EntityTypeBuilder<OrganizationUserReference> entity)
    {
        entity.ToTable("users");
        entity.HasKey(item => item.Id);
        entity.Property(item => item.Id).HasColumnName("id");
        entity.Property(item => item.DepartmentId).HasColumnName("department_id");
        entity.Property(item => item.PositionId).HasColumnName("position_id");
        entity.Property(item => item.LoginName).HasColumnName("login_name").HasMaxLength(100);
        entity.Property(item => item.DisplayName).HasColumnName("display_name").HasMaxLength(200);
        entity.Property(item => item.Email).HasColumnName("email").HasMaxLength(320);
        entity.Property(item => item.IsEnabled).HasColumnName("is_enabled");
        entity.Property(item => item.IsBuiltInSuperAdmin).HasColumnName("is_builtin_super_admin");
    }

    private static void ConfigureProcessRuntime(ModelBuilder modelBuilder)
    {
        var definition = modelBuilder.Entity<RuntimeWorkflowDefinition>();
        definition.ToTable("workflow_definitions");
        definition.HasKey(item => item.Id);
        definition.Property(item => item.Id).HasColumnName("id");
        definition.Property(item => item.Code).HasColumnName("code");
        definition.Property(item => item.NormalizedCode).HasColumnName("normalized_code");
        definition.Property(item => item.Name).HasColumnName("name");
        definition.Property(item => item.Description).HasColumnName("description");
        definition.Property(item => item.Type).HasColumnName("type");
        definition.Property(item => item.IsDisabled).HasColumnName("is_disabled");
        definition.Property(item => item.PublishedVersionId).HasColumnName("published_version_id");
        definition.Property(item => item.NextVersionNumber).HasColumnName("next_version_number");
        definition.Property(item => item.InstanceCount).HasColumnName("instance_count");
        definition.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        definition.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        definition.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        definition.Property(item => item.CreatedBy).HasColumnName("created_by");
        definition.Property(item => item.UpdatedBy).HasColumnName("updated_by");

        var version = modelBuilder.Entity<RuntimeWorkflowVersion>();
        version.ToTable("workflow_definition_versions");
        version.HasKey(item => item.Id);
        version.Property(item => item.Id).HasColumnName("id");
        version.Property(item => item.DefinitionId).HasColumnName("definition_id");
        version.Property(item => item.VersionNumber).HasColumnName("version_number");
        version.Property(item => item.VersionLabel).HasColumnName("version_label");
        version.Property(item => item.BasicJson).HasColumnName("basic_json");
        version.Property(item => item.SnapshotJson).HasColumnName("snapshot_json");
        version.Property(item => item.ValidationStatus).HasColumnName("validation_status");
        version.Property(item => item.ValidationJson).HasColumnName("validation_json");
        version.Property(item => item.ValidatedAt).HasColumnName("validated_at").HasPrecision(3);
        version.Property(item => item.InstanceCount).HasColumnName("instance_count");
        version.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        version.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        version.Property(item => item.CreatedBy).HasColumnName("created_by");
        version.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        version.Property(item => item.UpdatedBy).HasColumnName("updated_by");
        version.Property(item => item.FirstPublishedAt).HasColumnName("first_published_at").HasPrecision(3);
        version.Property(item => item.FirstPublishedBy).HasColumnName("first_published_by");
        version.Property(item => item.LatestPublishedAt).HasColumnName("latest_published_at").HasPrecision(3);
        version.Property(item => item.LatestPublishedBy).HasColumnName("latest_published_by");
        version.Property(item => item.UnpublishedAt).HasColumnName("unpublished_at").HasPrecision(3);
        version.Property(item => item.UnpublishedBy).HasColumnName("unpublished_by");
        version.Property(item => item.UnpublishedReason).HasColumnName("unpublished_reason");
        version.Property(item => item.ChangeNote).HasColumnName("change_note");

        ConfigureGroupRuntime(modelBuilder);
        ConfigureInstanceRuntime(modelBuilder);
        ConfigureRuntimeSupport(modelBuilder);
    }

    private static void ConfigureGroupRuntime(ModelBuilder modelBuilder)
    {
        var groupReference = modelBuilder.Entity<RuntimeWorkflowGroupReference>();
        groupReference.ToTable("workflow_version_group_refs");
        groupReference.HasKey(item => item.Id);
        groupReference.Property(item => item.Id).HasColumnName("id");
        groupReference.Property(item => item.VersionId).HasColumnName("version_id");
        groupReference.Property(item => item.GroupId).HasColumnName("group_id");
        groupReference.Property(item => item.Purpose).HasColumnName("purpose");
        groupReference.Property(item => item.NodeId).HasColumnName("node_id");

        var roleReference = modelBuilder.Entity<RuntimeWorkflowRoleReference>();
        roleReference.ToTable("workflow_version_role_refs");
        roleReference.HasKey(item => new { item.VersionId, item.RoleId, item.Purpose });
        roleReference.Property(item => item.VersionId).HasColumnName("version_id");
        roleReference.Property(item => item.RoleId).HasColumnName("role_id");
        roleReference.Property(item => item.Purpose).HasColumnName("purpose");

        var group = modelBuilder.Entity<RuntimeWorkflowGroup>();
        group.ToTable("workflow_permission_groups");
        group.HasKey(item => item.Id);
        group.Property(item => item.Id).HasColumnName("id");
        group.Property(item => item.Name).HasColumnName("name");
        group.Property(item => item.IsEnabled).HasColumnName("is_enabled");

        var groupUser = modelBuilder.Entity<RuntimeWorkflowGroupUser>();
        groupUser.ToTable("workflow_group_users");
        groupUser.HasKey(item => new { item.GroupId, item.UserId });
        groupUser.Property(item => item.GroupId).HasColumnName("group_id");
        groupUser.Property(item => item.UserId).HasColumnName("user_id");

        var groupRole = modelBuilder.Entity<RuntimeWorkflowGroupRole>();
        groupRole.ToTable("workflow_group_roles");
        groupRole.HasKey(item => new { item.GroupId, item.RoleId });
        groupRole.Property(item => item.GroupId).HasColumnName("group_id");
        groupRole.Property(item => item.RoleId).HasColumnName("role_id");

        var role = modelBuilder.Entity<RuntimeRole>();
        role.ToTable("roles");
        role.HasKey(item => item.Id);
        role.Property(item => item.Id).HasColumnName("id");
        role.Property(item => item.Name).HasColumnName("name");
        role.Property(item => item.IsEnabled).HasColumnName("is_enabled");
        role.Property(item => item.IsBuiltIn).HasColumnName("is_builtin");

        var userRole = modelBuilder.Entity<RuntimeUserRole>();
        userRole.ToTable("user_roles");
        userRole.HasKey(item => new { item.UserId, item.RoleId });
        userRole.Property(item => item.UserId).HasColumnName("user_id");
        userRole.Property(item => item.RoleId).HasColumnName("role_id");

        var field = modelBuilder.Entity<RuntimeVersionField>();
        field.ToTable("workflow_version_field_catalog");
        field.HasKey(item => item.Id);
        field.Property(item => item.Id).HasColumnName("id");
        field.Property(item => item.VersionId).HasColumnName("version_id");
        field.Property(item => item.FieldId).HasColumnName("field_id");
        field.Property(item => item.TableFieldId).HasColumnName("table_field_id");
        field.Property(item => item.ColumnId).HasColumnName("column_id");
        field.Property(item => item.FieldType).HasColumnName("field_type");
        field.Property(item => item.IsQueryable).HasColumnName("is_queryable");
        field.Property(item => item.IsListed).HasColumnName("is_listed");
        field.Property(item => item.IsExportable).HasColumnName("is_exportable");
    }

    private static void ConfigureInstanceRuntime(ModelBuilder modelBuilder)
    {
        var instance = modelBuilder.Entity<WorkflowInstanceEntity>();
        instance.ToTable("workflow_instances");
        instance.HasKey(item => item.Id);
        instance.Property(item => item.Id).HasColumnName("id");
        instance.Property(item => item.InstanceNumber).HasColumnName("instance_number");
        instance.Property(item => item.DefinitionId).HasColumnName("definition_id");
        instance.Property(item => item.VersionId).HasColumnName("version_id");
        instance.Property(item => item.InitiatorUserId).HasColumnName("initiator_user_id");
        instance.Property(item => item.ActualInitiatorUserId).HasColumnName("actual_initiator_user_id");
        instance.Property(item => item.Title).HasColumnName("title");
        instance.Property(item => item.Status).HasColumnName("status");
        instance.Property(item => item.CurrentRound).HasColumnName("current_round");
        instance.Property(item => item.CurrentNodeSummary).HasColumnName("current_node_summary");
        instance.Property(item => item.CurrentAssigneeId).HasColumnName("current_assignee_id");
        instance.Property(item => item.VerifiedEntryBaseUrl).HasColumnName("verified_entry_base_url");
        instance.Property(item => item.FormValuesJson).HasColumnName("form_values_json");
        instance.Property(item => item.FieldRevisionsJson).HasColumnName("field_revisions_json");
        instance.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        instance.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);
        instance.Property(item => item.SubmittedAt).HasColumnName("submitted_at").HasPrecision(3);
        instance.Property(item => item.CompletedAt).HasColumnName("completed_at").HasPrecision(3);
        instance.Property(item => item.ClosedAt).HasColumnName("closed_at").HasPrecision(3);
        instance.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();

        var task = modelBuilder.Entity<WorkflowTaskEntity>();
        task.ToTable("workflow_tasks", table => table.UseSqlOutputClause(false));
        task.HasKey(item => item.Id);
        task.Property(item => item.Id).HasColumnName("id");
        task.Property(item => item.TaskType).HasColumnName("task_type");
        task.Property(item => item.InstanceId).HasColumnName("instance_id");
        task.Property(item => item.VersionId).HasColumnName("version_id");
        task.Property(item => item.AssigneeId).HasColumnName("assignee_id");
        task.Property(item => item.Round).HasColumnName("round");
        task.Property(item => item.Status).HasColumnName("status");
        task.Property(item => item.ActivatedAt).HasColumnName("activated_at").HasPrecision(3);
        task.Property(item => item.CompletedAt).HasColumnName("completed_at").HasPrecision(3);
        task.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        task.Property(item => item.NodeId).HasColumnName("node_id");
        task.Property(item => item.NodeNameSnapshot).HasColumnName("node_name_snapshot");
        task.Property(item => item.GroupId).HasColumnName("group_id");
        task.Property(item => item.DefaultAssigneeId).HasColumnName("default_assignee_id");
        task.Property(item => item.ActualAssigneeId).HasColumnName("actual_assignee_id");
        task.Property(item => item.Action).HasColumnName("action");
        task.Property(item => item.ResultComment).HasColumnName("result_comment");

        var workflowEvent = modelBuilder.Entity<WorkflowEventEntity>();
        workflowEvent.ToTable("workflow_events");
        workflowEvent.HasKey(item => item.Id);
        workflowEvent.Property(item => item.Id).HasColumnName("id");
        workflowEvent.Property(item => item.EventType).HasColumnName("event_type");
        workflowEvent.Property(item => item.InstanceId).HasColumnName("instance_id");
        workflowEvent.Property(item => item.TaskId).HasColumnName("task_id");
        workflowEvent.Property(item => item.NodeId).HasColumnName("node_id");
        workflowEvent.Property(item => item.Round).HasColumnName("round");
        workflowEvent.Property(item => item.OperatorUserId).HasColumnName("operator_user_id");
        workflowEvent.Property(item => item.EffectiveUserId).HasColumnName("effective_user_id");
        workflowEvent.Property(item => item.OccurredAt).HasColumnName("occurred_at").HasPrecision(3);
        workflowEvent.Property(item => item.MetadataJson).HasColumnName("metadata_json");

        var auditEvent = modelBuilder.Entity<RuntimeAuditEvent>();
        auditEvent.ToTable("audit_events");
        auditEvent.HasKey(item => item.Id);
        auditEvent.Property(item => item.Id).HasColumnName("id");
        auditEvent.Property(item => item.ResourceType).HasColumnName("resource_type");
        auditEvent.Property(item => item.ResourceId).HasColumnName("resource_id");
        auditEvent.Property(item => item.Action).HasColumnName("action");
        auditEvent.Property(item => item.FieldIdentifiersJson).HasColumnName("field_identifiers_json");
        auditEvent.Property(item => item.OperatorUserId).HasColumnName("operator_user_id");
        auditEvent.Property(item => item.EffectiveUserId).HasColumnName("effective_user_id");
        auditEvent.Property(item => item.TraceId).HasColumnName("trace_id");
        auditEvent.Property(item => item.Result).HasColumnName("result");
        auditEvent.Property(item => item.OccurredAt).HasColumnName("occurred_at").HasPrecision(3);

        var outbox = modelBuilder.Entity<RuntimeEmailOutboxMessage>();
        outbox.ToTable("email_outbox");
        outbox.HasKey(item => item.Id);
        outbox.Property(item => item.Id).HasColumnName("id");
        outbox.Property(item => item.Revision).HasColumnName("revision").IsConcurrencyToken();
        outbox.Property(item => item.IdempotencyKey).HasColumnName("idempotency_key");
        outbox.Property(item => item.EventType).HasColumnName("event_type");
        outbox.Property(item => item.InstanceId).HasColumnName("instance_id");
        outbox.Property(item => item.TaskId).HasColumnName("task_id");
        outbox.Property(item => item.TemplateKey).HasColumnName("template_key");
        outbox.Property(item => item.RecipientUserId).HasColumnName("recipient_user_id");
        outbox.Property(item => item.RecipientEmailSnapshot).HasColumnName("recipient_email_snapshot");
        outbox.Property(item => item.Subject).HasColumnName("subject");
        outbox.Property(item => item.TemplateDataJson).HasColumnName("template_data_json");
        outbox.Property(item => item.TargetPath).HasColumnName("target_path");
        outbox.Property(item => item.LinkBaseUrl).HasColumnName("link_base_url");
        outbox.Property(item => item.ResolvedTargetUrl).HasColumnName("resolved_target_url");
        outbox.Property(item => item.Status).HasColumnName("status");
        outbox.Property(item => item.ScheduledAt).HasColumnName("scheduled_at").HasPrecision(3);
        outbox.Property(item => item.AttemptCount).HasColumnName("attempt_count");
        outbox.Property(item => item.LeaseOwner).HasColumnName("lease_owner");
        outbox.Property(item => item.LeaseUntil).HasColumnName("lease_until").HasPrecision(3);
        outbox.Property(item => item.LastErrorCode).HasColumnName("last_error_code");
        outbox.Property(item => item.LastErrorSummary).HasColumnName("last_error_summary");
        outbox.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        outbox.Property(item => item.SentAt).HasColumnName("sent_at").HasPrecision(3);
        outbox.Property(item => item.DeadLetteredAt).HasColumnName("dead_lettered_at").HasPrecision(3);

        var attempt = modelBuilder.Entity<RuntimeEmailDeliveryAttempt>();
        attempt.ToTable("email_delivery_attempts");
        attempt.HasKey(item => item.Id);
        attempt.Property(item => item.Id).HasColumnName("id");
        attempt.Property(item => item.OutboxId).HasColumnName("outbox_id");
        attempt.Property(item => item.AttemptNumber).HasColumnName("attempt_number");
        attempt.Property(item => item.StartedAt).HasColumnName("started_at").HasPrecision(3);
        attempt.Property(item => item.CompletedAt).HasColumnName("completed_at").HasPrecision(3);
        attempt.Property(item => item.Result).HasColumnName("result");
        attempt.Property(item => item.ErrorCategory).HasColumnName("error_category");
        attempt.Property(item => item.ServerResponseSummary).HasColumnName("server_response_summary");
    }

    private static void ConfigureRuntimeSupport(ModelBuilder modelBuilder)
    {
        var timeline = modelBuilder.Entity<FreeTimelineEntryEntity>();
        timeline.ToTable("free_timeline_entries");
        timeline.HasKey(item => item.Id);
        timeline.Property(item => item.Id).HasColumnName("id");
        timeline.Property(item => item.InstanceId).HasColumnName("instance_id");
        timeline.Property(item => item.EntryType).HasColumnName("entry_type");
        timeline.Property(item => item.ActorUserId).HasColumnName("actor_user_id");
        timeline.Property(item => item.RelatedEntryId).HasColumnName("related_entry_id");
        timeline.Property(item => item.Content).HasColumnName("content");
        timeline.Property(item => item.PreviousAssigneeId).HasColumnName("previous_assignee_id");
        timeline.Property(item => item.AssigneeId).HasColumnName("assignee_id");
        timeline.Property(item => item.Reason).HasColumnName("reason");
        timeline.Property(item => item.FieldChangesJson).HasColumnName("field_changes_json");
        timeline.Property(item => item.OccurredAt).HasColumnName("occurred_at").HasPrecision(3);
        timeline.Property(item => item.EditedBy).HasColumnName("edited_by");
        timeline.Property(item => item.EditedAt).HasColumnName("edited_at").HasPrecision(3);
        timeline.Property(item => item.Revision).HasColumnName("revision");

        var participant = modelBuilder.Entity<FreeParticipantEntity>();
        participant.ToTable("free_participants");
        participant.HasKey(item => new { item.InstanceId, item.UserId });
        participant.Property(item => item.InstanceId).HasColumnName("instance_id");
        participant.Property(item => item.UserId).HasColumnName("user_id");
        participant.Property(item => item.SourceFlags).HasColumnName("source_flags");
        participant.Property(item => item.FirstParticipatedAt).HasColumnName("first_participated_at").HasPrecision(3);
        participant.Property(item => item.LastParticipatedAt).HasColumnName("last_participated_at").HasPrecision(3);

        var counter = modelBuilder.Entity<NumberCounterEntity>();
        counter.ToTable("number_counters");
        counter.HasKey(item => new { item.Prefix, item.YearMonth });
        counter.Property(item => item.Prefix).HasColumnName("prefix");
        counter.Property(item => item.YearMonth).HasColumnName("year_month");
        counter.Property(item => item.NextValue).HasColumnName("next_value");
        counter.Property(item => item.Revision).HasColumnName("revision");
        counter.Property(item => item.UpdatedAt).HasColumnName("updated_at").HasPrecision(3);

        var fieldValue = modelBuilder.Entity<InstanceFieldValueEntity>();
        fieldValue.ToTable("instance_field_values");
        fieldValue.HasKey(item => item.Id);
        fieldValue.Property(item => item.Id).HasColumnName("id");
        fieldValue.Property(item => item.InstanceId).HasColumnName("instance_id");
        fieldValue.Property(item => item.DefinitionId).HasColumnName("definition_id");
        fieldValue.Property(item => item.VersionId).HasColumnName("version_id");
        fieldValue.Property(item => item.FieldId).HasColumnName("field_id");
        fieldValue.Property(item => item.TableFieldId).HasColumnName("table_field_id");
        fieldValue.Property(item => item.ColumnId).HasColumnName("column_id");
        fieldValue.Property(item => item.RowId).HasColumnName("row_id");
        fieldValue.Property(item => item.ValueType).HasColumnName("value_type");
        fieldValue.Property(item => item.TextValue).HasColumnName("text_value");
        fieldValue.Property(item => item.TextValueHash).HasColumnName("text_value_hash");
        fieldValue.Property(item => item.NumberValue).HasColumnName("number_value");
        fieldValue.Property(item => item.DatetimeValue).HasColumnName("datetime_value").HasPrecision(3);
        fieldValue.Property(item => item.BooleanValue).HasColumnName("boolean_value");
        fieldValue.Property(item => item.OptionId).HasColumnName("option_id");

        ConfigureAttachmentsAndIdempotency(modelBuilder);
    }

    private static void ConfigureAttachmentsAndIdempotency(ModelBuilder modelBuilder)
    {
        var attachment = modelBuilder.Entity<RuntimeAttachment>();
        attachment.ToTable("attachments");
        attachment.HasKey(item => item.Id);
        attachment.Property(item => item.Id).HasColumnName("id");
        attachment.Property(item => item.State).HasColumnName("state");
        attachment.Property(item => item.StorageYear).HasColumnName("storage_year");
        attachment.Property(item => item.StorageKey).HasColumnName("storage_key");
        attachment.Property(item => item.OriginalFileName).HasColumnName("original_file_name");
        attachment.Property(item => item.Extension).HasColumnName("extension");
        attachment.Property(item => item.DeclaredContentType).HasColumnName("declared_content_type");
        attachment.Property(item => item.DetectedContentType).HasColumnName("detected_content_type");
        attachment.Property(item => item.SizeBytes).HasColumnName("size_bytes");
        attachment.Property(item => item.Sha256).HasColumnName("sha256");
        attachment.Property(item => item.Purpose).HasColumnName("purpose");
        attachment.Property(item => item.UploadedBy).HasColumnName("uploaded_by");
        attachment.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        attachment.Property(item => item.StagedAt).HasColumnName("staged_at").HasPrecision(3);
        attachment.Property(item => item.CleanupAfter).HasColumnName("cleanup_after");
        attachment.Property(item => item.LastError).HasColumnName("last_error");
        attachment.Property(item => item.Revision).HasColumnName("revision");

        var reference = modelBuilder.Entity<AttachmentReferenceEntity>();
        reference.ToTable("attachment_references");
        reference.HasKey(item => item.Id);
        reference.Property(item => item.Id).HasColumnName("id");
        reference.Property(item => item.AttachmentId).HasColumnName("attachment_id");
        reference.Property(item => item.InstanceId).HasColumnName("instance_id");
        reference.Property(item => item.FieldId).HasColumnName("field_id");
        reference.Property(item => item.TableRowId).HasColumnName("table_row_id");
        reference.Property(item => item.FreeTimelineEntryId).HasColumnName("free_timeline_entry_id");
        reference.Property(item => item.ReferenceType).HasColumnName("reference_type");
        reference.Property(item => item.CreatedBy).HasColumnName("created_by");
        reference.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);

        var idempotency = modelBuilder.Entity<IdempotencyRecordEntity>();
        idempotency.ToTable("idempotency_records");
        idempotency.HasKey(item => item.Id);
        idempotency.Property(item => item.Id).HasColumnName("id");
        idempotency.Property(item => item.ActorId).HasColumnName("actor_id");
        idempotency.Property(item => item.RouteScope).HasColumnName("route_scope");
        idempotency.Property(item => item.IdempotencyKey).HasColumnName("idempotency_key");
        idempotency.Property(item => item.RequestHash).HasColumnName("request_hash");
        idempotency.Property(item => item.Status).HasColumnName("status");
        idempotency.Property(item => item.FirstHttpStatus).HasColumnName("first_http_status");
        idempotency.Property(item => item.ReplayHeadersJson).HasColumnName("replay_headers_json");
        idempotency.Property(item => item.ResponseBodyJson).HasColumnName("response_body_json");
        idempotency.Property(item => item.LeaseOwner).HasColumnName("lease_owner");
        idempotency.Property(item => item.LeaseUntil).HasColumnName("lease_until");
        idempotency.Property(item => item.CreatedAt).HasColumnName("created_at").HasPrecision(3);
        idempotency.Property(item => item.CompletedAt).HasColumnName("completed_at").HasPrecision(3);
        idempotency.Property(item => item.ExpiresAt).HasColumnName("expires_at").HasPrecision(3);
    }
}
