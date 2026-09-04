# FlowPilot 后端生产部署 Runbook

> 适用范围：Windows Server 2016 x64、.NET 10、原生 Windows Service、Kestrel loopback、IIS/ARR 反向代理、Microsoft SQL Server。
>
> 本文只详细说明后端。前端 `/flowpilot` 应用和 IIS/ARR 完整规则见 [`IIS_DEPLOYMENT.md`](./IIS_DEPLOYMENT.md)。

## 1. 部署结论与边界

FlowPilot 后端按以下方式运行：

```text
浏览器
  -> IIS 主站 /api/flowpilot/*
  -> ARR 反向代理
  -> http://127.0.0.1:3000/api/flowpilot/*
  -> FlowPilot API Windows Service
  -> SQL Server / LDAP / SMTP / 本机附件目录
```

- ASP.NET Core 不由 IIS 应用程序池直接托管。
- Kestrel 只监听 `127.0.0.1:3000`，不得通过局域网直接访问。
- IIS 只代理 `/api/flowpilot/*`，不接管同一站点的其他 API。
- API 启动时不自动创建、迁移或 Seed 数据库。
- 数据库结构升级由部署人员或 DBA 显式执行。
- API 与 Web 使用同一个不可变 release，通过同一个 `App\current` 目录联接切换。
- 允许计划停机；本文不承诺零停机发布。

## 2. 角色分工

| 角色 | 职责 |
| --- | --- |
| 发布负责人 | 从干净提交构建、测试、生成 release、校验哈希 |
| Windows 管理员 | 准备目录、账号、NTFS 权限、Runtime、Windows Service 和防火墙 |
| DBA | 创建数据库和账号、复核并执行迁移、备份与恢复 |
| 应用管理员 | 填写 Config/Secrets、首次 Seed、健康检查和业务验收 |
| IIS 管理员 | 配置前端应用、ARR、Host 限制和转发头覆盖 |

同一人员可以承担多个角色，但迁移账号不得作为 API 常驻运行账号。

## 3. 部署前填写表

部署前复制并填写以下内容，真实密码不要写入本文或提交 Git。

| 参数 | 示例 | 实际值 |
| --- | --- | --- |
| 部署根目录 | `D:\FlowPilot` |  |
| releaseId | `2026.09.02.1` |  |
| API 端口 | `3000` |  |
| 对外 Host | `flowpilot.internal.example` |  |
| Windows Service 名 | `FlowPilot API` |  |
| Windows Service 账号 | `DOMAIN\svc_flowpilot` |  |
| IIS 应用程序池账号 | `IIS AppPool\FlowPilotWeb` |  |
| SQL Server 地址 | `sql01.internal.example` |  |
| 数据库名 | `FlowPilot` |  |
| 数据库排序规则 | `Chinese_PRC_CI_AS` |  |
| SQL 迁移账号 | 由 DBA 提供 |  |
| SQL 运行账号 | 由 DBA 提供 |  |
| LDAPS 地址 | `ldaps://dc01.internal.example` |  |
| SMTP 地址 | `smtp.internal.example:587` |  |

## 4. 服务器前置条件

### 4.1 Windows Server

- Windows Server 2016 x64 已安装适用补丁。
- IIS 已安装；ARR 和 URL Rewrite 在配置 IIS 代理前安装。
- 服务器防火墙不对局域网开放 API 端口 `3000`。
- 服务账号已授予“作为服务登录”，但不加入本地 Administrators。
- 服务器能够通过受控网络访问 SQL Server、LDAPS 和 SMTP。
- 部署盘为本机 NTFS 卷，不使用网络共享承载 release、附件或目录联接。

### 4.2 .NET Runtime

当前仓库的 `pnpm publish:api` 使用框架依赖发布：

```text
-r win-x64 --self-contained false
```

目标服务器安装与发布包匹配的 **.NET 10 ASP.NET Core Runtime x64**，不安装 SDK。安装后验证：

```powershell
dotnet --list-runtimes
```

输出中应存在 `Microsoft.NETCore.App 10.x` 和 `Microsoft.AspNetCore.App 10.x`。记录实际补丁版本。

### 4.3 SQL Server

