# FlowPilot 全面代码审查报告

> 审查日期：2026-08-20  
> 审查范围：`apps/web`、`document/flowpilot-rest-api.openapi.yaml`、根目录工程配置  
> 需求基线：`REQUIREMENTS.md` 1.53  
> 审查方式：静态代码审阅、领域链路复核、权限边界复核、测试与生产构建；本轮未修改业务代码  
> 与旧报告关系：本报告复核 `CODE_REVIEW.md` 中 CR-001～CR-012 整改后的当前状态，不重复把已关闭问题当作现存问题

## 1. 结论摘要

> 整改复核（2026-08-21）：P0 三项已关闭。远程模式现在恢复 `/auth/me` 会话并按权限分区水合目录、组织、定义、实例和当前用户任务；流程定义、运行时、附件以及用户/部门/职务/角色/权限组等治理写命令均已通过 REST，响应只写入客户端缓存。审计页在正式构建中只查询后端。Excel 转 PDF 已按最新需求改为浏览器生成、预览确认后只上传 PDF，不再要求 LibreOffice。剩余工作包括正式 NestJS 实现和浏览器 E2E；这些不能用当前纯前端仓库伪装成已完成后端。

当前原型已经从“页面集合”进步为具有完整版本快照、稳定选项标识、拓扑驱动待办、动态权限组、附件存储和自动化领域/API测试的可交互系统。类型检查、51 项测试和生产构建均通过，旧报告中的主要主链路断点已得到实质修复。

本轮已关闭原报告中的三个阻断项：

1. 远程会话通过 `/auth/me` 恢复，并通过唯一启动水合器加载服务端目录、定义、实例和任务；核心业务写命令使用 REST 和 ETag，Zustand 在远程模式下只承载响应缓存。
2. 审核详情的附件只进入暂存仓库，保存、重新提交或审核决定时才与表单引用原子提交；旧引用进入延迟清理状态。
3. 设计器、保存、发布 Store、REST handler 共用同一个完整验证器，覆盖可达性、环、条件、并行冲突、权限组用途及有效成员。

因此，当前版本已经可以作为正式后端的前端契约基线，但仍不是可直接投产的完整系统：仓库中尚无 NestJS、SQL Server 持久化、真实磁盘附件服务和 SMTP worker。上述服务端能力必须按 OpenAPI 与需求文档另行实现和部署，不能由浏览器 Mock 代替。

### 风险统计

| 级别 | 数量 | 含义 |
| --- | ---: | --- |
| P0 | 0 | 原 3 项均已关闭 |
| P1 | 1 | 正式后端尚不存在 |
| P2 | 2 | 浏览器 E2E 尚未配置；设计器与治理聚合文件仍可继续拆分 |

## 2. 自动检查结果

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | TypeScript 项目引用检查无报错 |
| `pnpm test` | 通过 | 14 个测试文件、51 项测试全部通过，包含 MSW API 合约边界 |
| `pnpm build` | 通过 | Vite 成功生成生产构建；MSW 已从正式构建移除，ExcelJS 保持按需加载并纳入 950 kB 预算 |
| 类型规避 | 未发现 | 当前 `src` 中未发现 `any`、`@ts-ignore` 或 `@ts-expect-error` |
| 组件 / E2E 测试 | 缺失 | 现有测试运行在 Node 环境，没有 React 页面、MSW handler 或浏览器端到端测试 |
| 浏览器视觉复核 | 未执行 | 当前会话未提供可用的页面控制通道；界面结论来自 JSX、CSS 和交互代码审阅 |
| 工作区状态 | 非干净 | 审查开始前已有大量用户认可的未提交修改；本轮只新增本报告，未覆盖这些改动 |

## 3. 已确认的改进

