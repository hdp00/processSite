# FlowPilot 后端首次部署操作手册

> 给谁看：会登录 Windows Server、会复制文件、能以管理员身份打开 PowerShell，但不需要会编程的人。
>
> 本手册只负责第一次安装后端。数据库由 DBA 初始化；发布包由开发人员提供；IIS 在后端检查通过后再配置。

## 推荐方式：使用安装向导

开发人员交付发布包时，应同时提供：

```text
FlowPilot-<releaseId>.zip
Install-FlowPilotBackend.ps1
```

安装脚本位于仓库：

```text
deployment\Install-FlowPilotBackend.ps1
```

使用方法：

1. 把发布 zip 和脚本复制到目标服务器的临时目录，例如 `C:\FlowPilot-Install`。
2. 确认文件来自批准的发布包。
3. 从开始菜单搜索 PowerShell，右键选择“以管理员身份运行”。
4. 执行下面命令，其中路径按实际位置修改：

```powershell
Unblock-File -LiteralPath "C:\FlowPilot-Install\Install-FlowPilotBackend.ps1"
& "C:\FlowPilot-Install\Install-FlowPilotBackend.ps1"
```

5. 按屏幕提示输入信息。密码和 SQL 连接字符串不会显示在屏幕上。
6. 最后必须看到“FlowPilot 后端安装完成”。如果显示“安装停止”或“安装未完全通过”，根据提示处理，不要自行覆盖 `current`。

如果公司策略仍然禁止执行脚本，请让 Windows 管理员签名或批准脚本；不要修改整台服务器的执行策略来绕过公司安全要求。

脚本会自动完成：

- 检查管理员权限和 .NET 10 Runtime；
- 检查发布 zip 和 `release.json`；
- 收集部署目录、网站域名、排序规则和服务账号；
- 安全读取 SQL 连接字符串及可选的 LDAP/SMTP 配置；
- 创建目录和 `flowpilot.root`；
- 复制发布文件；
- 收紧 NTFS 权限；
- 生成 Config 和 Secrets；
- 创建并验证 `current`；
- 注册、启动和配置 Windows 服务恢复策略；
- 检查 live、ready 和端口监听；
- 在 `Logs` 中生成不含密码的部署结果文件。

脚本不会执行数据库迁移。运行到安装确认前，必须由 DBA 完成 initialize、seed、verify。后面的手工步骤保留用于了解输入要求、排查失败或在没有脚本时由 Windows 管理员操作。

当前安装向导适用于需要用户名和密码的普通域账号或本地服务账号。如果公司使用 gMSA，请由域管理员按公司标准注册 Windows 服务，不要在脚本的凭据窗口中填写虚假密码。

## 一、最后要得到什么

完成后，服务器上会有一个名为 **FlowPilot API** 的 Windows 服务：

- 服务自动启动；
- 后端只监听本机 `127.0.0.1:3000`；
- 数据保存在 SQL Server；
- 附件保存在部署目录外置的 `Data\Attachments`；
- 两个健康检查都返回 `ok`。

本手册统一使用下面的示例值：

| 项目 | 示例值 |
| --- | --- |
| 部署目录 | `D:\FlowPilot` |
| 发布版本号 | `2026.09.04.1` |
| 网站域名 | `flowpilot.internal.example` |
| Windows 服务账号 | `DOMAIN\svc_flowpilot` |
| Windows 服务名 | `FlowPilot API` |

实际部署时，把示例值替换成你拿到的真实值。

整个操作顺序只有十步：

```text
拿到发布包和账号
→ DBA 准备数据库
→ 安装 .NET Runtime
→ 创建目录
→ 复制发布文件
→ 填写两个配置文件
→ 设置文件夹权限
→ 创建 current
→ 安装并启动 Windows 服务
→ 检查 live、ready 和监听地址
```

## 二、开始前必须拿到的东西

在操作服务器前，逐项确认。任何一项没有拿到，都先停止部署。