- SQL Server 2016 13.x SP2/SP3 或主版本 14 及以上。
- 数据库兼容级别不低于 `130`。
- 使用 SQL 登录认证。
- 远程 SQL Server 使用受信 TLS 证书，连接字符串设置 `Encrypt=true;TrustServerCertificate=false`。
- 迁移账号和运行账号分离。
- 运行账号拥有业务所需 DML 权限和结构元数据可见性，但没有 DDL、`db_owner` 或 `sysadmin` 权限。

DBA 可使用以下只读查询核对目标数据库，不能把系统数据库作为 FlowPilot 目标：

```sql
SELECT
    SERVERPROPERTY('ProductVersion') AS product_version,
    SERVERPROPERTY('ProductLevel') AS product_level,
    SERVERPROPERTY('Edition') AS edition;

SELECT
    [name],
    [compatibility_level],
    [collation_name],
    [state_desc]
FROM sys.databases
WHERE [name] = N'FlowPilot';
```

## 5. 部署目录

以下命令均在目标服务器的管理员 PowerShell 中运行。先把变量替换为本次部署值：

```powershell
$FlowPilotDeployRoot = "D:\FlowPilot"
$FlowPilotReleaseId = "2026.09.02.1"
$FlowPilotReleaseRoot = Join-Path $FlowPilotDeployRoot "App\releases\$FlowPilotReleaseId"
```

首次安装时创建持久化目录：

```powershell
$FlowPilotPersistentDirectories = @(
    (Join-Path $FlowPilotDeployRoot "App\releases"),
    (Join-Path $FlowPilotDeployRoot "Config"),
    (Join-Path $FlowPilotDeployRoot "Secrets"),
    (Join-Path $FlowPilotDeployRoot "Data\Attachments"),
    (Join-Path $FlowPilotDeployRoot "Logs"),
    (Join-Path $FlowPilotDeployRoot "Temp"),
    (Join-Path $FlowPilotDeployRoot "Backup")
)

$FlowPilotPersistentDirectories | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

$FlowPilotRootMarker = Join-Path $FlowPilotDeployRoot "flowpilot.root"
if (-not (Test-Path -LiteralPath $FlowPilotRootMarker -PathType Leaf)) {
    New-Item -ItemType File -Path $FlowPilotRootMarker | Out-Null
}
```

目标结构为：

```text
{部署根目录}\
├─ flowpilot.root
├─ App\
│  ├─ current\                  -> releases\{releaseId}
│  ├─ previous\                 -> releases\{上一版本}
│  └─ releases\
│     └─ {releaseId}\
│        ├─ api\
│        ├─ web\
│        └─ release.json
├─ Config\
│  └─ appsettings.Production.json
├─ Secrets\
│  └─ secrets.Production.json
├─ Data\Attachments\
├─ Logs\
├─ Temp\
└─ Backup\
```

禁止事项：

- 不把 Config、Secrets、Data、Logs、Temp 或 Backup 放入 `App\releases`。
- 不把附件目录放入 IIS 网站、API 目录或 Web 目录。
- 不把 `current` 和 `previous` 指向网络共享或 `App\releases` 之外。
- 不覆盖已经存在的 releaseId。
- 不在运行中的 release 目录里直接替换 DLL。

## 6. 构建和生成发布包

### 6.1 构建环境要求

在受控构建机或 CI 中使用：

- .NET 10 SDK；
- Node.js 与 Corepack；
- pnpm 11.1.3；
- 能够运行 SQL Server 集成测试的隔离测试数据库；
- 干净、无未提交文件的指定 Git 提交。

正式包不要从日常开发工作区直接生成。构建前确认：

```powershell
git status --short
git rev-parse HEAD
```

`git status --short` 必须没有输出。

### 6.2 构建与发布

从仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm backend:check
pnpm publish:api
pnpm build:web
```

- `pnpm backend:check` 是正式发布前后端门禁，要求测试 SQL Server 可用。
- API 输出位于 `apps\api\artifacts\publish`。
- Web 输出位于 `apps\web\dist`。
- 即使本轮只启用后端，也要把匹配版本的 Web 放进同一个 release，暂不启用 IIS 前端即可。
- `publish:api` 使用固定输出目录；执行前必须由构建工作区清理流程确认该目录不存在或为空，防止旧文件残留。不要把日常开发机上已有的 `artifacts\publish` 直接打包。

创建新的暂存包：

```powershell
$FlowPilotRepoRoot = "D:\Build\processSite"
$FlowPilotPackageRoot = "D:\Build\FlowPilot-Packages\2026.09.02.1"

