import { http } from "msw";
import type {
  AuthSession,
  DirectorySnapshot,
  DirectoryUser,
  MockApiSettings,
  MockScenario,
  ValidationProblemField,
} from "../../api/contracts";
import {
  ROLE_PERMISSION_STORAGE_KEY,
  hasUserPermission,
  readStoredRolePermissions,
} from "../../state/permissionEngine";
import {
  effectiveGroupMemberIds,
  findIdentityUser,
  useIdentityStore,
  type DomainRole,
  type DomainUser,
  type EnableStatus,
  type WorkflowGroupPurpose,
  type WorkflowPermissionGroup,
} from "../../state/useIdentityStore";
import { useProcessDefinitionStore } from "../../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../../state/usePrototypeStore";
import { useOrganizationStore } from "../../state/useOrganizationStore";
import { createClientUuid } from "../../utils/clientId";
import { deriveWorkflowGroupStatistics } from "../../state/workflowGroupStatistics";
import { clearAttachments } from "../attachmentRepository";
import { clearRichMedia } from "../../utils/richMediaRepository";
import { MOCK_API_BASE_URL } from "../apiBase";
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
  readMockApiSettings,
  requireActor,
  resetMockApiRuntime,
  withIdempotency,
  writeMockApiSettings,
  type AuthResult,
} from "../runtime";

