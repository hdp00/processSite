# AGENTS.md

本文件适用于整个仓库。除非子目录中存在更具体的 `AGENTS.md`，所有自动化编码代理都应遵循以下约定。

## 项目定位

- 这是公司内部流程审核平台。`apps/api/FlowPilot.slnx` 提供 .NET 10 正式后端；前端、附件、权限和会话均以后端及 SQL Server 为唯一事实来源，不提供浏览器 Mock 数据模式。
- `REQUIREMENTS.md` 是需求的统一来源。实现业务变更前先查找对应章节；需求发生新增、调整或删除时，同步维护该文档及其变更记录。
- `document/flowpilot-rest-api.openapi.yaml` 是前后端 REST 契约来源；`document/BACKEND_IMPLEMENTATION_DESIGN.md` 和 `document/IIS_DEPLOYMENT.md` 分别说明后端落地设计和 IIS 部署。修改 API 行为、契约或部署方式时，检查并同步对应文档。

## 技术栈与目录

- 包管理器：pnpm 11，工作区配置位于 `pnpm-workspace.yaml`。
- 后端：`apps/api/FlowPilot.slnx`，使用 .NET 10、ASP.NET Core 10 Controller Web API 和分层 C# 项目；NuGet 依赖不由 pnpm 管理。
- Web 应用：`apps/web`，使用 React 19、TypeScript、Vite、Ant Design 6、React Router 7、Zustand、Playwright 和 Vitest。
- `apps/web/src/api`：REST 客户端、前端契约类型、远端 DTO 适配器、缓存和远端数据水合。页面应经由 `flowPilotApi` 访问服务，不要自行发起 `fetch` 或绕过响应规范化。
- `apps/web/src/pages`：路由级页面；页面专属样式通常与页面文件放在同一目录。
- `apps/web/src/components`：跨页面复用的 UI 组件。
- `apps/web/src/hooks`：可复用交互逻辑；`apps/web/e2e`：Playwright 端到端、可访问性和视觉回归测试，截图基线位于相邻 `visual.spec.ts-snapshots` 目录。
- `apps/web/src/state`：当前会话和后端实体的内存缓存；刷新后由后端重新水合，不作为持久化事实来源。
- `apps/web/src/data`：共享类型和列表字段配置。
- `apps/web/src/utils`：无 UI 的通用逻辑。
- `apps/web/src/App.tsx`：路由、登录保护、角色入口限制和全局 Ant Design 主题；`apps/web/src/main.tsx`：API 模式初始化；`apps/web/src/styles.css`：全局壳层样式。

## 运行、API 模式与部署

- Vite 应用基路径固定为 `/flowpilot/`。本地入口为 `http://127.0.0.1:5173/flowpilot/`；不要假定应用部署在站点根路径。
- 应用访问 `VITE_API_BASE_URL`（默认 `/api/flowpilot/v1`），启动时读取当前会话并从后端水合必要数据。开发代理目标由 `VITE_API_PROXY_TARGET` 配置。
- 正式认证只使用同源 `flowpilot_session` HttpOnly Cookie，前端不得保存或发送访问令牌，不得在浏览器存储中持久化业务数据。
- IIS 部署使用 `apps/web/public/web.config`，并以 `/flowpilot` 作为应用路径。修改 Vite 基路径、客户端路由回退或 API 代理假设时，一并检查该文件和 `document/IIS_DEPLOYMENT.md`。

## 常用命令

所有命令均从仓库根目录运行：

```bash
pnpm install
pnpm dev
pnpm restore:api
pnpm dev:api
pnpm build:api
pnpm test:api
pnpm publish:api
pnpm backend:check
pnpm test
pnpm test:coverage
pnpm test:coverage:all
pnpm test:e2e
pnpm test:e2e:edge
pnpm test:all
pnpm typecheck
pnpm build
```

- 开发服务器默认监听 `http://127.0.0.1:5173`。
- `pnpm dev:api` 运行 ASP.NET Core API；`pnpm build:api` 执行 Release 构建，`pnpm test:api` 运行 .NET 解决方案测试，`pnpm publish:api` 生成本地发布暂存产物。
- `pnpm test` 先构建 OpenAPI 合同包，再运行 .NET 测试与前端 Vitest；`pnpm test:coverage` 执行前端核心领域覆盖率门禁，`pnpm test:coverage:all` 生成前端全源码覆盖率报告。
- `pnpm test:e2e` 运行 Chromium 全量端到端测试；`pnpm test:e2e:edge` 运行 Microsoft Edge 的 `@smoke` 用例。根目录 `pnpm test:all` 先执行完整后端门禁，再运行前端门禁和真实后端浏览器测试。
- E2E 默认启动本地 API 和 Vite；也可设置 `FLOWPILOT_TEST_BASE_URL` 测试已部署服务。凭据来自 `FLOWPILOT_E2E_USERNAME`、`FLOWPILOT_E2E_PASSWORD`，未设置密码时读取本地后端开发配置中的超级管理员初始密码。
- 前端日常修改运行 `pnpm typecheck` 和受影响测试；后端修改运行受影响项目的构建，并按测试项目、测试类或名称过滤器运行相关测试。代码修改后默认不运行 `pnpm test:all`、完整 `pnpm test:api` 或其他全量测试；只有用户明确要求，或当前任务本身就是发布、全量门禁验证时才运行。仓库未配置 lint 脚本，不要声称运行了 lint 或不存在的检查。