if (Test-Path -LiteralPath $FlowPilotPackageRoot) {
    throw "目标 release 暂存目录已经存在，必须使用新的 releaseId。"
}

New-Item -ItemType Directory -Path (Join-Path $FlowPilotPackageRoot "api") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $FlowPilotPackageRoot "web") -Force | Out-Null

Copy-Item -Path (Join-Path $FlowPilotRepoRoot "apps\api\artifacts\publish\*") -Destination (Join-Path $FlowPilotPackageRoot "api") -Recurse
Copy-Item -Path (Join-Path $FlowPilotRepoRoot "apps\web\dist\*") -Destination (Join-Path $FlowPilotPackageRoot "web") -Recurse
```

发布包不得包含：

- `apps/api/config/appsettings.Development.local.json`；
- 真实 Config 或 Secrets；
- SQL 迁移账号；
- 数据库备份和附件；
- 测试项目、测试结果、SDK 或 `node_modules`；
- 构建机日志。

### 6.3 release.json

每个 release 根目录必须包含 `release.json`。示例：

```json
{
  "releaseId": "2026.09.02.1",
  "productVersion": "0.1.0",
  "builtAtUtc": "2026-09-02T04:00:00Z",
  "sourceCommit": "<完整 Git commit>",
  "apiContractVersion": "v1",
  "databaseSchemaVersion": "202609020002",
  "compatibleDatabaseSchemaVersions": ["202609020002"],
  "publishMode": "framework-dependent-win-x64",
  "dotnetRuntime": "10.x",
  "files": [
    {
      "path": "api/FlowPilot.Api.exe",
      "sha256": "<SHA-256>"
    }
  ]
}
```

`databaseSchemaVersion` 必须取自本次源代码的 `DatabaseSchemaVersion.Current`，不能沿用示例。`files` 应覆盖包内所有 API/Web 文件；`release.json` 自身的哈希由交付介质或工单单独记录，避免循环引用。对 `api`、`web` 和 `release.json` 执行病毒扫描与哈希校验后，再复制到服务器。

## 7. 数据库初始化或升级

### 7.1 重要限制

当前 `FlowPilot.DatabaseTool` 是受控数据库工具，不随 API 生产包常驻部署。它固定读取仓库中的：

```text
apps/api/src/FlowPilot.Api/appsettings.json
apps/api/config/appsettings.Development.local.json
```

因此生产数据库迁移应从受保护的 DBA 管理工作站执行，管理工作站必须检出与 release 完全相同的 Git commit。不要为了方便把迁移账号放入服务器 `Secrets`。

### 7.2 准备 DBA 工作站配置

在 DBA 工作站复制被 Git 忽略的本地配置：

```powershell
Copy-Item apps/api/config/appsettings.Development.local.example.json apps/api/config/appsettings.Development.local.json
```

只在该受保护文件中临时填写：

```json
{
  "ConnectionStrings": {
    "FlowPilot": "Server=<SQL 主机>;Database=<数据库>;User ID=<运行账号>;Password=<运行密码>;Encrypt=true;TrustServerCertificate=false;Connection Timeout=15;Min Pool Size=0;Max Pool Size=100",
    "FlowPilotMigration": "Server=<SQL 主机>;Database=<数据库>;User ID=<迁移账号>;Password=<迁移密码>;Encrypt=true;TrustServerCertificate=false;Connection Timeout=15;Min Pool Size=0;Max Pool Size=20",
    "FlowPilotMigrationTest": ""
  },
  "FlowPilot": {
    "Database": {
      "ExpectedCollation": "<DBA 确认的排序规则>"
    },
    "Bootstrap": {
      "SuperAdminPassword": "<仅首次 Seed 使用的临时密码>"
    }
  }
}
```

该文件不得提交 Git、发送到服务器、进入工单附件或保留在共享目录。也不要把连接字符串放到命令行参数中，以免进入命令历史或进程列表。

### 7.3 首次初始化

1. DBA 已创建专用空数据库、迁移账号和运行账号。
2. API Windows Service 尚未启动。
3. 从与 release 相同提交的仓库根目录运行：

```powershell
pnpm db:init
pnpm db:seed
pnpm db:verify
```

预期结果：

- `db:init` 报告结构已初始化或已经是当前版本；
- `db:seed` 创建或确认内置权限、角色和唯一 `superadmin`；
- `db:verify` 使用运行账号通过连接、版本、迁移账本和结构名称检查。

首次 Seed 成功后：

- 从 DBA 工作站本地配置删除 `SuperAdminPassword`；
- 按组织秘密处理要求删除迁移密码和不再需要的生产连接信息；
- 不再次使用配置覆盖已创建的超级管理员密码。

### 7.4 升级已有数据库

升级顺序固定为：

```text
停止 FlowPilot API
-> 记录当前 release 和数据库结构版本
-> 备份 SQL Server 数据库
-> 生成同一停机点的附件清单/备份
-> 使用新 release 对应的 DatabaseTool 执行 db:init
-> 执行 db:seed
-> 使用运行账号执行 db:verify
-> 切换 current
-> 启动 FlowPilot API
```

禁止：

- API 启动时调用自动迁移；
- 在 `master`、`model`、`msdb` 或 `tempdb` 上运行工具；
- 忽略迁移校验和漂移、未知迁移或部分结构错误；
- 手工删除迁移账本来伪造成功；
- 未确认旧程序与新数据库兼容就执行文件回滚。

## 8. 生产配置

### 8.1 Config

创建：

```text
{部署根目录}\Config\appsettings.Production.json
```

建议内容：

```json
{
  "FlowPilot": {
    "Http": {
      "AllowedHosts": "flowpilot.internal.example"
    },
    "Authentication": {
      "CookieSecure": false
    },
    "Database": {
      "ExpectedCollation": "Chinese_PRC_CI_AS",
      "ApplicationCommandTimeoutSeconds": 30,
      "ReadinessCommandTimeoutSeconds": 5,
      "SchemaProbeCommandTimeoutSeconds": 15,
      "MigrationPreflightCommandTimeoutSeconds": 15,
      "MigrationCommandTimeoutSeconds": 300
    },
    "Attachments": {
      "MaximumFileSizeMb": 100,
      "MinimumFreeSpaceBytes": 2147483648
    },
    "Logging": {
      "FileSizeLimitBytes": 52428800,
      "RetainedFileCountLimit": 30
    }
  }
}
```

- `AllowedHosts` 填 IIS 对外绑定的真实域名或 IP；多个值用分号分隔。
- 不使用 `*`。
- 当前内网 HTTP 部署使用 `CookieSecure=false`；未来启用 HTTPS 时同步改为 `true`。
- 所有数据库超时必须为 `1` 至 `3600` 秒，不能配置 `0`。

### 8.2 Secrets

创建：

```text
{部署根目录}\Secrets\secrets.Production.json
```

建议内容：

```json
{
  "ConnectionStrings": {
    "FlowPilot": "Server=<SQL Server 主机>;Database=<数据库名>;User ID=<运行账号>;Password=<运行密码>;Encrypt=true;TrustServerCertificate=false;Connection Timeout=15;Min Pool Size=0;Max Pool Size=100"
  },
  "FlowPilot": {
    "Ldap": {
      "Url": "ldaps://<域服务地址>",
      "BaseDn": "<目录搜索根>",
      "UpnSuffix": "<UPN 后缀>",
      "TimeoutSeconds": 10
    },
    "Smtp": {
      "Enabled": true,
      "TestEMail": "<联调阶段测试邮箱；正式启用实际收件人前清空>",
      "Host": "<SMTP 主机>",
      "Port": 587,
      "Security": "starttls",
      "UserName": "<SMTP 账号>",
      "Password": "<SMTP 密码>",
      "From": "<固定发件地址>",
      "FromName": "FlowPilot"
    }
  }
}
```

如果暂不启用 SMTP，设置 `Enabled=false`，其他 SMTP 值可以留空。生产服务器 Secrets 不保存迁移账号。超级管理员已经由 DBA 工具 Seed 后，生产 Secrets 也不保存初始密码。

配置优先级为：

```text
发布包 appsettings.json
< Config/appsettings.Production.json
< Secrets/secrets.Production.json
< 进程环境变量
```

不要设置 `FLOWPILOT_HOME`、`FLOWPILOT_CONFIG_FILE` 或 `FLOWPILOT_SECRETS_FILE`。这些变量不会改变部署路径。

## 9. NTFS 权限

先保留 `SYSTEM` 和部署管理员的管理权限，再按以下矩阵授予最小权限：

| 路径 | API 服务账号 | IIS 前端池账号 | 部署管理员 |
| --- | --- | --- | --- |
| `flowpilot.root` | 读取 | 读取 | 修改 |
| `App\releases\*\api` | 读取/执行 | 无 | 修改 |
| `App\releases\*\web` | 无需 | 读取 | 修改 |
| `App\current`、`App\previous` | 读取/执行 | 读取 | 切换 |
| `Config` | 读取 | 无 | 修改 |
| `Secrets` | 读取 | 无 | 修改 |
| `Data\Attachments` | 修改 | 无 | 修改/备份 |
| `Logs` | 修改 | 无 | 读取/维护 |
| `Temp` | 修改 | 无 | 修改 |
| `Backup` | 按备份流程 | 无 | 修改 |

权限配置后，使用服务账号实际验证：

- 能读取两个生产 JSON；
- 能读取和执行 API；
- 能在 Logs、Temp 和 Data/Attachments 创建并删除测试文件；
- IIS 应用池账号不能读取 Secrets 和附件。

不要通过让服务账号加入 Administrators 来修复权限问题。

## 10. 落地 release 与创建 current

把经过哈希校验的完整 release 复制到：

```text
{部署根目录}\App\releases\{releaseId}
```

复制后检查：

```powershell
$FlowPilotApiExe = Join-Path $FlowPilotReleaseRoot "api\FlowPilot.Api.exe"
$FlowPilotWebIndex = Join-Path $FlowPilotReleaseRoot "web\index.html"
$FlowPilotReleaseManifest = Join-Path $FlowPilotReleaseRoot "release.json"