const API_ROOT = MOCK_API_BASE_URL;
const ACTIVE_STATUSES = new Set<EnableStatus>(["启用", "停用"]);
const GROUP_PURPOSES = new Set<WorkflowGroupPurpose>(["发起", "审批/受理", "关闭"]);
const MOCK_SCENARIOS = new Set<MockScenario>([
  "normal",
  "slow",
  "offline",
  "server-error",
  "conflict",
  "mail-fail",
  "upload-fail",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textValue = (value: unknown) => typeof value === "string" ? value.trim() : undefined;

const stringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map((item) => item.trim()).filter(Boolean)
    : undefined;

const unique = <T,>(values: T[]) => [...new Set(values)];

const userDto = (user: DomainUser): DirectoryUser => {
  const { password: _password, ...safe } = user;
  return {
    ...safe,
    department: [...safe.department],
    roles: [...safe.roles],
  };
};

const sessionDto = (
  user: DomainUser,
  operator: DomainUser = user,
  impersonation?: AuthSession["impersonation"],
): AuthSession => {
  const roleIds = [...(user.roleIds ?? [])];
  const permissionMap = readStoredRolePermissions();
  const permissions = user.builtIn
    ? [...(permissionMap["ROLE-SUPER"] ?? [])]
    : [...new Set(roleIds.flatMap((roleId) => permissionMap[roleId] ?? []))];
  return {
    user: userDto(user),
    operatorUser: userDto(operator),
    roleIds,
    permissions,
    superAdmin: Boolean(user.builtIn),
    operatorSuperAdmin: Boolean(operator.builtIn),
    impersonation,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

const roleDto = (role: DomainRole): DomainRole => ({
  ...role,
  members: [...role.members],
  memberUserIds: [...(role.memberUserIds ?? [])],
  users: useIdentityStore.getState().users.filter((user) => user.roleIds?.includes(role.id)).length,
});

const groupDto = (group: WorkflowPermissionGroup): WorkflowPermissionGroup => {
  const derived = deriveWorkflowGroupStatistics(
    group,
    useProcessDefinitionStore.getState().definitions,
    usePrototypeStore.getState().tasks,
  );
  return {
    ...derived,
    processes: [...derived.processes],
    purposes: [...group.purposes],
    directMembers: [...group.directMembers],
    linkedRoles: [...group.linkedRoles],
    directMemberUserIds: [...(group.directMemberUserIds ?? [])],
    linkedRoleIds: [...(group.linkedRoleIds ?? [])],
  };
};

const paramValue = (value: string | readonly string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : String(value ?? "");

const optionalActor = (request: Request) => {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+mock:(.+)$/i)?.[1]
    ?? request.headers.get("X-Actor-Id")
    ?? "";
  return token ? findIdentityUser(token) : undefined;
};

const requireAnyPermission = (request: Request, permissions: string[]): AuthResult => {
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated;
  if (!permissions.some((permission) => hasUserPermission(authenticated.actor.id, permission))) {
    return {
      response: apiProblem(
        request,
        403,
        "PERMISSION_DENIED",
        "没有操作权限",
        `当前账号缺少以下任一权限：${permissions.join("、")}。`,
      ),
    };
  }
  return authenticated;
};

const validationProblem = (request: Request, errors: ValidationProblemField[]) =>
  apiProblem(request, 422, "VALIDATION_FAILED", "请求校验未通过", "请修正标记的字段后重试。", { errors });

const issue = (path: string, code: string, message: string): ValidationProblemField => ({ path, code, message });

const entityResponse = <T,>(request: Request, data: T, status = 200, location?: string) => {
  const headers = new Headers({ ETag: entityEtag(data) });
  if (location) headers.set("Location", location);
  return apiOk(request, data, { status, headers });
};

const auditIdentity = (
  actor: DomainUser | undefined,
  action: string,
  resourceType: string,
  resourceId: string,
  summary: string,
  details?: Record<string, unknown>,
) => appendAuditEvent({
  category: "identity",
  action,
  actorId: actor?.id,
  actorName: actor?.name,
  resourceType,
  resourceId,
  summary,
  details,
});

const auditAuthentication = (
  action: string,
  resourceId: string,
  summary: string,
  actor?: DomainUser,
  details?: Record<string, unknown>,
) => appendAuditEvent({
  category: "authentication",
  action,
  actorId: actor?.id,
  actorName: actor?.name,
  resourceType: "session",
  resourceId,
  summary,
  details,
});

const scenarioResponse = (request: Request, write = false) => applyMockScenario(request, write);

const notFound = (request: Request, resource: string) =>
  apiProblem(request, 404, "RESOURCE_NOT_FOUND", "资源不存在", `${resource}不存在或已经被删除。`);

const immutableBuiltIn = (request: Request, resource: string) =>
  apiProblem(request, 409, "BUILT_IN_PRINCIPAL_IMMUTABLE", "系统内置对象不可修改", `${resource}由系统内置，不能修改或删除。`);

const nextNumeric = (values: string[], prefix: string) => {
  const next = Math.max(0, ...values.map((value) => Number(value.match(/\d+$/)?.[0] ?? 0))) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
};

const resolveRoleNames = (references: string[], allowBuiltIn = false) => {
  const roles = useIdentityStore.getState().roles;
  const invalid: string[] = [];
  const names = references.flatMap((reference) => {
    const role = roles.find((item) => item.id === reference || item.name === reference);
    if (!role || (!allowBuiltIn && role.builtIn)) {
      invalid.push(reference);
      return [];
    }
    return [role.name];
  });
  return { names: unique(names), invalid };
};

const resolveUserNames = (references: string[]) => {
  const users = useIdentityStore.getState().users;
  const invalid: string[] = [];
  const names = references.flatMap((reference) => {
    const user = users.find((item) => item.id === reference || item.name === reference || item.account === reference);
    if (!user || user.builtIn) {
      invalid.push(reference);
      return [];
    }
    return [user.name];
  });
  return { names: unique(names), invalid };
};

const saveUser = (previous: DomainUser | undefined, next: DomainUser) => {
  useIdentityStore.getState().setUsers((users) => previous
    ? users.map((user) => user.id === previous.id ? next : user)
    : [...users, next]);

  useIdentityStore.getState().setRoles((roles) => roles.map((role) => {
    if (role.builtIn) return role;
    const members = role.members.filter((name) => name !== previous?.name && name !== next.name);
    if (next.roles.includes(role.name)) members.push(next.name);
    const normalized = unique(members);
    return { ...role, members: normalized, users: normalized.length };
  }));

  if (previous && previous.name !== next.name) {
    useIdentityStore.getState().setWorkflowGroups((groups) => groups.map((group) => ({
      ...group,
      directMembers: unique(group.directMembers.map((name) => name === previous.name ? next.name : name)),
    })));
  }
};

const removePermissionRecord = (roleId: string) => {
  try {
    const current = JSON.parse(window.localStorage.getItem(ROLE_PERMISSION_STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    if (!(roleId in current)) return;
    delete current[roleId];
    window.localStorage.setItem(ROLE_PERMISSION_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A damaged optional mock cache must not prevent deleting the directory role.
  }
};

const healthHandler = http.get(`${API_ROOT}/health`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  return apiOk(request, {
    status: "ok" as const,
    service: "flowpilot-mock-api" as const,
    version: "v1" as const,
    mode: "mock" as const,
    time: new Date().toISOString(),
  });
});

const mockSettingsReadHandler = http.get(`${API_ROOT}/mock/settings`, ({ request }) =>
  apiOk(request, readMockApiSettings()));

const mockSettingsUpdateHandler = http.patch(`${API_ROOT}/mock/settings`, async ({ request }) => {
  const parsed = await parseJsonBody<unknown>(request);
  if (parsed instanceof Response) return parsed;
  if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);

  const errors: ValidationProblemField[] = [];
  const patch: Partial<MockApiSettings> = {};
  const unknownKeys = Object.keys(parsed).filter((key) => !["scenario", "readDelayMs", "writeDelayMs"].includes(key));
  unknownKeys.forEach((key) => errors.push(issue(key, "UNKNOWN_FIELD", "不支持此设置项。")));

  if (parsed.scenario !== undefined) {
    if (typeof parsed.scenario !== "string" || !MOCK_SCENARIOS.has(parsed.scenario as MockScenario)) {
      errors.push(issue("scenario", "INVALID_SCENARIO", "Mock 场景无效。"));
    } else patch.scenario = parsed.scenario as MockScenario;
  }
  (["readDelayMs", "writeDelayMs"] as const).forEach((key) => {
    if (parsed[key] === undefined) return;
    if (!Number.isInteger(parsed[key]) || Number(parsed[key]) < 0 || Number(parsed[key]) > 60_000) {
      errors.push(issue(key, "INVALID_DELAY", "延迟必须是 0 到 60000 之间的整数。"));
    } else patch[key] = Number(parsed[key]);
  });
  if (errors.length) return validationProblem(request, errors);

  const before = readMockApiSettings();
  const settings = writeMockApiSettings(patch);
  const actor = optionalActor(request);
  auditIdentity(actor, "mock-settings.updated", "mock-settings", "global", "Mock API 设置已更新", { before, after: settings });
  return entityResponse(request, settings);
});

const mockResetHandler = http.post(`${API_ROOT}/mock/reset`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  const session = usePrototypeStore.getState();
  const operator = findIdentityUser(session.operatorUserId);
  if (!session.authenticated || !operator?.builtIn || operator.status !== "启用") {
    return apiProblem(
      request,
      403,
      "DEMO_RESET_NOT_ALLOWED",
      "不允许重置演示数据",
      "只有真实登录的系统内置超级管理员可以重置演示数据。",
    );
  }
  return withIdempotency(request, async () => {
    usePrototypeStore.getState().resetDemo();
    useProcessDefinitionStore.getState().resetDefinitions();
    useIdentityStore.getState().resetIdentity();
    useOrganizationStore.getState().resetOrganization();
    if ("indexedDB" in window) await Promise.all([clearAttachments(), clearRichMedia()]);
    resetMockApiRuntime();
    auditIdentity(operator, "mock.reset", "mock-runtime", "global", "Mock 演示数据已重置");
    return apiOk(request, { reset: true as const });
  });
});

const loginHandler = http.post(`${API_ROOT}/auth/login`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  return withIdempotency(request, async () => {
    const parsed = await parseJsonBody<unknown>(request);
    if (parsed instanceof Response) return parsed;
    if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);
    const account = textValue(parsed.account);
    const password = typeof parsed.password === "string" ? parsed.password : undefined;
    const errors: ValidationProblemField[] = [];
    if (!account) errors.push(issue("account", "REQUIRED", "请输入登录账号。"));
    if (!password) errors.push(issue("password", "REQUIRED", "请输入密码。"));
    if (errors.length) return validationProblem(request, errors);

    const user = useIdentityStore.getState().users.find((item) => item.account.toLowerCase() === account!.toLowerCase());
    if (!user || user.password !== password) {
      auditAuthentication("auth.login-failed", account!, "本地账号登录失败", undefined, { reason: "invalid-credentials" });
      return apiProblem(request, 401, "INVALID_CREDENTIALS", "登录失败", "账号或密码错误。 ");
    }
    if (user.status !== "启用") {
      auditAuthentication("auth.login-failed", user.id, "停用账号尝试登录", user, { reason: "account-disabled" });
      return apiProblem(request, 403, "ACCOUNT_DISABLED", "账号已停用", "该账号已停用，请联系管理员。 ");
    }

    const signedIn: DomainUser = {
      ...user,
      lastLogin: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
    useIdentityStore.getState().setUsers((users) => users.map((item) => item.id === user.id ? signedIn : item));
    usePrototypeStore.getState().login(signedIn.id);
    const session: AuthSession = {
      ...sessionDto(signedIn),
      accessToken: `mock:${signedIn.id}`,
      tokenType: "Bearer",
      expiresIn: 3_600,
    };
    auditAuthentication("auth.login", signedIn.id, `${signedIn.name} 登录系统`, signedIn);
    return apiOk(request, session);
  });
});

const meHandler = http.get(`${API_ROOT}/auth/me`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  return entityResponse(request, sessionDto(
    authenticated.actor,
    authenticated.operator,
    usePrototypeStore.getState().impersonation,
  ));
});

const impersonationCandidatesHandler = http.get(`${API_ROOT}/auth/impersonation/candidates`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  if (!authenticated.operator.builtIn) return apiProblem(request, 403, "IMPERSONATION_NOT_ALLOWED", "不允许模拟身份", "只有真实登录的系统内置超级管理员可以模拟身份。 ");
  const paging = pageQuery(request, 20);
  if ("response" in paging) return paging.response;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const users = useIdentityStore.getState().users
    .filter((user) => !user.builtIn && user.status === "启用")
    .filter((user) => !q || `${user.account}${user.name}${user.email}`.toLowerCase().includes(q))
    .map(userDto);
  return apiOk(request, paginate(users, paging.number, paging.size));
});

const impersonationStartHandler = http.post(`${API_ROOT}/auth/impersonation`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  return withIdempotency(request, async () => {
    const authenticated = requireActor(request);
    if (authenticated.response) return authenticated.response;
    if (!authenticated.operator.builtIn) return apiProblem(request, 403, "IMPERSONATION_NOT_ALLOWED", "不允许模拟身份", "只有真实登录的系统内置超级管理员可以模拟身份。 ");
    if (usePrototypeStore.getState().impersonation) return apiProblem(request, 409, "IMPERSONATION_ALREADY_ACTIVE", "模拟身份已经生效", "请先退出当前模拟身份。 ");
    const body = await parseJsonBody<{ targetUserId?: string; reason?: string }>(request);
    if (body instanceof Response) return body;
    const target = body.targetUserId ? findIdentityUser(body.targetUserId) : undefined;
    if (!target || target.builtIn || target.status !== "启用") return apiProblem(request, 422, "IMPERSONATION_TARGET_INVALID", "模拟用户无效", "请选择一个启用的非内置用户。 ");
    if (!body.reason?.trim()) return validationProblem(request, [issue("reason", "REQUIRED", "请输入模拟身份原因。")]);
    const startedAt = new Date().toISOString();
    const impersonation = {
      id: createClientUuid(),
      operatorUserId: authenticated.operator.id,
      targetUserId: target.id,
      reason: body.reason.trim(),
      startedAt,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const session = sessionDto(target, authenticated.operator, impersonation);
    usePrototypeStore.getState().applyAuthSession(session);
    appendAuditEvent({ category: "authentication", action: "auth.impersonation-started", actorId: target.id, actorName: target.name, operatorId: authenticated.operator.id, operatorName: authenticated.operator.name, impersonationId: impersonation.id, resourceType: "session", resourceId: impersonation.id, summary: `${authenticated.operator.name} 开始模拟 ${target.name}`, details: { reason: impersonation.reason } });
    return apiOk(request, session);
  });
});

const impersonationStopHandler = http.delete(`${API_ROOT}/auth/impersonation`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  return withIdempotency(request, async () => {
    const authenticated = requireActor(request);
    if (authenticated.response) return authenticated.response;
    if (!authenticated.operator.builtIn) return apiProblem(request, 403, "IMPERSONATION_NOT_ALLOWED", "不允许模拟身份", "只有真实登录的系统内置超级管理员可以结束模拟身份。 ");
    const active = usePrototypeStore.getState().impersonation;
    const session = sessionDto(authenticated.operator);
    if (active) appendAuditEvent({ category: "authentication", action: "auth.impersonation-stopped", actorId: authenticated.actor.id, actorName: authenticated.actor.name, operatorId: authenticated.operator.id, operatorName: authenticated.operator.name, impersonationId: active.id, resourceType: "session", resourceId: active.id, summary: `${authenticated.operator.name} 结束模拟身份` });
    usePrototypeStore.getState().applyAuthSession(session);
    return apiOk(request, session);
  });
});