- 路由已经按页面懒加载，旧报告中的单一 2.4 MB 主包问题明显改善；Tiptap、React Flow、ExcelJS 和治理页均形成独立分块。
- 流程定义与版本保存完整的基本信息、表单、系统字段、流程图和规则快照；运行实例通过 `definitionId + versionId` 锁定版本，不回退套用当前发布版本。
- 流程运行时已经能够按连线激活审批任务，支持并行、AND 汇聚、条件跳过、确认节点、驳回规则和重新提交。
- 用户、角色和流程权限组已进入共享 Store，并使用稳定用户 ID、角色 ID和权限组 ID维护主要关系；组成员变化能够动态影响任务资格。
- 单选、复选、下拉选项已经使用稳定选项 ID，标签重命名不会直接破坏同一版本家族中正常复制得到的历史值。
- 固定标题字段、轮次显示、流程进度、PDF 折叠预览、只读选择控件和设计器撤销/重做均有独立工具函数或共享组件支撑。
- 自动化测试已覆盖定义创建、发布切换、版本删除保护、实例发起、审核、驳回、重新提交、条件跳过、确认、关闭和自由协作等核心领域路径。

## 4. P0 问题

### CR2-001 REST 远程模式不能接管应用状态

**证据**

- `apps/web/src/main.tsx:14-16` 在 `VITE_API_MODE=remote` 时仅停止启动 MSW。
- `apps/web/src/api/flowPilotApi.ts:68-72` 的登录只保存 API token；只有 Mock 登录 handler 才会调用 `usePrototypeStore.login`（`apps/web/src/mocks/handlers/systemDirectory.ts:329-346`）。
- 路由登录判断仍读取 `usePrototypeStore.authenticated`（`apps/web/src/App.tsx:35-43`）。因此远程后端返回登录成功后，页面仍可能立即被送回 `/login`。
- 路由、菜单、任务中心、流程清单、治理页、流程定义页和详情页仍直接读取 Zustand Store。页面中真正调用 REST 的主要路径只有登录、发起提交、附件和 Excel 导出。
- 流程管理、版本发布、审批、驳回、关闭、自由协作和组织权限等动作仍由页面直接调用 Store；相应 REST client 与 MSW handler 大量处于未接入状态。

**影响**

当前无法通过配置环境变量平滑切换到 NestJS。即使后端接口全部实现，页面仍会显示本地数据并把多数操作写入浏览器；会话、权限、ETag、审计、Outbox 和后端数据可能彼此分叉。

**建议**

建立唯一的前端数据访问边界。页面只调用 application service / query hooks，不直接写 Zustand 领域 Store；Mock 和远程后端共用同一类型化 REST client。认证状态由 `/auth/login` 与 `/auth/me` 结果驱动，浏览器 Store只缓存会话视图，不作为服务器事实来源。迁移期间应按“认证与目录 → 定义与版本 → 实例与任务 → 附件与运维”逐域切换，禁止同一写命令同时保留两条入口。

### CR2-002 附件编辑先于审核结果提交，破坏原子性

**证据**

- `apps/web/src/pages/ProcessDetailPage.tsx:538-571` 在用户选择文件时立即调用上传或替换接口。
- 上传 handler 会立即调用 `synchronizeInstanceAttachment` 改写实例表单（`apps/web/src/mocks/handlers/attachmentsNotifications.ts:488-524`）。
- 单 PDF 替换会立即删除原文件、写入新文件并同步实例（`attachmentsNotifications.ts:628-671`）。
- 删除按钮也会立即删除文件并同步实例引用（`attachmentsNotifications.ts:584-625`）。
- 详情页随后因 Store 更新而在 effect 中把新实例值重新写回本地编辑态（`ProcessDetailPage.tsx:144-168`），附件变化可能不再被视为未提交修改。
- 审核结果仍通过页面直接调用 `reviewInstance`（`ProcessDetailPage.tsx:389`），附件写入与审核结果不是同一个命令或事务。

**影响**

