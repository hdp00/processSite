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

export const FLOWPILOT_SCHEMA = "flowpilot";

export const AUTHENTICATION_MODES = ["domain", "password"] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

@Entity({ schema: FLOWPILOT_SCHEMA, name: "departments" })
@Index("ux_departments_normalized_code", ["normalizedCode"], { unique: true })
@Check("ck_departments_revision", "[revision] >= 1")
export class DepartmentEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("nvarchar", { name: "code", length: 100 })
  code!: string;

  @Column("nvarchar", { name: "normalized_code", length: 100 })
  normalizedCode!: string;

  @Column("nvarchar", { name: "name", length: 100 })
  name!: string;

  @Column("uniqueidentifier", { name: "parent_id", nullable: true })
  parentId!: string | null;

  @ManyToOne(() => DepartmentEntity, { nullable: true, onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "parent_id", foreignKeyConstraintName: "fk_departments_parent" })
  parent!: Relation<DepartmentEntity> | null;

  @Column("nvarchar", { name: "path_cache", length: 500 })
  pathCache!: string;

  @Column("int", { name: "sort_order", default: 0 })
  sortOrder!: number;

  @Column("bit", { name: "is_enabled", default: true })
  isEnabled!: boolean;

  @Column("nvarchar", { name: "description", length: 500, nullable: true })
  description!: string | null;

  @Column("int", { name: "revision", default: 1 })
  revision!: number;

  @Column("datetime2", { name: "created_at", precision: 3 })
  createdAt!: Date;

  @Column("datetime2", { name: "updated_at", precision: 3 })
  updatedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "positions" })
@Index("ux_positions_normalized_code", ["normalizedCode"], { unique: true })
@Index("ux_positions_normalized_name", ["normalizedName"], { unique: true })
@Check("ck_positions_revision", "[revision] >= 1")
export class PositionEntity {
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

  @Column("int", { name: "sort_order", default: 0 })
  sortOrder!: number;

  @Column("bit", { name: "is_enabled", default: true })
  isEnabled!: boolean;

  @Column("nvarchar", { name: "description", length: 500, nullable: true })
  description!: string | null;

  @Column("int", { name: "revision", default: 1 })
  revision!: number;

  @Column("datetime2", { name: "created_at", precision: 3 })
  createdAt!: Date;

  @Column("datetime2", { name: "updated_at", precision: 3 })
  updatedAt!: Date;
}

@Entity({ schema: FLOWPILOT_SCHEMA, name: "users" })
@Index("ux_users_normalized_login_name", ["normalizedLoginName"], { unique: true })
@Index("ux_users_builtin_super_admin", ["isBuiltinSuperAdmin"], {
  unique: true,
  where: "[is_builtin_super_admin] = 1"
})
@Index("ix_users_directory_search", ["isEnabled", "departmentId", "positionId", "displayName"])
@Check(
  "ck_users_authentication_mode",
  "([authentication_mode] = N'password' AND [password_hash] IS NOT NULL) OR "
    + "([authentication_mode] = N'domain' AND [password_hash] IS NULL)"
)
@Check(
  "ck_users_builtin_super_admin",
  "[is_builtin_super_admin] = 0 OR ([authentication_mode] = N'password' AND [is_enabled] = 1)"
)
@Check("ck_users_revision", "[revision] >= 1")
export class UserEntity {
  @PrimaryColumn("uniqueidentifier")
  id!: string;

  @Column("nvarchar", { name: "login_name", length: 100 })
  loginName!: string;

  @Column("nvarchar", { name: "normalized_login_name", length: 100 })
  normalizedLoginName!: string;

  @Column("nvarchar", { name: "display_name", length: 100 })
  displayName!: string;

  @Column("nvarchar", { name: "email", length: 320 })
  email!: string;

  @Column("nvarchar", { name: "authentication_mode", length: 20 })
  authenticationMode!: AuthenticationMode;

  @Column("nvarchar", { name: "password_hash", length: 500, nullable: true })
  passwordHash!: string | null;

  @Column("uniqueidentifier", { name: "department_id" })
  departmentId!: string;

  @ManyToOne(() => DepartmentEntity, { nullable: false, onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "department_id", foreignKeyConstraintName: "fk_users_department" })
  department!: Relation<DepartmentEntity>;

  @Column("uniqueidentifier", { name: "position_id" })
  positionId!: string;

  @ManyToOne(() => PositionEntity, { nullable: false, onDelete: "NO ACTION", onUpdate: "NO ACTION" })
  @JoinColumn({ name: "position_id", foreignKeyConstraintName: "fk_users_position" })
  position!: Relation<PositionEntity>;

  @Column("bit", { name: "is_enabled", default: true })
  isEnabled!: boolean;

  @Column("bit", { name: "is_builtin_super_admin", default: false })
  isBuiltinSuperAdmin!: boolean;

  @Column("int", { name: "revision", default: 1 })
  revision!: number;

  @Column("datetime2", { name: "created_at", precision: 3 })
  createdAt!: Date;

  @Column("datetime2", { name: "updated_at", precision: 3 })
  updatedAt!: Date;

  @Column("uniqueidentifier", { name: "created_by", nullable: true })
  createdBy!: string | null;

  @Column("uniqueidentifier", { name: "updated_by", nullable: true })
  updatedBy!: string | null;
}
