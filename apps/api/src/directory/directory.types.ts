import type {
  DepartmentDto,
  PageMeta,
  PermissionDto,
  PositionDto,
  PositionPage,
  ProcessDefinitionDto,
  ProcessDefinitionPage,
  ProcessDefinitionRef,
  ProcessDefinitionStatus,
  ProcessDefinitionType,
  RoleDto,
  RolePage,
  WorkflowGroupPurpose,
  WorkflowPermissionGroupDto,
  WorkflowPermissionGroupPage,
} from "@process-site/api-contract/models";

export type {
  DepartmentDto,
  PermissionDto,
  PositionDto,
  ProcessDefinitionDto,
  ProcessDefinitionStatus,
  ProcessDefinitionType,
  RoleDto,
  WorkflowGroupPurpose,
  WorkflowPermissionGroupDto,
};

export type ProcessDefinitionReferenceDto = ProcessDefinitionRef;
export type RolePageDto = RolePage;
export type WorkflowPermissionGroupPageDto = WorkflowPermissionGroupPage;
export type PositionPageDto = PositionPage;
export type ProcessDefinitionPageDto = ProcessDefinitionPage;

export interface PageDto<T> {
  items: T[];
  meta: PageMeta;
}