审核人上传或删除附件后即使关闭页面、放弃审核、审核提交失败或任务已被他人处理，实例附件也可能已经改变。PDF 替换还可能让原文件提前消失。这与需求中“附件变更与保存、重新提交或审核结果一起提交”的原子规则相冲突。

**建议**

附件上传只创建“暂存附件”，不修改实例引用；页面维护待新增、待替换、待删除集合。`updateSubmission`、`resubmit`、`decision` 和 `field-revision` 命令一次提交表单值与附件操作，后端事务内校验 ETag、任务资格和字段授权后再切换引用。旧文件进入 `cleanup-pending`，不得在业务事务提交前物理删除。离开页面时清理或等待后台清理未引用暂存文件。

### CR2-003 发布权威校验弱于设计器校验，可发布不可运行拓扑

**证据**

- `validateSnapshot` 只检查开始/结束数量、至少一个审批节点、审批组是否为空以及“存在至少一条连线”（`apps/web/src/state/useProcessDefinitionStore.ts:127-203`）。
- 该校验没有验证所有节点从开始可达、能够到达结束、无环、无悬空边、汇聚关系有效，也没有验证开始与结束实际连通。
- 并行可修改字段冲突只在流程设计器页面的 `buildValidation` 中检查（`apps/web/src/pages/FlowDesignerPage.tsx:610-722`），Store 的发布校验没有复用该规则。
- 权限组是否存在、是否启用、用途是否匹配、是否至少有一个有效成员也未进入最终发布校验。
- `publishVersion` 只重新执行上述 `validateSnapshot`，校验状态为“通过”就直接切换发布指针（`useProcessDefinitionStore.ts:498-512`）。导入、迁移或未来 API 调用不必经过设计器 UI。

**影响**

异常 JSON、旧持久化数据、直接 Store 调用或未来后端请求可以生成设计器界面会提示失败、但发布端仍判定通过的版本。此类版本可能创建零待办、永远无法到达结束节点、并行写同一字段或把任务分配给无人可处理的组。

**建议**

把完整验证提取为纯领域函数，流程设计器、保存版本、发布页、MSW handler 和正式 NestJS 共同使用同一规则集。发布必须验证结构、可达性、DAG、节点语义、条件引用、并行字段冲突、权限组用途及有效成员；返回稳定问题编码和节点/字段定位信息。为每条发布阻断规则增加单元测试，并增加“非法导入快照不能发布”的集成测试。

## 5. P1 问题

### CR2-004 删除流程和版本没有独立权限

**证据**

- 需求明确规定删除属于不可恢复的高风险动作，需要独立权限并写审计（`REQUIREMENTS.md:399`）。
- 权限目录没有 `config-definition:删除`，只有查看、编辑和发布（`apps/web/src/state/permissionEngine.ts:18-41`）。
- `deleteVersion` 和 `deleteDefinition` 都只检查 `config-definition:编辑`（`apps/web/src/state/useProcessDefinitionStore.ts:533-557`）。
- 流程管理和版本页直接调用 Store 删除，未通过会写审计的 REST handler（`ProcessManagementPage.tsx:71-83`、`ProcessVersionsPage.tsx:180-201`）。

**影响**

任何获得流程编辑权限的角色都同时获得不可恢复删除能力；删除操作也可能不进入持久化审计。

**建议**

新增独立权限键并迁移默认角色权限；菜单、按钮、路由动作、API handler 和领域命令都重新校验。删除命令必须记录实际操作者、目标版本、删除原因和影响摘要，且只允许通过服务端命令执行。

### CR2-005 额外可见角色使用硬编码名称，部分配置不会生效

**证据**

- 基本信息页的角色候选是硬编码数组（`apps/web/src/pages/ProcessBasicConfigPage.tsx:46-47`），包含当前角色主数据中不存在的“研发经理、质量经理、生产经理、部门查看员”。
- `ProcessBasicConfig.visibleRoles` 保存字符串名称而非角色 ID（`apps/web/src/state/useProcessDefinitionStore.ts:24-35`）。
- 实例可见性通过 `user.roles` 名称与 `visibleRoles` 直接比较（`apps/web/src/state/workflowAccess.ts:26-27`、`:51-52`）。
- 内置流程也配置了不存在的角色名称（`useProcessDefinitionStore.ts:263-265`）。

