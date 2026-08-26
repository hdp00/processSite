# FlowPilot 自动化测试策略

> 适用范围：当前 React 前端、浏览器 Mock REST API，以及未来同一 OpenAPI 契约下的 NestJS 后端。

## 1. 测试分层

| 层级 | 工具 | 目标 |
| --- | --- | --- |
| 单元与领域测试 | Vitest（Node） | 流程拓扑、版本、权限、数据迁移、编号、导出等纯逻辑 |
| 组件测试 | Vitest、jsdom、Testing Library | 表单校验、反馈、路由门禁和组件交互 |
| Mock API 契约测试 | Vitest、MSW Node | OpenAPI 数据形状、鉴权、Problem Details、ETag、幂等和分页 |
| 后端单元与契约测试 | Vitest、OpenAPI 生成校验器 | NestJS 领域服务、守卫、DTO、响应契约和错误码 |
| SQL Server 集成测试 | Vitest、SQL Server 2016 SP2/兼容级别 130 最低基线及实际部署的更高版本/兼容级别 | TypeORM 仓储、Migration、约束、锁、事务和投影 |
| 浏览器端到端测试 | Playwright | 从登录到流程配置、发起、处理、查询和治理的用户链路 |
| 视觉与无障碍测试 | Playwright、axe-core | 关键桌面页面的稳定视觉基线及 WCAG A/AA 自动检查 |

当前 Mock API 只能验证前端契约和领域适配，不能代替正式后端的 SQL Server 事务、真正并发、附件磁盘恢复或 SMTP 测试。

## 2. 覆盖率与质量门禁

- 覆盖率使用 V8 provider。核心领域门禁显式纳入权限、身份、流程定义/运行 Store、发布校验和设计器迁移模块，包含未被测试导入的代码；聚合最低门槛为行和函数 80%、分支 75%。
- 权限、身份、发布校验和设计器迁移等可独立验证的核心模块最低门槛为行和函数 90%、分支 85%。
- 另生成不设百分比门禁的全源码报告，持续显示页面、浏览器适配和 Mock handler 的覆盖缺口；这些模块的主要门禁是 Playwright 用户链路，避免用 jsdom 调用替代真实界面验证。
- Chromium 运行全部 E2E；Microsoft Edge 稳定版运行标记为 `@smoke` 的关键链路。
- 关键页面的 axe 扫描不得存在 `critical` 或 `serious` 级别问题。
- 视觉差异必须人工确认后，才能通过专用快照更新命令写入基线。
- 测试不得依赖执行顺序，不共享上一个用例产生的浏览器数据，也不得清理非 FlowPilot 的浏览器存储。

## 3. 本地命令

所有命令从仓库根目录运行：

- 正式后端开工后，契约检查必须先运行锁定版本的 `@redocly/cli` lint，再运行 `orval` 生成共享 TypeScript 类型、Zod 请求校验器和 Axios 客户端，并检查重新生成后没有工作树差异。快速正则检查不能替代该门禁。
- 后端 ESM 门禁必须覆盖 API 启动、TypeORM DataSource/Migration CLI、Vitest、维护 CLI、`file-type` 导入和 WinSW 实际编译入口，禁止测试使用 CommonJS 而生产改用另一种模块格式。

```bash
pnpm test                  # 单元、领域集成和组件测试
pnpm test:coverage         # 核心领域覆盖率门禁与 HTML 报告
pnpm test:coverage:all     # 全源码覆盖率报告
pnpm test:e2e              # Chromium 全量 E2E
pnpm test:e2e:edge         # Edge 冒烟
pnpm test:visual           # Chromium 视觉回归
pnpm test:update-snapshots # 人工确认后的视觉基线更新
pnpm test:all              # 类型、覆盖率、双构建与全部浏览器门禁
```

核心与全源码覆盖率分别输出到 `apps/web/coverage/core` 和 `apps/web/coverage/all-source`；Playwright HTML 报告和失败附件输出到 `apps/web/test-results`。这些生成物均不提交 Git。

## 4. 浏览器数据与定位规则