- [ ] 开发人员提供的发布压缩包，例如 `FlowPilot-2026.09.04.1.zip`。
- [ ] 发布版本号，例如 `2026.09.04.1`。
- [ ] 公司批准的部署目录，例如 `D:\FlowPilot`。
- [ ] 对外访问域名或 IP，例如 `flowpilot.internal.example`。
- [ ] Windows 服务账号和密码。
- [ ] DBA 提供的完整 SQL Server **运行账号连接字符串**。
- [ ] DBA 确认数据库已经完成“初始化、Seed、运行账号验证”。
- [ ] DBA 确认的数据库排序规则，例如 `Chinese_PRC_CI_AS`。
- [ ] `.NET 10 ASP.NET Core Runtime x64` 安装程序。
- [ ] 如果本次启用域账号登录：LDAP 地址、Base DN、UPN 后缀。
- [ ] 如果本次启用邮件：SMTP 地址、端口、账号、密码和发件地址。

发布压缩包解压后必须直接看到：

```text
api
web
release.json
```

并且至少存在：

```text
api\FlowPilot.Api.exe
web\index.html
release.json
```

如果压缩包缺少这些文件，不要自己从源代码编译，退回开发人员重新提供。

## 三、请 DBA 先完成数据库准备

普通部署人员不要自己执行数据库脚本，也不要把 DBA 账号写入服务器配置。

把下面这段话发给 DBA，其中尖括号内容替换成真实值：

```text
请为 FlowPilot <发布版本号> 准备数据库：
1. 目标数据库：<数据库名>
2. 使用与本次发布包完全相同版本的 FlowPilot DatabaseTool
3. 依次执行 initialize、seed、verify
4. verify 必须使用后端长期运行账号通过
5. 请回复数据库结构版本、Seed 版本、排序规则和验证结果
6. 首次部署请单独通过安全渠道提供 superadmin 初始密码
```

只有 DBA 明确回复以下项目全部成功，才能继续：

| DBA 确认项 | 结果 |
| --- | --- |
| 数据库初始化或升级成功 |  |
| 内置数据 Seed 成功 |  |
| 运行账号 verify 成功 |  |
| 数据库兼容级别不低于 130 |  |
| 排序规则已确认 |  |
| 首次 `superadmin` 密码已安全交付 |  |

注意：服务器长期保存的配置中只放 SQL **运行账号**，绝对不能放迁移账号。

## 四、安装 .NET 运行环境

1. 登录目标服务器。
2. 双击运行 `.NET 10 ASP.NET Core Runtime x64` 安装程序。
3. 按安装程序提示完成安装。
4. 从开始菜单搜索 **PowerShell**。
5. 右键选择 **以管理员身份运行**。
6. 执行：

```powershell
dotnet --list-runtimes
```

正常情况能看到类似下面两行，最后的小版本号可以不同：

```text
Microsoft.AspNetCore.App 10.x.x
Microsoft.NETCore.App 10.x.x
```

如果看不到 `10` 开头的版本，停止部署，重新安装正确的 x64 Runtime。

## 五、创建部署目录

以下操作都在“管理员 PowerShell”中执行。

先设置本次部署使用的两个值：

```powershell
$FlowPilotDeployRoot = "D:\FlowPilot"
$FlowPilotReleaseId = "2026.09.04.1"
```

请只修改引号中的内容，不要删除 `$`、等号或引号。

第六节到第十二节会继续使用这两个变量。尽量不要关闭这个 PowerShell 窗口。如果中途关闭了，每次重新打开管理员 PowerShell 后，先重新执行上面两行。

然后整段复制执行：

