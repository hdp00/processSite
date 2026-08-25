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

@Entity({ schema: FLOWPILOT_SCHEMA, name: "roles" })
@Index("ux_roles_normalized_code", ["normalizedCode"], { unique: true })
@Index("ux_roles_normalized_name", ["normalizedName"], { unique: true })
@Check("ck_roles_revision", "[revision] >= 1")
export class RoleEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("nvarchar", { name: "code", length: 100 })
  code!: string;

  @Column("nvarchar", { name: "normalized_code", length: 100 })
  normalizedCode!: string;

  @Column("nvarchar", { name: "name", length: 100 })
  name!: string;

  @Column("nvarchar", { name: "normalized_name", length: 100 })
  normalizedName!: string;

  @Column("nvarchar", { name: "description", length: 500, nullable: true })
  description!: string | null;

  @Column("bit", { name: "is_enabled", default: true })
  isEnabled!: boolean;

  @Column("bit", { name: "is_builtin", default: false })
  isBuiltin!: boolean;

  @Column("int", { name: "revision", default: 1 })
  revision!: number;

  @Column("datetime2", { name: "created_at", precision: 3 })
  createdAt!: Date;

  @Column("datetime2", { name: "updated_at", precision: 3 })
  updatedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "permissions" })
@Index("ux_permissions_resource_action", ["resource", "action"], { unique: true })
export class PermissionEntity {
  @PrimaryColumn("nvarchar", { name: "code", length: 150 })
  code!: string;

  @Column("nvarchar", { name: "resource", length: 100 })
  resource!: string;

  @Column("nvarchar", { name: "action", length: 100 })
  action!: string;

  @Column("nvarchar", { name: "name", length: 100 })
  name!: string;

  @Column("int", { name: "sort_order", default: 0 })
  sortOrder!: number;

  @Column("bit", { name: "is_builtin", default: true })
  isBuiltin!: boolean;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "user_roles" })
@Index("ix_user_roles_role_user", ["roleId", "userId"])
export class UserRoleEntity {
  @PrimaryColumn("uniqueidentifier", { name: "user_id" })
  userId!: string;

  @PrimaryColumn("uniqueidentifier", { name: "role_id" })
  roleId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "fk_user_roles_user" })
  user!: Relation<UserEntity>;

  @ManyToOne(() => RoleEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "role_id", foreignKeyConstraintName: "fk_user_roles_role" })
  role!: Relation<RoleEntity>;

  @Column("uniqueidentifier", { name: "granted_by", nullable: true })
  grantedBy!: string | null;

  @Column("datetime2", { name: "granted_at", precision: 3 })
  grantedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "role_permissions" })
@Index("ix_role_permissions_permission_role", ["permissionCode", "roleId"])
export class RolePermissionEntity {
  @PrimaryColumn("uniqueidentifier", { name: "role_id" })
  roleId!: string;

  @PrimaryColumn("nvarchar", { name: "permission_code", length: 150 })
  permissionCode!: string;

  @ManyToOne(() => RoleEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "role_id", foreignKeyConstraintName: "fk_role_permissions_role" })
  role!: Relation<RoleEntity>;

  @ManyToOne(() => PermissionEntity, { onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "permission_code", referencedColumnName: "code", foreignKeyConstraintName: "fk_role_permissions_permission" })
  permission!: Relation<PermissionEntity>;

  @Column("uniqueidentifier", { name: "granted_by", nullable: true })
  grantedBy!: string | null;

  @Column("datetime2", { name: "granted_at", precision: 3 })
  grantedAt!: Date;
}
