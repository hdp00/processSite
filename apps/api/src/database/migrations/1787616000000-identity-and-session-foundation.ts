import { createHash } from "node:crypto";
import type { MigrationInterface, QueryRunner } from "typeorm";

export const IDENTITY_AND_SESSION_MIGRATION_ID = "1787616000000";
export const IDENTITY_AND_SESSION_MIGRATION_NAME = "IdentityAndSessionFoundation";

export const IDENTITY_AND_SESSION_SCHEMA_STATEMENTS = [
  `
    IF SCHEMA_ID(N'flowpilot') IS NULL
      EXEC(N'CREATE SCHEMA [flowpilot] AUTHORIZATION [dbo]')
  `,
  `
    CREATE TABLE [flowpilot].[departments] (
      [id] uniqueidentifier NOT NULL,
      [code] nvarchar(100) NOT NULL,
      [normalized_code] nvarchar(100) NOT NULL,
      [name] nvarchar(100) NOT NULL,
      [parent_id] uniqueidentifier NULL,
      [path_cache] nvarchar(500) NOT NULL,
      [sort_order] int NOT NULL CONSTRAINT [df_departments_sort_order] DEFAULT (0),
      [is_enabled] bit NOT NULL CONSTRAINT [df_departments_is_enabled] DEFAULT (1),
      [description] nvarchar(500) NULL,
      [revision] int NOT NULL CONSTRAINT [df_departments_revision] DEFAULT (1),
      [created_at] datetime2(3) NOT NULL,
      [updated_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_departments] PRIMARY KEY ([id]),
      CONSTRAINT [ck_departments_revision] CHECK ([revision] >= 1),
      CONSTRAINT [fk_departments_parent] FOREIGN KEY ([parent_id])
        REFERENCES [flowpilot].[departments] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE UNIQUE INDEX [ux_departments_normalized_code]
    ON [flowpilot].[departments] ([normalized_code])`,
  `CREATE INDEX [ix_departments_parent_sort]
    ON [flowpilot].[departments] ([parent_id], [sort_order], [name])`,
  `
    CREATE TABLE [flowpilot].[positions] (
      [id] uniqueidentifier NOT NULL,
      [code] nvarchar(100) NOT NULL,
      [normalized_code] nvarchar(100) NOT NULL,
      [name] nvarchar(100) NOT NULL,
      [normalized_name] nvarchar(100) NOT NULL,
      [sort_order] int NOT NULL CONSTRAINT [df_positions_sort_order] DEFAULT (0),
      [is_enabled] bit NOT NULL CONSTRAINT [df_positions_is_enabled] DEFAULT (1),
      [description] nvarchar(500) NULL,
      [revision] int NOT NULL CONSTRAINT [df_positions_revision] DEFAULT (1),
      [created_at] datetime2(3) NOT NULL,
      [updated_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_positions] PRIMARY KEY ([id]),
      CONSTRAINT [ck_positions_revision] CHECK ([revision] >= 1)
    )
  `,
  `CREATE UNIQUE INDEX [ux_positions_normalized_code]
    ON [flowpilot].[positions] ([normalized_code])`,
  `CREATE UNIQUE INDEX [ux_positions_normalized_name]
    ON [flowpilot].[positions] ([normalized_name])`,
  `CREATE INDEX [ix_positions_directory_order]
    ON [flowpilot].[positions] ([is_enabled], [sort_order], [name])`,
  `
    CREATE TABLE [flowpilot].[roles] (
      [id] uniqueidentifier NOT NULL,
      [code] nvarchar(100) NOT NULL,
      [normalized_code] nvarchar(100) NOT NULL,
      [name] nvarchar(100) NOT NULL,
      [normalized_name] nvarchar(100) NOT NULL,
      [description] nvarchar(500) NULL,
      [is_enabled] bit NOT NULL CONSTRAINT [df_roles_is_enabled] DEFAULT (1),
      [is_builtin] bit NOT NULL CONSTRAINT [df_roles_is_builtin] DEFAULT (0),
      [revision] int NOT NULL CONSTRAINT [df_roles_revision] DEFAULT (1),
      [created_at] datetime2(3) NOT NULL,
      [updated_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_roles] PRIMARY KEY ([id]),
      CONSTRAINT [ck_roles_revision] CHECK ([revision] >= 1)
    )
  `,
  `CREATE UNIQUE INDEX [ux_roles_normalized_code]
    ON [flowpilot].[roles] ([normalized_code])`,
  `CREATE UNIQUE INDEX [ux_roles_normalized_name]
    ON [flowpilot].[roles] ([normalized_name])`,
  `CREATE INDEX [ix_roles_directory_search]
    ON [flowpilot].[roles] ([is_enabled], [name], [code])`,
  `
    CREATE TABLE [flowpilot].[permissions] (
      [code] nvarchar(150) NOT NULL,
      [resource] nvarchar(100) NOT NULL,
      [action] nvarchar(100) NOT NULL,
      [name] nvarchar(100) NOT NULL,
      [sort_order] int NOT NULL CONSTRAINT [df_permissions_sort_order] DEFAULT (0),
      [is_builtin] bit NOT NULL CONSTRAINT [df_permissions_is_builtin] DEFAULT (1),
      CONSTRAINT [pk_permissions] PRIMARY KEY ([code])
    )
  `,
  `CREATE UNIQUE INDEX [ux_permissions_resource_action]
    ON [flowpilot].[permissions] ([resource], [action])`,
  `
    CREATE TABLE [flowpilot].[users] (
      [id] uniqueidentifier NOT NULL,
      [login_name] nvarchar(100) NOT NULL,
      [normalized_login_name] nvarchar(100) NOT NULL,
      [display_name] nvarchar(100) NOT NULL,
      [email] nvarchar(320) NOT NULL,
      [authentication_mode] nvarchar(20) NOT NULL,
      [password_hash] nvarchar(500) NULL,
      [department_id] uniqueidentifier NOT NULL,
      [position_id] uniqueidentifier NOT NULL,
      [is_enabled] bit NOT NULL CONSTRAINT [df_users_is_enabled] DEFAULT (1),
      [is_builtin_super_admin] bit NOT NULL CONSTRAINT [df_users_is_builtin_super_admin] DEFAULT (0),
      [revision] int NOT NULL CONSTRAINT [df_users_revision] DEFAULT (1),
      [created_at] datetime2(3) NOT NULL,
      [updated_at] datetime2(3) NOT NULL,
      [created_by] uniqueidentifier NULL,
      [updated_by] uniqueidentifier NULL,
      CONSTRAINT [pk_users] PRIMARY KEY ([id]),
      CONSTRAINT [ck_users_authentication_mode] CHECK (
        ([authentication_mode] = N'password' AND [password_hash] IS NOT NULL)
        OR ([authentication_mode] = N'domain' AND [password_hash] IS NULL)
      ),
      CONSTRAINT [ck_users_builtin_super_admin] CHECK (
        [is_builtin_super_admin] = 0
        OR ([authentication_mode] = N'password' AND [is_enabled] = 1)
      ),
      CONSTRAINT [ck_users_revision] CHECK ([revision] >= 1),
      CONSTRAINT [fk_users_department] FOREIGN KEY ([department_id])
        REFERENCES [flowpilot].[departments] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_users_position] FOREIGN KEY ([position_id])
        REFERENCES [flowpilot].[positions] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_users_created_by] FOREIGN KEY ([created_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_users_updated_by] FOREIGN KEY ([updated_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE UNIQUE INDEX [ux_users_normalized_login_name]
    ON [flowpilot].[users] ([normalized_login_name])`,
  `CREATE UNIQUE INDEX [ux_users_builtin_super_admin]
    ON [flowpilot].[users] ([is_builtin_super_admin])
    WHERE [is_builtin_super_admin] = 1`,
  `CREATE INDEX [ix_users_directory_search]
    ON [flowpilot].[users] ([is_enabled], [department_id], [position_id], [display_name])`,
  `
    CREATE TABLE [flowpilot].[user_roles] (
      [user_id] uniqueidentifier NOT NULL,
      [role_id] uniqueidentifier NOT NULL,
      [granted_by] uniqueidentifier NULL,
      [granted_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_user_roles] PRIMARY KEY ([user_id], [role_id]),
      CONSTRAINT [fk_user_roles_user] FOREIGN KEY ([user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_user_roles_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_user_roles_granted_by] FOREIGN KEY ([granted_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE INDEX [ix_user_roles_role_user]
    ON [flowpilot].[user_roles] ([role_id], [user_id])`,
  `
    CREATE TABLE [flowpilot].[role_permissions] (
      [role_id] uniqueidentifier NOT NULL,
      [permission_code] nvarchar(150) NOT NULL,
      [granted_by] uniqueidentifier NULL,
      [granted_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_role_permissions] PRIMARY KEY ([role_id], [permission_code]),
      CONSTRAINT [fk_role_permissions_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_role_permissions_permission] FOREIGN KEY ([permission_code])
        REFERENCES [flowpilot].[permissions] ([code]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_role_permissions_granted_by] FOREIGN KEY ([granted_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE INDEX [ix_role_permissions_permission_role]
    ON [flowpilot].[role_permissions] ([permission_code], [role_id])`,
  `
    CREATE TABLE [flowpilot].[workflow_permission_groups] (
      [id] uniqueidentifier NOT NULL,
      [code] nvarchar(100) NOT NULL,
      [normalized_code] nvarchar(100) NOT NULL,
      [name] nvarchar(100) NOT NULL,
      [description] nvarchar(500) NULL,
      [is_enabled] bit NOT NULL CONSTRAINT [df_workflow_permission_groups_is_enabled] DEFAULT (1),
      [revision] int NOT NULL CONSTRAINT [df_workflow_permission_groups_revision] DEFAULT (1),
      [created_at] datetime2(3) NOT NULL,
      [updated_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_workflow_permission_groups] PRIMARY KEY ([id]),
      CONSTRAINT [ck_workflow_permission_groups_revision] CHECK ([revision] >= 1)
    )
  `,
  `CREATE UNIQUE INDEX [ux_workflow_permission_groups_normalized_code]
    ON [flowpilot].[workflow_permission_groups] ([normalized_code])`,
  `CREATE INDEX [ix_workflow_permission_groups_directory_search]
    ON [flowpilot].[workflow_permission_groups] ([is_enabled], [name], [code])`,
  `
    CREATE TABLE [flowpilot].[workflow_group_users] (
      [group_id] uniqueidentifier NOT NULL,
      [user_id] uniqueidentifier NOT NULL,
      [added_by] uniqueidentifier NULL,
      [added_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_workflow_group_users] PRIMARY KEY ([group_id], [user_id]),
      CONSTRAINT [fk_workflow_group_users_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_workflow_group_users_user] FOREIGN KEY ([user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_workflow_group_users_added_by] FOREIGN KEY ([added_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE INDEX [ix_workflow_group_users_user_group]
    ON [flowpilot].[workflow_group_users] ([user_id], [group_id])`,
  `
    CREATE TABLE [flowpilot].[workflow_group_roles] (
      [group_id] uniqueidentifier NOT NULL,
      [role_id] uniqueidentifier NOT NULL,
      [added_by] uniqueidentifier NULL,
      [added_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_workflow_group_roles] PRIMARY KEY ([group_id], [role_id]),
      CONSTRAINT [fk_workflow_group_roles_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_workflow_group_roles_role] FOREIGN KEY ([role_id])
        REFERENCES [flowpilot].[roles] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_workflow_group_roles_added_by] FOREIGN KEY ([added_by])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE INDEX [ix_workflow_group_roles_role_group]
    ON [flowpilot].[workflow_group_roles] ([role_id], [group_id])`,
  `
    CREATE TABLE [flowpilot].[workflow_group_purposes] (
      [group_id] uniqueidentifier NOT NULL,
      [purpose] nvarchar(30) NOT NULL,
      CONSTRAINT [pk_workflow_group_purposes] PRIMARY KEY ([group_id], [purpose]),
      CONSTRAINT [ck_workflow_group_purposes_purpose] CHECK (
        [purpose] IN (N'start', N'review-or-accept', N'close')
      ),
      CONSTRAINT [fk_workflow_group_purposes_group] FOREIGN KEY ([group_id])
        REFERENCES [flowpilot].[workflow_permission_groups] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE INDEX [ix_workflow_group_purposes_purpose_group]
    ON [flowpilot].[workflow_group_purposes] ([purpose], [group_id])`,
  `
    CREATE TABLE [flowpilot].[sessions] (
      [id] uniqueidentifier NOT NULL,
      [token_hash] varchar(64) NOT NULL,
      [operator_user_id] uniqueidentifier NOT NULL,
      [effective_user_id] uniqueidentifier NOT NULL,
      [permission_version] int NOT NULL CONSTRAINT [df_sessions_permission_version] DEFAULT (1),
      [created_at] datetime2(3) NOT NULL,
      [last_accessed_at] datetime2(3) NOT NULL,
      [idle_expires_at] datetime2(3) NOT NULL,
      [absolute_expires_at] datetime2(3) NOT NULL,
      [revoked_at] datetime2(3) NULL,
      [revocation_reason] nvarchar(200) NULL,
      CONSTRAINT [pk_sessions] PRIMARY KEY ([id]),
      CONSTRAINT [ck_sessions_expiration] CHECK ([idle_expires_at] <= [absolute_expires_at]),
      CONSTRAINT [ck_sessions_revocation] CHECK (
        ([revoked_at] IS NULL AND [revocation_reason] IS NULL)
        OR ([revoked_at] IS NOT NULL AND [revocation_reason] IS NOT NULL)
      ),
      CONSTRAINT [fk_sessions_operator_user] FOREIGN KEY ([operator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_sessions_effective_user] FOREIGN KEY ([effective_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE UNIQUE INDEX [ux_sessions_token_hash]
    ON [flowpilot].[sessions] ([token_hash])`,
  `CREATE INDEX [ix_sessions_operator_expiration]
    ON [flowpilot].[sessions] ([operator_user_id], [revoked_at], [absolute_expires_at])`,
  `CREATE INDEX [ix_sessions_idle_expiration]
    ON [flowpilot].[sessions] ([revoked_at], [idle_expires_at])`,
  `
    CREATE TABLE [flowpilot].[impersonation_records] (
      [id] uniqueidentifier NOT NULL,
      [session_id] uniqueidentifier NOT NULL,
      [operator_user_id] uniqueidentifier NOT NULL,
      [target_user_id] uniqueidentifier NOT NULL,
      [reason] nvarchar(500) NOT NULL,
      [started_at] datetime2(3) NOT NULL,
      [ended_at] datetime2(3) NULL,
      [end_reason] nvarchar(200) NULL,
      [start_trace_id] varchar(128) NOT NULL,
      [end_trace_id] varchar(128) NULL,
      [source_ip] varchar(64) NOT NULL,
      [user_agent] nvarchar(500) NULL,
      CONSTRAINT [pk_impersonation_records] PRIMARY KEY ([id]),
      CONSTRAINT [ck_impersonation_records_users] CHECK ([operator_user_id] <> [target_user_id]),
      CONSTRAINT [ck_impersonation_records_end] CHECK (
        ([ended_at] IS NULL AND [end_reason] IS NULL AND [end_trace_id] IS NULL)
        OR ([ended_at] IS NOT NULL AND [end_reason] IS NOT NULL AND [end_trace_id] IS NOT NULL)
      ),
      CONSTRAINT [fk_impersonation_records_session] FOREIGN KEY ([session_id])
        REFERENCES [flowpilot].[sessions] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_impersonation_records_operator] FOREIGN KEY ([operator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_impersonation_records_target] FOREIGN KEY ([target_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE UNIQUE INDEX [ux_impersonation_records_active_session]
    ON [flowpilot].[impersonation_records] ([session_id])
    WHERE [ended_at] IS NULL`,
  `CREATE INDEX [ix_impersonation_records_operator_started]
    ON [flowpilot].[impersonation_records] ([operator_user_id], [started_at])`,
  `
    CREATE TABLE [flowpilot].[schema_migrations] (
      [migration_id] nvarchar(150) NOT NULL,
      [name] nvarchar(200) NOT NULL,
      [checksum] varchar(64) NOT NULL,
      [started_at] datetime2(3) NOT NULL,
      [completed_at] datetime2(3) NULL,
      [tool_version] nvarchar(100) NOT NULL,
      [result] nvarchar(20) NOT NULL,
      CONSTRAINT [pk_schema_migrations] PRIMARY KEY ([migration_id]),
      CONSTRAINT [ck_schema_migrations_checksum] CHECK (
        LEN([checksum]) = 64 AND [checksum] NOT LIKE '%[^0-9a-f]%'
      ),
      CONSTRAINT [ck_schema_migrations_result] CHECK (
        [result] IN (N'running', N'succeeded', N'failed')
      )
    )
  `,
  `
    CREATE TABLE [flowpilot].[system_state] (
      [state_key] nvarchar(100) NOT NULL,
      [value_json] nvarchar(max) NOT NULL,
      [revision] int NOT NULL CONSTRAINT [df_system_state_revision] DEFAULT (1),
      [updated_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_system_state] PRIMARY KEY ([state_key]),
      CONSTRAINT [ck_system_state_value_json] CHECK (ISJSON([value_json]) = 1),
      CONSTRAINT [ck_system_state_revision] CHECK ([revision] >= 1)
    )
  `,
  `
    CREATE TABLE [flowpilot].[audit_events] (
      [id] uniqueidentifier NOT NULL,
      [resource_type] nvarchar(100) NOT NULL,
      [resource_id] uniqueidentifier NULL,
      [action] nvarchar(100) NOT NULL,
      [changed_fields_json] nvarchar(max) NULL,
      [actor_user_id] uniqueidentifier NULL,
      [operator_user_id] uniqueidentifier NULL,
      [impersonation_id] uniqueidentifier NULL,
      [trace_id] varchar(128) NOT NULL,
      [result] nvarchar(20) NOT NULL,
      [details_json] nvarchar(max) NULL,
      [occurred_at] datetime2(3) NOT NULL,
      CONSTRAINT [pk_audit_events] PRIMARY KEY ([id]),
      CONSTRAINT [ck_audit_events_changed_fields_json] CHECK (
        [changed_fields_json] IS NULL OR ISJSON([changed_fields_json]) = 1
      ),
      CONSTRAINT [ck_audit_events_details_json] CHECK (
        [details_json] IS NULL OR ISJSON([details_json]) = 1
      ),
      CONSTRAINT [ck_audit_events_result] CHECK ([result] IN (N'success', N'failure')),
      CONSTRAINT [fk_audit_events_actor] FOREIGN KEY ([actor_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_audit_events_operator] FOREIGN KEY ([operator_user_id])
        REFERENCES [flowpilot].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT [fk_audit_events_impersonation] FOREIGN KEY ([impersonation_id])
        REFERENCES [flowpilot].[impersonation_records] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `,
  `CREATE INDEX [ix_audit_events_occurred_at]
    ON [flowpilot].[audit_events] ([occurred_at])`,
  `CREATE INDEX [ix_audit_events_resource]
    ON [flowpilot].[audit_events] ([resource_type], [resource_id], [occurred_at])`,
  `CREATE INDEX [ix_audit_events_actor]
    ON [flowpilot].[audit_events] ([actor_user_id], [occurred_at])`
] as const;