```powershell
$FlowPilotReleasePath = Join-Path $FlowPilotDeployRoot "App\releases\$FlowPilotReleaseId"

if (Test-Path -LiteralPath $FlowPilotReleasePath) {
    throw "这个发布版本目录已经存在。请停止操作，不要覆盖旧目录。"
}

@(
    $FlowPilotReleasePath,
    (Join-Path $FlowPilotDeployRoot "Config"),
    (Join-Path $FlowPilotDeployRoot "Secrets"),
    (Join-Path $FlowPilotDeployRoot "Data\Attachments"),
    (Join-Path $FlowPilotDeployRoot "Logs"),
    (Join-Path $FlowPilotDeployRoot "Temp"),
    (Join-Path $FlowPilotDeployRoot "Backup")
) | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

$FlowPilotRootMarker = Join-Path $FlowPilotDeployRoot "flowpilot.root"
if (-not (Test-Path -LiteralPath $FlowPilotRootMarker -PathType Leaf)) {
    New-Item -ItemType File -Path $FlowPilotRootMarker | Out-Null
}
```

执行成功时一般没有红色错误。

打开资源管理器，进入 `D:\FlowPilot`，应看到：

```text
App
Backup
Config
Data
Logs
Secrets
Temp
flowpilot.root
```

确认文件名是 `flowpilot.root`，不能是 `flowpilot.root.txt`。

## 六、复制发布文件

1. 解压开发人员提供的压缩包。
2. 把解压后的 `api`、`web` 和 `release.json` 复制到：

```text
D:\FlowPilot\App\releases\2026.09.04.1
```

3. 复制完成后执行下面的检查：

```powershell
$FlowPilotReleasePath = Join-Path $FlowPilotDeployRoot "App\releases\$FlowPilotReleaseId"

$FlowPilotRequiredFiles = @(
    (Join-Path $FlowPilotReleasePath "api\FlowPilot.Api.exe"),
    (Join-Path $FlowPilotReleasePath "web\index.html"),
    (Join-Path $FlowPilotReleasePath "release.json")
)

$FlowPilotMissingFiles = $FlowPilotRequiredFiles | Where-Object {
    -not (Test-Path -LiteralPath $_ -PathType Leaf)
}

if ($FlowPilotMissingFiles.Count -gt 0) {
    $FlowPilotMissingFiles
    throw "发布包不完整，请停止部署并联系开发人员。"
}

Write-Host "发布包检查通过。" -ForegroundColor Green
```

看到绿色的“发布包检查通过”才能继续。

## 七、创建非敏感配置文件

在管理员 PowerShell 中执行：

```powershell
notepad (Join-Path $FlowPilotDeployRoot "Config\appsettings.Production.json")
```

如果记事本询问是否创建文件，选择“是”。粘贴下面内容：

```json
{
  "FlowPilot": {
    "Http": {
      "AllowedHosts": "flowpilot.internal.example;127.0.0.1"
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

只需要修改两处：

1. `flowpilot.internal.example` 改成实际网站域名或 IP，但保留后面的 `;127.0.0.1`，它用于服务器本机健康检查。
2. `Chinese_PRC_CI_AS` 改成 DBA 确认的排序规则。

不要把 `AllowedHosts` 改成 `*`。

当前是公司内网 HTTP，所以 `CookieSecure` 保持 `false`。如果实际部署使用 HTTPS，改成 `true`。

保存并关闭记事本。

## 八、创建敏感配置文件

敏感配置里有数据库、LDAP 和 SMTP 密码。不要截图、发群聊或放进 Git。

在管理员 PowerShell 中执行：

```powershell
notepad (Join-Path $FlowPilotDeployRoot "Secrets\secrets.Production.json")
```

### 情况 A：暂时不启用域登录和邮件

粘贴下面内容，把整条连接字符串替换成 DBA 提供的 SQL 运行账号连接字符串：

```json
{
  "ConnectionStrings": {
    "FlowPilot": "Server=<SQL主机>;Database=<数据库名>;User ID=<运行账号>;Password=<运行密码>;Encrypt=false;TrustServerCertificate=true;Connection Timeout=15;Min Pool Size=0;Max Pool Size=100"
  },
  "FlowPilot": {
    "Smtp": {
      "Enabled": false
    }
  }
}
```

### 情况 B：启用域登录和邮件

粘贴下面内容，并替换所有尖括号内容：

```json
{
  "ConnectionStrings": {
    "FlowPilot": "Server=<SQL主机>;Database=<数据库名>;User ID=<运行账号>;Password=<运行密码>;Encrypt=false;TrustServerCertificate=true;Connection Timeout=15;Min Pool Size=0;Max Pool Size=100"
  },
  "FlowPilot": {
    "Ldap": {
      "Url": "ldap://<域服务器地址>:389",
      "BaseDn": "<目录搜索根>",
      "UpnSuffix": "<UPN后缀>",
      "TimeoutSeconds": 10,
      "AllowPlainText": true
    },
    "Smtp": {
      "Enabled": true,
      "TestEMail": "<联调测试邮箱>",
      "Host": "<SMTP主机>",
      "Port": 587,
      "Security": "starttls",
      "UserName": "<SMTP账号>",
      "Password": "<SMTP密码>",
      "From": "<发件邮箱>",
      "FromName": "FlowPilot"
    }
  }
}
```

联调期间填写 `TestEMail` 后，所有邮件只会发到测试邮箱。正式启用真实收件人前必须把它改成空字符串：

```json
"TestEMail": ""
```

这个文件中不要填写数据库迁移账号，也不要填写 `superadmin` 初始密码。

保存并关闭记事本。

## 九、检查两个配置文件是否写坏

在管理员 PowerShell 中整段执行：

```powershell
$FlowPilotConfigFile = Join-Path $FlowPilotDeployRoot "Config\appsettings.Production.json"
$FlowPilotSecretsFile = Join-Path $FlowPilotDeployRoot "Secrets\secrets.Production.json"

