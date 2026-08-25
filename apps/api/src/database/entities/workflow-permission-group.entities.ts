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
import { RoleEntity } from "./access-control.entities.js";
import { FLOWPILOT_SCHEMA, UserEntity } from "./identity.entities.js";

export const WORKFLOW_GROUP_PURPOSES = ["start", "review-or-accept", "close"] as const;
export type WorkflowGroupPurpose = (typeof WORKFLOW_GROUP_PURPOSES)[number];

@Entity({ schema: FLOWPILOT_SCHEMA, name: "workflow_permission_groups" })
@Index("ux_workflow_permission_groups_normalized_code", ["normalizedCode"], { unique: true })
@Check("ck_workflow_permission_groups_revision", "[revision] >= 1")
export class WorkflowPermissionGroupEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("nvarchar", { name: "code", length: 100 })
  code!: string;

  @Column("nvarchar", { name: "normalized_code", length: 100 })
  normalizedCode!: string;

  @Column("nvarchar", { name: "name", length: 100 })
  name!: string;

  @Column("nvarchar", { name: "description", length: 500, nullable: true })
  description!: string | null;

  @Column("bit", { name: "is_enabled", default: true })
  isEnabled!: boolean;

  @Column("int", { name: "revision", default: 1 })
  revision!: number;

  @Column("datetime2", { name: "created_at", precision: 3 })
  createdAt!: Date;

  @Column("datetime2", { name: "updated_at", precision: 3 })
  updatedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "workflow_group_users" })
@Index("ix_workflow_group_users_user_group", ["userId", "groupId"])
export class WorkflowGroupUserEntity {
  @PrimaryColumn("uniqueidentifier", { name: "group_id" })
  groupId!: string;

  @PrimaryColumn("uniqueidentifier", { name: "user_id" })
  userId!: string;

  @ManyToOne(() => WorkflowPermissionGroupEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "group_id", foreignKeyConstraintName: "fk_workflow_group_users_group" })
  group!: Relation<WorkflowPermissionGroupEntity>;

  @ManyToOne(() => UserEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "fk_workflow_group_users_user" })
  user!: Relation<UserEntity>;

  @Column("uniqueidentifier", { name: "added_by", nullable: true })
  addedBy!: string | null;

  @Column("datetime2", { name: "added_at", precision: 3 })
  addedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "workflow_group_roles" })
@Index("ix_workflow_group_roles_role_group", ["roleId", "groupId"])
export class WorkflowGroupRoleEntity {
  @PrimaryColumn("uniqueidentifier", { name: "group_id" })
  groupId!: string;

  @PrimaryColumn("uniqueidentifier", { name: "role_id" })
  roleId!: string;

  @ManyToOne(() => WorkflowPermissionGroupEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "group_id", foreignKeyConstraintName: "fk_workflow_group_roles_group" })
  group!: Relation<WorkflowPermissionGroupEntity>;

  @ManyToOne(() => RoleEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "role_id", foreignKeyConstraintName: "fk_workflow_group_roles_role" })
  role!: Relation<RoleEntity>;

  @Column("uniqueidentifier", { name: "added_by", nullable: true })
  addedBy!: string | null;

  @Column("datetime2", { name: "added_at", precision: 3 })
  addedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "workflow_group_purposes" })
@Check(
  "ck_workflow_group_purposes_purpose",
  "[purpose] IN (N'start', N'review-or-accept', N'close')"
)
export class WorkflowGroupPurposeEntity {
  @PrimaryColumn("uniqueidentifier", { name: "group_id" })
  groupId!: string;

  @PrimaryColumn("nvarchar", { name: "purpose", length: 30 })
  purpose!: WorkflowGroupPurpose;

  @ManyToOne(() => WorkflowPermissionGroupEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "group_id", foreignKeyConstraintName: "fk_workflow_group_purposes_group" })
  group!: Relation<WorkflowPermissionGroupEntity>;
}