const logoutHandler = http.post(`${API_ROOT}/auth/logout`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  return withIdempotency(request, () => {
    auditAuthentication("auth.logout", authenticated.actor.id, `${authenticated.actor.name} 退出系统`, authenticated.actor);
    usePrototypeStore.getState().logout();
    return apiNoContent(request);
  });
});

const directorySnapshotHandler = http.get(`${API_ROOT}/directory`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:查看", "org-role:查看", "org-group:查看"]);
  if (authorized.response) return authorized.response;
  const state = useIdentityStore.getState();
  const snapshot: DirectorySnapshot = {
    users: state.users.map(userDto),
    roles: state.roles.map(roleDto),
    workflowGroups: state.workflowGroups.map(groupDto),
  };
  return apiOk(request, snapshot);
});

const usersListHandler = http.get(`${API_ROOT}/users`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:查看", "org-role:查看", "org-group:查看", "config-definition:编辑"]);
  if (authorized.response) return authorized.response;
  const paging = pageQuery(request, 20);
  if ("response" in paging) return paging.response;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const status = url.searchParams.get("status");
  const hasEmail = url.searchParams.get("hasEmail");
  if (status && !ACTIVE_STATUSES.has(status as EnableStatus)) {
    return apiProblem(request, 400, "INVALID_FILTER", "筛选条件无效", "status 只支持“启用”或“停用”。");
  }
  if (hasEmail && hasEmail !== "true" && hasEmail !== "false") {
    return apiProblem(request, 400, "INVALID_FILTER", "筛选条件无效", "hasEmail 只支持 true 或 false。 ");
  }

  const departmentId = url.searchParams.get("departmentId") ?? url.searchParams.get("department");
  const jobTitle = url.searchParams.get("jobTitle");
  const roleReference = url.searchParams.get("roleId") ?? url.searchParams.get("role");
  const roleName = roleReference
    ? useIdentityStore.getState().roles.find((role) => role.id === roleReference || role.name === roleReference)?.name ?? roleReference
    : undefined;
  const workflowGroupId = url.searchParams.get("workflowGroupId");
  const groupMemberIds = workflowGroupId ? new Set(effectiveGroupMemberIds(workflowGroupId)) : undefined;

  const users = useIdentityStore.getState().users
    .filter((user) => !q || `${user.account}${user.name}${user.email}`.toLowerCase().includes(q))
    .filter((user) => !status || user.status === status)
    .filter((user) => !departmentId || user.department.includes(departmentId))
    .filter((user) => !jobTitle || user.jobTitle === jobTitle)
    .filter((user) => !roleName || user.roles.includes(roleName))
    .filter((user) => !groupMemberIds || groupMemberIds.has(user.id))
    .filter((user) => hasEmail === null || Boolean(user.email.trim()) === (hasEmail === "true"))
    .sort((left, right) => left.account.localeCompare(right.account, "zh-CN"))
    .map(userDto);
  return apiOk(request, paginate(users, paging.number, paging.size));
});

