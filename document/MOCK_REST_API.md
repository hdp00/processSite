# FlowPilot 前端 Mock REST API

## 1. 定位

当前仓库没有启动真实后端。开发和 debug 演示模式使用 MSW 2 的页面内 Fetch/XHR 拦截器处理请求，不注册 Service Worker，因此通过普通 HTTP 部署到 IIS 时也可以运行。页面仍通过标准 HTTP 语义访问 Mock API，而不是直接调用 Mock handler 或 Zustand action。

- 正式接口契约：[`flowpilot-rest-api.openapi.yaml`](./flowpilot-rest-api.openapi.yaml)
- 类型化客户端：`apps/web/src/api/flowPilotApi.ts`
- HTTP 客户端与错误解析：`apps/web/src/api/client.ts`
- 浏览器 Mock 入口：`apps/web/src/mocks/browser.ts`
- 领域 Handler：`apps/web/src/mocks/handlers`

Mock 层是当前前端领域模型的兼容适配器；OpenAPI 是 NestJS 正式实现的目标契约。统一客户端会把 Mock 响应包和 OpenAPI 直接 DTO 映射到同一前端领域模型，并以 OpenAPI 中的服务端校验、事务和并发约束为准；正式模式不调用 Mock 私有聚合接口。

## 2. 运行方式

```bash
pnpm install
pnpm dev
```

开发服务器默认启用 Mock API。应用会先启用页面内请求拦截器，再渲染 React，避免首屏请求漏过拦截。

生成可部署的 HTTP 演示包：

```bash
pnpm build:debug
```

debug 构建固定使用 `/flowpilot/mock-api/v1`，请求只在当前页面内处理，不发送到 IIS。PDF、附件和富媒体正文继续保存在当前浏览器的 IndexedDB 中。

如需连接真实后端，在 `apps/web/.env.local` 中配置：

```dotenv
VITE_API_MODE=remote
VITE_API_BASE_URL=http://127.0.0.1:3000/api/flowpilot/v1
```

正式构建使用：

```bash
pnpm build
```

该命令固定读取 `.env.production`，使用 `/api/flowpilot/v1` 后端并完全排除浏览器 Mock。演示 Mock 不属于正式业务数据源。

> 页面内拦截器只处理当前页面代码发起的 Fetch/XHR。直接在地址栏打开 Mock API，或使用 `curl` 请求 IIS 地址，不会进入 Mock Handler。

## 3. 调用约定

```ts
import { ApiError } from "./api/client";
import { flowPilotApi } from "./api/flowPilotApi";

try {
  const session = await flowPilotApi.auth.login("lina", "1");
  const tasks = await flowPilotApi.tasks.listMine({ view: "pending", page: 1, pageSize: 20 });
  console.log(session.user.name, tasks.page.totalElements);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.problem.code, error.problem.detail, error.problem.traceId);
  }
}
```

客户端统一提供：

- 正式 `/api/flowpilot/v1` 与 Debug `/flowpilot/mock-api/v1` 基础地址切换和查询参数编码；
- `Authorization: Bearer mock:<userId>` 演示会话；正式模式只使用同源 HttpOnly Cookie，不保存或发送该令牌；
- 15 秒默认超时和 `AbortSignal` 取消；
- 写命令的 `Idempotency-Key`；
- 基于 `ETag` / `If-Match` 的乐观并发；
- JSON 请求、multipart 上传和 Blob 下载；
- RFC Problem Details 风格错误解析。

当前 Mock 兼容层的成功响应采用 `{ data, meta: { requestId, timestamp } }`，正式 OpenAPI 成功响应直接返回 DTO；客户端兼容两种形式，并从响应头或响应包读取 requestId。错误响应至少包含 `type`、`title`、`status`、`detail`、`instance`、`code` 和 `traceId`。字段校验错误附带 `errors[]`，并发错误可附带 `currentEtag`。

## 4. API 范围

| 领域 | 主要路径 | 已模拟能力 |
| --- | --- | --- |
| 健康与 Mock 控制 | `/health`、`/mock/settings`、`/mock/reset` | 当前 Mock 健康检查、延迟/故障场景、定向重置演示数据；正式契约使用 `/health/live`、`/health/ready`、`/health/details` |
| 会话 | `/auth/login`、`/auth/me`、`/auth/logout` | 演示密码校验、停用账号拦截、无密码用户 DTO；不连接真实域服务 |
| 用户与组织 | `/users`、`/departments`、`/positions` | 分页、CRUD、登录方式、启停、密码登录账号重置密码、ETag、审计 |
| 角色与权限 | `/roles`、`/permissions` | 角色 CRUD、权限矩阵、变更影响预览 |
| 流程权限组 | `/workflow-permission-groups` | CRUD、有效成员分页、变更影响预览 |
| 流程定义与版本 | `/process-definitions`、`/process-definitions/imports` | 新建/复制/原子导入、版本、分区设计器保存、校验、发布、取消发布、删除；正式契约另含定义 JSON 导出 |
| 发起配置 | `/me/launchable-process-definitions`、`/process-definitions/{id}/launch-config` | 数据范围裁剪、锁定发布版本、候选人员解析 |
| 流程实例 | `/process-instances` | 分页查询、创建、首审前修改、重新提交、关闭、复制新建 |
| 审批任务 | `/me/workflow-tasks`、`/workflow-tasks/{id}` | 我的待办/可代办、审批/确认/驳回、重复字段修改 |
| 自由协作 | `/process-instances/{id}/free-collaboration/*` | 回复、转交、编辑、异常改派、关闭、重新打开 |
| 附件 | `/attachments`、`/process-instances/{id}/fields/{fieldId}/attachment` | 当前 Mock 的 multipart、大小/类型校验、权限下载和旧单文件替换兼容路由；正式契约统一采用“先暂存、随业务命令引用”并支持 Range/507 |
| 邮件 Outbox | `/email-outbox` | 收件人解析、去重、发送结果、失败重试演示 |
| Excel 导出 | `/exports/process-instances/data` | 重新校验权限和查询条件，返回当前查询全部导出数据，由浏览器生成 `.xlsx` |
| 操作审计 | `/audit-events` | 分页筛选、详情、关键写操作留痕 |

