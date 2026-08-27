SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;

-- This migration is executed by the controlled migration runner inside one
-- transaction. The runner must short-circuit an already-succeeded migration
-- before executing this file and insert the ledger row only after this file
-- completes successfully. Do not add a schema_migrations INSERT here: the
-- checksum covers schema DDL only and must not include ledger/state writes.

IF SCHEMA_ID(N'flowpilot') IS NOT NULL
BEGIN
    THROW 51000, 'The flowpilot schema already exists without a matching successful migration ledger entry.', 1;
END;

EXEC(N'CREATE SCHEMA [flowpilot] AUTHORIZATION [dbo];');

CREATE TABLE [flowpilot].[schema_migrations]
(
    [migration_id] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [checksum] varchar(64) NOT NULL,
    [started_at] datetime2(3) NOT NULL,
    [completed_at] datetime2(3) NULL,
    [tool_version] nvarchar(100) NOT NULL,
    [result] nvarchar(20) NOT NULL,
    CONSTRAINT [pk_schema_migrations] PRIMARY KEY CLUSTERED ([migration_id]),
    CONSTRAINT [ck_schema_migrations_checksum] CHECK
    (
        LEN([checksum]) = 64
        AND [checksum] = LOWER([checksum])
        AND [checksum] COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%'
    ),
    CONSTRAINT [ck_schema_migrations_result] CHECK ([result] IN (N'running', N'succeeded', N'failed')),
    CONSTRAINT [ck_schema_migrations_completion] CHECK
    (
        ([result] = N'running' AND [completed_at] IS NULL)
        OR ([result] IN (N'succeeded', N'failed') AND [completed_at] IS NOT NULL)
    ),
    CONSTRAINT [ck_schema_migrations_time_order] CHECK
    (
        [completed_at] IS NULL OR [completed_at] >= [started_at]
    )
);

CREATE INDEX [ix_schema_migrations_result_completed]
    ON [flowpilot].[schema_migrations] ([result], [completed_at] DESC, [migration_id] DESC);

CREATE TABLE [flowpilot].[system_state]
(
    [state_key] nvarchar(100) NOT NULL,
    [state_value] nvarchar(4000) NOT NULL,
    [revision] int NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [updated_by] uniqueidentifier NULL,
    CONSTRAINT [pk_system_state] PRIMARY KEY CLUSTERED ([state_key]),
    CONSTRAINT [ck_system_state_revision] CHECK ([revision] >= 1)
);

CREATE TABLE [flowpilot].[departments]
(
    [id] uniqueidentifier NOT NULL,
    [code] nvarchar(100) NOT NULL,
    [normalized_code] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [parent_id] uniqueidentifier NULL,
    [path_cache] nvarchar(1000) NOT NULL,
    [sort_order] int NOT NULL,
    [is_enabled] bit NOT NULL,
    [description] nvarchar(1000) NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NULL,
    [updated_by] uniqueidentifier NULL,
    CONSTRAINT [pk_departments] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_departments_code] CHECK (LEN(LTRIM(RTRIM([code]))) > 0),
    CONSTRAINT [ck_departments_normalized_code] CHECK (LEN(LTRIM(RTRIM([normalized_code]))) > 0),
    CONSTRAINT [ck_departments_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_departments_parent] CHECK ([parent_id] IS NULL OR [parent_id] <> [id]),
    CONSTRAINT [ck_departments_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_departments_time_order] CHECK ([updated_at] >= [created_at])
);

CREATE UNIQUE INDEX [ux_departments_normalized_code]
    ON [flowpilot].[departments] ([normalized_code]);
CREATE INDEX [ix_departments_parent_sort]
    ON [flowpilot].[departments] ([parent_id], [sort_order], [id]);

CREATE TABLE [flowpilot].[positions]
(
    [id] uniqueidentifier NOT NULL,
    [code] nvarchar(100) NOT NULL,
    [normalized_code] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [normalized_name] nvarchar(200) NOT NULL,
    [sort_order] int NOT NULL,
    [is_enabled] bit NOT NULL,
    [description] nvarchar(1000) NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NULL,
    [updated_by] uniqueidentifier NULL,
    CONSTRAINT [pk_positions] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_positions_code] CHECK (LEN(LTRIM(RTRIM([code]))) > 0),
    CONSTRAINT [ck_positions_normalized_code] CHECK (LEN(LTRIM(RTRIM([normalized_code]))) > 0),
    CONSTRAINT [ck_positions_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_positions_normalized_name] CHECK (LEN(LTRIM(RTRIM([normalized_name]))) > 0),
    CONSTRAINT [ck_positions_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_positions_time_order] CHECK ([updated_at] >= [created_at])
);

CREATE UNIQUE INDEX [ux_positions_normalized_code]
    ON [flowpilot].[positions] ([normalized_code]);
CREATE UNIQUE INDEX [ux_positions_normalized_name]
    ON [flowpilot].[positions] ([normalized_name]);
CREATE INDEX [ix_positions_enabled_sort]
    ON [flowpilot].[positions] ([is_enabled], [sort_order], [id]);

CREATE TABLE [flowpilot].[users]
(
    [id] uniqueidentifier NOT NULL,
    [login_name] nvarchar(100) NOT NULL,
    [normalized_login_name] nvarchar(100) NOT NULL,
    [display_name] nvarchar(100) NOT NULL,
    [email] nvarchar(320) NOT NULL,
    [authentication_mode] nvarchar(20) NOT NULL,
    [password_hash] nvarchar(500) NULL,
    [department_id] uniqueidentifier NOT NULL,
    [position_id] uniqueidentifier NOT NULL,
    [is_enabled] bit NOT NULL,
    [is_builtin_super_admin] bit NOT NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NULL,
    [updated_by] uniqueidentifier NULL,
    CONSTRAINT [pk_users] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_users_login_name] CHECK (LEN(LTRIM(RTRIM([login_name]))) > 0),
    CONSTRAINT [ck_users_normalized_login_name] CHECK (LEN(LTRIM(RTRIM([normalized_login_name]))) > 0),
    CONSTRAINT [ck_users_display_name] CHECK (LEN(LTRIM(RTRIM([display_name]))) > 0),
    CONSTRAINT [ck_users_email] CHECK (LEN(LTRIM(RTRIM([email]))) > 0),
    CONSTRAINT [ck_users_authentication_mode] CHECK ([authentication_mode] IN (N'domain', N'password')),
    CONSTRAINT [ck_users_password_hash] CHECK
    (
        ([authentication_mode] = N'password' AND [password_hash] IS NOT NULL AND LEN([password_hash]) > 0)
        OR ([authentication_mode] = N'domain' AND [password_hash] IS NULL)
    ),
    CONSTRAINT [ck_users_builtin_super_admin] CHECK
    (
        [is_builtin_super_admin] = 0
        OR ([authentication_mode] = N'password' AND [is_enabled] = 1)
    ),
    CONSTRAINT [ck_users_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_users_time_order] CHECK ([updated_at] >= [created_at]),
    CONSTRAINT [fk_users_department] FOREIGN KEY ([department_id])
        REFERENCES [flowpilot].[departments] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_users_position] FOREIGN KEY ([position_id])
        REFERENCES [flowpilot].[positions] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_users_normalized_login_name]
    ON [flowpilot].[users] ([normalized_login_name]);
CREATE UNIQUE INDEX [ux_users_builtin_super_admin]
    ON [flowpilot].[users] ([is_builtin_super_admin])
    WHERE [is_builtin_super_admin] = 1;
CREATE INDEX [ix_users_department_enabled]
    ON [flowpilot].[users] ([department_id], [is_enabled], [display_name], [id]);
CREATE INDEX [ix_users_position_enabled]
    ON [flowpilot].[users] ([position_id], [is_enabled], [display_name], [id]);