**影响**

管理员可能选择一个界面上存在、实际主数据中不存在的角色，配置保存成功但无人获得查看权限；真实角色重命名后，已发布版本的可见范围还会悄然失效。

**建议**

候选项从共享角色仓库分页/搜索加载，版本快照保存稳定角色 ID，界面按当前主数据解析名称。发布校验阻止新增无效或停用角色引用；历史已删除引用显示明确的“未识别角色”，不能静默失效。

### CR2-006 运行时领域模型仍允许缺失稳定关联，并重复保存任务状态

**证据**

- `ProcessInstance.definitionId`、`versionId` 和 `initiatorId` 仍是可选字段（`apps/web/src/data/types.ts:59-103`）。
- 通用实例类型仍强制包含 `pdfName`、`documentCode`、`documentType`、`documentLevel`、`revision` 等 PDF 历史字段，自由流程和其他动态流程只能填充占位值。
- 审批状态同时保存在 `WorkflowTask` 和 `ProcessInstance.reviewers`；Store 需要 `normalizeInstanceReviewers`、`synchronizeInstanceReviewersFromTasks` 和持久化迁移持续对齐两份状态（`apps/web/src/state/usePrototypeStore.ts:172-498`）。
- 页面有些地方读任务，有些地方读 `reviewers`，例如能否修改发起内容仍通过 `reviewers` 判断是否已经审核（`ProcessDetailPage.tsx:197-200`）。

**影响**

类型系统无法保证新数据一定锁定定义和版本；两份审批事实源在异常中断、迁移或新功能更新不完整时仍可能分叉，近期 `DOC26080042` 的节点键问题正属于这类同步成本。

**建议**

拆分 `ApprovalProcessInstance` 与 `FreeFlowInstance`，新数据强制要求稳定 ID；遗留兼容只存在于一次性 migration DTO，不进入核心类型。以任务 / 运行节点为唯一审批事实，进度与 reviewer 展示由 selector 派生，不在实例上再持久化第二份状态。

### CR2-007 流程定义导入会破坏跨版本稳定字段和选项关联

**证据**

- 导出文件按需求只使用显示文本，不包含内部 ID；导出会为同名字段生成“引用名称”用于单版本内消歧（`apps/web/src/utils/processDefinitionTransfer.ts:103-133`）。
- 导入每个版本时都独立调用 `importForm`，并为普通字段和表格列重新生成随机 ID（`processDefinitionTransfer.ts:305-326`）。
- 选择项 ID 又基于新字段 ID重新生成（`processDefinitionTransfer.ts:349-360`）。
- 各版本之间没有共享的“业务引用名称 → 新稳定 ID”映射。

**影响**

导入一个包含 V1、V2 的流程后，即使两个版本都存在同名字段 A 和同名选项 A/B，它们的内部标识也不一致。若先用导入后的 V1 创建实例，再切换到 V2，按当前版本列展示历史实例时可能把相同业务字段视为不存在并显示为空；复选框选中状态也无法跨版本正常解析。

**建议**

导入整个定义时先建立跨版本引用注册表：相同“引用名称 + 类型兼容”的字段、表格列和选项复用同一个新稳定 ID；仅新增或类型不兼容项生成新 ID。导出结构可继续保持可读文本，但要保证引用名称在版本家族内稳定且唯一。补充多版本导出→导入→V1 发起→切换 V2 列表显示的回归测试。

### CR2-008 附件策略与已确认需求不完整，初次发起可绕过字段限制

**证据**