const userReadHandler = http.get(`${API_ROOT}/users/:userId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:查看", "org-role:查看", "org-group:查看", "config-definition:编辑"]);
  if (authorized.response) return authorized.response;
  const user = findIdentityUser(paramValue(params.userId));
  return user ? entityResponse(request, userDto(user)) : notFound(request, "用户");
});

const userCreateHandler = http.post(`${API_ROOT}/users`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:编辑"]);
  if (authorized.response) return authorized.response;
  return withIdempotency(request, async () => {
    const parsed = await parseJsonBody<unknown>(request);
    if (parsed instanceof Response) return parsed;
    if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);

    const account = textValue(parsed.account);
    const email = textValue(parsed.email);
    const password = typeof parsed.password === "string" ? parsed.password : undefined;
    const name = textValue(parsed.name);
    const department = stringArray(parsed.department);
    const departmentPath = textValue(parsed.departmentPath);
    const jobTitle = textValue(parsed.jobTitle);
    const roles = parsed.roles === undefined ? [] : stringArray(parsed.roles);
    const status = parsed.status === undefined ? "启用" : parsed.status;
    const errors: ValidationProblemField[] = [];
    if (!account) errors.push(issue("account", "REQUIRED", "请输入登录账号。"));
    if (!email) errors.push(issue("email", "REQUIRED", "请输入邮箱。"));
    else if (!EMAIL_PATTERN.test(email)) errors.push(issue("email", "INVALID_EMAIL", "邮箱格式不正确。"));
    if (!password) errors.push(issue("password", "REQUIRED", "请输入初始密码。"));
    if (!name) errors.push(issue("name", "REQUIRED", "请输入员工姓名。"));
    if (!department?.length) errors.push(issue("department", "REQUIRED", "请选择所属部门。"));
    if (!jobTitle) errors.push(issue("jobTitle", "REQUIRED", "请选择职务。"));
    if (roles === undefined) errors.push(issue("roles", "INVALID_TYPE", "角色必须是字符串数组。"));
    if (!ACTIVE_STATUSES.has(status as EnableStatus)) errors.push(issue("status", "INVALID_STATUS", "账号状态无效。"));

    const users = useIdentityStore.getState().users;
    if (account && users.some((user) => user.account.toLowerCase() === account.toLowerCase())) errors.push(issue("account", "ACCOUNT_CONFLICT", "登录账号已存在。"));
    if (email && users.some((user) => user.email.toLowerCase() === email.toLowerCase())) errors.push(issue("email", "EMAIL_CONFLICT", "邮箱已被其他用户使用。"));
    if (name && users.some((user) => user.name === name)) errors.push(issue("name", "NAME_CONFLICT", "员工姓名已存在；当前原型的名称关联要求姓名唯一。"));
    if (account?.toLowerCase() === "superadmin" || parsed.builtIn === true) errors.push(issue("account", "RESERVED_ACCOUNT", "不能创建系统内置账号。"));
    const resolvedRoles = resolveRoleNames(roles ?? []);
    if (resolvedRoles.invalid.length) errors.push(issue("roles", "ROLE_NOT_FOUND", `以下角色不存在或不可分配：${resolvedRoles.invalid.join("、")}。`));
    if (errors.length) return validationProblem(request, errors);

    const created: DomainUser = {
      id: `USR-${createClientUuid()}`,
      account: account ?? "",
      email: email ?? "",
      password: password ?? "",
      name: name ?? "",
      department: department ?? [],
      departmentPath: departmentPath ?? (department ?? []).join(" / "),
      jobTitle: jobTitle ?? "",
      roles: resolvedRoles.names,
      status: status as EnableStatus,
      lastLogin: "从未登录",
    };
    saveUser(undefined, created);
    const safe = userDto(created);
    auditIdentity(authorized.actor, "user.created", "user", created.id, `用户 ${created.name} 已创建`, { after: safe });
    return entityResponse(request, safe, 201, `${API_ROOT}/directory/users/${encodeURIComponent(created.id)}`);
  });
});

const userUpdateHandler = http.patch(`${API_ROOT}/users/:userId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:编辑"]);
  if (authorized.response) return authorized.response;
  const userId = paramValue(params.userId);
  const current = findIdentityUser(userId);
  if (!current) return notFound(request, "用户");
  if (current.builtIn) return immutableBuiltIn(request, "超级管理员账号");
  const revisionProblem = checkIfMatch(request, userDto(current));
  if (revisionProblem) return revisionProblem;

  const parsed = await parseJsonBody<unknown>(request);
  if (parsed instanceof Response) return parsed;
  if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);
  const allowedFields = new Set(["account", "email", "name", "department", "departmentPath", "jobTitle", "roles", "status"]);
  const errors = Object.keys(parsed)
    .filter((key) => !allowedFields.has(key))
    .map((key) => issue(key, key === "password" ? "PASSWORD_WRITE_NOT_ALLOWED" : "IMMUTABLE_OR_UNKNOWN_FIELD", key === "password" ? "密码只能通过重置密码接口修改。" : "字段不可通过此接口修改。"));

  const account = parsed.account === undefined ? current.account : textValue(parsed.account);
  const email = parsed.email === undefined ? current.email : textValue(parsed.email);
  const name = parsed.name === undefined ? current.name : textValue(parsed.name);
  const department = parsed.department === undefined ? current.department : stringArray(parsed.department);
  const departmentPath = parsed.departmentPath === undefined ? current.departmentPath : textValue(parsed.departmentPath);
  const jobTitle = parsed.jobTitle === undefined ? current.jobTitle : textValue(parsed.jobTitle);
  const roleReferences = parsed.roles === undefined ? current.roles : stringArray(parsed.roles);
  const status = parsed.status === undefined ? current.status : parsed.status;
  if (!account) errors.push(issue("account", "REQUIRED", "请输入登录账号。"));
  if (!email) errors.push(issue("email", "REQUIRED", "请输入邮箱。"));
  else if (!EMAIL_PATTERN.test(email)) errors.push(issue("email", "INVALID_EMAIL", "邮箱格式不正确。"));
  if (!name) errors.push(issue("name", "REQUIRED", "请输入员工姓名。"));
  if (!department?.length) errors.push(issue("department", "REQUIRED", "请选择所属部门。"));
  if (!jobTitle) errors.push(issue("jobTitle", "REQUIRED", "请选择职务。"));
  if (roleReferences === undefined) errors.push(issue("roles", "INVALID_TYPE", "角色必须是字符串数组。"));
  if (!ACTIVE_STATUSES.has(status as EnableStatus)) errors.push(issue("status", "INVALID_STATUS", "账号状态无效。"));

  const users = useIdentityStore.getState().users;
  if (account && users.some((user) => user.id !== current.id && user.account.toLowerCase() === account.toLowerCase())) errors.push(issue("account", "ACCOUNT_CONFLICT", "登录账号已存在。"));
  if (email && users.some((user) => user.id !== current.id && user.email.toLowerCase() === email.toLowerCase())) errors.push(issue("email", "EMAIL_CONFLICT", "邮箱已被其他用户使用。"));
  if (name && users.some((user) => user.id !== current.id && user.name === name)) errors.push(issue("name", "NAME_CONFLICT", "员工姓名已存在；当前原型的名称关联要求姓名唯一。"));
  const resolvedRoles = resolveRoleNames(roleReferences ?? []);
  if (resolvedRoles.invalid.length) errors.push(issue("roles", "ROLE_NOT_FOUND", `以下角色不存在或不可分配：${resolvedRoles.invalid.join("、")}。`));
  if (errors.length) return validationProblem(request, errors);

  const updated: DomainUser = {
    ...current,
    account: account ?? current.account,
    email: email ?? current.email,
    name: name ?? current.name,
    department: department ?? current.department,
    departmentPath: departmentPath ?? current.departmentPath,
    jobTitle: jobTitle ?? current.jobTitle,
    roles: resolvedRoles.names,
    status: status as EnableStatus,
  };
  saveUser(current, updated);
  const safe = userDto(updated);
  auditIdentity(authorized.actor, "user.updated", "user", current.id, `用户 ${updated.name} 已更新`, { before: userDto(current), after: safe });
  return entityResponse(request, safe);
});

