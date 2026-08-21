# AGENTS.md

本文件适用于整个仓库。除非子目录中存在更具体的 `AGENTS.md`，所有自动化编码代理都应遵循以下约定。

## 项目定位

- 这是公司内部流程审核平台的首版交互原型，不是已接入后端的生产系统。
- `REQUIREMENTS.md` 是需求的统一来源。实现业务变更前先查找对应章节；需求发生新增、调整或删除时，同步维护该文档及其变更记录。
- 原型的重点是业务流程完整、交互可演示、角色权限表现一致。不要把尚未确认的讨论项当作已确认需求。
- 未经明确要求，不要引入真实认证、数据库、文件存储或后端服务，也不要把原型数据访问包装成看似真实的生产 API。

## 技术栈与目录

- 包管理器：pnpm 11，工作区配置位于 `pnpm-workspace.yaml`。
- Web 应用：`apps/web`，使用 React 19、TypeScript、Vite、Ant Design 6、React Router 7 和 Zustand。
- `apps/web/src/pages`：路由级页面；页面专属样式通常与页面文件放在同一目录。
- `apps/web/src/components`：跨页面复用的 UI 组件。
- `apps/web/src/state`：原型状态、角色权限和流程定义状态。
- `apps/web/src/data`：共享类型、模拟数据和列表字段配置。
- `apps/web/src/utils`：无 UI 的通用逻辑。
- `apps/web/src/App.tsx`：路由、登录保护、角色入口限制和全局 Ant Design 主题。

## 常用命令

所有命令均从仓库根目录运行：

```bash
pnpm install
pnpm dev
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
- `pnpm test` 运行 Vitest 单元、领域集成和组件测试；`pnpm test:coverage` 执行核心领域覆盖率门禁，`pnpm test:coverage:all` 生成包含页面与浏览器适配代码的全源码报告。
- `pnpm test:e2e` 运行 Chromium 全量浏览器测试；`pnpm test:e2e:edge` 运行 Microsoft Edge 冒烟测试。仓库当前不配置 CI 或 lint 脚本，不要声称运行了不存在的检查。
- 日常修改至少运行 `pnpm typecheck` 和受影响测试；涉及路由、构建配置、依赖或交付前修改时运行 `pnpm test:all`。

## 实现约定

- 遵循现有 TypeScript 风格：严格类型、双引号、分号、函数组件和具名领域类型。不要用 `any`、`@ts-ignore` 或关闭类型检查来绕过错误。
- 优先使用现有 Ant Design 组件、全局主题 token 和既有页面样式，避免引入第二套 UI 组件库或孤立的视觉语言。
- 用户可见文本以简体中文为主。新增提示应明确说明操作结果或下一步，并沿用 `message`、`Modal`、`Result` 等现有反馈模式。
- 页面级导航应在 `App.tsx` 注册，并评估是否需要 `ProtectedRoute` 或 `PersonaGate`。不要只隐藏按钮而遗漏路由和动作级权限判断。
- 业务数据结构优先定义或复用 `src/data/types.ts` 中的类型；共享模拟数据放入 `src/data/mock.ts`，不要在多个页面复制不同版本的同一业务实体。
- 跨页面、可持久化的业务状态放入合适的 Zustand store；短暂的表单、弹窗和页面筛选状态保留在组件内。
- 更新 store 时保持不可变更新，并同时维护实例状态、当前节点、待办、通知和审计/时间线等相互关联的数据。
- 超级管理员、普通角色和流程权限组是不同层次的授权概念。修改权限逻辑时同时检查 `rolePermissions.ts`、相关 store、路由入口和页面动作。
- 流程定义的基本信息、表单设计、流程图、发布版本和运行实例有关联。改变其中一处时检查创建、复制、保存草稿、发布、版本回溯和发起页面是否仍使用同一份数据。

## 原型持久化

- 当前原型使用 Zustand `persist` 和 `window.localStorage` 保存演示状态；相关 key 分布在 state、设计器和列表配置代码中。
- 修改持久化数据形状时，应提供兼容旧数据的读取/迁移或有意识地升级存储 key，避免已有浏览器数据导致空白页或运行时异常。
- 重置演示数据必须一并清理受影响的存储 key 和编号序列。不要用清空整个 `localStorage` 的方式破坏同源下的无关数据。
- 依赖浏览器 API 的逻辑应考虑数据不存在、JSON 损坏和旧版本字段缺失的情况。

## 样式与交互

- 保持现有桌面端原型的信息密度和视觉体系。全局 token 在 `App.tsx`，全局壳层样式在 `src/styles.css`；局部样式放到对应页面的 CSS 文件。
- 复用已有类名和布局模式，避免大范围覆盖 Ant Design 内部选择器。确需覆盖时将选择器限制在页面根类下。
- 修改布局后检查仓库现有关键断点以及 `1180px` 最小宽度约束；新增响应式行为时不要破坏设计器、表格和侧栏的可操作性。
- 表单必须保留必填校验、失败提示、成功反馈及按钮禁用/加载状态。危险操作应使用确认对话框，并清楚说明影响范围。

## 工作流程

1. 阅读 `REQUIREMENTS.md` 的相关章节及待修改文件的相邻实现。
2. 检查 `git status`，保留用户已有改动；不要顺手重构无关代码或覆盖未提交内容。
3. 以最小完整改动实现需求，并同步更新共享类型、模拟数据、权限判断和文档中实际受影响的部分。
4. 运行 `pnpm typecheck` 和受影响的 Vitest；按修改风险运行覆盖率、构建及浏览器测试，交付前运行 `pnpm test:all`。
5. 对受影响流程做浏览器验证，至少覆盖正常路径、校验失败路径和一个无权限/不同身份路径；新增稳定业务链路时同步补自动化用例。

## 完成标准

- 实现与 `REQUIREMENTS.md` 中的已确认需求一致。
- TypeScript 检查和受影响自动化测试通过；交付前的覆盖率、双构建与浏览器门禁通过。
- 无明显控制台错误，刷新后持久化状态仍可读取。
- 关键操作具有中文反馈，权限边界和异常状态可解释。
- 提交内容聚焦本次任务，不包含生成产物、`node_modules` 或无关格式化改动。
