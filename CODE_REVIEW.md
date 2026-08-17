# FlowPilot 原型代码审核报告

> 审核日期：2026-08-14  
> 审核范围：`apps/web` 前端原型、Zustand 状态、流程定义与版本、表单/流程设计器、发起与实例、权限治理页面  
> 需求基线：`REQUIREMENTS.md` 0.83  
> 审核方式：静态代码审阅、`pnpm typecheck`、`pnpm build`；未修改现有业务代码，未进行浏览器交互测试

> 整改复核：2026-08-17 已完成 CR-001～CR-012；原始问题与证据保留在下文，作为整改前基线。整改后再次通过 `pnpm --filter @process-site/web typecheck` 和 `pnpm --filter @process-site/web build`。CR-013～CR-016 不属于本轮范围，仍作为后续工程化事项保留。

## 0. CR-001～CR-012 整改结果

| 编号 | 状态 | 主要落点 |
| --- | --- | --- |
| CR-001 | 已修复 | 登录统一调用共享用户仓库，校验账号、密码和启停状态，不再对未知账号回退演示身份。 |
| CR-002 | 已修复 | 新增统一实例创建命令；提交会锁定版本、生成编号、保存表单/附件、创建任务、更新实例计数和通知；发起草稿实际持久化。 |
| CR-003 | 已修复 | 员工运行页只读取生效版本或实例锁定版本的完整快照；设计器工作缓存不再作为发布和运行事实来源。 |
| CR-004 | 已修复 | 新增实例数据范围服务，流程清单、详情和打印统一复用；附件入口与详情保持同一授权边界。 |
| CR-005 | 已修复 | 实例与任务保存稳定的定义 ID、版本 ID、节点 ID、权限组 ID和用户 ID；复制新建不再按名称猜测流程。 |
| CR-006 | 已修复 | 流程草稿和每个发布版本内嵌完整表单、系统列、拓扑与规则快照，并提供旧本地数据迁移。 |
| CR-007 | 已修复 | 拓扑解释器按入边激活节点，同源多出边并行、多入边 AND 汇聚；驳回规则和重新发布均读取实例锁定版本。 |
| CR-008 | 已修复 | 用户、角色和流程权限组合并为共享身份主数据；治理页、基本信息、设计器和运行时使用同一组稳定标识。 |
| CR-009 | 已修复 | 多角色权限并集统一控制菜单、路由和流程领域命令；发起/审核/关闭继续叠加流程权限组资格。 |
| CR-010 | 已修复 | 用户管理改用持久化共享用户仓库，新增、角色、启停和重置密码即时影响登录及流程权限组有效成员。 |
| CR-011 | 已修复 | 任务中心和流程清单从当前生效版本生成系统列、业务列及高级查询；历史实例缺少当前字段时显示空值。 |
| CR-012 | 已修复 | 表单设计器工作区使用 `definitionId + draftId` 作为组件 key，切换流程时完整重建本地状态。 |

## 1. 结论摘要

当前代码已经具备较完整的页面原型和交互外观，TypeScript 类型检查及生产构建均通过，但核心业务仍是多个相互独立的演示页面，并未形成一条可执行、可授权、可追溯的流程链路。

最需要优先处理的不是页面样式，而是以下四个阻断项：

1. 登录没有校验密码，未知账号也能登录。
2. 发起页提交后没有创建流程实例或待办，只显示成功提示。
3. 已发布流程的运行页面会读取正在编辑的工作草稿，未发布内容可能直接影响员工侧。
4. 流程清单、详情和打印缺少数据范围鉴权，任意已登录用户可通过地址访问实例。

因此，当前版本适合继续用于界面评审，不适合被视为业务逻辑原型，更不能直接演进为可在公司内网承载真实数据的版本。建议先建立统一领域模型和运行时数据链路，再继续扩展页面。

### 风险统计

| 级别 | 数量 | 含义 |
| --- | ---: | --- |
| P0 | 4 | 主链路或安全阻断，进入后端开发前必须解决 |
| P1 | 8 | 会造成版本、权限或跨页面数据不一致 |
| P2 | 4 | 工程质量、性能或维护性风险 |

