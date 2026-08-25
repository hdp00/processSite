import { http } from "msw";
import { MOCK_API_BASE_URL } from "../apiBase";
import type {
  DepartmentRecord,
  ImpactPreview,
  PermissionCatalogItem,
  PositionRecord,
} from "../../api/contracts";
import {
  ROLE_PERMISSION_STORAGE_KEY,
  defaultRolePermissionMap,
  notifyRolePermissionsChanged,
  readStoredRolePermissions,
} from "../../state/rolePermissions";
import { effectiveGroupMemberIds, useIdentityStore } from "../../state/useIdentityStore";
import { useOrganizationStore } from "../../state/useOrganizationStore";
import { createClientUuid } from "../../utils/clientId";
import {
  apiNoContent,
  apiOk,
  apiProblem,
  appendAuditEvent,
  applyMockScenario,
  checkIfMatch,
  entityEtag,
  pageQuery,
  paginate,
  parseJsonBody,
  requirePermission,
  withIdempotency,
} from "../runtime";
import { permissionCatalogPages } from "../../data/permissionCatalog";

const API = MOCK_API_BASE_URL;

const permissions: PermissionCatalogItem[] = permissionCatalogPages.flatMap((row) => row.actions.map((action) => `${row.key}:${action}`)).map((key) => {
  const [page, action] = key.split(":");
  return { key, page, action };
});

const departments = () => {
  const users = useIdentityStore.getState().users;
  return useOrganizationStore.getState().departments.map((item): DepartmentRecord => ({
    id: item.key,
    name: item.name,
    parentId: item.parentKey,
    path: item.path,
    status: item.status,
    memberCount: users.filter((user) => user.department.includes(item.key)).length,
    sortOrder: item.sort,
    description: item.description,
  }));
};

const positions = () => {
  const users = useIdentityStore.getState().users;
  return useOrganizationStore.getState().jobTitles.map((item): PositionRecord => ({
    id: item.id,
    name: item.name,
    description: item.description,
    status: item.status,
    memberCount: users.filter((user) => user.jobTitle === item.name).length,
    sortOrder: item.sort,
  }));
};

const audit = (actorId: string, actorName: string, action: string, resourceType: string, resourceId: string, summary: string) =>
  appendAuditEvent({ category: "identity", action, actorId, actorName, resourceType, resourceId, summary });

const idParam = (value: string | readonly string[] | undefined) => String(Array.isArray(value) ? value[0] ?? "" : value ?? "");