const userDeleteHandler = http.delete(`${API_ROOT}/users/:userId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:编辑"]);
  if (authorized.response) return authorized.response;
  const userId = paramValue(params.userId);
  const current = findIdentityUser(userId);
  if (!current) return notFound(request, "用户");
  if (current.builtIn) return immutableBuiltIn(request, "超级管理员账号");
  if (authorized.actor.id === current.id) return apiProblem(request, 409, "SELF_DELETE_NOT_ALLOWED", "不能删除当前账号", "请由其他管理员处理此账号。 ");
  const revisionProblem = checkIfMatch(request, userDto(current));
  if (revisionProblem) return revisionProblem;
  const referencingGroups = useIdentityStore.getState().workflowGroups.filter((group) => group.directMemberUserIds?.includes(current.id));
  if (referencingGroups.length) {
    return apiProblem(request, 409, "USER_REFERENCED", "用户仍被流程权限组引用", `请先从以下权限组移除该用户：${referencingGroups.map((group) => group.name).join("、")}。`);
  }

  useIdentityStore.getState().setUsers((users) => users.filter((user) => user.id !== current.id));
  useIdentityStore.getState().setRoles((roles) => roles.map((role) => {
    const members = role.members.filter((name) => name !== current.name);
    return { ...role, members, users: members.length };
  }));
  auditIdentity(authorized.actor, "user.deleted", "user", current.id, `用户 ${current.name} 已删除`, { before: userDto(current) });
  return apiNoContent(request);
});

const resetPasswordHandler = http.post(`${API_ROOT}/users/:userId/reset-password`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-user:重置密码"]);
  if (authorized.response) return authorized.response;
  const userId = paramValue(params.userId);
  const current = findIdentityUser(userId);
  if (!current) return notFound(request, "用户");
  if (current.builtIn) return immutableBuiltIn(request, "超级管理员账号密码");
  return withIdempotency(request, () => {
    const temporaryPassword = `T-${createClientUuid().replaceAll("-", "").slice(0, 10)}`;
    useIdentityStore.getState().setUsers((users) => users.map((user) => user.id === current.id ? { ...user, password: temporaryPassword } : user));
    auditIdentity(authorized.actor, "user.password-reset", "user", current.id, `已重置 ${current.name} 的密码`, { passwordReset: true });
    return apiOk(request, { temporaryPassword });
  });
});

const rolesListHandler = http.get(`${API_ROOT}/roles`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-role:查看", "org-user:查看", "org-group:查看", "config-definition:编辑"]);
  if (authorized.response) return authorized.response;
  const paging = pageQuery(request, 20);
  if ("response" in paging) return paging.response;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const status = url.searchParams.get("status");
  if (status && !ACTIVE_STATUSES.has(status as EnableStatus)) return apiProblem(request, 400, "INVALID_FILTER", "筛选条件无效", "status 只支持“启用”或“停用”。");
  const roles = useIdentityStore.getState().roles
    .filter((role) => !q || `${role.name}${role.description}`.toLowerCase().includes(q))
    .filter((role) => !status || role.status === status)
    .map(roleDto)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return apiOk(request, paginate(roles, paging.number, paging.size));
});

const roleReadHandler = http.get(`${API_ROOT}/roles/:roleId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-role:查看", "org-user:查看", "org-group:查看", "config-definition:编辑"]);
  if (authorized.response) return authorized.response;
  const roleId = paramValue(params.roleId);
  const role = useIdentityStore.getState().roles.find((item) => item.id === roleId);
  return role ? entityResponse(request, roleDto(role)) : notFound(request, "角色");
});