foreach ($FlowPilotRequiredFile in @(
    $FlowPilotApiExe,
    $FlowPilotWebIndex,
    $FlowPilotReleaseManifest
)) {
    if (-not (Test-Path -LiteralPath $FlowPilotRequiredFile -PathType Leaf)) {
        throw "发布包缺少文件：$FlowPilotRequiredFile"
    }
}
```

首次安装创建 `current` 联接，不创建无效的 `previous`：

```powershell
$FlowPilotCurrentLink = Join-Path $FlowPilotDeployRoot "App\current"
if (Test-Path -LiteralPath $FlowPilotCurrentLink) {
    throw "current 已经存在；首次安装不得覆盖，升级请走第 14 节。"
}

New-Item -ItemType Junction -Path $FlowPilotCurrentLink -Target $FlowPilotReleaseRoot | Out-Null

(Get-Item -LiteralPath $FlowPilotCurrentLink).Target
```

输出目标必须是本机 `{部署根目录}\App\releases\{releaseId}`。

## 11. 注册 Windows Service

### 11.1 注册

使用组织标准服务部署工具优先。以下 PowerShell 示例会通过安全凭据对话框读取普通域服务账号密码，不把密码写进脚本：

```powershell
$FlowPilotServiceName = "FlowPilot API"
$FlowPilotServiceDisplayName = "FlowPilot API"
$FlowPilotServiceAccount = "DOMAIN\svc_flowpilot"
$FlowPilotStableApiExe = Join-Path $FlowPilotDeployRoot "App\current\api\FlowPilot.Api.exe"