- 附件配置只有大小、数量和 `inlinePdf`（`apps/web/src/utils/designerStorage.ts:63-67`），没有允许扩展名、Excel 转 PDF、最大页数和转换状态。
- 上传校验只检查大小；开启 PDF 预览时再检查 PDF 扩展名和声明 MIME（`apps/web/src/mocks/handlers/attachmentsNotifications.ts:258-286`）。没有拒绝 `.exe/.dll/.bat/.ps1/.js` 等危险类型，也没有识别实际内容类型。
- 发起页在实例创建前调用无实例/字段范围的上传接口（`apps/web/src/pages/ConfiguredProcessStartPage.tsx:331-357`）。此时 handler 无法按目标字段校验数量、PDF 规则或允许扩展名。
- 创建实例 handler 只检查附件存在并映射到字段，没有再次依据锁定版本逐字段校验格式、数量和大小（`apps/web/src/mocks/handlers/instancesTasks.ts:143-175`）。
- OpenAPI 中也没有 Excel 转 PDF 转换任务或状态接口。

**影响**

原审查时尚未实现 Excel 转换链路；最新需求已改为浏览器读取 `.xlsx` 并生成 PDF，附件接口只允许接收最终 PDF。直接调用 API 仍必须经过字段范围、PDF 签名和附件安全规则校验。

**建议**

扩展附件字段快照与 OpenAPI：允许扩展名、前端 Excel 转 PDF 和最大页数。浏览器预览确认后只上传 PDF 暂存附件并携带目标 `definitionId/versionId/fieldId`；上传和实例提交两次校验，服务端通过 PDF 签名识别类型并统一拒绝危险文件。

### CR2-009 邮件 Outbox 由查询时反推，不是任务激活事件

**证据**

- `deriveOutboxCandidates` 同时扫描“待处理”和“已完成”任务（`apps/web/src/mocks/handlers/attachmentsNotifications.ts:385-407`）。
- 只有管理员请求 `/email-outbox` 详情或重试接口时才调用 `materializeOutbox`（`attachmentsNotifications.ts:428-466`、`:682-738`）。
- 因为页面审批动作绕过 REST handler，任务激活时没有在同一命令中写 Outbox 事件。
- 首次很晚打开 Outbox 页面时，已经完成的历史任务也会被创建成“进入节点”邮件，并使用查询时刻作为 `createdAt`。

**影响**

邮件是否产生依赖管理员是否打开监控接口；历史完成任务可能补发本不应发送的进入节点邮件，创建时间、收件人成员和邮箱也会使用查询时而非节点激活时的状态。这不符合“激活事务内写 Outbox、成员变化不追发”的规则。

**建议**

任务从未激活变为待处理时，在同一领域命令中生成不可变 `TaskActivated` 事件和收件人快照，并以事件+收件人为幂等键写 Outbox。查询接口只能读取，不得产生业务记录。取消、驳回和关闭不删除已存在事件，但不得为从未激活或已跳过任务创建邮件。

### CR2-010 操作审计存在旁路、操作者不明确和业务值泄露

**证据**

- 多数页面直接调用 Store，绕过会 `appendAuditEvent` 的 REST handler；定义创建、编辑、发布、取消发布、删除和治理变更不能保证写入同一审计源。
- 流程定义 Store 把 `createdBy/updatedBy/firstPublishedBy` 多处写成“当前用户”而非稳定用户 ID与真实姓名（`apps/web/src/state/useProcessDefinitionStore.ts:207-234`、`:367-369`、`:498-524`）。
- 审计页通过当前实例和任务反推一部分事件（`apps/web/src/utils/runtimeAudit.ts`），删除后的对象和失败动作无法反推。
- `WorkflowFieldChange` 保存 `before/after`，运行时审计又把完整 `revision.changes` 放入全局审计详情（`apps/web/src/data/types.ts:5-10`、`apps/web/src/utils/runtimeAudit.ts:38`）。
- 需求规定全局操作审计只记录字段标识和名称，不保存字段业务值（`REQUIREMENTS.md:965`）。

