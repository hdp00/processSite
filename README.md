# FlowPilot 流程审核平台

FlowPilot 是 React 前端与 .NET 10 / ASP.NET Core 10 后端组成的公司内部流程审核平台。所有业务数据、附件、权限和会话均以后端及 SQL Server 为唯一事实来源；前端不提供 Mock 数据模式，也不使用 localStorage、sessionStorage 或 IndexedDB 保存业务数据。

后端使用 EF Core 10 和 SQL Server 2016 SP2 及之后版本。`apps/api/FlowPilot.slnx` 已实现认证与域登录、组织权限、流程定义全生命周期、任务与流程实例、自由协作、附件、邮件 Outbox、审计、Excel 数据集和运维状态。富文本编辑器上传的图片和视频同样进入后端附件存储，正文只保存附件标识和受认证内容地址。

- [统一需求](REQUIREMENTS.md)
- [IIS 与 .NET Windows Service 部署说明](document/IIS_DEPLOYMENT.md)
- [.NET 正式后端实现设计](document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [SQL Server 数据库结构](document/BACKEND_DATABASE_SCHEMA.md)
- [.NET 后端实施清单](document/BACKEND_IMPLEMENTATION_CHECKLIST.md)
- [OpenAPI 3.1 契约](document/flowpilot-rest-api.openapi.yaml)
- [自动化测试策略](document/TEST_STRATEGY.md)

## 前端开发

```bash
pnpm install
pnpm dev:api
pnpm dev
```

开发入口为 `http://127.0.0.1:5173/flowpilot/`。前端必须连接后端；默认代理到 `http://127.0.0.1:3000`，可在被 Git 忽略的 `apps/web/.env.local` 中设置 `VITE_API_PROXY_TARGET`。浏览器始终请求同源 `/api/flowpilot/v1`。

构建命令：

```bash
# 请求同源 /api/flowpilot/v1，由开发代理或 IIS 转发到 ASP.NET Core
pnpm build
```

## 正式后端

- 后端位置继续为 `apps/api`，但使用独立 .NET solution 和 NuGet；前端继续使用 pnpm。
- 默认采用 `Controller → Application Service → EF Core` 的简单纵向切片；少量锁或复杂查询才使用参数化 SQL。
- Kestrel 仅监听 loopback，以原生 .NET Windows Service 运行，IIS 托管 `/flowpilot` 并反代 `/api/flowpilot/*`；不使用 WinSW。
- 数据库支持 SQL Server 2016 SP2 及之后版本，数据库兼容级别不低于 130；共享 SQL 和迁移以 2016 SP2/兼容级别 130 为最低能力基线。不支持 SQLite，也不制定服务器或 SQL Server 升级计划。
- 生产发布采用不可变的 `{部署根目录}\App\releases\{releaseId}` 发布包，每个发布包同时包含 `api` 与 `web`；`App\current` 和 `App\previous` 使用本机 NTFS 目录联接，API 与 Web 作为同一兼容版本统一切换和回滚。
- Windows Service 固定运行 `App\current\api\FlowPilot.Api.exe`，IIS `/flowpilot` 固定指向 `App\current\web`。应用从 `AppContext.BaseDirectory` 向上有限层级查找 `{部署根目录}\flowpilot.root`，不需要 `FLOWPILOT_HOME` 或配置路径参数。
- 外置配置为 `{部署根目录}\Config\appsettings.Production.json` 和 `{部署根目录}\Secrets\secrets.Production.json`；真实文件禁止进入 Git。
- 附件位于程序目录之外的 `{部署根目录}\Data\Attachments\{yyyy}`，例如 2026 年附件进入 `2026` 目录。
- OpenAPI YAML 保持唯一对外契约；Orval 生成前端 TypeScript/Axios 客户端，C# DTO 和校验由 ASP.NET Core 实现并通过语义契约测试。

后端工程命令（从仓库根目录运行）：

```bash
pnpm restore:api
pnpm db:init
pnpm db:seed
pnpm db:verify
pnpm dev:api
pnpm build:api
pnpm test:api
pnpm publish:api
pnpm backend:check
```

未部署调试时，将 `apps/api/config/appsettings.Development.local.example.json` 复制为同目录的 `appsettings.Development.local.json`，填写两个连接字符串、排序规则和首次超级管理员密码，再依次执行 `pnpm db:init`、`pnpm db:seed`、`pnpm db:verify`。该文件被 Git 忽略并由 API 与数据库工具共同读取；API 不会在启动时自动修改数据库。完整步骤见 [后端 README](apps/api/README.md)。

完成初始化和 Seed 后，`/api/flowpilot/v1/health/ready` 可验证数据库结构与种子版本。当前后端支持 `superadmin` 与 LDAPS 域账号登录、会话和模拟身份，组织与权限维护，流程定义导入导出及发布生命周期，发起、审批、重新提交、关闭和自由协作完整流转，实例字段与回复附件，MailKit 邮件发送及 Outbox 治理，审计查询、Excel 数据集和详细运维状态。尚需在实际部署环境完成 SQL Server 版本基线、LDAP、SMTP、Windows Service 和 IIS 联调验收。

## 测试

```bash
pnpm test
pnpm test:coverage
pnpm test:coverage:all
pnpm test:e2e
pnpm test:e2e:edge
pnpm test:all
```

`pnpm test` 同时运行 .NET 后端测试和前端 Vitest。`pnpm test:all` 是整个仓库的完整门禁：先执行 OpenAPI 契约检查、后端 Release 构建、后端单元测试、HTTP/API 测试和必须通过的真实 SQL Server 集成测试，再执行前端类型检查、覆盖率、双构建、Chromium 全量 E2E 和 Edge 冒烟测试。数据库集成测试仍需在 SQL Server 2016 SP2/兼容级别 130 最低基线以及实际部署版本上复验；本地自动化不能代替 LDAP、SMTP、IIS、磁盘附件或 Windows Service 的部署环境验收。