- Playwright 每个用例使用独立 BrowserContext，默认从 Mock 初始数据启动；需要验证刷新持久化时只在同一用例内刷新。
- 旧 schema 或损坏存储使用 `addInitScript` 定向写入 FlowPilot 自有 key，不执行整个 `localStorage.clear()`。
- 权限存储升级测试需要区分原全权限系统管理员与自定义角色：前者补齐新权限，后者保持原授权；用户删除测试按页面真实路径覆盖“启用且有角色 → 停用 → 清空角色 → 引用检查 → 删除”。
- E2E 优先使用角色、可访问名称和用户可见中文文本定位；只有画布、文件输入等缺少稳定语义的控件才增加测试标识。
- 视觉基线固定 Windows、1440×900、`zh-CN`、`Asia/Shanghai`，禁用动画并遮罩时间、编号等动态区域。
- 失败时保留截图、视频和 trace；正常通过不保留大体积媒体。

## 5. 正式后端复用边界

- 黑盒场景通过 `FLOWPILOT_TEST_TARGET=mock|remote` 和 `FLOWPILOT_TEST_BASE_URL` 选择目标；账号凭据仅从环境变量读取。
- OpenAPI 操作矩阵、Problem Details、ETag、幂等和权限场景应原样对 NestJS 重跑，不添加测试专用生产接口。
- 正式认证测试至少覆盖：域用户成功/失败、域服务不可用且不回退本地密码、普通密码用户成功与失败时均不调用或探测 LDAP、固定密码模式超级管理员、未知账号的域可用性探测、两种登录方式切换后的会话失效，以及域用户禁止本地密码重置。
- 模拟身份测试需要证明只有真实登录的内置超级管理员可以调用；域用户和密码用户作为目标时均不校验目标凭据，响应直接返回双身份会话，权限按生效用户计算且审计同时保留真实操作者。
- 正式后端实现后，SQL Server 数据访问层必须执行仓储契约和完整业务场景套件；另外验证结构迁移、事务回滚、任务抢占、附件状态机和 Outbox 恢复。
- Migration 同时从空数据库和上一结构版本执行；校验迁移校验和、兼容级别、排序规则、失败后的前向修复，以及结构落后时 `/health/ready` 返回 `503`。
- 并发测试至少覆盖同一任务双提交、编号竞争、发布指针竞争、If-Match 过期、字段级 revision 冲突、同幂等键重放与不同请求体复用。
- 附件测试至少覆盖流式中断、危险签名、路径穿越、同卷原子移动、合法单区间 `206`、非法或多区间 `416`、磁盘保留空间不足 `507`、事务失败后的暂存文件和重复清理。
- AD 和 SMTP 使用可控替身覆盖超时、证书、错误凭据、死信和重试；部署验收再使用外置测试账号完成一次真实域登录和一次测试邮件，凭据不得进入测试代码或报告。
- 邮件链路测试需要验证任务和结束通知生成正确的 FlowPilot 详情链接：内外网入口分别发起写请求时，后端把 `Origin`（缺失时才用 `Referer`）与可信代理后的 protocol/host 精确比较并冻结对应的 `${origin}/flowpilot`；来源不匹配时返回 403。还要验证无请求事件继承实例已验证入口、缺失时明确失败而不猜地址、首次发送冻结绝对 URL、重试不改变链接、链接不含令牌、未登录后安全返回详情、无权限用户不能因收到邮件读取或处理流程，以及 Outbox/每次投递尝试均可在 SQL Server 中核对。
- 远程前端测试需要证明登录不全量下载用户、实例、任务和审计；列表使用服务端分页，完整流程版本按需加载，正式请求只依靠 Cookie 且不发送 Mock Bearer。
- IIS 冒烟覆盖 `/health/live`、`/health/ready`、受保护的 `/health/details`、Cookie、Origin/Referer、代理客户端 IP、上传大小、Range、Windows 服务重启和程序目录回滚。代理测试必须从两个不同来源验证限流桶彼此独立，通过每个允许的内外网绑定验证同源请求及邮件入口，并伪造 `X-Forwarded-For`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`，证明 IIS 覆盖全部外部值、NestJS 仍识别真实来源和 authority，不能通过伪造头绕过限流/同源校验或改变邮件链接；未知 Host 必须在反代前被拒绝。
- 在正式后端、SQL Server 2016 SP2/兼容级别 130 最低基线及实际部署的更高版本/兼容级别通过前，测试报告必须明确标记为“未执行”，不能用 Mock 结果代替。

## 6. 缺陷处理

- P0/P1：本轮修复并补回归测试，重新运行受影响层级和全量门禁。
- P2/P3：记录复现步骤、影响、证据和建议，纳入后续清单。
- 测试发现业务语义变化时，同步更新 `REQUIREMENTS.md`、OpenAPI 和变更记录；纯测试基础设施变化只更新本策略、README 和代理工作说明。