try {
    Get-Content -LiteralPath $FlowPilotConfigFile -Raw | ConvertFrom-Json | Out-Null
    Get-Content -LiteralPath $FlowPilotSecretsFile -Raw | ConvertFrom-Json | Out-Null
    Write-Host "两个配置文件格式正确。" -ForegroundColor Green
}
catch {
    Write-Host "配置文件格式错误，请检查逗号、双引号和大括号。" -ForegroundColor Red
    throw
}
```

看到绿色的“两个配置文件格式正确”才能继续。

注意：此检查只能确认 JSON 格式正确，不能确认数据库密码或地址正确。

## 十、设置文件夹权限

这一节建议由 Windows 管理员操作。如果你没有修改 NTFS 权限的经验，不要通过“给 Everyone 完全控制”解决问题。

必须保留 `SYSTEM` 和服务器管理员的权限，再给 Windows 服务账号增加下面的权限：

| 路径 | 服务账号权限 |
| --- | --- |
| `D:\FlowPilot\flowpilot.root` | 读取 |
| `D:\FlowPilot\App` | 读取和执行 |
| `D:\FlowPilot\Config` | 读取 |
| `D:\FlowPilot\Secrets` | 读取 |
| `D:\FlowPilot\Data\Attachments` | 修改 |
| `D:\FlowPilot\Logs` | 修改 |
| `D:\FlowPilot\Temp` | 修改 |

操作方法：

1. 在资源管理器中右键对应文件夹，选择“属性”。
2. 打开“安全”页签。
3. 点击“编辑”→“添加”。
4. 输入服务账号，例如 `DOMAIN\svc_flowpilot`。
5. 按上表勾选权限。
6. 点击“应用”。

不要给服务账号以下权限：

- 本地管理员；
- 对整个部署盘的完全控制；
- SQL Server `sysadmin`；
- IIS 前端目录以外不必要的权限。

后续配置 IIS 时，IIS 应用程序池账号不能读取 `Secrets` 和 `Data\Attachments`。

## 十一、创建 current 目录联接

Windows 服务以后永远从 `App\current` 启动，而不是写死某个版本号。

在管理员 PowerShell 中执行：

```powershell
$FlowPilotReleasePath = Join-Path $FlowPilotDeployRoot "App\releases\$FlowPilotReleaseId"
$FlowPilotCurrentPath = Join-Path $FlowPilotDeployRoot "App\current"

if (Test-Path -LiteralPath $FlowPilotCurrentPath) {
    throw "current 已经存在。这不是首次安装，请停止操作。"
}

