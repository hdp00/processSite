# FlowPilot 自动化测试策略

> 适用范围：当前 React 前端、浏览器 Mock REST API，以及未来同一 OpenAPI 契约下的 NestJS 后端。

## 1. 测试分层

| 层级 | 工具 | 目标 |
| --- | --- | --- |
| 单元与领域测试 | Vitest（Node） | 流程拓扑、版本、权限、数据迁移、编号、导出等纯逻辑 |
| 组件测试 | Vitest、jsdom、Testing Library | 表单校验、反馈、路由门禁和组件交互 |
| Mock API 契约测试 | Vitest、MSW Node | OpenAPI 数据形状、鉴权、Problem Details、ETag、幂等和分页 |
| 浏览器端到端测试 | Playwright | 从登录到流程配置、发起、处理、查询和治理的用户链路 |
| 视觉与无障碍测试 | Playwright、axe-core | 关键桌面页面的稳定视觉基线及 WCAG A/AA 自动检查 |

当前 Mock API 只能验证前端契约和领域适配，不能代替正式后端的数据库事务、真正并发、附件磁盘恢复、SMTP 或双数据库兼容测试。

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
- E2E 优先使用角色、可访问名称和用户可见中文文本定位；只有画布、文件输入等缺少稳定语义的控件才增加测试标识。
- 视觉基线固定 Windows、1440×900、`zh-CN`、`Asia/Shanghai`，禁用动画并遮罩时间、编号等动态区域。
- 失败时保留截图、视频和 trace；正常通过不保留大体积媒体。

## 5. 正式后端复用边界

- 黑盒场景通过 `FLOWPILOT_TEST_TARGET=mock|remote` 和 `FLOWPILOT_TEST_BASE_URL` 选择目标；账号凭据仅从环境变量读取。
- OpenAPI 操作矩阵、Problem Details、ETag、幂等和权限场景应原样对 NestJS 重跑，不添加测试专用生产接口。
- 正式后端实现后，SQLite 与 SQL Server 适配器必须执行同一仓储契约和业务场景套件；另外验证迁移、事务回滚、任务抢占、附件状态机和 Outbox 恢复。
- 在正式后端及两种数据库实际通过前，测试报告必须明确标记为“未执行”，不能用 Mock 结果代替。

## 6. 缺陷处理

- P0/P1：本轮修复并补回归测试，重新运行受影响层级和全量门禁。
- P2/P3：记录复现步骤、影响、证据和建议，纳入后续清单。
- 测试发现业务语义变化时，同步更新 `REQUIREMENTS.md`、OpenAPI 和变更记录；纯测试基础设施变化只更新本策略、README 和代理工作说明。
