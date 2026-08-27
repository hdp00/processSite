# FlowPilot 流程审核平台

当前完整可演示部分是 React 前端交互原型，开发环境默认启用浏览器内 Mock REST API，无需启动后端即可演示登录、流程定义、实例、任务、附件、邮件 Outbox、审计和 Excel 导出。

正式后端使用 .NET 10 / ASP.NET Core 10 Controller Web API、EF Core 10 和 SQL Server 2016 SP2 及之后版本。旧 NestJS 骨架已删除，`apps/api/FlowPilot.sln` 已具备健康检查、数据库初始化、内置数据 Seed、超级管理员登录/会话、组织目录读取、用户与角色完整维护、流程权限组管理、任务中心与流程实例列表，以及流程定义读取、创建、V1 分区保存和重新校验切片；其余业务 API 仍需逐个实现，当前不能代替浏览器 Mock 运行完整流程。

- [统一需求](REQUIREMENTS.md)
- [Mock REST API 使用说明](document/MOCK_REST_API.md)
- [IIS 与 .NET Windows Service 部署说明](document/IIS_DEPLOYMENT.md)
- [.NET 正式后端实现设计](document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [SQL Server 数据库结构](document/BACKEND_DATABASE_SCHEMA.md)
- [.NET 后端实施清单](document/BACKEND_IMPLEMENTATION_CHECKLIST.md)
- [OpenAPI 3.1 契约](document/flowpilot-rest-api.openapi.yaml)
- [自动化测试策略](document/TEST_STRATEGY.md)

## 前端开发

```bash
pnpm install
pnpm dev
```

开发入口为 `http://127.0.0.1:5173/flowpilot/`。要连接后续 .NET API，可在被 Git 忽略的 `apps/web/.env.remote.local` 中设置 `VITE_API_PROXY_TARGET`，前端仍请求同源 `/api/flowpilot/v1`。

构建命令按数据来源分开：

```bash
# 正式包：请求同源 /api/flowpilot/v1，由 IIS 代理到 ASP.NET Core
pnpm build

# HTTP 演示包：使用页面内 Mock，不注册 Service Worker
pnpm build:debug
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

完成初始化和 Seed 后，`/health/ready` 可验证数据库结构与种子版本；当前支持 `superadmin` 登录、会话恢复和注销，用户与角色的列表、详情、创建、编辑、启停和受引用保护的删除，用户密码重置、角色权限矩阵和角色变更影响预览，以及流程权限组完整维护。也可读取任务中心、“我的发起”和流程定义，创建定义、保存 V1 的基本信息/表单/流程图并重新校验。域登录、部门/职务写操作、流程发布及实例业务写入尚未实现。

## 测试

```bash
pnpm test
pnpm test:coverage
pnpm test:coverage:all
pnpm test:e2e
pnpm test:e2e:edge
pnpm test:all
```

`pnpm test` 现在同时运行 .NET 解决方案测试和前端 Vitest；数据库集成测试还需在真实 SQL Server 2016 SP2/兼容级别 130 最低基线以及实际部署版本上运行。现有 Mock/前端测试不能代替正式后端的事务、LDAP、SMTP、磁盘附件或 Windows Service 验收。