## 2. 检查结果

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | `tsc -b --pretty false` 无报错 |
| `pnpm build` | 通过并有警告 | 主 JS 2,441.39 kB，gzip 754.73 kB；超过 500 kB 分块阈值 |
| 自动化测试 | 缺失 | 根目录与 Web 包均无 `test` 脚本，`src` 下未发现 `*.test.*` / `*.spec.*` |
| Lint | 缺失 | 根目录与 Web 包均无 `lint` 脚本 |
| 工作区状态 | 审核前干净 | 审核开始时 `git status --short` 无输出；本次仅新增本报告 |

## 3. P0 问题

### CR-001 登录可被任意账号和任意非空密码绕过

**证据**

- `apps/web/src/pages/LoginPage.tsx:20-28` 只维护少量演示账号到身份的映射。
- `apps/web/src/pages/LoginPage.tsx:37-46` 没有比较密码；除用户名等于 `disabled` 外，任何输入都会执行登录。
- `apps/web/src/pages/LoginPage.tsx:45` 对未知账号使用 `demoPersona` 兜底，因此输入不存在的用户名也能获得当前演示身份。
- 用户管理页面创建/停用的账号没有被登录页读取。

**影响**

任何知道内网页面地址的人都可以用任意用户名和任意一个字符的密码登录，并可能通过演示身份获得管理员权限。“允许单字符密码”被错误实现成了“不验证密码”。

**建议**

原型阶段至少建立共享的本地用户仓库，校验账号存在、账号启用状态和密码；进入真实开发后由后端完成密码哈希校验、会话签发和每次请求鉴权。演示身份切换应只在明确的原型模式下启用，不能与正式登录逻辑共用兜底。

### CR-002 发起流程的“提交成功”没有创建实例和待办

**证据**

- `apps/web/src/pages/ConfiguredProcessStartPage.tsx:257-267` 只通过 `setTimeout` 生成编号、提示成功并跳转任务中心，没有调用任何实例创建 action。
- `apps/web/src/pages/ProcessStartPage.tsx:385-393` 内置 PDF/测试报告流程同样只提示“三个审核节点的待办已同时生成”。
- 两个页面只从 `usePrototypeStore` 读取 `instances` 用于编号，没有写入实例集合：`ConfiguredProcessStartPage.tsx:194`、`ProcessStartPage.tsx:199`。
- `ConfiguredProcessStartPage.tsx:288` 和 `ProcessStartPage.tsx:364-366` 的“保存草稿”也只显示消息，没有保存表单值。

**影响**

用户提交后，任务中心、流程清单和实例监控均不会出现新数据；自由流程的动态发起页也不会调用现有的 `createFreeFlow`。这是当前最主要的端到端断点。

**建议**

建立统一的 `createProcessInstance` 命令：在一次原子操作中锁定流程定义与生效版本、生成实例编号、保存表单值和附件元数据、展开审批节点/待办、记录时间线并发送通知。保存发起草稿也应有独立数据结构，不能用 toast 代替。

### CR-003 运行时读取工作草稿，未发布配置可能泄漏到已发布流程

**证据**

- 员工发起页虽然接收了生效 `version`，却在 `apps/web/src/pages/ConfiguredProcessStartPage.tsx:195-200` 按 `definition.id` 读取工作区的表单和流程图。
- `readFormDesignerSnapshot` / `readFlowDesignerSnapshot` 对应的工作区 key 只按流程定义区分，不按版本区分；版本归档另存于 `apps/web/src/utils/designerStorage.ts:19-30`。
- 表单设计器在编辑下一版本草稿时持续覆盖工作区：`apps/web/src/pages/FormDesignerPage.tsx:694-705`。
- 流程设计器同样自动覆盖工作区：`apps/web/src/pages/FlowDesignerPage.tsx:618-625`。
- 流程清单系统列配置也读取工作区而不是生效版本：`apps/web/src/pages/ProcessListPage.tsx:63-65`；任务中心存在同样行为：`TaskCenterPage.tsx:108-113`。

**影响**

一个流程拥有 V1 生效版本并正在编辑 V2 草稿时，员工侧可能直接看到 V2 的字段、审批节点或列表列，即使 V2 尚未发布。历史版本切换和草稿放弃也可能让员工侧短暂读取错误内容。

**建议**

运行时只能通过 `effectiveVersionId` 读取不可变的完整版本快照；设计器只能读写 `draftId` 对应的草稿快照。禁止使用同一个“working key”同时充当发布版本和草稿的事实来源。