**影响**

审计记录既可能缺失关键高风险动作，也可能无法证明真实操作者；与此同时，审核字段的业务内容可能被复制到权限更广的系统审计页，扩大敏感数据暴露范围。

**建议**

所有写命令通过统一服务端 application service，事务内追加不可变审计事件。领域实体保存 `actorUserId`，显示时再解析姓名；不使用“当前用户”占位。业务流程时间线可以按已确认范围展示差异，全局审计只保存字段 ID、当时标签、动作、节点、轮次和 traceId，不保存前后业务值。

### CR2-011 富媒体以 Base64 写入 localStorage，极易保存失败

**证据**

- Tiptap 图片允许 Base64，图片上限 1.5 MB、视频上限 6 MB，FileReader 直接生成 data URL（`apps/web/src/components/RichTextEditor.tsx:70-82`、`:96-117`）。
- 富文本内容随后进入 `ProcessInstance.formValues/freeTimeline` 并由 Zustand persist 保存到 localStorage。
- 一个 6 MB 视频经过 Base64 膨胀后通常已接近或超过常见浏览器单源 localStorage 配额，Store 中还同时保存 200+ 用户、流程版本、实例和任务。
- Zustand 持久化写入没有面向用户的配额失败恢复；设计器旁路存储虽然捕获异常，但多处只返回布尔值。

**影响**

自由协作中一次合法视频插入就可能导致整个实例 Store 持久化失败；页面当下看似成功，刷新后内容、审核结果或其他并发修改可能丢失。

**建议**

富媒体与普通附件统一上传文件仓库，富文本只保存受控附件 ID / 内网 URL；服务端校验 MIME、大小与访问权限。原型阶段也应改用 IndexedDB 保存 blob，并在提交前检测配额和显示明确失败。禁止把 Base64 正文写入业务 JSON或 localStorage。

### CR2-012 当前自动化测试没有覆盖真正的 API 和页面边界

**证据**

- 43 项测试主要覆盖纯工具函数和 Zustand 领域命令。
- Vitest 输出显示 Node 环境，没有 jsdom / React Testing Library 页面测试。
- 没有测试直接请求 MSW handlers，也没有验证 `flowPilotApi` 的 Problem Details、ETag、幂等、附件、Outbox 和审计行为。
- 没有 Playwright/Cypress 端到端测试；远程登录状态分叉、附件提前提交和发布校验分叉因此未被现有测试发现。

**影响**

“领域 Store 测试通过”不能证明用户实际点击的页面走了相同命令，也不能证明未来 NestJS 契约兼容。

**建议**

先增加 API 合约集成测试，再增加少量关键页面/E2E。优先覆盖：远程登录与刷新会话、发布非法拓扑、附件暂存后放弃、审核附件与结果原子提交、任务激活 Outbox、独立删除权限、多版本导入稳定字段、直接 URL 与文件下载权限。

## 6. P2 问题

### CR2-013 查询交互契约不统一，部分“查询”按钮只是装饰

**证据**

- 流程清单在输入变化时立即过滤，但“查询”按钮没有 `onClick`（`apps/web/src/pages/ProcessListPage.tsx:285-339`）。
- 用户、权限组、实例监控和审计页同样以本地状态即时过滤；部分“查询”按钮只弹出“已查询到 N 条”提示（`apps/web/src/pages/GovernancePages.tsx:241-252`、`:1004-1007`、`:1079-1081`）。
- 任务中心则没有查询按钮，关键词明确采用即时过滤。

**影响**

相似页面看起来使用同一种查询卡片，实际却分别是即时筛选、点击无动作和点击仅提示；用户难以形成稳定预期，未来接服务端分页时也容易重复请求或遗漏已应用条件。

**建议**

统一成一种模式：列表页建议表单编辑条件、点击“查询”后提交 applied filters；简单单关键词可保留带防抖的即时搜索，但不要同时放无效查询按钮。重置必须同步清空表单、已应用条件和分页。

