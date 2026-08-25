export {
  AUTHENTICATION_MODES,
  DepartmentEntity,
  FLOWPILOT_SCHEMA,
  PositionEntity,
  UserEntity,
  type AuthenticationMode
} from "./identity.entities.js";
export {
  PermissionEntity,
  RoleEntity,
  RolePermissionEntity,
  UserRoleEntity
} from "./access-control.entities.js";
export {
  WORKFLOW_GROUP_PURPOSES,
  WorkflowGroupPurposeEntity,
  WorkflowGroupRoleEntity,
  WorkflowGroupUserEntity,
  WorkflowPermissionGroupEntity,
  type WorkflowGroupPurpose
} from "./workflow-permission-group.entities.js";
export { ImpersonationRecordEntity, SessionEntity } from "./session.entities.js";
export {
  AuditEventEntity,
  MIGRATION_RESULTS,
  SchemaMigrationEntity,
  SystemStateEntity,
  type MigrationResult
} from "./system.entities.js";

import {
  PermissionEntity,
  RoleEntity,
  RolePermissionEntity,
  UserRoleEntity
} from "./access-control.entities.js";
import { DepartmentEntity, PositionEntity, UserEntity } from "./identity.entities.js";
import { ImpersonationRecordEntity, SessionEntity } from "./session.entities.js";
import { AuditEventEntity, SchemaMigrationEntity, SystemStateEntity } from "./system.entities.js";
import {
  WorkflowGroupPurposeEntity,
  WorkflowGroupRoleEntity,
  WorkflowGroupUserEntity,
  WorkflowPermissionGroupEntity
} from "./workflow-permission-group.entities.js";

export const FLOWPILOT_ENTITIES = [
  DepartmentEntity,
  PositionEntity,
  UserEntity,
  RoleEntity,
  PermissionEntity,
  UserRoleEntity,
  RolePermissionEntity,
  WorkflowPermissionGroupEntity,
  WorkflowGroupUserEntity,
  WorkflowGroupRoleEntity,
  WorkflowGroupPurposeEntity,
  SessionEntity,
  ImpersonationRecordEntity,
  SchemaMigrationEntity,
  SystemStateEntity,
  AuditEventEntity
] as const;