### CR-004 流程实例缺少数据范围鉴权

**证据**

- `/processes`、`/processes/:id` 仅受登录保护，没有页面权限或流程数据范围 Gate：`apps/web/src/App.tsx:92-104`。
- 打印路由也只校验是否登录：`apps/web/src/App.tsx:91`。
- 流程清单直接从全量 `instances` 中按流程名称筛选，没有按当前用户可见范围过滤：`apps/web/src/pages/ProcessListPage.tsx:54`、`:76-84`。
- 详情路由直接按 URL 中的实例 ID 查找并展示：`apps/web/src/App.tsx:80-85`。
- `ProcessDetailPage` 只控制操作按钮，不在读取实例前校验查看资格：`apps/web/src/pages/ProcessDetailPage.tsx:56-69`。

**影响**

任意已登录用户可通过流程清单或猜测/复制 URL 查看不属于自己的实例、表单和附件信息，并可访问打印页。前端隐藏菜单无法形成安全边界。

**建议**

建立统一 `canViewInstance(userId, instanceId)` 规则，同时检查页面权限和流程数据范围；列表、详情、附件预览/下载、打印都必须复用。后端实现时在接口和文件下载层再次校验，不能只依赖 React 路由。

## 4. P1 问题

### CR-005 流程实例没有稳定的流程定义 ID 和版本 ID

**证据**

- `apps/web/src/data/types.ts:33-60` 的 `ProcessInstance` 只有 `template` 和 `templateVersion` 文本，没有 `definitionId`、`versionId`。
- 流程清单用 `item.template === definition.template` 关联实例：`apps/web/src/pages/ProcessListPage.tsx:76-84`。
- 任务中心也用流程名称分组和过滤：`apps/web/src/pages/TaskCenterPage.tsx:83-100`、`:115-120`。
- 复制已完成流程时通过标题是否包含“测试报告”猜测定义 ID，否则一律当作 PDF 流程：`apps/web/src/state/usePrototypeStore.ts:227-245`。

**影响**

流程改名、历史版本切换或多个流程同名时，实例可能从菜单中消失、被归入错误流程，复制新建也会使用错误的前缀和定义。实例无法满足“永久锁定发起时版本”的要求。

**建议**

实例必须保存不可变的 `definitionId`、`versionId` 和必要的版本显示快照；名称只用于展示。任务、时间线、附件、通知和编号记录也应引用稳定 ID。

### CR-006 完整版本快照被拆成 localStorage 旁路，操作不具备原子性

**证据**

- `ProcessVersion` 只保存基本信息和字段/节点数量，没有表单、拓扑、列表配置等完整数据：`apps/web/src/state/useProcessDefinitionStore.ts:45-61`。
- 发布记录由 `version()` 生成，也只写入计数和 basic：`useProcessDefinitionStore.ts:125-150`。
- 表单/流程图/列表列被另外序列化到 localStorage：`apps/web/src/utils/designerStorage.ts:7-30`。
- 草稿创建、版本切换、草稿删除等先修改 Zustand 状态，再调用 `restoreDesignerVersionSnapshot`，且忽略其布尔返回值，例如 `useProcessDefinitionStore.ts:296-334`、`:532-575`。
- `restoreDesignerVersionSnapshot` 在快照缺失或解析失败时只返回 `false`：`designerStorage.ts:33-48`，调用方仍报告操作成功。
- 持久化迁移 `useProcessDefinitionStore.ts:607-680` 只规范化版本元数据，没有为已有版本补齐完整快照；内置初始版本也没有对应归档数据。

**影响**

可能出现“版本记录已经切换/删除，但设计数据仍是另一个版本”的半成功状态。清空浏览器存储、跨设备打开、旧数据升级或 localStorage 写入失败后，历史版本无法独立恢复，违反完整快照和原子操作要求。

**建议**

将完整版本快照作为 `ProcessVersion` 的组成部分持久化；草稿也保存完整结构。发布、撤回、切换生效、删除版本和恢复草稿应由单一事务完成。原型阶段也应至少在一个 Zustand 持久化对象中原子替换，而不是跨多个 localStorage key 协调。

### CR-007 可视化流程定义没有真正驱动运行时

**证据**

