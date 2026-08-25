import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ZodBodyPipe } from "../common/http/zod-body.pipe.js";
import { SessionGuard, type SessionRequest } from "../auth/session.guard.js";
import { DirectoryService } from "./directory.service.js";
import {
  departmentListQuerySchema,
  positionListQuerySchema,
  processDefinitionListQuerySchema,
  roleListQuerySchema,
  workflowGroupListQuerySchema,
  type DepartmentListQuery,
  type PositionListQuery,
  type ProcessDefinitionListQuery,
  type RoleListQuery,
  type WorkflowGroupListQuery,
} from "./directory.schemas.js";
import type {
  DepartmentDto,
  PermissionDto,
  PositionPageDto,
  ProcessDefinitionPageDto,
  RolePageDto,
  WorkflowPermissionGroupPageDto,
} from "./directory.types.js";

const principalOf = (request: SessionRequest) => {
  if (!request.flowPilotSession) throw new Error("SessionGuard did not attach an authenticated session");
  return request.flowPilotSession.principal;
};

@Controller()
@UseGuards(SessionGuard)
export class CatalogController {
  constructor(private readonly directoryService: DirectoryService) {}

  @Get("roles")
  roles(@Query(new ZodBodyPipe(roleListQuerySchema)) query: RoleListQuery): Promise<RolePageDto> {
    return this.directoryService.listRoles(query);
  }

  @Get("permissions")
  permissions(@Req() request: SessionRequest): Promise<PermissionDto[]> {
    return this.directoryService.listPermissions(principalOf(request));
  }

  @Get("workflow-permission-groups")
  workflowPermissionGroups(
    @Query(new ZodBodyPipe(workflowGroupListQuerySchema)) query: WorkflowGroupListQuery,
  ): Promise<WorkflowPermissionGroupPageDto> {
    return this.directoryService.listWorkflowPermissionGroups(query);
  }

  @Get("departments")
  departments(
    @Query(new ZodBodyPipe(departmentListQuerySchema)) query: DepartmentListQuery,
  ): Promise<DepartmentDto[]> {
    return this.directoryService.listDepartments(query);
  }

  @Get("positions")
  positions(
    @Query(new ZodBodyPipe(positionListQuerySchema)) query: PositionListQuery,
  ): Promise<PositionPageDto> {
    return this.directoryService.listPositions(query);
  }

  @Get("process-definitions")
  processDefinitions(
    @Req() request: SessionRequest,
    @Query(new ZodBodyPipe(processDefinitionListQuerySchema)) query: ProcessDefinitionListQuery,
  ): Promise<ProcessDefinitionPageDto> {
    return this.directoryService.listProcessDefinitions(principalOf(request), query);
  }
}