if (-not (Test-Path -LiteralPath $FlowPilotStableApiExe -PathType Leaf)) {
    throw "找不到稳定 API 执行文件：$FlowPilotStableApiExe"
}

$FlowPilotServiceCredential = Get-Credential -UserName $FlowPilotServiceAccount
$FlowPilotServiceBinaryPath = "`"$FlowPilotStableApiExe`" --environment Production"

New-Service -Name $FlowPilotServiceName -BinaryPathName $FlowPilotServiceBinaryPath -DisplayName $FlowPilotServiceDisplayName -Description "FlowPilot ASP.NET Core API" -StartupType Automatic -Credential $FlowPilotServiceCredential

sc.exe config $FlowPilotServiceName start= delayed-auto
```

如果使用 gMSA，由域管理员按组织标准注册，不在本文中设置密码。

`--environment Production` 不包含秘密，并能避免服务器上的全局开发环境变量误把服务启动为 Development。服务注册后仍应检查并清理服务器上错误的 `DOTNET_ENVIRONMENT` 或 `ASPNETCORE_ENVIRONMENT` 全局值。

### 11.2 恢复策略

示例恢复策略：

```powershell
sc.exe failure "FlowPilot API" reset= 86400 actions= restart/60000/restart/300000/restart/900000
sc.exe failureflag "FlowPilot API" 1
```