- 内置发起页固定显示“研发 / 质量 / 生产”三个节点：`apps/web/src/pages/ProcessStartPage.tsx:391`、`:438-445`。
- 审核 store 依赖固定的 `reviewerKey`，按 `rd/qa/production` 更新 `reviewers` 数组：`apps/web/src/state/usePrototypeStore.ts:124-160`。
- 动态发起页能读取设计器节点，但只把节点数量放进成功提示，没有展开节点或待办：`ConfiguredProcessStartPage.tsx:198-200`、`:257-266`。
- 驳回重新发布也固定写回“研发 / 质量 / 生产并行审核”：`usePrototypeStore.ts:205-223`。

**影响**

设计器中增加、删除、串行或并行连接审批节点，不会改变实际审批行为。页面展示的“可配置流程”与运行时状态机是两套逻辑。

**建议**

实现从版本快照拓扑到运行节点/任务的解释器：根据入边满足情况激活节点，同一前置节点多出边形成并行，任一驳回按版本规则结束当前轮，全部必需分支通过后继续。运行时不得再硬编码部门节点。

### CR-008 流程权限组治理页与流程设计器不是同一数据源

**证据**

- 流程权限组页面使用页面内 `useState(initialGroups)`：`apps/web/src/pages/GovernancePages.tsx:887-908`。
- 新增、编辑、启停只更新该组件局部状态：`GovernancePages.tsx:931-940`，离开页面后恢复初始数据。
- 基本信息和流程设计器读取另一份静态数组：`apps/web/src/data/workflowPermissionGroups.ts:1-20`、`ProcessBasicConfigPage.tsx:240-269`、`FlowDesignerPage.tsx:987-1005`。
- 治理页中部分组名与静态数组中的组名也不一致，例如“PDF审核_研发_审核组”和“PDF审核_研发_流程权限组”。

**影响**

管理员新建或修改的权限组不会出现在流程设计器中，成员变化也不会影响运行中的待办；设计器可以选择治理页不存在的静态组。界面提示的“成员资格已立即更新”与实际行为不符。

**建议**

建立共享的用户、角色、流程权限组 store，统一使用稳定组 ID。设计器按“启用状态 + 允许用途”查询同一数据源；运行时每次发起、查看、审核、关闭和改派时动态计算有效成员。

### CR-009 角色权限配置没有真正控制大多数页面和动作

**证据**

- 管理路由只允许硬编码的 `admin` 或 `superadmin`，没有读取权限管理配置：`apps/web/src/App.tsx:46-75`。
- 所有管理页面共用同一个 `scope="admin"`，无法区分用户、角色、权限、流程管理、发布、删除等权限：`App.tsx:106-118`。
- `rolePermissions.ts:18-41` 把身份、角色和可发起流程写死在代码中；新用户、多角色和新流程不会进入这些映射。
- `canPersonaAccessLaunch` 还要求硬编码流程列表非空：`rolePermissions.ts:62-71`，仅在权限页面勾选“流程发起”并不能让新角色/用户发起。
- 自定义流程只检查用户具有通用发起权限且流程配置了任意发起组，没有检查用户是否为该组成员：`ProcessLaunchCenterPage.tsx:80-88`；路由 Gate 也存在同样的 OR 条件：`App.tsx:54-65`。
- 流程定义 store 的发布、删除、启停等 action 不接收操作者，也不校验权限：`useProcessDefinitionStore.ts:85-101`、`:404-448`、`:532-589`。

**影响**

权限管理页面保存的结果与实际路由授权不一致；普通身份无法通过配置获得管理权限，管理员又天然拥有所有管理能力。自定义流程发起可能被错误放行，业务 action 也可绕过页面按钮直接调用。

**建议**

用统一权限服务计算“多角色权限并集”，页面、菜单和 action 使用相同权限 key。业务能力还需叠加流程权限组资格。任何改变数据的 action 都应接收当前用户并在领域层重新校验。

### CR-010 用户管理数据会在离开页面后丢失，也未接入登录和权限组

**证据**

- 用户列表每次挂载都由 `makeUsers()` 重新生成 238 条模拟数据：`apps/web/src/pages/GovernancePages.tsx:156-176`、`:229-230`。
- 新增和编辑只调用局部 `setUsers`：`GovernancePages.tsx:327-335`，没有持久化。
- 登录页使用独立的 `usernameMap`：`apps/web/src/pages/LoginPage.tsx:20-28`。
- 流程权限组人员候选来自固定 `peopleNames`：`GovernancePages.tsx:123-128`、`:954`，不是用户管理结果。