export const normalizeMigrationSchemaStatement = (statement: string): string => (
  statement
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
);

export const IDENTITY_AND_SESSION_SCHEMA_FINGERPRINT_SOURCE = JSON.stringify(
  IDENTITY_AND_SESSION_SCHEMA_STATEMENTS.map(normalizeMigrationSchemaStatement)
);

export const IDENTITY_AND_SESSION_MIGRATION_CHECKSUM = createHash("sha256")
  .update(IDENTITY_AND_SESSION_SCHEMA_FINGERPRINT_SOURCE, "utf8")
  .digest("hex");

const migrationLedgerStatements = [
  `
    INSERT INTO [flowpilot].[schema_migrations] (
      [migration_id], [name], [checksum], [started_at], [completed_at], [tool_version], [result]
    ) VALUES (
      N'${IDENTITY_AND_SESSION_MIGRATION_ID}',
      N'${IDENTITY_AND_SESSION_MIGRATION_NAME}',
      '${IDENTITY_AND_SESSION_MIGRATION_CHECKSUM}',
      SYSUTCDATETIME(),
      SYSUTCDATETIME(),
      N'flowpilot-api/0.1.0',
      N'succeeded'
    )
  `,
  `
    INSERT INTO [flowpilot].[system_state] (
      [state_key], [value_json], [revision], [updated_at]
    ) VALUES (
      N'database-structure',
      N'{"migrationId":"${IDENTITY_AND_SESSION_MIGRATION_ID}","checksum":"${IDENTITY_AND_SESSION_MIGRATION_CHECKSUM}"}',
      1,
      SYSUTCDATETIME()
    )
  `
] as const;