## 缺陷修复与测试范围

- 修改代码后只运行与改动直接相关的最小测试集，不因交付、路由、构建配置、依赖或 API 契约变更而默认扩大为全量测试。根据改动范围选择受影响的 Vitest、按过滤器限定的 .NET 测试、契约/边界测试或具体 E2E 用例。
- 修复缺陷时必须判断根因是否具有普遍性，并搜索相同实现模式、同类组件、服务和接口。若可能存在同类问题，应检查其他相关位置，并在本次任务范围内一并处理确认存在的问题。
- 必须评估缺陷是否可能再次发生。若存在复发可能，应新增能够稳定复现根因并防止回归的自动化测试；若已有等价测试覆盖，可补强现有测试而不重复新增。

## 实现约定

- 遵循现有 TypeScript 风格：严格类型、双引号、分号、函数组件和具名领域类型。不要用 `any`、`@ts-ignore` 或关闭类型检查来绕过错误。
- 新增或调整 REST 调用时，先更新 `src/api/contracts.ts`、`src/api/flowPilotApi.ts`、`src/api/remoteAdapters.ts` 与 OpenAPI 契约中实际受影响的部分；随后同步后端实现和契约/边界测试。服务端返回的非可信 JSON 必须经适配器校验和规范化后进入页面或 store。
- API 失败必须使用现有 `ApiError` 和页面反馈模式处理；不得把后端响应直接断言为领域类型，也不得绕过统一客户端自行维护业务数据。
- 优先使用现有 Ant Design 组件、全局主题 token 和既有页面样式，避免引入第二套 UI 组件库或孤立的视觉语言。
- 用户可见文本以简体中文为主。新增提示应明确说明操作结果或下一步，并沿用 `message`、`Modal`、`Result` 等现有反馈模式。
- 页面级导航应在 `App.tsx` 注册，并评估是否需要 `ProtectedRoute` 或 `PersonaGate`。不要只隐藏按钮而遗漏路由和动作级权限判断。
- 业务数据结构优先定义或复用 `src/data/types.ts`、`src/api/contracts.ts` 中的类型，避免在页面中复制不同版本的业务实体。
- 跨页面数据可放入 Zustand 内存缓存，但业务持久化必须由后端完成；短暂的表单、弹窗和页面筛选状态保留在组件内。
- 更新 store 时保持不可变更新，并同时维护实例状态、当前节点、待办、通知和审计/时间线等相互关联的数据。
- 超级管理员、普通角色和流程权限组是不同层次的授权概念。修改权限逻辑时同时检查 `rolePermissions.ts`、相关 store、路由入口和页面动作。
- 流程定义的基本信息、表单设计、流程图、发布版本和运行实例有关联。改变其中一处时检查创建、复制、保存草稿、发布、版本回溯和发起页面是否仍使用同一份数据。

## 数据持久化

- 浏览器不持久化业务数据、访问令牌、附件或设计器草稿。页面刷新后从后端重新读取。
- Zustand 仅作为当前页面生命周期内的查询缓存，不承担事务、权限或数据一致性职责。

## 样式与交互

- 保持现有桌面端原型的信息密度和视觉体系。全局 token 在 `App.tsx`，全局壳层样式在 `src/styles.css`；局部样式放到对应页面的 CSS 文件。
- 复用已有类名和布局模式，避免大范围覆盖 Ant Design 内部选择器。确需覆盖时将选择器限制在页面根类下。
- 修改布局后检查仓库现有关键断点以及 `1180px` 最小宽度约束；新增响应式行为时不要破坏设计器、表格和侧栏的可操作性。
- 表单必须保留必填校验、失败提示、成功反馈及按钮禁用/加载状态。危险操作应使用确认对话框，并清楚说明影响范围。
- 可访问性和视觉相关改动应同步更新相应 E2E 用例或经人工确认后更新截图基线。

## 工作流程

1. 阅读 `REQUIREMENTS.md` 的相关章节、对应 API/部署文档及待修改文件的相邻实现。
2. 检查 `git status`，保留用户已有改动；不要顺手重构无关代码或覆盖未提交内容。
3. 以最小完整改动实现需求，并同步更新共享类型、API 契约、后端实现、前端缓存、权限判断和文档中实际受影响的部分。
4. 修复缺陷时先完成同类问题排查和复发风险评估；存在同类问题时检查相关实现，存在复发可能时新增或补强回归测试。
5. 只运行与本次改动直接相关的检查和最小测试集；按风险选择受影响的类型检查、构建、Vitest、.NET 过滤测试、API 边界测试或具体 E2E 用例，不默认运行全量测试。
6. 对受影响流程做浏览器验证，至少覆盖正常路径、校验失败路径和一个无权限/不同身份路径；涉及 remote 模式时验证 API 初始化失败与会话失效的回退行为，新增稳定业务链路时同步补自动化用例。

## 完成标准

- 实现与 `REQUIREMENTS.md` 中的已确认需求及 REST 契约一致。
- 与改动相关的类型检查、构建、自动化测试和必要浏览器验证通过；未运行与本次改动无关的全量测试，不得声称通过未实际执行的门禁。
- 无明显控制台错误，刷新后能够从后端恢复会话和页面数据，后端不可用或会话失效时反馈明确。
- 关键操作具有中文反馈，权限边界和异常状态可解释。
- 提交内容聚焦本次任务，不包含生成产物、`node_modules` 或无关格式化改动。