### CR2-014 页面和 Store 文件职责过大，规则容易再次漂移

**证据**

- `FlowDesignerPage.tsx` 约 1761 行，`FormDesignerPage.tsx` 约 1715 行，`usePrototypeStore.ts` 约 1257 行，`ProcessDetailPage.tsx` 约 1079 行，`GovernancePages.tsx` 约 1047 行。
- `styles.css` 约 3074 行，`process-admin-pages.css` 约 1639 行；全局壳层、任务、详情、运行表单和局部页面样式混在大文件中。
- 设计器页面同时包含数据迁移、验证、历史、画布、属性编辑和发布导航；详情页同时处理权限、审批、附件、表单渲染、进度和打印入口。

**影响**

同一规则已经出现“设计器校验”和“发布校验”两套实现。继续增加附件转换、条件分支和后端状态后，单文件修改的回归面会快速扩大。

**建议**

按领域能力而非页面机械拆分：`definition-validation`、`workflow-runtime`、`attachment-draft`、`instance-commands`、`form-runtime-renderer`、`audit-selector`。页面只组合 hook 和视图组件；CSS 以壳层、数据列表、运行表单、设计器四个明确层级组织。

### CR2-015 构建分块仍偏大，ExcelJS 和 Mock 浏览器运行时需要隔离

**证据**

- 生产构建中 `exceljs` 约 929.58 kB（gzip 256.44 kB），MSW browser 分块约 498.15 kB，Tiptap 分块约 413.41 kB，React 运行时分块约 396.03 kB。
- ExcelJS 已通过动态 import，只在导出时加载，这是正确方向；但仍触发 500 kB 构建警告。
- `main.tsx` 的动态 Mock import 会让普通生产构建仍包含 MSW browser 分块，除非构建器能够在固定环境变量下消除该分支。

**影响**

首次使用导出、自由协作或本地 Mock 时会产生明显大块下载与解析；弱终端和内网无缓存场景下更明显。

**建议**

正式部署构建彻底排除 MSW；把 mock 作为独立入口或构建 mode。Excel 导出可评估更轻量的 xlsx writer，或保留 ExcelJS 但加入懒加载进度与 chunk 预算。对员工区、设计器和运维区建立构建体积阈值。

### CR2-016 时间格式不统一，字符串排序在两位数月份会错误

**证据**

- 多个 Store 使用 `toLocaleString("zh-CN")` 生成不保证补零的时间文本，例如 `2026/9/2`（`apps/web/src/state/useProcessDefinitionStore.ts:108`、`usePrototypeStore.ts` 中同类 `nowText`）。
- 部分 API / Outbox / 审计又使用 ISO 8601。
- 任务和实例接口多处直接对时间字符串 `localeCompare` 排序（如 `apps/web/src/mocks/handlers/instancesTasks.ts:66-87`、`:285-305`）。

**影响**

`2026/10/...` 可能排在 `2026/9/...` 之前；日期过滤、打印和审计展示还需要反复兼容 `-`、`/` 和 ISO 三种格式。

**建议**

领域与 API 统一保存 UTC ISO 8601，排序比较 epoch 或 ISO；只在视图层按 Asia/Shanghai 格式化。为跨月、跨年排序和默认 30 天范围增加测试。

### CR2-017 保留了未接入的旧页面和静态定义，增加误用概率

**证据**

- `apps/web/src/pages/FreeFlowCreatePage.tsx` 没有注册路由，仍保留一套硬编码自由流程表单和人员选择。
- `apps/web/src/data/processDefinitions.ts` 没有任何外部引用，仍保存旧静态流程定义模型。
- `usePrototypeStore.createFreeFlow` 主要只被未接入页面和 Mock 兼容 handler 使用，与通用动态发起页形成第二条自由流程创建路径。

**影响**