const roleCreateHandler = http.post(`${API_ROOT}/roles`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-role:编辑"]);
  if (authorized.response) return authorized.response;
  return withIdempotency(request, async () => {
    const parsed = await parseJsonBody<unknown>(request);
    if (parsed instanceof Response) return parsed;
    if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);
    const name = textValue(parsed.name);
    const description = textValue(parsed.description) ?? "";
    const status = parsed.status === undefined ? "启用" : parsed.status;
    const memberReferences = parsed.members === undefined ? [] : stringArray(parsed.members);
    const errors: ValidationProblemField[] = [];
    if (!name) errors.push(issue("name", "REQUIRED", "请输入角色名称。"));
    if (name === "超级管理员" || parsed.builtIn === true) errors.push(issue("name", "RESERVED_ROLE", "不能创建系统内置角色。"));
    if (!ACTIVE_STATUSES.has(status as EnableStatus)) errors.push(issue("status", "INVALID_STATUS", "角色状态无效。"));
    if (memberReferences === undefined) errors.push(issue("members", "INVALID_TYPE", "角色成员必须是字符串数组。"));
    if (name && useIdentityStore.getState().roles.some((role) => role.name === name)) errors.push(issue("name", "ROLE_NAME_CONFLICT", "角色名称已存在。"));
    const resolvedMembers = resolveUserNames(memberReferences ?? []);
    if (resolvedMembers.invalid.length) errors.push(issue("members", "USER_NOT_FOUND", `以下用户不存在或不可选择：${resolvedMembers.invalid.join("、")}。`));
    if (errors.length) return validationProblem(request, errors);

    const currentRoles = useIdentityStore.getState().roles;
    const id = nextNumeric(currentRoles.map((role) => role.id), "ROLE-");
    const record: DomainRole = {
      id,
      code: nextNumeric(currentRoles.map((role) => role.code), "role_"),
      name: name ?? "",
      description,
      pagePermissions: 0,
      actionPermissions: 0,
      users: resolvedMembers.names.length,
      status: status as EnableStatus,
      members: resolvedMembers.names,
      memberUserIds: useIdentityStore.getState().users.filter((user) => resolvedMembers.names.includes(user.name)).map((user) => user.id),
    };
    useIdentityStore.getState().setRoles((roles) => [...roles, record]);
    auditIdentity(authorized.actor, "role.created", "role", record.id, `角色 ${record.name} 已创建`, { after: roleDto(record) });
    return entityResponse(request, roleDto(record), 201, `${API_ROOT}/directory/roles/${encodeURIComponent(record.id)}`);
  });
});

const roleUpdateHandler = http.patch(`${API_ROOT}/roles/:roleId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-role:编辑"]);
  if (authorized.response) return authorized.response;
  const roleId = paramValue(params.roleId);
  const current = useIdentityStore.getState().roles.find((role) => role.id === roleId);
  if (!current) return notFound(request, "角色");
  if (current.builtIn) return immutableBuiltIn(request, "超级管理员角色");
  const revisionProblem = checkIfMatch(request, roleDto(current));
  if (revisionProblem) return revisionProblem;
  const parsed = await parseJsonBody<unknown>(request);
  if (parsed instanceof Response) return parsed;
  if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);

  const allowedFields = new Set(["name", "description", "status", "members"]);
  const errors = Object.keys(parsed).filter((key) => !allowedFields.has(key))
    .map((key) => issue(key, "IMMUTABLE_OR_UNKNOWN_FIELD", "字段不可通过此接口修改。"));
  const name = parsed.name === undefined ? current.name : textValue(parsed.name);
  const description = parsed.description === undefined ? current.description : textValue(parsed.description);
  const status = parsed.status === undefined ? current.status : parsed.status;
  const memberReferences = parsed.members === undefined ? current.members : stringArray(parsed.members);
  if (!name) errors.push(issue("name", "REQUIRED", "请输入角色名称。"));
  if (description === undefined) errors.push(issue("description", "INVALID_TYPE", "角色说明必须是字符串。"));
  if (!ACTIVE_STATUSES.has(status as EnableStatus)) errors.push(issue("status", "INVALID_STATUS", "角色状态无效。"));
  if (memberReferences === undefined) errors.push(issue("members", "INVALID_TYPE", "角色成员必须是字符串数组。"));
  if (name && useIdentityStore.getState().roles.some((role) => role.id !== current.id && role.name === name)) errors.push(issue("name", "ROLE_NAME_CONFLICT", "角色名称已存在。"));
  const resolvedMembers = resolveUserNames(memberReferences ?? []);
  if (resolvedMembers.invalid.length) errors.push(issue("members", "USER_NOT_FOUND", `以下用户不存在或不可选择：${resolvedMembers.invalid.join("、")}。`));
  if (errors.length) return validationProblem(request, errors);

  const updated: DomainRole = {
    ...current,
    name: name ?? current.name,
    description: description ?? current.description,
    status: status as EnableStatus,
    members: resolvedMembers.names,
    memberUserIds: useIdentityStore.getState().users.filter((user) => resolvedMembers.names.includes(user.name)).map((user) => user.id),
    users: resolvedMembers.names.length,
  };
  useIdentityStore.getState().setRoles((roles) => roles.map((role) => role.id === current.id ? updated : role));
  if (current.name !== updated.name) {
    useIdentityStore.getState().setWorkflowGroups((groups) => groups.map((group) => ({
      ...group,
      linkedRoles: unique(group.linkedRoles.map((name) => name === current.name ? updated.name : name)),
    })));
  }
  auditIdentity(authorized.actor, "role.updated", "role", current.id, `角色 ${updated.name} 已更新`, { before: roleDto(current), after: roleDto(updated) });
  return entityResponse(request, roleDto(updated));
});

const roleDeleteHandler = http.delete(`${API_ROOT}/roles/:roleId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-role:编辑"]);
  if (authorized.response) return authorized.response;
  const roleId = paramValue(params.roleId);
  const current = useIdentityStore.getState().roles.find((role) => role.id === roleId);
  if (!current) return notFound(request, "角色");
  if (current.builtIn) return immutableBuiltIn(request, "超级管理员角色");
  const revisionProblem = checkIfMatch(request, roleDto(current));
  if (revisionProblem) return revisionProblem;
  const referencingGroups = useIdentityStore.getState().workflowGroups.filter((group) => group.linkedRoleIds?.includes(current.id));
  if (referencingGroups.length) return apiProblem(request, 409, "ROLE_REFERENCED", "角色仍被流程权限组引用", `请先从以下权限组移除角色关联：${referencingGroups.map((group) => group.name).join("、")}。`);
  useIdentityStore.getState().setRoles((roles) => roles.filter((role) => role.id !== current.id));
  removePermissionRecord(current.id);
  auditIdentity(authorized.actor, "role.deleted", "role", current.id, `角色 ${current.name} 已删除`, { before: roleDto(current) });
  return apiNoContent(request);
});

