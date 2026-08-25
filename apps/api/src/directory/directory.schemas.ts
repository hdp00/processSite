import type { z } from "zod";
import {
  ListDepartmentsQueryParams,
  ListPositionsQueryParams,
  ListProcessDefinitionsQueryParams,
  ListRolesQueryParams,
  ListWorkflowPermissionGroupsQueryParams,
} from "@process-site/api-contract/validators";

export const roleListQuerySchema = ListRolesQueryParams;
export const workflowGroupListQuerySchema = ListWorkflowPermissionGroupsQueryParams;
export const departmentListQuerySchema = ListDepartmentsQueryParams;
export const positionListQuerySchema = ListPositionsQueryParams;
export const processDefinitionListQuerySchema = ListProcessDefinitionsQueryParams;

export type RoleListQuery = z.output<typeof roleListQuerySchema>;
export type WorkflowGroupListQuery = z.output<typeof workflowGroupListQuerySchema>;
export type DepartmentListQuery = z.output<typeof departmentListQuerySchema>;
export type PositionListQuery = z.output<typeof positionListQuerySchema>;
export type ProcessDefinitionListQuery = z.output<typeof processDefinitionListQuerySchema>;