完整路径、参数、DTO、响应码和示例以 OpenAPI 文件为准。

当前浏览器 Mock 为避免依赖公司域环境，所有演示账号继续使用本地演示密码；它不模拟 AD/LDAP 可用性，也不把演示密码当作正式用户登录方式。正式后端按用户的 `authenticationMode` 在域认证和 Argon2id 本地密码之间分流。超级管理员在 Mock 中切换演示身份时与正式模拟身份语义一致：不校验目标身份密码，直接返回切换后的会话状态。

## 5. 并发、权限和幂等

- GET 单资源返回 `ETag`；要求乐观锁的写接口读取 `If-Match`，缺失或过期分别返回 428/412。
- 创建、发布、审批、重试等命令使用 `Idempotency-Key`。同键同请求重放首次结果，同键不同请求返回 `IDEMPOTENCY_KEY_REUSED`。
- 审批任务采用首个成功提交生效；确认节点拒绝驳回；重复修改只更新节点授权字段，不改变原审核结果。
- Handler 从当前会话解析操作人，不接受请求体伪造操作人，并重新检查页面权限、动作权限和流程数据范围。
- 流程权限组用途统一为“发起、审批/受理、关闭”。流程版本分别保存发起组、自由流程受理组和关闭组标识；关闭命令按实例锁定版本的关闭组当前有效成员重新鉴权，不从发起或受理资格推导。
- 用户与角色删除分别要求 `org-user:删除`、`org-role:删除` 和最新 `If-Match`。Mock 在删除用户前检查角色、流程权限组、全部流程版本的可见人/通知收件人、实例、任务和附件，在删除角色前检查成员、流程权限组和全部流程版本引用；存在引用返回 `409 USER_REFERENCED` 或 `409 ROLE_REFERENCED`，内置项与当前账号始终拒绝删除。
- Mock 权限只用于交互演示和前端集成测试。代码、令牌与数据均在浏览器内，不能形成真实安全边界。

正式后端必须按 OpenAPI 的事务策略，在同一数据库事务内提交实例状态、任务、字段差异、时间线、审计和 Outbox；不能依赖前端按顺序调用多个接口维持一致性。

## 6. 延迟和故障场景

Debug 环境可通过 `PATCH /flowpilot/mock-api/v1/mock/settings` 设置全局场景，或用 `X-Mock-Scenario` 请求头、`?mockScenario=` 覆盖单次请求；正式 `/api/flowpilot/v1` 不提供这些 Mock 控制端点：

| 场景 | 作用 |
| --- | --- |
| `normal` | 确定性短延迟，正常响应 |
| `slow` | 放大读写延迟，用于检查 loading、重复点击和取消请求 |
| `offline` | 模拟网络层失败 |
| `server-error` | 返回 500 Problem Details |
| `conflict` | 写操作返回 409 并发冲突 |
| `mail-fail` | 邮件进入失败状态，可验证重试 |
| `upload-fail` | 上传失败，不覆盖原 PDF 引用 |

```ts
await flowPilotApi.system.updateMockSettings({
  scenario: "slow",
  readDelayMs: 500,
  writeDelayMs: 1200,
});
```

自动化测试应在每条用例前把场景重置为 `normal`。

## 7. 数据与副作用

- 当前流程、身份和运行实例暂时复用带 schema 迁移的原型仓库；已迁移页面不应再直接调用同一领域 action。
- 附件 Blob 与元数据写入 IndexedDB；PDF 替换在同一仓储事务中更新引用并清理旧文件。
- Mock 审计、幂等记录、邮件 Outbox 与场景设置在浏览器持久化；重置接口只清理 FlowPilot 自己的 key。
- 邮件只模拟 Outbox 状态，不连接 SMTP，也不会在浏览器关闭后后台发送。
- Excel 在浏览器中使用 ExcelJS 生成真正的 `.xlsx`；Mock 和正式后端都只返回已鉴权、已筛选的列定义与数据行，不生成或保存 Excel 文件。单次最多返回 10000 行，超过上限要求用户缩小查询范围。

## 8. 正式后端迁移清单

1. 以 OpenAPI 生成共享 TypeScript 类型、前端客户端和请求校验器，并对 NestJS 响应做契约测试。
2. 保持正式基础路径 `/api/flowpilot/v1`、错误码、分页、ETag 与幂等语义，逐域替换 Mock 兼容 DTO。
3. 将会话改为 HttpOnly/SameSite Cookie；移除 `mock:<userId>` Bearer 方案。
4. 将领域命令迁移到 NestJS、TypeORM 和 SQL Server：常规持久化使用领域仓储与 TypeORM，锁语义和复杂投影通过事务专属 `QueryRunner` 执行参数化 SQL，底层 MSSQL 驱动使用 `node-mssql`。
5. 将附件迁移到服务器文件目录，将邮件迁移到持久化 Outbox worker；Excel 继续由浏览器生成，后端只实现导出数据集查询和权限控制。
6. 逐页切换到生成客户端；登录只水合会话、权限和小型字典，用户、实例、任务、审计和 Outbox 改为服务端分页，流程完整版本按需加载。最后设置 `VITE_API_MODE=remote` 并删除浏览器业务数据双写和正式模式 Bearer 逻辑。
7. 对 OpenAPI、领域服务、Handler、组件集成和关键 E2E 分层测试。