含义：第一次失败 1 分钟后重启，第二次 5 分钟后重启，后续 15 分钟后重启；连续正常 24 小时后重置失败计数。具体退避时间可按运维标准调整。

### 11.3 启动

```powershell
Start-Service "FlowPilot API"
Get-Service "FlowPilot API"
```

状态应进入 `Running`。如果启动失败，先检查 Windows 服务事件和 `{部署根目录}\Logs`，不要反复修改权限或把账号提升为管理员。

## 12. 后端独立健康检查

### 12.1 存活检查

生产 `AllowedHosts` 通常不包含 `127.0.0.1`，所以本机直连时显式发送外部 Host：

```powershell
$FlowPilotExternalHost = "flowpilot.internal.example"
$FlowPilotHealthHeaders = @{ Host = $FlowPilotExternalHost }

Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/flowpilot/v1/health/live" -Headers $FlowPilotHealthHeaders
```

预期 HTTP `200`，状态为 `ok`。

### 12.2 就绪检查

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/flowpilot/v1/health/ready" -Headers $FlowPilotHealthHeaders
```

预期 HTTP `200`，并返回当前应用版本。HTTP `503` 表示数据库连接、数据库版本、Seed 或结构检查未通过。

### 12.3 监听范围

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

`LocalAddress` 必须是 `127.0.0.1`，不能是 `0.0.0.0`、服务器局域网 IP 或 `::`。

再从另一台局域网机器确认以下地址不可达：

```text
http://<服务器局域网IP>:3000/api/flowpilot/v1/health/live
```

### 12.4 重启恢复

```powershell
Restart-Service "FlowPilot API"
Get-Service "FlowPilot API"
```

重启后重新执行 live 和 ready。检查最新日志没有连接字符串、密码、Cookie、会话令牌、完整表单或附件正文。

## 13. 接入 IIS 前的后端验收

以下全部通过后，才进入 IIS/ARR 配置：

- [ ] Windows Service 使用专用低权限账号运行。
- [ ] API 只监听 `127.0.0.1:3000`。
- [ ] `health/live` 返回 `200`。
- [ ] `health/ready` 返回 `200`。
- [ ] 运行账号通过 `pnpm db:verify`。
- [ ] 生产 Secrets 不包含迁移账号和超级管理员初始密码。
- [ ] 附件目录位于 release 和 IIS 目录之外。
- [ ] IIS 应用程序池账号无法读取 Secrets 和附件。
- [ ] 日志写入外置 Logs，且未记录秘密或业务正文。
- [ ] 停止和重启服务后能够恢复。
- [ ] releaseId、Git commit、数据库结构版本、Runtime 版本和文件哈希已记录。

接下来按 [`IIS_DEPLOYMENT.md`](./IIS_DEPLOYMENT.md) 配置 `/flowpilot` 和 `/api/flowpilot/*`。

## 14. 后端升级

### 14.1 升级前

1. 在 `App\releases` 中落地新的完整、不可变 release。
2. 校验 `release.json`、哈希、API/Web 文件和目标数据库兼容范围。
3. 记录 `current` 实际目标。
4. 停止 API 服务，并暂停 IIS `/flowpilot` 应用或使其脱机。
5. 备份数据库和同一时间点的附件清单。
6. 需要结构变化时，由 DBA 执行第 7.4 节。

### 14.2 切换目录联接

切换前必须确认：

- 新旧目标都是本机目录；
- 都是 `App\releases` 的直接子目录；
- 旧 `current` 确实是目录联接；
- 新 release 同时包含 `api`、`web` 和 `release.json`；
- 服务和 IIS 已停止。

先建立临时 `next` 联接并验证目标，再将旧 `current` 记为 `previous`，最后切换 `current`。删除或替换联接前，部署脚本必须再次检查 ReparsePoint 属性和解析后的绝对目标，不能对未验证路径执行递归删除。

### 14.3 升级后

```text
启动 FlowPilot API
-> 检查 live
-> 检查 ready
-> 启动 IIS
-> 检查登录
-> 检查一个只读列表
-> 检查一个受控写操作
-> 检查附件上传/下载
-> 使用测试邮箱检查一封通知
-> 观察日志和 health/details
```

至少保留 `current` 和 `previous` 对应的两个完整 release。清理更旧 release 前必须解析所有目录联接目标，不能跟随联接递归清理，也不能触碰持久化目录。

## 15. 回滚

文件回滚只恢复 API/Web 文件，不恢复数据库结构和业务数据。

回滚前必须满足至少一项：

- 新数据库结构仍在旧程序声明的兼容范围内；
- DBA 已执行并验证批准的数据恢复方案。

回滚顺序：

```text
停止 FlowPilot API 和 IIS
-> 记录失败 release、日志和健康结果
-> 确认 previous 目标及数据库兼容性
-> 将 current 切回 previous 对应的完整 release
-> 启动 FlowPilot API
-> 检查 live 和 ready
-> 启动 IIS
-> 完成登录和关键业务冒烟
```

禁止通过覆盖外置 Config/Secrets/Data、删除迁移记录、直接覆盖 release 或 `git reset` 回滚生产系统。

## 16. 常见故障

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 服务立即停止 | 缺少 `flowpilot.root` | 确认标记位于唯一部署根，且在 API 向上 6 层搜索范围内 |
| 服务立即停止 | API 不在 `App\releases` 或合法 `current` 联接内 | 检查 release 目录和联接真实目标 |
| 服务立即停止 | Config/Secrets 缺失或无读取权限 | 检查两个固定 JSON 和服务账号 ACL |
| 服务立即停止 | Kestrel 配置被覆盖为非 loopback | 删除不安全的 `urls`/环境变量覆盖，恢复 `127.0.0.1` |
| 服务立即停止 | `AllowedHosts` 缺失或含 `*` | 填写 IIS 实际绑定的明确 Host |
| 服务立即停止 | 生产连接串未显式加密或信任任意证书 | 使用 `Encrypt=true;TrustServerCertificate=false` 和可信证书 |
| live 失败 | 进程未运行、端口冲突或 Host 不允许 | 检查服务、日志、端口并在本机探测时发送真实 Host 头 |
| ready 返回 503 | 数据库不可达 | 核对网络、SQL 登录、证书链和连接池配置 |
| ready 返回 503 | 数据库结构或 Seed 版本不匹配 | 使用相同 release 的 DatabaseTool 执行 init、seed、verify |
| 附件上传返回 507 | 磁盘低于保留空间 | 扩容或清理受控数据，不能降低为不安全的负数 |
| 没有发送邮件 | SMTP 未启用、Outbox 重试或测试邮箱配置 | 检查脱敏 health/details、Outbox 和 `TestEMail` |
| 本机 127.0.0.1 健康检查返回 400 | `AllowedHosts` 拒绝 loopback Host | 使用本文示例显式发送外部 Host，不建议为了探测加入通配符 |

## 17. 首次上线记录

上线工单至少记录：

```text
releaseId:
Git commit:
API productVersion:
API contractVersion:
数据库结构版本:
Seed 版本:
.NET Runtime 版本:
部署根目录:
current 实际目标:
previous 实际目标:
服务账号:
SQL Server 版本:
数据库兼容级别:
数据库排序规则:
数据库备份编号:
附件备份/清单编号:
live 检查时间与结果:
ready 检查时间与结果:
回滚演练结果:
部署人员:
复核人员:
```

## 18. 当前需继续完善的自动化

本 Runbook 描述现有代码可以执行的部署路径，但仓库尚未提供完整的一键生产部署器。正式规模化发布前建议继续补齐：

1. release 组装、`release.json` 和文件哈希生成脚本；
2. 具备目标校验的 `current`/`previous` 安全切换脚本；
3. DatabaseTool 的独立 DBA 发布包和生产输入方式；
4. Windows Service 安装、恢复策略和卸载脚本；
5. IIS/ARR 规则自动化与伪造转发头验收脚本；
6. 数据库与附件同一恢复点的备份/恢复演练脚本。

在这些自动化完成前，每次生产部署都应由两人复核路径、账号、数据库目标、releaseId 和联接目标。
