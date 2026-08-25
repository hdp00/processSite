import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation
} from "typeorm";
import { FLOWPILOT_SCHEMA, UserEntity } from "./identity.entities.js";

@Entity({ schema: FLOWPILOT_SCHEMA, name: "sessions" })
@Index("ux_sessions_token_hash", ["tokenHash"], { unique: true })
@Index("ix_sessions_operator_expiration", ["operatorUserId", "revokedAt", "absoluteExpiresAt"])
@Index("ix_sessions_idle_expiration", ["revokedAt", "idleExpiresAt"])
@Check("ck_sessions_expiration", "[idle_expires_at] <= [absolute_expires_at]")
export class SessionEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("varchar", { name: "token_hash", length: 64 })
  tokenHash!: string;

  @Column("uniqueidentifier", { name: "operator_user_id" })
  operatorUserId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "operator_user_id", foreignKeyConstraintName: "fk_sessions_operator_user" })
  operatorUser!: Relation<UserEntity>;

  @Column("uniqueidentifier", { name: "effective_user_id" })
  effectiveUserId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "effective_user_id", foreignKeyConstraintName: "fk_sessions_effective_user" })
  effectiveUser!: Relation<UserEntity>;

  @Column("int", { name: "permission_version", default: 1 })
  permissionVersion!: number;

  @Column("datetime2", { name: "created_at", precision: 3 })
  createdAt!: Date;

  @Column("datetime2", { name: "last_accessed_at", precision: 3 })
  lastAccessedAt!: Date;

  @Column("datetime2", { name: "idle_expires_at", precision: 3 })
  idleExpiresAt!: Date;

  @Column("datetime2", { name: "absolute_expires_at", precision: 3 })
  absoluteExpiresAt!: Date;

  @Column("datetime2", { name: "revoked_at", precision: 3, nullable: true })
  revokedAt!: Date | null;

  @Column("nvarchar", { name: "revocation_reason", length: 200, nullable: true })
  revocationReason!: string | null;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "impersonation_records" })
@Index("ux_impersonation_records_active_session", ["sessionId"], {
  unique: true,
  where: "[ended_at] IS NULL"
})
@Index("ix_impersonation_records_operator_started", ["operatorUserId", "startedAt"])
export class ImpersonationRecordEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("uniqueidentifier", { name: "session_id" })
  sessionId!: string;

  @ManyToOne(() => SessionEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "session_id", foreignKeyConstraintName: "fk_impersonation_records_session" })
  session!: Relation<SessionEntity>;

  @Column("uniqueidentifier", { name: "operator_user_id" })
  operatorUserId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "operator_user_id", foreignKeyConstraintName: "fk_impersonation_records_operator" })
  operatorUser!: Relation<UserEntity>;

  @Column("uniqueidentifier", { name: "target_user_id" })
  targetUserId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "target_user_id", foreignKeyConstraintName: "fk_impersonation_records_target" })
  targetUser!: Relation<UserEntity>;

  @Column("nvarchar", { name: "reason", length: 500 })
  reason!: string;

  @Column("datetime2", { name: "started_at", precision: 3 })
  startedAt!: Date;

  @Column("datetime2", { name: "ended_at", precision: 3, nullable: true })
  endedAt!: Date | null;

  @Column("nvarchar", { name: "end_reason", length: 200, nullable: true })
  endReason!: string | null;

  @Column("varchar", { name: "start_trace_id", length: 128 })
  startTraceId!: string;

  @Column("varchar", { name: "end_trace_id", length: 128, nullable: true })
  endTraceId!: string | null;

  @Column("varchar", { name: "source_ip", length: 64 })
  sourceIp!: string;

  @Column("nvarchar", { name: "user_agent", length: 500, nullable: true })
  userAgent!: string | null;
}