const groupsListHandler = http.get(`${API_ROOT}/workflow-permission-groups`, async ({ request }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-group:查看", "config-definition:编辑"]);
  if (authorized.response) return authorized.response;
  const paging = pageQuery(request, 20);
  if ("response" in paging) return paging.response;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const purpose = url.searchParams.get("purpose");
  const status = url.searchParams.get("status");
  if (purpose && !GROUP_PURPOSES.has(purpose as WorkflowGroupPurpose)) return apiProblem(request, 400, "INVALID_FILTER", "筛选条件无效", "purpose 不是支持的流程权限组用途。 ");
  if (status && !ACTIVE_STATUSES.has(status as EnableStatus)) return apiProblem(request, 400, "INVALID_FILTER", "筛选条件无效", "status 只支持“启用”或“停用”。");
  const groups = useIdentityStore.getState().workflowGroups
    .filter((group) => !q || `${group.name}${group.code}`.toLowerCase().includes(q))
    .filter((group) => !purpose || group.purposes.includes(purpose as WorkflowGroupPurpose))
    .filter((group) => !status || group.status === status)
    .map(groupDto)
    .sort((left, right) => left.code.localeCompare(right.code, "zh-CN"));
  return apiOk(request, paginate(groups, paging.number, paging.size));
});

const groupReadHandler = http.get(`${API_ROOT}/workflow-permission-groups/:groupId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-group:查看", "config-definition:编辑"]);
  if (authorized.response) return authorized.response;
  const groupId = paramValue(params.groupId);
  const group = useIdentityStore.getState().workflowGroups.find((item) => item.id === groupId);
  return group ? entityResponse(request, groupDto(group)) : notFound(request, "流程权限组");
});

const validateGroupReferences = (
  directReferences: string[],
  roleReferences: string[],
  current?: WorkflowPermissionGroup,
) => {
  const direct = resolveUserNames(directReferences);
  const roles = resolveRoleNames(roleReferences);
  const inactiveNewRoles = roles.names.filter((name) => {
    const role = useIdentityStore.getState().roles.find((item) => item.name === name);
    return role?.status === "停用" && !current?.linkedRoles.includes(name);
  });
  return { direct, roles, inactiveNewRoles };
};

const groupCreateHandler = http.post(`${API_ROOT}/workflow-permission-groups`, async ({ request }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-group:编辑"]);
  if (authorized.response) return authorized.response;
  return withIdempotency(request, async () => {
    const parsed = await parseJsonBody<unknown>(request);
    if (parsed instanceof Response) return parsed;
    if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);
    const name = textValue(parsed.name);
    const purposes = stringArray(parsed.purposes);
    const directReferences = parsed.directMembers === undefined ? [] : stringArray(parsed.directMembers);
    const roleReferences = parsed.linkedRoles === undefined ? [] : stringArray(parsed.linkedRoles);
    const status = parsed.status === undefined ? "启用" : parsed.status;
    const errors: ValidationProblemField[] = [];
    if (!name) errors.push(issue("name", "REQUIRED", "请输入权限组名称。"));
    if (!purposes?.length || purposes.some((purpose) => !GROUP_PURPOSES.has(purpose as WorkflowGroupPurpose))) errors.push(issue("purposes", "INVALID_PURPOSES", "请至少选择一个有效用途。"));
    if (directReferences === undefined) errors.push(issue("directMembers", "INVALID_TYPE", "直接成员必须是字符串数组。"));
    if (roleReferences === undefined) errors.push(issue("linkedRoles", "INVALID_TYPE", "关联角色必须是字符串数组。"));
    if (!ACTIVE_STATUSES.has(status as EnableStatus)) errors.push(issue("status", "INVALID_STATUS", "权限组状态无效。"));
    if (name && useIdentityStore.getState().workflowGroups.some((group) => group.name === name)) errors.push(issue("name", "GROUP_NAME_CONFLICT", "流程权限组名称已存在。"));
    const resolved = validateGroupReferences(directReferences ?? [], roleReferences ?? []);
    if (resolved.direct.invalid.length) errors.push(issue("directMembers", "USER_NOT_FOUND", `以下用户不存在或不可选择：${resolved.direct.invalid.join("、")}。`));
    if (resolved.roles.invalid.length) errors.push(issue("linkedRoles", "ROLE_NOT_FOUND", `以下角色不存在或不可关联：${resolved.roles.invalid.join("、")}。`));
    if (resolved.inactiveNewRoles.length) errors.push(issue("linkedRoles", "ROLE_DISABLED", `停用角色不能新增关联：${resolved.inactiveNewRoles.join("、")}。`));
    if (errors.length) return validationProblem(request, errors);

    const groups = useIdentityStore.getState().workflowGroups;
    const record: WorkflowPermissionGroup = {
      id: `workflow-group-${createClientUuid()}`,
      code: nextNumeric(groups.map((group) => group.code), "PG-"),
      name: name ?? "",
      processes: [],
      purposes: (purposes ?? []) as WorkflowGroupPurpose[],
      directMembers: resolved.direct.names,
      linkedRoles: resolved.roles.names,
      directMemberUserIds: useIdentityStore.getState().users.filter((user) => resolved.direct.names.includes(user.name)).map((user) => user.id),
      linkedRoleIds: useIdentityStore.getState().roles.filter((role) => resolved.roles.names.includes(role.name)).map((role) => role.id),
      status: status as EnableStatus,
      referenced: false,
      openTasks: 0,
      updatedAt: new Date().toISOString(),
    };
    useIdentityStore.getState().setWorkflowGroups((current) => [...current, record]);
    auditIdentity(authorized.actor, "workflow-group.created", "workflow-permission-group", record.id, `流程权限组 ${record.name} 已创建`, { after: groupDto(record) });
    return entityResponse(request, groupDto(record), 201, `${API_ROOT}/workflow-permission-groups/${encodeURIComponent(record.id)}`);
  });
});

const groupUpdateHandler = http.patch(`${API_ROOT}/workflow-permission-groups/:groupId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-group:编辑"]);
  if (authorized.response) return authorized.response;
  const groupId = paramValue(params.groupId);
  const current = useIdentityStore.getState().workflowGroups.find((group) => group.id === groupId);
  if (!current) return notFound(request, "流程权限组");
  const revisionProblem = checkIfMatch(request, groupDto(current));
  if (revisionProblem) return revisionProblem;
  const parsed = await parseJsonBody<unknown>(request);
  if (parsed instanceof Response) return parsed;
  if (!isObject(parsed)) return validationProblem(request, [issue("body", "OBJECT_REQUIRED", "请求体必须是对象。")]);

  const allowedFields = new Set(["name", "purposes", "directMembers", "linkedRoles", "status"]);
  const errors = Object.keys(parsed).filter((key) => !allowedFields.has(key))
    .map((key) => issue(key, "IMMUTABLE_OR_UNKNOWN_FIELD", "字段由引用关系或系统统计维护，不能直接修改。"));
  const name = parsed.name === undefined ? current.name : textValue(parsed.name);
  const purposes = parsed.purposes === undefined ? current.purposes : stringArray(parsed.purposes);
  const directReferences = parsed.directMembers === undefined ? current.directMembers : stringArray(parsed.directMembers);
  const roleReferences = parsed.linkedRoles === undefined ? current.linkedRoles : stringArray(parsed.linkedRoles);
  const status = parsed.status === undefined ? current.status : parsed.status;
  if (!name) errors.push(issue("name", "REQUIRED", "请输入权限组名称。"));
  if (!purposes?.length || purposes.some((purpose) => !GROUP_PURPOSES.has(purpose as WorkflowGroupPurpose))) errors.push(issue("purposes", "INVALID_PURPOSES", "请至少选择一个有效用途。"));
  if (directReferences === undefined) errors.push(issue("directMembers", "INVALID_TYPE", "直接成员必须是字符串数组。"));
  if (roleReferences === undefined) errors.push(issue("linkedRoles", "INVALID_TYPE", "关联角色必须是字符串数组。"));
  if (!ACTIVE_STATUSES.has(status as EnableStatus)) errors.push(issue("status", "INVALID_STATUS", "权限组状态无效。"));
  if (name && useIdentityStore.getState().workflowGroups.some((group) => group.id !== current.id && group.name === name)) errors.push(issue("name", "GROUP_NAME_CONFLICT", "流程权限组名称已存在。"));
  const resolved = validateGroupReferences(directReferences ?? [], roleReferences ?? [], current);
  if (resolved.direct.invalid.length) errors.push(issue("directMembers", "USER_NOT_FOUND", `以下用户不存在或不可选择：${resolved.direct.invalid.join("、")}。`));
  if (resolved.roles.invalid.length) errors.push(issue("linkedRoles", "ROLE_NOT_FOUND", `以下角色不存在或不可关联：${resolved.roles.invalid.join("、")}。`));
  if (resolved.inactiveNewRoles.length) errors.push(issue("linkedRoles", "ROLE_DISABLED", `停用角色不能新增关联：${resolved.inactiveNewRoles.join("、")}。`));
  if (errors.length) return validationProblem(request, errors);

  const updated: WorkflowPermissionGroup = {
    ...current,
    name: name ?? current.name,
    purposes: (purposes ?? current.purposes) as WorkflowGroupPurpose[],
    directMembers: resolved.direct.names,
    linkedRoles: resolved.roles.names,
    directMemberUserIds: useIdentityStore.getState().users.filter((user) => resolved.direct.names.includes(user.name)).map((user) => user.id),
    linkedRoleIds: useIdentityStore.getState().roles.filter((role) => resolved.roles.names.includes(role.name)).map((role) => role.id),
    status: status as EnableStatus,
    updatedAt: new Date().toISOString(),
  };
  useIdentityStore.getState().setWorkflowGroups((groups) => groups.map((group) => group.id === current.id ? updated : group));
  auditIdentity(authorized.actor, "workflow-group.updated", "workflow-permission-group", current.id, `流程权限组 ${updated.name} 已更新`, { before: groupDto(current), after: groupDto(updated) });
  return entityResponse(request, groupDto(updated));
});