后续维护者可能误改或重新接入旧实现，导致自由流程再次绕过表单设计器和权限组；死代码也干扰全局搜索和审查。

**建议**

在 API 状态收口后删除未引用页面和旧静态定义；兼容迁移逻辑集中到明确的 `legacy/` 模块并标注移除版本，避免与正式领域代码同层存在。

## 7. 建议整改顺序

### 第一阶段：收紧数据和事务边界

1. 建立页面唯一数据访问层，先修复远程登录与会话恢复。
2. 审核、驳回、关闭、发布、删除和组织权限全部改走 REST 命令，页面不再直接写 Store。
3. 附件改为暂存模型，与实例保存 / 审核结果原子提交。
4. 统一完整发布校验并在服务端再次执行。

### 第二阶段：修正权限和稳定标识

1. 增加独立删除权限并补审计。
2. 额外可见角色改为稳定角色 ID，清理无效内置引用。
3. 收紧实例必填稳定 ID，移除 `reviewers` 第二事实源。
4. 修复多版本 JSON 导入的跨版本字段、列和选项映射。

### 第三阶段：补齐附件、邮件和审计能力

1. 完成附件扩展名、内容识别、危险类型和二次关联校验。
2. 增加浏览器端 Excel 转 PDF 配置、预览确认、最大页数和本地资源释放测试。
3. Outbox 改为任务激活事务事件，不允许查询接口生成业务记录。
4. 审计统一真实操作者并移除业务字段前后值。

### 第四阶段：工程化与体验收口

1. 增加 API handler、组件和浏览器端到端测试。
2. 拆分超大页面 / Store，统一查询交互和时间格式。
3. 删除死代码并设置构建分块预算。
4. 在可用浏览器环境中完成 1180、1440 和低高度桌面视口的视觉回归。

## 8. 建议优先验收的回归场景

1. 以 `VITE_API_MODE=remote` 启动，登录、刷新、退出和重新登录均只依赖后端会话，路由不读取 Mock 登录副作用。
2. 审核人上传或删除附件后直接离开，实例与旧附件完全不变；审核提交成功后表单、附件、任务、审计一次生效。
3. 构造孤立审批节点、环、不可达结束、无成员权限组和并行字段冲突，保存可返回定位错误，但任何入口都不能发布。
4. 只有“流程编辑”权限的角色不能删除定义或版本；获得独立删除权限后才能操作，并产生真实操作者审计。
5. 新建真实角色并配置额外可见范围，角色重命名后已发布版本仍正确授权；停用角色按确认规则立即失效。
6. 导出含 V1（A/B/C）和 V2（A/B/D）的定义再导入；用导入后的 V1 创建实例、切换 V2 后，A/B 正常显示，C 按当前版本规则隐藏，D 为空。
7. 直接调用暂存附件和创建实例 API，危险文件、超量文件、错误字段类型和伪装 MIME 均被服务端拒绝。
8. 条件节点激活时立即产生一份幂等 Outbox；任务完成后首次打开监控页不会补发旧节点邮件，组成员变化也不追发。
9. 6 MB 视频不进入 localStorage；上传失败、配额不足或刷新页面均有明确且可恢复的状态。
10. 从 9 月跨到 10 月查询任务、实例和审计，排序、30 天范围及打印时间保持正确。

## 9. 完成判定建议

以下条件同时满足后，可以认为前端已经具备对接正式 NestJS 后端的可靠基础：

- 页面不直接写领域 Store，Mock 与远程模式共用同一 REST 行为。
- P0 三项全部关闭，并有自动化回归覆盖。
- 删除、查看、审核、关闭、附件下载和打印均在服务端重新鉴权。
- 发布校验只有一套权威规则，非法版本无法通过任意入口发布。
- 附件、任务、审核结果、审计和 Outbox 的事务边界与需求文档一致。
- API 合约测试、关键页面测试和至少一条发起→审核→驳回→重新提交→完成的浏览器 E2E 通过。