export const organizationHandlers = [
  http.put(`${API}/users/:userId/status`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-user:编辑");
    if (auth.response) return auth.response;
    const userId = idParam(params.userId);
    const user = useIdentityStore.getState().users.find((item) => item.id === userId);
    if (!user) return apiProblem(request, 404, "USER_NOT_FOUND", "用户不存在", "未找到指定用户。 ");
    if (user.builtIn) return apiProblem(request, 409, "IMMUTABLE_BUILTIN_RESOURCE", "内置用户不可停用", "超级管理员账号必须始终保持启用。 ");
    const conflict = checkIfMatch(request, { ...user, password: undefined }, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<{ status?: "启用" | "停用" }>(request);
    if (body instanceof Response) return body;
    if (!body.status || !["启用", "停用"].includes(body.status)) return apiProblem(request, 422, "STATUS_INVALID", "用户状态无效", "status 必须是启用或停用。 ");
    const enabledRoles = useIdentityStore.getState().roles.filter((role) => role.status === "启用");
    const enabledRoleIds = new Set(enabledRoles.map((role) => role.id));
    const enabledRoleNames = new Set(enabledRoles.map((role) => role.name));
    const hasEnabledRole = user.roleIds
      ? user.roleIds.some((roleId) => enabledRoleIds.has(roleId))
      : user.roles.some((roleName) => enabledRoleNames.has(roleName));
    if (body.status === "启用" && !hasEnabledRole) {
      return apiProblem(request, 409, "USER_ROLE_REQUIRED", "账号缺少角色", "请先为用户分配至少一个启用角色，再启用账号。 ");
    }
    const updated = { ...user, status: body.status };
    useIdentityStore.getState().setUsers((users) => users.map((item) => item.id === user.id ? updated : item));
    audit(auth.actor.id, auth.actor.name, "update-user-status", "user", user.id, `${body.status}用户 ${user.name}`);
    const { password: _password, ...dto } = updated;
    return apiOk(request, dto, { headers: { ETag: entityEtag(dto) } });
  }),
  http.get(`${API}/departments`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:查看");
    if (auth.response) return auth.response;
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
    return apiOk(request, departments().filter((item) => !q || `${item.name}${item.path}`.toLowerCase().includes(q)).sort((left, right) => left.sortOrder - right.sortOrder));
  }),
  http.post(`${API}/departments`, async ({ request }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "org-department:编辑");
      if (auth.response) return auth.response;
      const body = await parseJsonBody<{ name?: string; parentId?: string; sortOrder?: number; description?: string }>(request);
      if (body instanceof Response) return body;
      const current = departments();
      const name = body.name?.trim() ?? "";
      const parent = body.parentId ? current.find((item) => item.id === body.parentId) : undefined;
      if (!name || (body.parentId && !parent)) return apiProblem(request, 422, "VALIDATION_FAILED", "部门数据无效", "请填写部门名称并选择有效上级部门。 ");
      if (current.some((item) => item.parentId === body.parentId && item.name === name)) return apiProblem(request, 409, "DEPARTMENT_NAME_CONFLICT", "同级部门名称已存在", "请使用其他部门名称。 ");
      const record: DepartmentRecord = { id: createClientUuid(), name, parentId: parent?.id, path: parent ? `${parent.path} / ${name}` : name, status: "启用", memberCount: 0, sortOrder: body.sortOrder ?? current.length * 10, description: body.description?.trim() ?? "" };
      useOrganizationStore.getState().setDepartments((items) => [...items, {
        key: record.id,
        name: record.name,
        path: record.path,
        level: record.parentId ? 2 : 1,
        parentKey: record.parentId,
        sort: record.sortOrder,
        status: record.status,
        users: 0,
        referenced: false,
        description: record.description ?? "",
      }]);
      audit(auth.actor.id, auth.actor.name, "create-department", "department", record.id, `创建部门 ${record.path}`);
      return apiOk(request, record, { status: 201, headers: { ETag: entityEtag(record) } });
    });
  }),
  http.get(`${API}/departments/:departmentId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:查看");
    if (auth.response) return auth.response;
    const record = departments().find((item) => item.id === idParam(params.departmentId));
    return record ? apiOk(request, record, { headers: { ETag: entityEtag(record) } }) : apiProblem(request, 404, "DEPARTMENT_NOT_FOUND", "部门不存在", "未找到指定部门。 ");
  }),
  http.patch(`${API}/departments/:departmentId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:编辑");
    if (auth.response) return auth.response;
    const current = departments();
    const record = current.find((item) => item.id === idParam(params.departmentId));
    if (!record) return apiProblem(request, 404, "DEPARTMENT_NOT_FOUND", "部门不存在", "未找到指定部门。 ");
    const conflict = checkIfMatch(request, record, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<Partial<Pick<DepartmentRecord, "name" | "status" | "sortOrder" | "description">>>(request);
    if (body instanceof Response) return body;
    const updated: DepartmentRecord = { ...record, ...body, name: body.name?.trim() || record.name };
    useOrganizationStore.getState().setDepartments((items) => items.map((item) => item.key === record.id ? {
      ...item,
      name: updated.name,
      status: updated.status,
      sort: updated.sortOrder,
      description: updated.description ?? item.description,
    } : item));
    const departmentById = new Map(useOrganizationStore.getState().departments.map((item) => [item.key, item]));
    useIdentityStore.getState().setUsers((users) => users.map((user) => {
      const assigned = [...user.department].reverse().map((id) => departmentById.get(id)).find(Boolean);
      return assigned ? { ...user, departmentPath: assigned.path } : user;
    }));
    const saved = departments().find((item) => item.id === record.id) ?? updated;
    audit(auth.actor.id, auth.actor.name, "update-department", "department", record.id, `更新部门 ${saved.path}`);
    return apiOk(request, saved, { headers: { ETag: entityEtag(saved) } });
  }),
  http.delete(`${API}/departments/:departmentId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:删除");
    if (auth.response) return auth.response;
    const current = departments();
    const record = current.find((item) => item.id === idParam(params.departmentId));
    if (!record) return apiProblem(request, 404, "DEPARTMENT_NOT_FOUND", "部门不存在", "未找到指定部门。 ");
    const conflict = checkIfMatch(request, record, true);
    if (conflict) return conflict;
    if (record.memberCount || current.some((item) => item.parentId === record.id)) return apiProblem(request, 409, "DEPARTMENT_IN_USE", "部门正在使用", "请先移走部门成员并删除所有下级部门。 ");
    useOrganizationStore.getState().setDepartments((items) => items.filter((item) => item.key !== record.id));
    audit(auth.actor.id, auth.actor.name, "delete-department", "department", record.id, `删除部门 ${record.path}`);
    return apiNoContent(request);
  }),
  http.get(`${API}/positions`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:查看");
    if (auth.response) return auth.response;
    return apiOk(request, positions());
  }),
  http.post(`${API}/positions`, async ({ request }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "org-department:编辑");
      if (auth.response) return auth.response;
      const body = await parseJsonBody<{ name?: string; description?: string; sortOrder?: number }>(request);
      if (body instanceof Response) return body;
      const current = positions();
      const name = body.name?.trim() ?? "";
      if (!name) return apiProblem(request, 422, "POSITION_NAME_REQUIRED", "职务名称不能为空", "请填写职务名称。 ");
      if (current.some((item) => item.name === name)) return apiProblem(request, 409, "POSITION_NAME_CONFLICT", "职务名称已存在", "请使用其他职务名称。 ");
      const record: PositionRecord = { id: createClientUuid(), name, description: body.description?.trim() ?? "", status: "启用", memberCount: 0, sortOrder: body.sortOrder ?? Math.max(0, ...useOrganizationStore.getState().jobTitles.map((item) => item.sort)) + 10 };
      useOrganizationStore.getState().setJobTitles((items) => [...items, {
        id: record.id,
        name: record.name,
        description: record.description,
        status: record.status,
        users: 0,
        sort: record.sortOrder ?? Math.max(0, ...items.map((item) => item.sort)) + 10,
      }]);
      audit(auth.actor.id, auth.actor.name, "create-position", "position", record.id, `创建职务 ${record.name}`);
      return apiOk(request, record, { status: 201, headers: { ETag: entityEtag(record) } });
    });
  }),
  http.get(`${API}/positions/:positionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:查看");
    if (auth.response) return auth.response;
    const record = positions().find((item) => item.id === idParam(params.positionId));
    return record ? apiOk(request, record, { headers: { ETag: entityEtag(record) } }) : apiProblem(request, 404, "POSITION_NOT_FOUND", "职务不存在", "未找到指定职务。 ");
  }),
  http.patch(`${API}/positions/:positionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:编辑");
    if (auth.response) return auth.response;
    const current = positions();
    const record = current.find((item) => item.id === idParam(params.positionId));
    if (!record) return apiProblem(request, 404, "POSITION_NOT_FOUND", "职务不存在", "未找到指定职务。 ");
    const conflict = checkIfMatch(request, record, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<Partial<Pick<PositionRecord, "name" | "description" | "status" | "sortOrder">>>(request);
    if (body instanceof Response) return body;
    const updated: PositionRecord = { ...record, ...body, name: body.name?.trim() || record.name };
    useOrganizationStore.getState().setJobTitles((items) => items.map((item) => item.id === record.id ? {
      ...item,
      name: updated.name,
      description: updated.description,
      status: updated.status,
      sort: updated.sortOrder ?? item.sort,
    } : item));
    if (updated.name !== record.name) {
      useIdentityStore.getState().setUsers((users) => users.map((user) =>
        user.jobTitle === record.name ? { ...user, jobTitle: updated.name } : user));
    }
    audit(auth.actor.id, auth.actor.name, "update-position", "position", record.id, `更新职务 ${updated.name}`);
    return apiOk(request, updated, { headers: { ETag: entityEtag(updated) } });
  }),
  http.delete(`${API}/positions/:positionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-department:删除");
    if (auth.response) return auth.response;
    const current = positions();
    const record = current.find((item) => item.id === idParam(params.positionId));
    if (!record) return apiProblem(request, 404, "POSITION_NOT_FOUND", "职务不存在", "未找到指定职务。 ");
    const conflict = checkIfMatch(request, record, true);
    if (conflict) return conflict;
    if (record.memberCount) return apiProblem(request, 409, "POSITION_IN_USE", "职务正在使用", "请先调整使用该职务的用户。 ");
    useOrganizationStore.getState().setJobTitles((items) => items.filter((item) => item.id !== record.id));
    audit(auth.actor.id, auth.actor.name, "delete-position", "position", record.id, `删除职务 ${record.name}`);
    return apiNoContent(request);
  }),
  http.get(`${API}/permissions`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-role:查看");
    if (auth.response) return auth.response;
    return apiOk(request, permissions);
  }),
  http.get(`${API}/roles/:roleId/permissions`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-role:查看");
    if (auth.response) return auth.response;
    const roleId = idParam(params.roleId);
    if (!useIdentityStore.getState().roles.some((item) => item.id === roleId)) return apiProblem(request, 404, "ROLE_NOT_FOUND", "角色不存在", "未找到指定角色。 ");
    const items = readStoredRolePermissions()[roleId] ?? [];
    return apiOk(request, items, { headers: { ETag: entityEtag(items) } });
  }),
  http.put(`${API}/roles/:roleId/permissions`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-role:授权");
    if (auth.response) return auth.response;
    const roleId = idParam(params.roleId);
    const role = useIdentityStore.getState().roles.find((item) => item.id === roleId);
    if (!role) return apiProblem(request, 404, "ROLE_NOT_FOUND", "角色不存在", "未找到指定角色。 ");
    if (role.builtIn) return apiProblem(request, 409, "IMMUTABLE_BUILTIN_RESOURCE", "内置角色不可修改", "超级管理员角色始终具有全部权限。 ");
    const current = readStoredRolePermissions()[roleId] ?? [];
    const conflict = checkIfMatch(request, current, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<{ permissions?: string[] }>(request);
    if (body instanceof Response) return body;
    const keys = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
    const invalid = keys.filter((key) => !permissions.some((item) => item.key === key));
    if (invalid.length) return apiProblem(request, 422, "PERMISSION_INVALID", "权限标识无效", `以下权限不存在：${invalid.join("、")}`);
    const map = readStoredRolePermissions();
    map[roleId] = keys;
    window.localStorage.setItem(ROLE_PERMISSION_STORAGE_KEY, JSON.stringify({ ...defaultRolePermissionMap, ...map }));
    const pagePermissions = new Set(keys.map((key) => key.split(":")[0])).size;
    useIdentityStore.getState().setRoles((roles) => roles.map((item) => item.id === roleId ? {
      ...item,
      pagePermissions,
      actionPermissions: keys.length,
    } : item));
    notifyRolePermissionsChanged();
    audit(auth.actor.id, auth.actor.name, "update-role-permissions", "role", roleId, `更新角色 ${role.name} 的权限`);
    return apiOk(request, keys, { headers: { ETag: entityEtag(keys) } });
  }),
  http.post(`${API}/roles/:roleId/change-impact`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-role:授权");
    if (auth.response) return auth.response;
    const role = useIdentityStore.getState().roles.find((item) => item.id === idParam(params.roleId));
    if (!role) return apiProblem(request, 404, "ROLE_NOT_FOUND", "角色不存在", "未找到指定角色。 ");
    const impact: ImpactPreview = { affectedUsers: role.users, affectedOpenTasks: useIdentityStore.getState().workflowGroups.filter((group) => group.linkedRoles.includes(role.name)).reduce((sum, group) => sum + group.openTasks, 0), references: useIdentityStore.getState().workflowGroups.filter((group) => group.linkedRoles.includes(role.name)).map((group) => group.name) };
    return apiOk(request, impact);
  }),
  http.get(`${API}/workflow-permission-groups/:groupId/effective-members`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-group:查看");
    if (auth.response) return auth.response;
    const pagination = pageQuery(request, 50);
    if ("response" in pagination) return pagination.response;
    const groupId = idParam(params.groupId);
    const group = useIdentityStore.getState().workflowGroups.find((item) => item.id === groupId);
    if (!group) return apiProblem(request, 404, "WORKFLOW_GROUP_NOT_FOUND", "流程权限组不存在", "未找到指定权限组。 ");
    const users = effectiveGroupMemberIds(groupId).map((id) => useIdentityStore.getState().users.find((user) => user.id === id)).filter((item) => Boolean(item)).map((user) => ({ id: user!.id, account: user!.account, name: user!.name, email: user!.email, departmentPath: user!.departmentPath, sources: [...(group.directMembers.includes(user!.name) ? ["direct"] : []), ...user!.roles.filter((role) => group.linkedRoles.includes(role)).map((role) => `role:${role}`)] }));
    return apiOk(request, paginate(users, pagination.number, pagination.size));
  }),
  http.post(`${API}/workflow-permission-groups/:groupId/change-impact`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "org-group:编辑");
    if (auth.response) return auth.response;
    const group = useIdentityStore.getState().workflowGroups.find((item) => item.id === idParam(params.groupId));
    if (!group) return apiProblem(request, 404, "WORKFLOW_GROUP_NOT_FOUND", "流程权限组不存在", "未找到指定权限组。 ");
    return apiOk(request, { affectedUsers: effectiveGroupMemberIds(group.id).length, affectedOpenTasks: group.openTasks, references: group.processes } satisfies ImpactPreview);
  }),
];