ALTER TABLE [flowpilot].[departments]
    ADD CONSTRAINT [fk_departments_parent] FOREIGN KEY ([parent_id])
        REFERENCES [flowpilot].[departments] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[departments]
    ADD CONSTRAINT [fk_departments_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[departments]
    ADD CONSTRAINT [fk_departments_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[positions]
    ADD CONSTRAINT [fk_positions_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[positions]
    ADD CONSTRAINT [fk_positions_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [fk_users_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [fk_users_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;
ALTER TABLE [flowpilot].[system_state]
    ADD CONSTRAINT [fk_system_state_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION;

CREATE TABLE [flowpilot].[roles]
(
    [id] uniqueidentifier NOT NULL,
    [code] nvarchar(100) NOT NULL,
    [normalized_code] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [normalized_name] nvarchar(200) NOT NULL,
    [description] nvarchar(1000) NULL,
    [is_enabled] bit NOT NULL,
    [is_builtin] bit NOT NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NULL,
    [updated_by] uniqueidentifier NULL,
    CONSTRAINT [pk_roles] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_roles_code] CHECK (LEN(LTRIM(RTRIM([code]))) > 0),
    CONSTRAINT [ck_roles_normalized_code] CHECK (LEN(LTRIM(RTRIM([normalized_code]))) > 0),
    CONSTRAINT [ck_roles_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_roles_normalized_name] CHECK (LEN(LTRIM(RTRIM([normalized_name]))) > 0),
    CONSTRAINT [ck_roles_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_roles_time_order] CHECK ([updated_at] >= [created_at]),
    CONSTRAINT [fk_roles_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_roles_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_roles_normalized_code]
    ON [flowpilot].[roles] ([normalized_code]);
CREATE UNIQUE INDEX [ux_roles_normalized_name]
    ON [flowpilot].[roles] ([normalized_name]);
CREATE INDEX [ix_roles_enabled_name]
    ON [flowpilot].[roles] ([is_enabled], [normalized_name], [id]);

CREATE TABLE [flowpilot].[permissions]
(
    [code] nvarchar(150) NOT NULL,
    [resource] nvarchar(100) NOT NULL,
    [action] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [sort_order] int NOT NULL,
    [is_builtin] bit NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_permissions] PRIMARY KEY CLUSTERED ([code]),
    CONSTRAINT [ck_permissions_code] CHECK (LEN(LTRIM(RTRIM([code]))) > 0),
    CONSTRAINT [ck_permissions_resource] CHECK (LEN(LTRIM(RTRIM([resource]))) > 0),
    CONSTRAINT [ck_permissions_action] CHECK (LEN(LTRIM(RTRIM([action]))) > 0),
    CONSTRAINT [ck_permissions_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_permissions_time_order] CHECK ([updated_at] >= [created_at])
);

CREATE UNIQUE INDEX [ux_permissions_resource_action]
    ON [flowpilot].[permissions] ([resource], [action]);
CREATE INDEX [ix_permissions_sort]
    ON [flowpilot].[permissions] ([sort_order], [code]);

CREATE TABLE [flowpilot].[user_roles]
(
    [user_id] uniqueidentifier NOT NULL,
    [role_id] uniqueidentifier NOT NULL,
    [granted_by] uniqueidentifier NOT NULL,
    [granted_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_user_roles] PRIMARY KEY CLUSTERED ([user_id], [role_id]),
    CONSTRAINT [fk_user_roles_user] FOREIGN KEY ([user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_user_roles_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_user_roles_granted_by] FOREIGN KEY ([granted_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_user_roles_role_user]
    ON [flowpilot].[user_roles] ([role_id], [user_id]);

CREATE TABLE [flowpilot].[role_permissions]
(
    [role_id] uniqueidentifier NOT NULL,
    [permission_code] nvarchar(150) NOT NULL,
    [granted_by] uniqueidentifier NOT NULL,
    [granted_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_role_permissions] PRIMARY KEY CLUSTERED ([role_id], [permission_code]),
    CONSTRAINT [fk_role_permissions_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_role_permissions_permission] FOREIGN KEY ([permission_code])
        REFERENCES [flowpilot].[permissions] ([code]) ON DELETE NO ACTION,
    CONSTRAINT [fk_role_permissions_granted_by] FOREIGN KEY ([granted_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_role_permissions_permission_role]
    ON [flowpilot].[role_permissions] ([permission_code], [role_id]);

CREATE TABLE [flowpilot].[workflow_permission_groups]
(
    [id] uniqueidentifier NOT NULL,
    [code] nvarchar(100) NOT NULL,
    [normalized_code] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [description] nvarchar(1000) NULL,
    [is_enabled] bit NOT NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NOT NULL,
    [updated_by] uniqueidentifier NOT NULL,
    CONSTRAINT [pk_workflow_permission_groups] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_permission_groups_code] CHECK (LEN(LTRIM(RTRIM([code]))) > 0),
    CONSTRAINT [ck_workflow_permission_groups_normalized_code] CHECK (LEN(LTRIM(RTRIM([normalized_code]))) > 0),
    CONSTRAINT [ck_workflow_permission_groups_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_workflow_permission_groups_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_workflow_permission_groups_time_order] CHECK ([updated_at] >= [created_at]),
    CONSTRAINT [fk_workflow_permission_groups_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_permission_groups_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_workflow_permission_groups_normalized_code]
    ON [flowpilot].[workflow_permission_groups] ([normalized_code]);
CREATE INDEX [ix_workflow_permission_groups_enabled_name]
    ON [flowpilot].[workflow_permission_groups] ([is_enabled], [name], [id]);

CREATE TABLE [flowpilot].[workflow_permission_group_purposes]
(
    [group_id] uniqueidentifier NOT NULL,
    [purpose] nvarchar(20) NOT NULL,
    CONSTRAINT [pk_workflow_permission_group_purposes] PRIMARY KEY CLUSTERED ([group_id], [purpose]),
    CONSTRAINT [ck_workflow_permission_group_purposes_purpose] CHECK ([purpose] IN (N'start', N'review', N'close')),
    CONSTRAINT [fk_workflow_permission_group_purposes_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE CASCADE
);

CREATE TABLE [flowpilot].[workflow_group_users]
(
    [group_id] uniqueidentifier NOT NULL,
    [user_id] uniqueidentifier NOT NULL,
    [added_by] uniqueidentifier NOT NULL,
    [added_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_workflow_group_users] PRIMARY KEY CLUSTERED ([group_id], [user_id]),
    CONSTRAINT [fk_workflow_group_users_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_workflow_group_users_user] FOREIGN KEY ([user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_group_users_added_by] FOREIGN KEY ([added_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_workflow_group_users_user_group]
    ON [flowpilot].[workflow_group_users] ([user_id], [group_id]);

CREATE TABLE [flowpilot].[workflow_group_roles]
(
    [group_id] uniqueidentifier NOT NULL,
    [role_id] uniqueidentifier NOT NULL,
    [added_by] uniqueidentifier NOT NULL,
    [added_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_workflow_group_roles] PRIMARY KEY CLUSTERED ([group_id], [role_id]),
    CONSTRAINT [fk_workflow_group_roles_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_workflow_group_roles_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_group_roles_added_by] FOREIGN KEY ([added_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_workflow_group_roles_role_group]
    ON [flowpilot].[workflow_group_roles] ([role_id], [group_id]);

CREATE TABLE [flowpilot].[workflow_definitions]
(
    [id] uniqueidentifier NOT NULL,
    [code] nvarchar(100) NOT NULL,
    [normalized_code] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [description] nvarchar(2000) NULL,
    [type] nvarchar(20) NOT NULL,
    [is_disabled] bit NOT NULL,
    [published_version_id] uniqueidentifier NULL,
    [next_version_number] int NOT NULL,
    [instance_count] int NOT NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NOT NULL,
    [updated_by] uniqueidentifier NOT NULL,
    CONSTRAINT [pk_workflow_definitions] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_definitions_code] CHECK (LEN(LTRIM(RTRIM([code]))) > 0),
    CONSTRAINT [ck_workflow_definitions_normalized_code] CHECK (LEN(LTRIM(RTRIM([normalized_code]))) > 0),
    CONSTRAINT [ck_workflow_definitions_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_workflow_definitions_type] CHECK ([type] IN (N'approval', N'free')),
    CONSTRAINT [ck_workflow_definitions_next_version] CHECK ([next_version_number] >= 1),
    CONSTRAINT [ck_workflow_definitions_instance_count] CHECK ([instance_count] >= 0),
    CONSTRAINT [ck_workflow_definitions_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_workflow_definitions_time_order] CHECK ([updated_at] >= [created_at]),
    CONSTRAINT [fk_workflow_definitions_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_definitions_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_workflow_definitions_normalized_code]
    ON [flowpilot].[workflow_definitions] ([normalized_code]);
CREATE INDEX [ix_workflow_definitions_disabled_name]
    ON [flowpilot].[workflow_definitions] ([is_disabled], [name], [id]);

CREATE TABLE [flowpilot].[workflow_definition_versions]
(
    [id] uniqueidentifier NOT NULL,
    [definition_id] uniqueidentifier NOT NULL,
    [version_number] int NOT NULL,
    [version_label] nvarchar(100) NOT NULL,
    [basic_json] nvarchar(max) NOT NULL,
    [snapshot_json] nvarchar(max) NOT NULL,
    [validation_status] nvarchar(20) NULL,
    [validation_json] nvarchar(max) NULL,
    [validated_at] datetime2(3) NULL,
    [instance_count] int NOT NULL,
    [revision] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [created_by] uniqueidentifier NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [updated_by] uniqueidentifier NOT NULL,
    [first_published_at] datetime2(3) NULL,
    [first_published_by] uniqueidentifier NULL,
    [latest_published_at] datetime2(3) NULL,
    [latest_published_by] uniqueidentifier NULL,
    [unpublished_at] datetime2(3) NULL,
    [unpublished_by] uniqueidentifier NULL,
    [unpublished_reason] nvarchar(1000) NULL,
    CONSTRAINT [pk_workflow_definition_versions] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_definition_versions_number] CHECK ([version_number] >= 1),
    CONSTRAINT [ck_workflow_definition_versions_label] CHECK (LEN(LTRIM(RTRIM([version_label]))) > 0),
    CONSTRAINT [ck_workflow_definition_versions_basic_json] CHECK (ISJSON([basic_json]) = 1),
    CONSTRAINT [ck_workflow_definition_versions_snapshot_json] CHECK (ISJSON([snapshot_json]) = 1),
    CONSTRAINT [ck_workflow_definition_versions_validation_status] CHECK
        ([validation_status] IS NULL OR [validation_status] IN (N'passed', N'failed')),
    CONSTRAINT [ck_workflow_definition_versions_validation_json] CHECK
        ([validation_json] IS NULL OR ISJSON([validation_json]) = 1),
    CONSTRAINT [ck_workflow_definition_versions_validation_pair] CHECK
        (([validation_status] IS NULL AND [validated_at] IS NULL)
         OR ([validation_status] IS NOT NULL AND [validated_at] IS NOT NULL)),
    CONSTRAINT [ck_workflow_definition_versions_instance_count] CHECK ([instance_count] >= 0),
    CONSTRAINT [ck_workflow_definition_versions_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_workflow_definition_versions_time_order] CHECK ([updated_at] >= [created_at]),
    CONSTRAINT [ck_workflow_definition_versions_first_publish_pair] CHECK
        (([first_published_at] IS NULL AND [first_published_by] IS NULL)
         OR ([first_published_at] IS NOT NULL AND [first_published_by] IS NOT NULL)),
    CONSTRAINT [ck_workflow_definition_versions_latest_publish_pair] CHECK
        (([latest_published_at] IS NULL AND [latest_published_by] IS NULL)
         OR ([latest_published_at] IS NOT NULL AND [latest_published_by] IS NOT NULL)),
    CONSTRAINT [ck_workflow_definition_versions_unpublish_pair] CHECK
        (([unpublished_at] IS NULL AND [unpublished_by] IS NULL AND [unpublished_reason] IS NULL)
         OR ([unpublished_at] IS NOT NULL AND [unpublished_by] IS NOT NULL AND [unpublished_reason] IS NOT NULL)),
    CONSTRAINT [fk_workflow_definition_versions_definition] FOREIGN KEY ([definition_id])
        REFERENCES [flowpilot].[workflow_definitions] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_definition_versions_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_definition_versions_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_definition_versions_first_published_by] FOREIGN KEY ([first_published_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_definition_versions_latest_published_by] FOREIGN KEY ([latest_published_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_definition_versions_unpublished_by] FOREIGN KEY ([unpublished_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_workflow_definition_versions_definition_number]
    ON [flowpilot].[workflow_definition_versions] ([definition_id], [version_number]);
CREATE UNIQUE INDEX [ux_workflow_definition_versions_definition_id]
    ON [flowpilot].[workflow_definition_versions] ([definition_id], [id]);
CREATE INDEX [ix_workflow_definition_versions_definition_updated]
    ON [flowpilot].[workflow_definition_versions] ([definition_id], [updated_at] DESC, [id]);

ALTER TABLE [flowpilot].[workflow_definitions]
    ADD CONSTRAINT [fk_workflow_definitions_published_version] FOREIGN KEY ([id], [published_version_id])
        REFERENCES [flowpilot].[workflow_definition_versions] ([definition_id], [id]) ON DELETE NO ACTION;

CREATE TABLE [flowpilot].[workflow_version_group_refs]
(
    [id] uniqueidentifier NOT NULL,
    [version_id] uniqueidentifier NOT NULL,
    [group_id] uniqueidentifier NOT NULL,
    [purpose] nvarchar(20) NOT NULL,
    [node_id] nvarchar(100) NULL,
    CONSTRAINT [pk_workflow_version_group_refs] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_version_group_refs_purpose] CHECK ([purpose] IN (N'start', N'review', N'close')),
    CONSTRAINT [ck_workflow_version_group_refs_node] CHECK ([node_id] IS NULL OR LEN(LTRIM(RTRIM([node_id]))) > 0),
    CONSTRAINT [fk_workflow_version_group_refs_version] FOREIGN KEY ([version_id])
        REFERENCES [flowpilot].[workflow_definition_versions] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_workflow_version_group_refs_group_purpose] FOREIGN KEY ([group_id], [purpose])
        REFERENCES [flowpilot].[workflow_permission_group_purposes] ([group_id], [purpose]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_workflow_version_group_refs_global]
    ON [flowpilot].[workflow_version_group_refs] ([version_id], [group_id], [purpose])
    WHERE [node_id] IS NULL;
CREATE UNIQUE INDEX [ux_workflow_version_group_refs_node]
    ON [flowpilot].[workflow_version_group_refs] ([version_id], [group_id], [purpose], [node_id])
    WHERE [node_id] IS NOT NULL;
CREATE INDEX [ix_workflow_version_group_refs_group_version]
    ON [flowpilot].[workflow_version_group_refs] ([group_id], [version_id]);

CREATE TABLE [flowpilot].[workflow_version_role_refs]
(
    [version_id] uniqueidentifier NOT NULL,
    [role_id] uniqueidentifier NOT NULL,
    [purpose] nvarchar(50) NOT NULL,
    CONSTRAINT [pk_workflow_version_role_refs] PRIMARY KEY CLUSTERED ([version_id], [role_id], [purpose]),
    CONSTRAINT [ck_workflow_version_role_refs_purpose] CHECK (LEN(LTRIM(RTRIM([purpose]))) > 0),
    CONSTRAINT [fk_workflow_version_role_refs_version] FOREIGN KEY ([version_id])
        REFERENCES [flowpilot].[workflow_definition_versions] ([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_workflow_version_role_refs_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_workflow_version_role_refs_role_version]
    ON [flowpilot].[workflow_version_role_refs] ([role_id], [version_id]);

CREATE TABLE [flowpilot].[workflow_version_field_catalog]
(
    [id] uniqueidentifier NOT NULL,
    [version_id] uniqueidentifier NOT NULL,
    [field_id] nvarchar(100) NOT NULL,
    [table_field_id] nvarchar(100) NULL,
    [column_id] nvarchar(100) NULL,
    [name] nvarchar(200) NOT NULL,
    [field_type] nvarchar(50) NOT NULL,
    [is_queryable] bit NOT NULL,
    [is_listed] bit NOT NULL,
    [is_exportable] bit NOT NULL,
    [input_stage] nvarchar(50) NOT NULL,
    CONSTRAINT [pk_workflow_version_field_catalog] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_version_field_catalog_field_id] CHECK (LEN(LTRIM(RTRIM([field_id]))) > 0),
    CONSTRAINT [ck_workflow_version_field_catalog_name] CHECK (LEN(LTRIM(RTRIM([name]))) > 0),
    CONSTRAINT [ck_workflow_version_field_catalog_type] CHECK (LEN(LTRIM(RTRIM([field_type]))) > 0),
    CONSTRAINT [ck_workflow_version_field_catalog_stage] CHECK (LEN(LTRIM(RTRIM([input_stage]))) > 0),
    CONSTRAINT [ck_workflow_version_field_catalog_table_shape] CHECK
    (
        ([table_field_id] IS NULL AND [column_id] IS NULL)
        OR ([table_field_id] IS NOT NULL AND [column_id] IS NOT NULL
            AND LEN(LTRIM(RTRIM([table_field_id]))) > 0
            AND LEN(LTRIM(RTRIM([column_id]))) > 0)
    ),
    CONSTRAINT [fk_workflow_version_field_catalog_version] FOREIGN KEY ([version_id])
        REFERENCES [flowpilot].[workflow_definition_versions] ([id]) ON DELETE CASCADE
);

CREATE UNIQUE INDEX [ux_workflow_version_field_catalog_scalar]
    ON [flowpilot].[workflow_version_field_catalog] ([version_id], [field_id])
    WHERE [table_field_id] IS NULL AND [column_id] IS NULL;
CREATE UNIQUE INDEX [ux_workflow_version_field_catalog_table]
    ON [flowpilot].[workflow_version_field_catalog] ([version_id], [table_field_id], [column_id])
    WHERE [table_field_id] IS NOT NULL AND [column_id] IS NOT NULL;
CREATE INDEX [ix_workflow_version_field_catalog_capabilities]
    ON [flowpilot].[workflow_version_field_catalog]
        ([version_id], [is_queryable], [is_listed], [is_exportable], [field_id]);

CREATE TABLE [flowpilot].[workflow_instances]
(
    [id] uniqueidentifier NOT NULL,
    [instance_number] nvarchar(100) NOT NULL,
    [definition_id] uniqueidentifier NOT NULL,
    [version_id] uniqueidentifier NOT NULL,
    [initiator_user_id] uniqueidentifier NOT NULL,
    [actual_initiator_user_id] uniqueidentifier NOT NULL,
    [title] nvarchar(500) NOT NULL,
    [status] nvarchar(40) NOT NULL,
    [current_round] int NOT NULL,
    [current_node_summary] nvarchar(500) NULL,
    [current_assignee_id] uniqueidentifier NULL,
    [verified_entry_base_url] nvarchar(2048) NULL,
    [form_values_json] nvarchar(max) NOT NULL,
    [field_revisions_json] nvarchar(max) NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    [submitted_at] datetime2(3) NULL,
    [completed_at] datetime2(3) NULL,
    [closed_at] datetime2(3) NULL,
    [revision] int NOT NULL,
    CONSTRAINT [pk_workflow_instances] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_instances_number] CHECK (LEN(LTRIM(RTRIM([instance_number]))) > 0),
    CONSTRAINT [ck_workflow_instances_title] CHECK (LEN(LTRIM(RTRIM([title]))) > 0),
    CONSTRAINT [ck_workflow_instances_status] CHECK
        ([status] IN (N'reviewing', N'rejected-pending', N'completed', N'in-progress', N'closed')),
    CONSTRAINT [ck_workflow_instances_round] CHECK ([current_round] >= 1),
    CONSTRAINT [ck_workflow_instances_form_values_json] CHECK (ISJSON([form_values_json]) = 1),
    CONSTRAINT [ck_workflow_instances_field_revisions_json] CHECK (ISJSON([field_revisions_json]) = 1),
    CONSTRAINT [ck_workflow_instances_verified_entry_base_url] CHECK
    (
        [verified_entry_base_url] IS NULL
        OR ([verified_entry_base_url] LIKE N'http://%/flowpilot'
            OR [verified_entry_base_url] LIKE N'https://%/flowpilot')
    ),
    CONSTRAINT [ck_workflow_instances_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_workflow_instances_time_order] CHECK
    (
        [updated_at] >= [created_at]
        AND ([submitted_at] IS NULL OR [submitted_at] >= [created_at])
        AND ([completed_at] IS NULL OR [completed_at] >= [created_at])
        AND ([closed_at] IS NULL OR [closed_at] >= [created_at])
    ),
    CONSTRAINT [fk_workflow_instances_definition] FOREIGN KEY ([definition_id])
        REFERENCES [flowpilot].[workflow_definitions] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_instances_version] FOREIGN KEY ([definition_id], [version_id])
        REFERENCES [flowpilot].[workflow_definition_versions] ([definition_id], [id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_instances_initiator] FOREIGN KEY ([initiator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_instances_actual_initiator] FOREIGN KEY ([actual_initiator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_instances_current_assignee] FOREIGN KEY ([current_assignee_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_workflow_instances_number]
    ON [flowpilot].[workflow_instances] ([instance_number]);
CREATE INDEX [ix_workflow_instances_definition_status_updated]
    ON [flowpilot].[workflow_instances] ([definition_id], [status], [updated_at] DESC, [id]);
CREATE INDEX [ix_workflow_instances_initiator_updated]
    ON [flowpilot].[workflow_instances] ([initiator_user_id], [updated_at] DESC, [id]);
CREATE INDEX [ix_workflow_instances_assignee_status]
    ON [flowpilot].[workflow_instances] ([current_assignee_id], [status], [updated_at] DESC, [id])
    WHERE [current_assignee_id] IS NOT NULL;
CREATE UNIQUE INDEX [ux_workflow_instances_id_definition_version]
    ON [flowpilot].[workflow_instances] ([id], [definition_id], [version_id]);
CREATE UNIQUE INDEX [ux_workflow_instances_id_version]
    ON [flowpilot].[workflow_instances] ([id], [version_id]);

CREATE TABLE [flowpilot].[instance_field_values]
(
    [id] uniqueidentifier NOT NULL,
    [instance_id] uniqueidentifier NOT NULL,
    [definition_id] uniqueidentifier NOT NULL,
    [version_id] uniqueidentifier NOT NULL,
    [field_id] nvarchar(100) NOT NULL,
    [table_field_id] nvarchar(100) NULL,
    [column_id] nvarchar(100) NULL,
    [row_id] nvarchar(100) NULL,
    [value_type] nvarchar(20) NOT NULL,
    [text_value] nvarchar(2000) NULL,
    [text_value_hash] binary(32) NULL,
    [number_value] decimal(38, 10) NULL,
    [datetime_value] datetime2(3) NULL,
    [boolean_value] bit NULL,
    [option_id] nvarchar(200) NULL,
    CONSTRAINT [pk_instance_field_values] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_instance_field_values_field_id] CHECK (LEN(LTRIM(RTRIM([field_id]))) > 0),
    CONSTRAINT [ck_instance_field_values_shape] CHECK
    (
        ([table_field_id] IS NULL AND [column_id] IS NULL AND [row_id] IS NULL)
        OR ([table_field_id] IS NOT NULL AND [column_id] IS NOT NULL AND [row_id] IS NOT NULL
            AND LEN(LTRIM(RTRIM([table_field_id]))) > 0
            AND LEN(LTRIM(RTRIM([column_id]))) > 0
            AND LEN(LTRIM(RTRIM([row_id]))) > 0)
    ),
    CONSTRAINT [ck_instance_field_values_value_type] CHECK
        ([value_type] IN (N'text', N'number', N'datetime', N'boolean', N'option')),
    CONSTRAINT [ck_instance_field_values_value] CHECK
    (
        ([value_type] = N'text'
            AND [text_value] IS NOT NULL AND [text_value_hash] IS NOT NULL
            AND [number_value] IS NULL AND [datetime_value] IS NULL
            AND [boolean_value] IS NULL AND [option_id] IS NULL)
        OR ([value_type] = N'number'
            AND [text_value] IS NULL AND [text_value_hash] IS NULL
            AND [number_value] IS NOT NULL AND [datetime_value] IS NULL
            AND [boolean_value] IS NULL AND [option_id] IS NULL)
        OR ([value_type] = N'datetime'
            AND [text_value] IS NULL AND [text_value_hash] IS NULL
            AND [number_value] IS NULL AND [datetime_value] IS NOT NULL
            AND [boolean_value] IS NULL AND [option_id] IS NULL)
        OR ([value_type] = N'boolean'
            AND [text_value] IS NULL AND [text_value_hash] IS NULL
            AND [number_value] IS NULL AND [datetime_value] IS NULL
            AND [boolean_value] IS NOT NULL AND [option_id] IS NULL)
        OR ([value_type] = N'option'
            AND [text_value] IS NULL AND [text_value_hash] IS NULL
            AND [number_value] IS NULL AND [datetime_value] IS NULL
            AND [boolean_value] IS NULL AND [option_id] IS NOT NULL)
    ),
    CONSTRAINT [fk_instance_field_values_instance_version] FOREIGN KEY
        ([instance_id], [definition_id], [version_id])
        REFERENCES [flowpilot].[workflow_instances] ([id], [definition_id], [version_id]) ON DELETE CASCADE
);

CREATE UNIQUE INDEX [ux_instance_field_values_scalar]
    ON [flowpilot].[instance_field_values] ([instance_id], [field_id])
    WHERE [table_field_id] IS NULL AND [column_id] IS NULL AND [row_id] IS NULL;
CREATE UNIQUE INDEX [ux_instance_field_values_table]
    ON [flowpilot].[instance_field_values] ([instance_id], [table_field_id], [row_id], [column_id])
    WHERE [table_field_id] IS NOT NULL AND [column_id] IS NOT NULL AND [row_id] IS NOT NULL;
CREATE INDEX [ix_instance_field_values_text]
    ON [flowpilot].[instance_field_values] ([definition_id], [field_id], [text_value_hash], [instance_id])
    INCLUDE ([text_value])
    WHERE [value_type] = N'text';
CREATE INDEX [ix_instance_field_values_number]
    ON [flowpilot].[instance_field_values] ([definition_id], [field_id], [number_value], [instance_id])
    WHERE [value_type] = N'number';
CREATE INDEX [ix_instance_field_values_datetime]
    ON [flowpilot].[instance_field_values] ([definition_id], [field_id], [datetime_value], [instance_id])
    WHERE [value_type] = N'datetime';
CREATE INDEX [ix_instance_field_values_option]
    ON [flowpilot].[instance_field_values] ([definition_id], [field_id], [option_id], [instance_id])
    WHERE [value_type] = N'option';
CREATE INDEX [ix_instance_field_values_instance_field]
    ON [flowpilot].[instance_field_values] ([instance_id], [field_id]);

CREATE TABLE [flowpilot].[workflow_tasks]
(
    [id] uniqueidentifier NOT NULL,
    [task_type] nvarchar(30) NOT NULL,
    [instance_id] uniqueidentifier NOT NULL,
    [version_id] uniqueidentifier NOT NULL,
    [assignee_id] uniqueidentifier NULL,
    [round] int NOT NULL,
    [status] nvarchar(20) NOT NULL,
    [activated_at] datetime2(3) NOT NULL,
    [completed_at] datetime2(3) NULL,
    [revision] int NOT NULL,
    [node_id] nvarchar(100) NULL,
    [node_name_snapshot] nvarchar(200) NULL,
    [group_id] uniqueidentifier NULL,
    [default_assignee_id] uniqueidentifier NULL,
    [actual_assignee_id] uniqueidentifier NULL,
    [action] nvarchar(30) NULL,
    [result_comment] nvarchar(2000) NULL,
    CONSTRAINT [pk_workflow_tasks] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_tasks_type] CHECK
        ([task_type] IN (N'approval', N'free-collaboration', N'resubmission')),
    CONSTRAINT [ck_workflow_tasks_round] CHECK ([round] >= 1),
    CONSTRAINT [ck_workflow_tasks_status] CHECK
        ([status] IN (N'inactive', N'pending', N'completed', N'cancelled', N'skipped')),
    CONSTRAINT [ck_workflow_tasks_type_status] CHECK
    (
        [task_type] = N'approval'
        OR [status] IN (N'pending', N'completed', N'cancelled')
    ),
    CONSTRAINT [ck_workflow_tasks_type_shape] CHECK
    (
        ([task_type] = N'approval'
            AND [assignee_id] IS NULL
            AND [node_id] IS NOT NULL AND LEN(LTRIM(RTRIM([node_id]))) > 0
            AND [node_name_snapshot] IS NOT NULL AND LEN(LTRIM(RTRIM([node_name_snapshot]))) > 0
            AND [group_id] IS NOT NULL)
        OR ([task_type] IN (N'free-collaboration', N'resubmission')
            AND [assignee_id] IS NOT NULL
            AND [node_id] IS NULL AND [node_name_snapshot] IS NULL
            AND [group_id] IS NULL AND [default_assignee_id] IS NULL
            AND [actual_assignee_id] IS NULL AND [action] IS NULL
            AND [result_comment] IS NULL)
    ),
    CONSTRAINT [ck_workflow_tasks_action] CHECK
        ([action] IS NULL OR [action] IN (N'pass', N'confirm', N'reject', N'revise-fields')),
    CONSTRAINT [ck_workflow_tasks_approval_result] CHECK
    (
        [task_type] <> N'approval'
        OR ([status] = N'completed' AND [action] IS NOT NULL)
        OR ([status] <> N'completed' AND [action] IS NULL AND [result_comment] IS NULL)
    ),
    CONSTRAINT [ck_workflow_tasks_completion] CHECK
    (
        ([status] IN (N'inactive', N'pending') AND [completed_at] IS NULL)
        OR ([status] IN (N'completed', N'cancelled', N'skipped') AND [completed_at] IS NOT NULL)
    ),
    CONSTRAINT [ck_workflow_tasks_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_workflow_tasks_time_order] CHECK
        ([completed_at] IS NULL OR [completed_at] >= [activated_at]),
    CONSTRAINT [fk_workflow_tasks_instance_version] FOREIGN KEY ([instance_id], [version_id])
        REFERENCES [flowpilot].[workflow_instances] ([id], [version_id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_tasks_assignee] FOREIGN KEY ([assignee_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_tasks_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_tasks_default_assignee] FOREIGN KEY ([default_assignee_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_tasks_actual_assignee] FOREIGN KEY ([actual_assignee_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_workflow_tasks_approval_node_round]
    ON [flowpilot].[workflow_tasks] ([instance_id], [node_id], [round])
    WHERE [task_type] = N'approval' AND [node_id] IS NOT NULL;
CREATE UNIQUE INDEX [ux_workflow_tasks_pending_free]
    ON [flowpilot].[workflow_tasks] ([instance_id])
    WHERE [task_type] = N'free-collaboration' AND [status] = N'pending';
CREATE UNIQUE INDEX [ux_workflow_tasks_pending_resubmission]
    ON [flowpilot].[workflow_tasks] ([instance_id])
    WHERE [task_type] = N'resubmission' AND [status] = N'pending';
CREATE INDEX [ix_workflow_tasks_assignee_status_activated]
    ON [flowpilot].[workflow_tasks] ([assignee_id], [status], [activated_at], [id])
    WHERE [assignee_id] IS NOT NULL;
CREATE INDEX [ix_workflow_tasks_instance_round]
    ON [flowpilot].[workflow_tasks] ([instance_id], [round], [activated_at], [id]);
CREATE UNIQUE INDEX [ux_workflow_tasks_id_instance]
    ON [flowpilot].[workflow_tasks] ([id], [instance_id]);

CREATE TABLE [flowpilot].[free_timeline_entries]
(
    [id] uniqueidentifier NOT NULL,
    [instance_id] uniqueidentifier NOT NULL,
    [entry_type] nvarchar(30) NOT NULL,
    [actor_user_id] uniqueidentifier NOT NULL,
    [related_entry_id] uniqueidentifier NULL,
    [content] nvarchar(max) NULL,
    [previous_assignee_id] uniqueidentifier NULL,
    [assignee_id] uniqueidentifier NULL,
    [reason] nvarchar(2000) NULL,
    [field_changes_json] nvarchar(max) NULL,
    [occurred_at] datetime2(3) NOT NULL,
    [edited_by] uniqueidentifier NULL,
    [edited_at] datetime2(3) NULL,
    [revision] int NOT NULL,
    CONSTRAINT [pk_free_timeline_entries] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_free_timeline_entries_type] CHECK
        ([entry_type] IN (N'created', N'reply', N'reply-edited', N'transferred', N'form-edited', N'reassigned', N'closed', N'reopened')),
    CONSTRAINT [ck_free_timeline_entries_content] CHECK
    (
        ([entry_type] = N'reply' AND [content] IS NOT NULL AND LEN([content]) > 0)
        OR ([entry_type] <> N'reply' AND [content] IS NULL)
    ),
    CONSTRAINT [ck_free_timeline_entries_related_reply] CHECK
    (
        ([entry_type] = N'reply-edited' AND [related_entry_id] IS NOT NULL)
        OR ([entry_type] <> N'reply-edited' AND [related_entry_id] IS NULL)
    ),
    CONSTRAINT [ck_free_timeline_entries_field_changes_json] CHECK
        ([field_changes_json] IS NULL OR ISJSON([field_changes_json]) = 1),
    CONSTRAINT [ck_free_timeline_entries_edit_pair] CHECK
        (([edited_by] IS NULL AND [edited_at] IS NULL)
         OR ([entry_type] = N'reply' AND [edited_by] IS NOT NULL AND [edited_at] IS NOT NULL)),
    CONSTRAINT [ck_free_timeline_entries_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_free_timeline_entries_time_order] CHECK
        ([edited_at] IS NULL OR [edited_at] >= [occurred_at]),
    CONSTRAINT [fk_free_timeline_entries_instance] FOREIGN KEY ([instance_id])
        REFERENCES [flowpilot].[workflow_instances] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_free_timeline_entries_actor] FOREIGN KEY ([actor_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_free_timeline_entries_related] FOREIGN KEY ([related_entry_id])
        REFERENCES [flowpilot].[free_timeline_entries] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_free_timeline_entries_previous_assignee] FOREIGN KEY ([previous_assignee_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_free_timeline_entries_assignee] FOREIGN KEY ([assignee_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_free_timeline_entries_edited_by] FOREIGN KEY ([edited_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_free_timeline_entries_instance_occurred]
    ON [flowpilot].[free_timeline_entries] ([instance_id], [occurred_at], [id]);
CREATE INDEX [ix_free_timeline_entries_related]
    ON [flowpilot].[free_timeline_entries] ([related_entry_id])
    WHERE [related_entry_id] IS NOT NULL;
CREATE UNIQUE INDEX [ux_free_timeline_entries_id_instance]
    ON [flowpilot].[free_timeline_entries] ([id], [instance_id]);

CREATE TABLE [flowpilot].[free_participants]
(
    [instance_id] uniqueidentifier NOT NULL,
    [user_id] uniqueidentifier NOT NULL,
    [first_participated_at] datetime2(3) NOT NULL,
    [last_participated_at] datetime2(3) NOT NULL,
    [source_flags] int NOT NULL,
    CONSTRAINT [pk_free_participants] PRIMARY KEY CLUSTERED ([instance_id], [user_id]),
    CONSTRAINT [ck_free_participants_source_flags] CHECK ([source_flags] > 0),
    CONSTRAINT [ck_free_participants_time_order] CHECK ([last_participated_at] >= [first_participated_at]),
    CONSTRAINT [fk_free_participants_instance] FOREIGN KEY ([instance_id])
        REFERENCES [flowpilot].[workflow_instances] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_free_participants_user] FOREIGN KEY ([user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_free_participants_user_instance]
    ON [flowpilot].[free_participants] ([user_id], [instance_id]);

CREATE TABLE [flowpilot].[workflow_events]
(
    [id] uniqueidentifier NOT NULL,
    [event_type] nvarchar(100) NOT NULL,
    [instance_id] uniqueidentifier NOT NULL,
    [task_id] uniqueidentifier NULL,
    [node_id] nvarchar(100) NULL,
    [round] int NULL,
    [operator_user_id] uniqueidentifier NOT NULL,
    [effective_user_id] uniqueidentifier NOT NULL,
    [occurred_at] datetime2(3) NOT NULL,
    [metadata_json] nvarchar(max) NULL,
    CONSTRAINT [pk_workflow_events] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_workflow_events_type] CHECK (LEN(LTRIM(RTRIM([event_type]))) > 0),
    CONSTRAINT [ck_workflow_events_round] CHECK ([round] IS NULL OR [round] >= 1),
    CONSTRAINT [ck_workflow_events_metadata_json] CHECK
        ([metadata_json] IS NULL OR ISJSON([metadata_json]) = 1),
    CONSTRAINT [fk_workflow_events_instance] FOREIGN KEY ([instance_id])
        REFERENCES [flowpilot].[workflow_instances] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_events_task_instance] FOREIGN KEY ([task_id], [instance_id])
        REFERENCES [flowpilot].[workflow_tasks] ([id], [instance_id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_events_operator] FOREIGN KEY ([operator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_workflow_events_effective_user] FOREIGN KEY ([effective_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_workflow_events_instance_occurred]
    ON [flowpilot].[workflow_events] ([instance_id], [occurred_at], [id]);
CREATE INDEX [ix_workflow_events_task]
    ON [flowpilot].[workflow_events] ([task_id], [occurred_at], [id])
    WHERE [task_id] IS NOT NULL;

CREATE TABLE [flowpilot].[audit_events]
(
    [id] uniqueidentifier NOT NULL,
    [resource_type] nvarchar(100) NOT NULL,
    [resource_id] uniqueidentifier NOT NULL,
    [action] nvarchar(100) NOT NULL,
    [field_identifiers_json] nvarchar(max) NULL,
    [operator_user_id] uniqueidentifier NOT NULL,
    [effective_user_id] uniqueidentifier NOT NULL,
    [trace_id] nvarchar(100) NOT NULL,
    [result] nvarchar(30) NOT NULL,
    [occurred_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_audit_events] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_audit_events_resource_type] CHECK (LEN(LTRIM(RTRIM([resource_type]))) > 0),
    CONSTRAINT [ck_audit_events_action] CHECK (LEN(LTRIM(RTRIM([action]))) > 0),
    CONSTRAINT [ck_audit_events_field_identifiers_json] CHECK
        ([field_identifiers_json] IS NULL OR ISJSON([field_identifiers_json]) = 1),
    CONSTRAINT [ck_audit_events_trace_id] CHECK (LEN(LTRIM(RTRIM([trace_id]))) > 0),
    CONSTRAINT [ck_audit_events_result] CHECK ([result] IN (N'success', N'failure')),
    CONSTRAINT [fk_audit_events_operator] FOREIGN KEY ([operator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_audit_events_effective_user] FOREIGN KEY ([effective_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_audit_events_resource]
    ON [flowpilot].[audit_events] ([resource_type], [resource_id], [occurred_at] DESC, [id]);
CREATE INDEX [ix_audit_events_operator]
    ON [flowpilot].[audit_events] ([operator_user_id], [occurred_at] DESC, [id]);
CREATE INDEX [ix_audit_events_effective_user]
    ON [flowpilot].[audit_events] ([effective_user_id], [occurred_at] DESC, [id]);
CREATE INDEX [ix_audit_events_result]
    ON [flowpilot].[audit_events] ([result], [occurred_at] DESC, [id]);
CREATE INDEX [ix_audit_events_action]
    ON [flowpilot].[audit_events] ([action], [occurred_at] DESC, [id]);
CREATE INDEX [ix_audit_events_occurred]
    ON [flowpilot].[audit_events] ([occurred_at] DESC, [id]);
CREATE INDEX [ix_audit_events_trace]
    ON [flowpilot].[audit_events] ([trace_id]);

CREATE TABLE [flowpilot].[number_counters]
(
    [prefix] nvarchar(20) NOT NULL,
    [year_month] char(6) NOT NULL,
    [next_value] bigint NOT NULL,
    [revision] int NOT NULL,
    [updated_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_number_counters] PRIMARY KEY CLUSTERED ([prefix], [year_month]),
    CONSTRAINT [ck_number_counters_prefix] CHECK (LEN(LTRIM(RTRIM([prefix]))) > 0),
    CONSTRAINT [ck_number_counters_year_month] CHECK
    (
        [year_month] COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9]%'
        AND SUBSTRING([year_month], 5, 2) BETWEEN '01' AND '12'
    ),
    CONSTRAINT [ck_number_counters_next_value] CHECK ([next_value] >= 1),
    CONSTRAINT [ck_number_counters_revision] CHECK ([revision] >= 1)
);

CREATE TABLE [flowpilot].[attachments]
(
    [id] uniqueidentifier NOT NULL,
    [state] nvarchar(30) NOT NULL,
    [storage_year] smallint NOT NULL,
    [storage_key] nvarchar(500) NOT NULL,
    [original_file_name] nvarchar(255) NOT NULL,
    [extension] nvarchar(50) NOT NULL,
    [declared_content_type] nvarchar(255) NULL,
    [detected_content_type] nvarchar(255) NULL,
    [size_bytes] bigint NULL,
    [sha256] varchar(64) NULL,
    [purpose] nvarchar(50) NOT NULL,
    [uploaded_by] uniqueidentifier NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [staged_at] datetime2(3) NULL,
    [cleanup_after] datetime2(3) NULL,
    [last_error] nvarchar(1000) NULL,
    [revision] int NOT NULL,
    CONSTRAINT [pk_attachments] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_attachments_state] CHECK
        ([state] IN (N'uploading', N'staged', N'active', N'cleanup-pending', N'failed', N'deleted')),
    CONSTRAINT [ck_attachments_storage_year] CHECK ([storage_year] BETWEEN 2000 AND 9999),
    CONSTRAINT [ck_attachments_storage_key] CHECK
    (
        LEN([storage_key]) > 0
        AND LEFT([storage_key], 1) <> N'/'
        AND [storage_key] NOT LIKE N'%\%'
        AND [storage_key] NOT LIKE N'%:%'
        AND [storage_key] NOT LIKE N'%//%'
        AND [storage_key] NOT LIKE N'../%'
        AND [storage_key] NOT LIKE N'%/../%'
        AND RIGHT([storage_key], 3) <> N'/..'
    ),
    CONSTRAINT [ck_attachments_original_file_name] CHECK (LEN([original_file_name]) > 0),
    CONSTRAINT [ck_attachments_size] CHECK ([size_bytes] IS NULL OR [size_bytes] >= 0),
    CONSTRAINT [ck_attachments_sha256] CHECK
    (
        [sha256] IS NULL
        OR (LEN([sha256]) = 64
            AND [sha256] = LOWER([sha256])
            AND [sha256] COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%')
    ),
    CONSTRAINT [ck_attachments_completed_metadata] CHECK
    (
        [state] IN (N'uploading', N'failed')
        OR ([size_bytes] IS NOT NULL AND [sha256] IS NOT NULL AND [staged_at] IS NOT NULL)
    ),
    CONSTRAINT [ck_attachments_purpose] CHECK (LEN(LTRIM(RTRIM([purpose]))) > 0),
    CONSTRAINT [ck_attachments_staged_time] CHECK ([staged_at] IS NULL OR [staged_at] >= [created_at]),
    CONSTRAINT [ck_attachments_revision] CHECK ([revision] >= 1),
    CONSTRAINT [fk_attachments_uploaded_by] FOREIGN KEY ([uploaded_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_attachments_storage_key]
    ON [flowpilot].[attachments] ([storage_key]);
CREATE INDEX [ix_attachments_state_cleanup]
    ON [flowpilot].[attachments] ([state], [cleanup_after], [id]);
CREATE INDEX [ix_attachments_uploaded_by_created]
    ON [flowpilot].[attachments] ([uploaded_by], [created_at] DESC, [id]);

CREATE TABLE [flowpilot].[attachment_references]
(
    [id] uniqueidentifier NOT NULL,
    [attachment_id] uniqueidentifier NOT NULL,
    [instance_id] uniqueidentifier NOT NULL,
    [field_id] nvarchar(100) NULL,
    [table_row_id] nvarchar(100) NULL,
    [free_timeline_entry_id] uniqueidentifier NULL,
    [reference_type] nvarchar(30) NOT NULL,
    [created_by] uniqueidentifier NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_attachment_references] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_attachment_references_type] CHECK
        ([reference_type] IN (N'form-field', N'table-row', N'free-timeline')),
    CONSTRAINT [ck_attachment_references_shape] CHECK
    (
        ([reference_type] = N'form-field'
            AND [field_id] IS NOT NULL AND LEN(LTRIM(RTRIM([field_id]))) > 0
            AND [table_row_id] IS NULL AND [free_timeline_entry_id] IS NULL)
        OR ([reference_type] = N'table-row'
            AND [field_id] IS NOT NULL AND LEN(LTRIM(RTRIM([field_id]))) > 0
            AND [table_row_id] IS NOT NULL AND LEN(LTRIM(RTRIM([table_row_id]))) > 0
            AND [free_timeline_entry_id] IS NULL)
        OR ([reference_type] = N'free-timeline'
            AND [field_id] IS NULL AND [table_row_id] IS NULL
            AND [free_timeline_entry_id] IS NOT NULL)
    ),
    CONSTRAINT [fk_attachment_references_attachment] FOREIGN KEY ([attachment_id])
        REFERENCES [flowpilot].[attachments] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_attachment_references_instance] FOREIGN KEY ([instance_id])
        REFERENCES [flowpilot].[workflow_instances] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_attachment_references_free_timeline_instance] FOREIGN KEY
        ([free_timeline_entry_id], [instance_id])
        REFERENCES [flowpilot].[free_timeline_entries] ([id], [instance_id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_attachment_references_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_attachment_references_form_field]
    ON [flowpilot].[attachment_references] ([instance_id], [field_id], [id])
    WHERE [reference_type] = N'form-field';
CREATE INDEX [ix_attachment_references_table_row]
    ON [flowpilot].[attachment_references] ([instance_id], [field_id], [table_row_id], [id])
    WHERE [reference_type] = N'table-row';
CREATE INDEX [ix_attachment_references_free_timeline]
    ON [flowpilot].[attachment_references] ([free_timeline_entry_id], [id])
    WHERE [reference_type] = N'free-timeline';
CREATE UNIQUE INDEX [ux_attachment_references_attachment]
    ON [flowpilot].[attachment_references] ([attachment_id]);

CREATE TABLE [flowpilot].[sessions]
(
    [id] uniqueidentifier NOT NULL,
    [token_hash] binary(32) NOT NULL,
    [operator_user_id] uniqueidentifier NOT NULL,
    [effective_user_id] uniqueidentifier NOT NULL,
    [permission_snapshot_version] int NOT NULL,
    [created_at] datetime2(3) NOT NULL,
    [last_accessed_at] datetime2(3) NOT NULL,
    [idle_expires_at] datetime2(3) NOT NULL,
    [absolute_expires_at] datetime2(3) NOT NULL,
    [revoked_at] datetime2(3) NULL,
    [revocation_reason] nvarchar(500) NULL,
    CONSTRAINT [pk_sessions] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_sessions_permission_snapshot] CHECK ([permission_snapshot_version] >= 1),
    CONSTRAINT [ck_sessions_expiry] CHECK
    (
        [last_accessed_at] >= [created_at]
        AND [idle_expires_at] >= [last_accessed_at]
        AND [absolute_expires_at] >= [created_at]
        AND [idle_expires_at] <= [absolute_expires_at]
    ),
    CONSTRAINT [ck_sessions_revocation] CHECK
    (
        ([revoked_at] IS NULL AND [revocation_reason] IS NULL)
        OR ([revoked_at] IS NOT NULL AND [revocation_reason] IS NOT NULL
            AND LEN(LTRIM(RTRIM([revocation_reason]))) > 0)
    ),
    CONSTRAINT [fk_sessions_operator] FOREIGN KEY ([operator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_sessions_effective_user] FOREIGN KEY ([effective_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_sessions_token_hash]
    ON [flowpilot].[sessions] ([token_hash]);
CREATE INDEX [ix_sessions_operator_active]
    ON [flowpilot].[sessions] ([operator_user_id], [revoked_at], [absolute_expires_at], [id]);
CREATE INDEX [ix_sessions_effective_active]
    ON [flowpilot].[sessions] ([effective_user_id], [revoked_at], [absolute_expires_at], [id]);
CREATE INDEX [ix_sessions_expiry]
    ON [flowpilot].[sessions] ([revoked_at], [idle_expires_at], [absolute_expires_at], [id]);

CREATE TABLE [flowpilot].[impersonation_records]
(
    [id] uniqueidentifier NOT NULL,
    [super_admin_user_id] uniqueidentifier NOT NULL,
    [target_user_id] uniqueidentifier NOT NULL,
    [reason] nvarchar(1000) NOT NULL,
    [started_at] datetime2(3) NOT NULL,
    [ended_at] datetime2(3) NULL,
    [start_trace_id] nvarchar(100) NOT NULL,
    [end_trace_id] nvarchar(100) NULL,
    CONSTRAINT [pk_impersonation_records] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_impersonation_records_users] CHECK ([super_admin_user_id] <> [target_user_id]),
    CONSTRAINT [ck_impersonation_records_reason] CHECK (LEN(LTRIM(RTRIM([reason]))) > 0),
    CONSTRAINT [ck_impersonation_records_start_trace] CHECK (LEN(LTRIM(RTRIM([start_trace_id]))) > 0),
    CONSTRAINT [ck_impersonation_records_end] CHECK
    (
        ([ended_at] IS NULL AND [end_trace_id] IS NULL)
        OR ([ended_at] IS NOT NULL AND [end_trace_id] IS NOT NULL
            AND [ended_at] >= [started_at]
            AND LEN(LTRIM(RTRIM([end_trace_id]))) > 0)
    ),
    CONSTRAINT [fk_impersonation_records_super_admin] FOREIGN KEY ([super_admin_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_impersonation_records_target] FOREIGN KEY ([target_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE INDEX [ix_impersonation_records_super_admin_started]
    ON [flowpilot].[impersonation_records] ([super_admin_user_id], [started_at] DESC, [id]);
CREATE INDEX [ix_impersonation_records_target_started]
    ON [flowpilot].[impersonation_records] ([target_user_id], [started_at] DESC, [id]);

CREATE TABLE [flowpilot].[idempotency_records]
(
    [id] uniqueidentifier NOT NULL,
    [actor_id] uniqueidentifier NOT NULL,
    [route_scope] nvarchar(200) NOT NULL,
    [idempotency_key] nvarchar(200) NOT NULL,
    [request_hash] varchar(64) NOT NULL,
    [status] nvarchar(20) NOT NULL,
    [first_http_status] smallint NULL,
    [replay_headers_json] nvarchar(max) NULL,
    [response_body_json] nvarchar(max) NULL,
    [lease_owner] nvarchar(100) NULL,
    [lease_until] datetime2(3) NULL,
    [created_at] datetime2(3) NOT NULL,
    [completed_at] datetime2(3) NULL,
    [expires_at] datetime2(3) NOT NULL,
    CONSTRAINT [pk_idempotency_records] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_idempotency_records_route] CHECK (LEN(LTRIM(RTRIM([route_scope]))) > 0),
    CONSTRAINT [ck_idempotency_records_key] CHECK (LEN(LTRIM(RTRIM([idempotency_key]))) BETWEEN 16 AND 200),
    CONSTRAINT [ck_idempotency_records_request_hash] CHECK
    (
        LEN([request_hash]) = 64
        AND [request_hash] = LOWER([request_hash])
        AND [request_hash] COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%'
    ),
    CONSTRAINT [ck_idempotency_records_status] CHECK
        ([status] IN (N'processing', N'completed', N'failed')),
    CONSTRAINT [ck_idempotency_records_http_status] CHECK
        ([first_http_status] IS NULL OR [first_http_status] BETWEEN 100 AND 599),
    CONSTRAINT [ck_idempotency_records_headers_json] CHECK
        ([replay_headers_json] IS NULL OR ISJSON([replay_headers_json]) = 1),
    CONSTRAINT [ck_idempotency_records_body_json] CHECK
        ([response_body_json] IS NULL OR ISJSON([response_body_json]) = 1),
    CONSTRAINT [ck_idempotency_records_lease] CHECK
    (
        ([status] = N'processing'
            AND [lease_owner] IS NOT NULL AND [lease_until] IS NOT NULL
            AND LEN(LTRIM(RTRIM([lease_owner]))) > 0)
        OR ([status] IN (N'completed', N'failed')
            AND [lease_owner] IS NULL AND [lease_until] IS NULL)
    ),
    CONSTRAINT [ck_idempotency_records_completion] CHECK
    (
        ([status] = N'processing' AND [completed_at] IS NULL)
        OR ([status] IN (N'completed', N'failed')
            AND [completed_at] IS NOT NULL AND [first_http_status] IS NOT NULL)
    ),
    CONSTRAINT [ck_idempotency_records_time_order] CHECK
    (
        [expires_at] > [created_at]
        AND ([completed_at] IS NULL OR [completed_at] >= [created_at])
    ),
    CONSTRAINT [fk_idempotency_records_actor] FOREIGN KEY ([actor_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_idempotency_records_scope_key]
    ON [flowpilot].[idempotency_records] ([actor_id], [route_scope], [idempotency_key]);
CREATE INDEX [ix_idempotency_records_status_lease]
    ON [flowpilot].[idempotency_records] ([status], [lease_until], [created_at], [id]);
CREATE INDEX [ix_idempotency_records_expiry]
    ON [flowpilot].[idempotency_records] ([expires_at], [id]);

CREATE TABLE [flowpilot].[email_outbox]
(
    [id] uniqueidentifier NOT NULL,
    [revision] int NOT NULL,
    [idempotency_key] nvarchar(300) NOT NULL,
    [event_type] nvarchar(100) NOT NULL,
    [instance_id] uniqueidentifier NOT NULL,
    [task_id] uniqueidentifier NULL,
    [template_key] nvarchar(100) NOT NULL,
    [recipient_user_id] uniqueidentifier NOT NULL,
    [recipient_email_snapshot] nvarchar(320) NOT NULL,
    [subject] nvarchar(500) NOT NULL,
    [template_data_json] nvarchar(max) NOT NULL,
    [target_path] nvarchar(1000) NOT NULL,
    [link_base_url] nvarchar(2048) NULL,
    [resolved_target_url] nvarchar(2048) NULL,
    [status] nvarchar(30) NOT NULL,
    [scheduled_at] datetime2(3) NOT NULL,
    [attempt_count] int NOT NULL,
    [lease_owner] nvarchar(100) NULL,
    [lease_until] datetime2(3) NULL,
    [last_error_code] nvarchar(100) NULL,
    [last_error_summary] nvarchar(1000) NULL,
    [created_at] datetime2(3) NOT NULL,
    [sent_at] datetime2(3) NULL,
    [dead_lettered_at] datetime2(3) NULL,
    CONSTRAINT [pk_email_outbox] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_email_outbox_revision] CHECK ([revision] >= 1),
    CONSTRAINT [ck_email_outbox_idempotency_key] CHECK (LEN(LTRIM(RTRIM([idempotency_key]))) > 0),
    CONSTRAINT [ck_email_outbox_event_type] CHECK (LEN(LTRIM(RTRIM([event_type]))) > 0),
    CONSTRAINT [ck_email_outbox_template_key] CHECK (LEN(LTRIM(RTRIM([template_key]))) > 0),
    CONSTRAINT [ck_email_outbox_recipient_email] CHECK (LEN(LTRIM(RTRIM([recipient_email_snapshot]))) > 0),
    CONSTRAINT [ck_email_outbox_subject] CHECK (LEN(LTRIM(RTRIM([subject]))) > 0),
    CONSTRAINT [ck_email_outbox_template_data_json] CHECK (ISJSON([template_data_json]) = 1),
    CONSTRAINT [ck_email_outbox_target_path] CHECK
    (
        [target_path] LIKE N'/processes/%'
        AND [target_path] NOT LIKE N'%://%'
        AND [target_path] NOT LIKE N'%#%'
    ),
    CONSTRAINT [ck_email_outbox_link_base_url] CHECK
    (
        [link_base_url] IS NULL
        OR [link_base_url] LIKE N'http://%/flowpilot'
        OR [link_base_url] LIKE N'https://%/flowpilot'
    ),
    CONSTRAINT [ck_email_outbox_resolved_target_url] CHECK
    (
        [resolved_target_url] IS NULL
        OR [resolved_target_url] LIKE N'http://%/flowpilot/processes/%'
        OR [resolved_target_url] LIKE N'https://%/flowpilot/processes/%'
    ),
    CONSTRAINT [ck_email_outbox_status] CHECK
        ([status] IN (N'pending', N'processing', N'sent', N'retry-wait', N'dead-letter')),
    CONSTRAINT [ck_email_outbox_attempt_count] CHECK ([attempt_count] >= 0),
    CONSTRAINT [ck_email_outbox_lease] CHECK
    (
        ([status] = N'processing'
            AND [lease_owner] IS NOT NULL AND [lease_until] IS NOT NULL
            AND LEN(LTRIM(RTRIM([lease_owner]))) > 0)
        OR ([status] <> N'processing'
            AND [lease_owner] IS NULL AND [lease_until] IS NULL)
    ),
    CONSTRAINT [ck_email_outbox_error_pair] CHECK
    (
        ([last_error_code] IS NULL AND [last_error_summary] IS NULL)
        OR ([last_error_code] IS NOT NULL AND [last_error_summary] IS NOT NULL)
    ),
    CONSTRAINT [ck_email_outbox_terminal_time] CHECK
    (
        ([status] = N'sent' AND [sent_at] IS NOT NULL AND [dead_lettered_at] IS NULL)
        OR ([status] = N'dead-letter' AND [sent_at] IS NULL AND [dead_lettered_at] IS NOT NULL)
        OR ([status] NOT IN (N'sent', N'dead-letter') AND [sent_at] IS NULL AND [dead_lettered_at] IS NULL)
    ),
    CONSTRAINT [fk_email_outbox_instance] FOREIGN KEY ([instance_id])
        REFERENCES [flowpilot].[workflow_instances] ([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_email_outbox_task_instance] FOREIGN KEY ([task_id], [instance_id])
        REFERENCES [flowpilot].[workflow_tasks] ([id], [instance_id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_email_outbox_recipient] FOREIGN KEY ([recipient_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX [ux_email_outbox_idempotency_key]
    ON [flowpilot].[email_outbox] ([idempotency_key]);
CREATE INDEX [ix_email_outbox_dispatch]
    ON [flowpilot].[email_outbox] ([status], [scheduled_at], [lease_until], [id]);
CREATE INDEX [ix_email_outbox_instance_created]
    ON [flowpilot].[email_outbox] ([instance_id], [created_at] DESC, [id]);

CREATE TABLE [flowpilot].[email_delivery_attempts]
(
    [id] uniqueidentifier NOT NULL,
    [outbox_id] uniqueidentifier NOT NULL,
    [attempt_number] int NOT NULL,
    [started_at] datetime2(3) NOT NULL,
    [completed_at] datetime2(3) NULL,
    [result] nvarchar(20) NOT NULL,
    [error_category] nvarchar(100) NULL,
    [server_response_summary] nvarchar(1000) NULL,
    CONSTRAINT [pk_email_delivery_attempts] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ck_email_delivery_attempts_number] CHECK ([attempt_number] >= 1),
    CONSTRAINT [ck_email_delivery_attempts_result] CHECK
        ([result] IN (N'processing', N'succeeded', N'failed')),
    CONSTRAINT [ck_email_delivery_attempts_completion] CHECK
    (
        ([result] = N'processing' AND [completed_at] IS NULL)
        OR ([result] IN (N'succeeded', N'failed') AND [completed_at] IS NOT NULL)
    ),
    CONSTRAINT [ck_email_delivery_attempts_time_order] CHECK
        ([completed_at] IS NULL OR [completed_at] >= [started_at]),
    CONSTRAINT [ck_email_delivery_attempts_error] CHECK
    (
        ([result] <> N'failed' AND [error_category] IS NULL AND [server_response_summary] IS NULL)
        OR ([result] = N'failed' AND [error_category] IS NOT NULL)
    ),
    CONSTRAINT [fk_email_delivery_attempts_outbox] FOREIGN KEY ([outbox_id])
        REFERENCES [flowpilot].[email_outbox] ([id]) ON DELETE CASCADE
);

CREATE UNIQUE INDEX [ux_email_delivery_attempts_outbox_number]
    ON [flowpilot].[email_delivery_attempts] ([outbox_id], [attempt_number]);

CREATE TABLE [flowpilot].[job_leases]
(
    [job_name] nvarchar(100) NOT NULL,
    [owner_id] nvarchar(100) NULL,
    [lease_until] datetime2(3) NULL,
    [heartbeat_at] datetime2(3) NULL,
    [last_succeeded_at] datetime2(3) NULL,
    [last_failed_at] datetime2(3) NULL,
    [last_result_summary] nvarchar(1000) NULL,
    [revision] int NOT NULL,
    CONSTRAINT [pk_job_leases] PRIMARY KEY CLUSTERED ([job_name]),
    CONSTRAINT [ck_job_leases_name] CHECK (LEN(LTRIM(RTRIM([job_name]))) > 0),
    CONSTRAINT [ck_job_leases_owner] CHECK
    (
        ([owner_id] IS NULL AND [lease_until] IS NULL)
        OR ([owner_id] IS NOT NULL AND [lease_until] IS NOT NULL
            AND LEN(LTRIM(RTRIM([owner_id]))) > 0)
    ),
    CONSTRAINT [ck_job_leases_heartbeat] CHECK
        ([heartbeat_at] IS NULL OR [owner_id] IS NOT NULL),
    CONSTRAINT [ck_job_leases_revision] CHECK ([revision] >= 1)
);

CREATE INDEX [ix_job_leases_expiry]
    ON [flowpilot].[job_leases] ([lease_until], [job_name]);

-- Full department-cycle validation cannot be expressed as a row-level CHECK.
-- The trigger evaluates every inserted/updated department against its ancestor
-- chain and rejects cycles in the same transaction.
EXEC(N'
CREATE TRIGGER [flowpilot].[tr_departments_reject_cycles]
ON [flowpilot].[departments]
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @has_cycle bit = 0;

    ;WITH [ancestors] AS
    (
        SELECT [i].[id] AS [origin_id], [i].[parent_id] AS [ancestor_id]
        FROM [inserted] AS [i]
        WHERE [i].[parent_id] IS NOT NULL

        UNION ALL

        SELECT [a].[origin_id], [d].[parent_id]
        FROM [ancestors] AS [a]
        INNER JOIN [flowpilot].[departments] AS [d]
            ON [d].[id] = [a].[ancestor_id]
        WHERE [a].[ancestor_id] IS NOT NULL
          AND [a].[ancestor_id] <> [a].[origin_id]
    )
    SELECT TOP (1) @has_cycle = 1
    FROM [ancestors]
    WHERE [ancestor_id] = [origin_id]
    OPTION (MAXRECURSION 32767);

    IF @has_cycle = 1
    BEGIN
        THROW 51001, ''Department hierarchy cycles are not allowed.'', 1;
    END;
END;');

EXEC(N'
CREATE TRIGGER [flowpilot].[tr_workflow_tasks_validate_assignee]
ON [flowpilot].[workflow_tasks]
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS
    (
        SELECT 1
        FROM [inserted] AS [i]
        INNER JOIN [flowpilot].[workflow_instances] AS [wi]
            ON [wi].[id] = [i].[instance_id]
        WHERE [i].[task_type] = N''resubmission''
          AND [i].[assignee_id] <> [wi].[initiator_user_id]
    )
    BEGIN
        THROW 51003, ''A resubmission task must be assigned to the effective instance initiator.'', 1;
    END;

    IF EXISTS
    (
        SELECT 1
        FROM [inserted] AS [i]
        INNER JOIN [flowpilot].[workflow_instances] AS [wi]
            ON [wi].[id] = [i].[instance_id]
        WHERE [i].[task_type] = N''free-collaboration''
          AND [i].[status] = N''pending''
          AND ([wi].[current_assignee_id] IS NULL OR [i].[assignee_id] <> [wi].[current_assignee_id])
    )
    BEGIN
        THROW 51004, ''A pending free-collaboration task must match the instance current assignee.'', 1;
    END;
END;');

EXEC(N'
CREATE TRIGGER [flowpilot].[tr_free_timeline_entries_validate_reply_edit]
ON [flowpilot].[free_timeline_entries]
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS
    (
        SELECT 1
        FROM [inserted] AS [i]
        LEFT JOIN [flowpilot].[free_timeline_entries] AS [reply]
            ON [reply].[id] = [i].[related_entry_id]
        WHERE [i].[entry_type] = N''reply-edited''
          AND ([reply].[id] IS NULL
               OR [reply].[entry_type] <> N''reply''
               OR [reply].[instance_id] <> [i].[instance_id])
    )
    BEGIN
        THROW 51005, ''A reply-edited entry must reference a reply in the same instance.'', 1;
    END;
END;');

EXEC(N'
CREATE TRIGGER [flowpilot].[tr_workflow_events_append_only]
ON [flowpilot].[workflow_events]
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    THROW 51006, ''Workflow events are append-only.'', 1;
END;');

EXEC(N'
CREATE TRIGGER [flowpilot].[tr_audit_events_append_only]
ON [flowpilot].[audit_events]
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    THROW 51007, ''Audit events are append-only.'', 1;
END;');

-- CHECK constraints keep a built-in super administrator enabled and local;
-- this trigger additionally prevents deleting or demoting that protected row.
EXEC(N'
CREATE TRIGGER [flowpilot].[tr_users_protect_builtin_super_admin]
ON [flowpilot].[users]
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS
    (
        SELECT 1
        FROM [deleted] AS [d]
        LEFT JOIN [inserted] AS [i] ON [i].[id] = [d].[id]
        WHERE [d].[is_builtin_super_admin] = 1
          AND ([i].[id] IS NULL OR [i].[is_builtin_super_admin] = 0)
    )
    BEGIN
        THROW 51002, ''The built-in super administrator cannot be deleted or demoted.'', 1;
    END;
END;');