**影响**

新增用户离开页面即消失，不能登录、不能被权限组选择，也不会参与角色有效成员计算；停用用户不会立即失去流程资格。

**建议**

用户、部门、职务、角色、权限组必须使用共享主数据仓库并持久化。原型可继续使用 localStorage，但需要统一 schema 和迁移，不能由各页面各自维护模拟数组。

### CR-011 动态列表字段只对内置静态流程有效

**证据**

- 任务中心的 `selectedDefinition` 只从静态 `processDefinitions` 查找：`apps/web/src/pages/TaskCenterPage.tsx:100-110`。
- 动态列和“流程信息”也只读取静态定义的 `taskFields`：`TaskCenterPage.tsx:130-160`。
- 流程清单对审批流程固定追加“文件编号、文件类型”，没有按表单设计器的 `listVisible` 字段生成列：`apps/web/src/pages/ProcessListPage.tsx:103-112`。
- 流程清单的高级查询表单是固定字段，而非当前生效版本的 `queryable` 字段。

**影响**

新建流程即使在表单设计器配置了任务中心/流程清单字段，发布后也不会按配置显示；不同版本切换后的列表口径无法生效。

**建议**

由当前生效版本快照输出列表 schema：系统字段、业务字段、查询字段和显示顺序统一生成列。旧实例缺少当前字段时显示空值，选项标签则从实例版本快照解析。

### CR-012 表单设计器在同一路由参数切换时可能把 A 流程数据写入 B 流程

**证据**

- `FormDesignerPage` 根据 `definitionId` 重新计算 `initialDraft`：`apps/web/src/pages/FormDesignerPage.tsx:662-675`。
- 但 `formName`、`fields`、`selectedId`、`systemListFields` 只在首次挂载时由 `useState` 初始化：`FormDesignerPage.tsx:676-685`，没有在 `definitionId` 变化时重置。
- 自动保存 effect 会使用新的 `draftKey` 写入仍保留在 state 中的旧字段：`FormDesignerPage.tsx:694-705`。
- 流程设计器已经通过 `key={`${definitionId}-${definition.draft?.id}`}` 强制重建工作区：`FlowDesignerPage.tsx:1237-1245`，表单设计器没有对应保护。

**影响**

如果用户在不卸载该路由组件的情况下从流程 A 切换到流程 B，A 的表单可能自动覆盖 B 的存储空间。

**建议**

把工作区拆成带 `key={definitionId + draftId}` 的子组件，或在参数变化时完整重新加载所有本地 state，并在切换前处理未保存状态。

## 5. P2 问题

### CR-013 localStorage 写入和富媒体体积缺少失败处理

**证据**

- 表单设计器自动保存和手工保存直接调用 `localStorage.setItem`，没有捕获配额或序列化异常：`apps/web/src/pages/FormDesignerPage.tsx:694-701`、`:772-778`。
- 流程设计器同样直接写入：`apps/web/src/pages/FlowDesignerPage.tsx:618-625`、`:748-770`。
- 版本快照保存也没有异常处理：`apps/web/src/utils/designerStorage.ts:22-30`。
- 自由流程支持图片和视频，若以 base64/富文本形式进入本地存储，很容易超过浏览器配额。

**影响**

保存失败时页面可能仍显示成功或直接抛异常，导致草稿、版本快照或富文本内容丢失。

**建议**

所有持久化 action 返回明确结果并在 UI 显示失败；附件和富媒体只保存服务端文件 ID/URL，不把二进制数据放入 localStorage 或业务 JSON。

### CR-014 缺少针对流程状态机、版本和权限的自动化测试

**证据**

- `package.json:6-10` 和 `apps/web/package.json:6-10` 只有 dev/build/typecheck，没有 test/lint。
- `apps/web/src` 下未发现测试文件。

**影响**

发布/撤回/删除/切换版本、并行驳回、权限组即时生效、编号共享序列等高风险规则只能靠人工验证。当前多处“类型检查通过但主链路失效”的问题正是这一缺口的表现。

**建议**