const upStatements = [
  ...IDENTITY_AND_SESSION_SCHEMA_STATEMENTS,
  ...migrationLedgerStatements
] as const;

const downStatements = [
  `DROP TABLE IF EXISTS [flowpilot].[audit_events]`,
  `DROP TABLE IF EXISTS [flowpilot].[system_state]`,
  `DROP TABLE IF EXISTS [flowpilot].[schema_migrations]`,
  `DROP TABLE IF EXISTS [flowpilot].[impersonation_records]`,
  `DROP TABLE IF EXISTS [flowpilot].[sessions]`,
  `DROP TABLE IF EXISTS [flowpilot].[workflow_group_purposes]`,
  `DROP TABLE IF EXISTS [flowpilot].[workflow_group_roles]`,
  `DROP TABLE IF EXISTS [flowpilot].[workflow_group_users]`,
  `DROP TABLE IF EXISTS [flowpilot].[workflow_permission_groups]`,
  `DROP TABLE IF EXISTS [flowpilot].[role_permissions]`,
  `DROP TABLE IF EXISTS [flowpilot].[user_roles]`,
  `DROP TABLE IF EXISTS [flowpilot].[users]`,
  `DROP TABLE IF EXISTS [flowpilot].[permissions]`,
  `DROP TABLE IF EXISTS [flowpilot].[roles]`,
  `DROP TABLE IF EXISTS [flowpilot].[positions]`,
  `DROP TABLE IF EXISTS [flowpilot].[departments]`,
  `IF SCHEMA_ID(N'flowpilot') IS NOT NULL DROP SCHEMA [flowpilot]`
] as const;

export class IdentityAndSessionFoundation1787616000000 implements MigrationInterface {
  readonly name = "IdentityAndSessionFoundation1787616000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of upStatements) await queryRunner.query(statement);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const statement of downStatements) await queryRunner.query(statement);
  }
}
