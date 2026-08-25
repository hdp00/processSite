import type {
  ProcessDefinitionReferenceDto,
  ProcessDefinitionStatus,
  ProcessDefinitionType,
  WorkflowGroupPurpose,
} from "./directory.types.js";
import type { UserReferenceDto } from "../auth/auth.types.js";

export const DIRECTORY_PERSISTENCE = Symbol("DIRECTORY_PERSISTENCE");

export interface PageSelection {
  page: number;
  pageSize: number;
  q?: string | undefined;
}

export interface PagedRecords<T> {
  items: T[];
  total: number;
}

export interface RoleCatalogRecord {
  id: string;
  revision: number;
  code: string;
  name: string;
  description?: string;
  enabled: boolean;
  builtIn: boolean;
  memberIds: string[];
  permissionCodes: string[];
}

export interface PermissionCatalogRecord {
  code: string;
  name: string;
  category: string;
  kind: "page" | "action";
  description?: string;
  sortOrder: number;
}

export interface WorkflowPermissionGroupCatalogRecord {
  id: string;
  revision: number;
  code: string;
  name: string;
  description?: string;
  purposes: WorkflowGroupPurpose[];
  enabled: boolean;
  directUserIds: string[];
  roleIds: string[];
  effectiveMemberCount: number;
  openTaskCount: number;
  referencedProcesses: ProcessDefinitionReferenceDto[];
}

export interface DepartmentCatalogRecord {
  id: string;
  revision: number;
  code: string;
  name: string;
  parentId?: string;
  path: string;
  sortOrder: number;
  enabled: boolean;
  description?: string;
  userCount: number;
}

export interface PositionCatalogRecord {
  id: string;
  revision: number;
  name: string;
  sortOrder: number;
  enabled: boolean;
  description?: string;
  userCount: number;
}

export interface ProcessDefinitionCatalogRecord {
  id: string;
  revision: number;
  code: string;
  name: string;
  description: string;
  type: ProcessDefinitionType;
  disabled: boolean;
  publishedVersionId?: string;
  publishedInstancePrefix?: string;
  nextVersionNumber: number;
  versionCount: number;
  instanceCount: number;
  updatedAt: Date;
  updatedBy: UserReferenceDto;
}

export interface DirectoryPersistence {
  listRoles(query: PageSelection & { status?: "enabled" | "disabled" | undefined }): Promise<PagedRecords<RoleCatalogRecord>>;
  listPermissions(): Promise<PermissionCatalogRecord[]>;
  listWorkflowPermissionGroups(
    query: PageSelection & {
      purpose?: WorkflowGroupPurpose | undefined;
      status?: "enabled" | "disabled" | undefined;
    },
  ): Promise<PagedRecords<WorkflowPermissionGroupCatalogRecord>>;
  listDepartments(includeDisabled: boolean): Promise<DepartmentCatalogRecord[]>;
  listPositions(query: PageSelection & { status?: "enabled" | "disabled" | undefined }): Promise<PagedRecords<PositionCatalogRecord>>;
  listProcessDefinitions(
    query: PageSelection & {
      type?: ProcessDefinitionType | undefined;
      status?: ProcessDefinitionStatus | undefined;
    },
  ): Promise<PagedRecords<ProcessDefinitionCatalogRecord>>;
}