优先为纯领域函数建立单元测试，再补关键端到端场景。至少覆盖：版本状态转换、完整快照隔离、实例锁定版本、并行分支、权限组成员变化、指定人员与可代办、编号并发和数据范围。

### CR-015 单包体积过大，首屏没有代码分割

**证据**

- `pnpm build` 产出单个主 JS：2,441.39 kB，gzip 754.73 kB，并触发 Vite 500 kB 大分块警告。
- 所有页面在 `apps/web/src/App.tsx:1-31` 同步导入，包括 Tiptap、React Flow、设计器和治理页面。

**影响**

员工只访问任务中心，也需要下载管理端设计器和富文本相关代码；公司内网弱终端或缓存失效时首屏会变慢。

**建议**

按员工区、流程设计器、治理运维区做路由级 `lazy` 分包，并把 Tiptap、React Flow、打印页拆成独立 chunk。

### CR-016 文件职责过大且存在规避类型检查的注释

**证据**

- `FormDesignerPage.tsx`、`FlowDesignerPage.tsx`、`GovernancePages.tsx` 均超过千行，同时包含类型、数据、业务规则和 UI。
- `apps/web/src/pages/FlowDesignerPage.tsx:77` 使用 `@ts-ignore` 处理 CSS 导入，与项目约定不符。
- 多处 ID 使用 `Date.now()` 或 `Date.now() + Math.random()`，例如 `useProcessDefinitionStore.ts:267-283`、`ConfiguredProcessStartPage.tsx:57-59`。

**影响**

跨页面规则容易重复和漂移；局部修改难以测试。只用毫秒时间生成流程定义 ID，在快速连续操作或多端环境中存在冲突风险。

**建议**

按领域拆分 `definitions / versions / instances / permissions / numbering`，页面只组合视图；移除 `@ts-ignore` 并补正确的模块声明；内部 ID 使用后端生成的 UUID/ULID 或数据库键。

## 6. 建议的修复顺序

### 第一阶段：建立可执行主链路

1. 定义稳定实体：用户、角色、流程权限组、流程定义、完整版本快照、实例、运行节点、任务、表单值、附件、时间线、通知。
2. 实例强制保存 `definitionId` 与 `versionId`。
3. 发起命令真正创建实例和任务，任务中心、清单、详情读取同一数据源。
4. 运行时只读取生效/实例锁定版本快照，彻底隔离工作草稿。

### 第二阶段：统一权限与治理数据

1. 用户、角色、权限组改为共享仓库。
2. 建立“页面权限 + 流程数据范围 + 节点操作资格”的统一鉴权服务。
3. 菜单、路由、按钮、store action 和未来后端接口复用同一规则。
4. 登录使用真实用户数据；演示身份仅保留在原型开关下。

### 第三阶段：落实版本事务和动态配置

1. 完整快照进入版本实体，不再依赖旁路 localStorage key。
2. 发布、撤回、切换、删除和草稿恢复实现原子状态转换。
3. 表单字段、系统列、任务列、高级查询全部由当前生效版本 schema 生成。
4. 流程拓扑解释器驱动运行节点，而不是硬编码三部门审核。

### 第四阶段：工程化保障

1. 为状态机、权限、编号和版本快照补单元测试。
2. 为发起—审核—驳回—重新发布—完成/关闭补端到端测试。
3. 增加 lint、移除 `@ts-ignore`、拆分超大页面。
4. 做路由级代码分割和构建体积预算。

## 7. 建议优先验收的回归场景

1. V1 已发布并编辑 V2 草稿时，员工发起页仍严格显示 V1 表单和拓扑。
2. 提交新流程后，任务中心、流程清单、实例监控、通知数字同时出现一致数据。
3. 流程改名后，V1/V2 历史实例仍归属同一菜单；复制新建使用正确目标定义和当前生效前缀。
4. 新建流程权限组后立即可在设计器选择；移除成员后，其运行中待办立即消失且提交被拒。
5. 只读用户无法通过直接 URL 查看无权实例、附件或打印内容。
6. 基于 V1 创建 V4、删除无实例的 V2/V3 后，V4 仍拥有完整独立配置。
7. 发布/删除/切换版本过程中模拟存储失败，不产生“元数据已成功、快照仍旧”的半状态。
8. 新增用户、多角色授权、停用账号后，登录、菜单、流程发起和审核资格同步变化。