New-Item -ItemType Junction -Path $FlowPilotCurrentPath -Target $FlowPilotReleasePath | Out-Null

$FlowPilotCurrentItem = Get-Item -LiteralPath $FlowPilotCurrentPath
Write-Host "current 指向：$($FlowPilotCurrentItem.Target)" -ForegroundColor Green
```

显示的路径必须是本次版本，例如：

```text
D:\FlowPilot\App\releases\2026.09.04.1
```

如果指向别处，停止部署，不要继续注册服务。

## 十二、安装 Windows 服务

确认你已经拿到服务账号和密码，并且该账号已被允许“作为服务登录”。

在管理员 PowerShell 中执行，先修改服务账号：

```powershell
$FlowPilotServiceAccount = "DOMAIN\svc_flowpilot"
$FlowPilotServiceName = "FlowPilot API"
$FlowPilotApiExe = Join-Path $FlowPilotDeployRoot "App\current\api\FlowPilot.Api.exe"

if (-not (Test-Path -LiteralPath $FlowPilotApiExe -PathType Leaf)) {
    throw "找不到 FlowPilot.Api.exe，请检查 current 指向和发布包。"
}

if (Get-Service -Name $FlowPilotServiceName -ErrorAction SilentlyContinue) {
    throw "FlowPilot API 服务已经存在。这不是首次安装，请停止操作。"
}

$FlowPilotServiceCredential = Get-Credential -UserName $FlowPilotServiceAccount
$FlowPilotServiceCommand = "`"$FlowPilotApiExe`" --environment Production"

New-Service -Name $FlowPilotServiceName -BinaryPathName $FlowPilotServiceCommand -DisplayName $FlowPilotServiceName -Description "FlowPilot ASP.NET Core API" -StartupType Automatic -Credential $FlowPilotServiceCredential

sc.exe config $FlowPilotServiceName start= delayed-auto
sc.exe failure $FlowPilotServiceName reset= 86400 actions= restart/60000/restart/300000/restart/900000
sc.exe failureflag $FlowPilotServiceName 1
```

系统会弹出凭据窗口。输入服务账号密码，不要把密码写进 PowerShell 命令。

然后启动服务：

```powershell
Start-Service "FlowPilot API"
Start-Sleep -Seconds 5
Get-Service "FlowPilot API"
```

正常结果中的 `Status` 是：

```text
Running
```

如果是 `Stopped`，不要连续重试，直接看第十五节“故障处理”。

## 十三、检查后端是否正常

### 1. 检查日志

打开：

```text
D:\FlowPilot\Logs
```

应当出现名称类似下面的日志文件：

```text
flowpilot-api-20260904.json
```

### 2. 检查存活状态

在管理员 PowerShell 中执行：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/flowpilot/v1/health/live"
```

正常结果包含：

```text
status : ok
```

### 3. 检查数据库准备状态

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/flowpilot/v1/health/ready"
```

正常结果同样包含：

```text
status : ok
```

如果返回 `503`，通常是数据库连接、Seed 或数据库结构问题，按第十五节处理。

当前版本的 ready 接口主要检查数据库和 Seed；附件目录权限仍要按第十节人工确认，不能只依赖 ready 结果。

