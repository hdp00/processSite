import { Check, Column, Entity, Index, PrimaryColumn } from "typeorm";
import { FLOWPILOT_SCHEMA } from "./identity.entities.js";

export const MIGRATION_RESULTS = ["running", "succeeded", "failed"] as const;
export type MigrationResult = (typeof MIGRATION_RESULTS)[number];

@Entity({ schema: FLOWPILOT_SCHEMA, name: "schema_migrations" })
@Check("ck_schema_migrations_result", "[result] IN (N'running', N'succeeded', N'failed')")
export class SchemaMigrationEntity {
  @PrimaryColumn("nvarchar", { name: "migration_id", length: 150 })
  migrationId!: string;

  @Column("nvarchar", { name: "name", length: 200 })
  name!: string;

  @Column("varchar", { name: "checksum", length: 64 })
  checksum!: string;

  @Column("datetime2", { name: "started_at", precision: 3 })
  startedAt!: Date;

  @Column("datetime2", { name: "completed_at", precision: 3, nullable: true })
  completedAt!: Date | null;

  @Column("nvarchar", { name: "tool_version", length: 100 })
  toolVersion!: string;

  @Column("nvarchar", { name: "result", length: 20 })
  result!: MigrationResult;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "system_state" })
@Check("ck_system_state_value_json", "ISJSON([value_json]) = 1")
@Check("ck_system_state_revision", "[revision] >= 1")
export class SystemStateEntity {
  @PrimaryColumn("nvarchar", { name: "state_key", length: 100 })
  stateKey!: string;

  @Column("nvarchar", { name: "value_json", length: "MAX" })
  valueJson!: string;

  @Column("int", { name: "revision", default: 1 })
  revision!: number;

  @Column("datetime2", { name: "updated_at", precision: 3 })
  updatedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "audit_events" })
@Index("ix_audit_events_occurred_at", ["occurredAt"])
@Index("ix_audit_events_resource", ["resourceType", "resourceId", "occurredAt"])
@Index("ix_audit_events_actor", ["actorUserId", "occurredAt"])
@Check("ck_audit_events_result", "[result] IN (N'success', N'failure')")
@Check(
  "ck_audit_events_changed_fields_json",
  "[changed_fields_json] IS NULL OR ISJSON([changed_fields_json]) = 1"
)
@Check("ck_audit_events_details_json", "[details_json] IS NULL OR ISJSON([details_json]) = 1")
export class AuditEventEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("nvarchar", { name: "resource_type", length: 100 })
  resourceType!: string;

  @Column("uniqueidentifier", { name: "resource_id", nullable: true })
  resourceId!: string | null;

  @Column("nvarchar", { name: "action", length: 100 })
  action!: string;

  @Column("nvarchar", { name: "changed_fields_json", length: "MAX", nullable: true })
  changedFieldsJson!: string | null;

  @Column("uniqueidentifier", { name: "actor_user_id", nullable: true })
  actorUserId!: string | null;

  @Column("uniqueidentifier", { name: "operator_user_id", nullable: true })
  operatorUserId!: string | null;

  @Column("uniqueidentifier", { name: "impersonation_id", nullable: true })
  impersonationId!: string | null;

  @Column("varchar", { name: "trace_id", length: 128 })
  traceId!: string;

  @Column("nvarchar", { name: "result", length: 20 })
  result!: "success" | "failure";

  @Column("nvarchar", { name: "details_json", length: "MAX", nullable: true })
  detailsJson!: string | null;

  @Column("datetime2", { name: "occurred_at", precision: 3 })
  occurredAt!: Date;
}