const groupDeleteHandler = http.delete(`${API_ROOT}/workflow-permission-groups/:groupId`, async ({ request, params }) => {
  const scenario = await scenarioResponse(request, true);
  if (scenario) return scenario;
  const authorized = requireAnyPermission(request, ["org-group:编辑"]);
  if (authorized.response) return authorized.response;
  const groupId = paramValue(params.groupId);
  const current = useIdentityStore.getState().workflowGroups.find((group) => group.id === groupId);
  if (!current) return notFound(request, "流程权限组");
  const revisionProblem = checkIfMatch(request, groupDto(current));
  if (revisionProblem) return revisionProblem;
  const currentStats = groupDto(current);
  if (currentStats.referenced || currentStats.processes.length) return apiProblem(request, 409, "WORKFLOW_GROUP_REFERENCED", "流程权限组已被引用", "请先从流程定义和节点配置中解除全部引用。 ");
  useIdentityStore.getState().setWorkflowGroups((groups) => groups.filter((group) => group.id !== current.id));
  auditIdentity(authorized.actor, "workflow-group.deleted", "workflow-permission-group", current.id, `流程权限组 ${current.name} 已删除`, { before: groupDto(current) });
  return apiNoContent(request);
});

export const systemDirectoryHandlers = [
  healthHandler,
  mockSettingsReadHandler,
  mockSettingsUpdateHandler,
  mockResetHandler,
  loginHandler,
  meHandler,
  impersonationCandidatesHandler,
  impersonationStartHandler,
  impersonationStopHandler,
  logoutHandler,
  directorySnapshotHandler,
  usersListHandler,
  userReadHandler,
  userCreateHandler,
  userUpdateHandler,
  userDeleteHandler,
  resetPasswordHandler,
  rolesListHandler,
  roleReadHandler,
  roleCreateHandler,
  roleUpdateHandler,
  roleDeleteHandler,
  groupsListHandler,
  groupReadHandler,
  groupCreateHandler,
  groupUpdateHandler,
  groupDeleteHandler,
];