### 4. 检查监听地址

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalAddress, LocalPort
```

正确结果：

```text
LocalAddress LocalPort
------------ ---------
127.0.0.1         3000
```

如果看到 `0.0.0.0`、`::` 或服务器局域网 IP，立即停止服务并联系开发人员。

## 十四、后端部署完成标准

下面全部勾选后，后端首次部署才算完成：

- [ ] `.NET 10 ASP.NET Core Runtime x64` 已安装。
- [ ] 发布包中的 `api`、`web`、`release.json` 完整。
- [ ] DBA 已确认 initialize、seed、verify 全部成功。
- [ ] Config 和 Secrets JSON 格式检查通过。
- [ ] Secrets 只包含 SQL 运行账号，不包含迁移账号。
- [ ] Windows 服务账号权限已按表设置。
- [ ] `current` 指向本次 release。
- [ ] `FlowPilot API` 服务状态为 `Running`。
- [ ] `health/live` 返回 `ok`。
- [ ] `health/ready` 返回 `ok`。
- [ ] 端口 3000 只监听 `127.0.0.1`。
- [ ] 日志写入 `D:\FlowPilot\Logs`。

完成后再交给 IIS 管理员，继续按照 [`IIS_DEPLOYMENT.md`](./IIS_DEPLOYMENT.md) 配置前端和 `/api/flowpilot/*` 反向代理。

## 十五、故障处理

### 服务启动后马上停止

按下面顺序检查：

1. `D:\FlowPilot\Logs` 是否有最新日志。
2. `D:\FlowPilot\flowpilot.root` 是否存在且没有 `.txt` 后缀。
3. `D:\FlowPilot\App\current\api\FlowPilot.Api.exe` 是否存在。
4. `Config\appsettings.Production.json` 是否存在。
5. `Secrets\secrets.Production.json` 是否存在。
6. 服务账号是否能读取 Config、Secrets 和 API 文件。
7. 服务账号是否能写入 Logs、Temp 和 Data\Attachments。

如果 Windows 服务显示错误 `1069`，通常是服务账号密码错误、密码已过期或账号没有“作为服务登录”权限。请让 Windows 管理员在“服务”管理器中修正登录账号，不要删除 release 或数据库。

仍无法启动时，把下面信息发给开发人员：

- releaseId；
- Windows 服务状态；
- Windows 事件查看器中的错误；
- 最新日志中错误附近的内容；
- 不要发送 Secrets 文件或数据库密码。

### 健康检查返回 400

最常见原因是 `AllowedHosts` 写错。

确认 Config 中的 `FlowPilot.Http.AllowedHosts` 至少包含：

```text
实际网站域名或 IP
127.0.0.1
```

不要为了通过检查把 `AllowedHosts` 改成 `*`。

### 健康检查返回 503

把返回内容中的 `code` 记录下来，交给 DBA 或开发人员。常见原因：

- SQL Server 地址、账号或密码错误；
- SQL Server 证书不受服务器信任；
- DBA 未完成初始化或 Seed；
- 运行账号权限不足；
- 数据库排序规则与 Config 不一致；

不要通过给 SQL 运行账号 `sysadmin` 来绕过错误。

### 日志提示找不到 Runtime

重新确认安装的是 `.NET 10 ASP.NET Core Runtime x64`，不是只安装普通 `.NET Runtime`，也不是 x86 版本。

### 日志提示配置文件格式错误

重新执行第九节的 JSON 检查。重点检查：

- 每一项之间是否有英文逗号；
- 是否误用了中文引号；
- 大括号是否成对；
- 密码中如果包含双引号，是否由开发人员正确进行 JSON 转义。

不熟悉 JSON 时，不要反复试错，请让开发人员生成完整的 Secrets 文件并通过安全渠道交付。

## 十六、升级和回滚说明

本手册只用于第一次安装。

升级和回滚会涉及：

- 停止 Windows 服务和 IIS；
- 数据库与附件备份；
- 数据库结构兼容性确认；
- `current`、`previous` 目录联接切换；
- 失败后的回滚判断。

这些操作做错可能造成程序版本与数据库版本不匹配。仓库目前还没有给普通部署人员使用的一键升级脚本，因此不要用“复制并覆盖 `App\current`”的方式升级。

升级前由开发、DBA 和 Windows 管理员共同按照 [`IIS_DEPLOYMENT.md`](./IIS_DEPLOYMENT.md) 的升级与回滚章节制定本次变更单。

## 十七、部署结果记录

把下面内容复制到上线工单：

```text
部署日期：
部署服务器：
部署根目录：
releaseId：
Git commit（来自 release.json）：
Windows 服务账号：
.NET Runtime 版本：
SQL Server 版本：
数据库名：
数据库结构版本：
Seed 版本：
数据库排序规则：
current 实际指向：
health/live 结果：
health/ready 结果：
端口 3000 监听地址：
日志文件位置：
部署人员：
复核人员：
```
