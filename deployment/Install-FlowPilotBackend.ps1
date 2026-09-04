#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(DontShow = $true)]
    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:TemporaryExtractDirectory = $null
$script:ServiceName = "FlowPilot API"

function Write-Title {
    param([Parameter(Mandatory = $true)][string]$Text)

    Write-Host ""
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
}

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Text)

    Write-Host ""
    Write-Host "[步骤] $Text" -ForegroundColor Cyan
}

function Write-Success {
    param([Parameter(Mandatory = $true)][string]$Text)

    Write-Host "[成功] $Text" -ForegroundColor Green
}

function Write-WarningMessage {
    param([Parameter(Mandatory = $true)][string]$Text)

    Write-Host "[注意] $Text" -ForegroundColor Yellow
}

function Stop-Installation {
    param([Parameter(Mandatory = $true)][string]$Message)

    throw $Message
}

function Read-RequiredValue {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [string]$DefaultValue = ""
    )

    while ($true) {
        $displayPrompt = $Prompt
        if (-not [string]::IsNullOrWhiteSpace($DefaultValue)) {
            $displayPrompt = "$Prompt [$DefaultValue]"
        }

        $value = Read-Host $displayPrompt
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = $DefaultValue
        }

        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim().Trim('"')
        }

        Write-WarningMessage "此项不能为空，请重新输入。"
    }
}

function Read-OptionalValue {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    $value = Read-Host $Prompt
    if ($null -eq $value) {
        return ""
    }

    return $value.Trim()
}

function Read-YesNo {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [bool]$DefaultYes = $false
    )

    $suffix = "[y/N]"
    if ($DefaultYes) {
        $suffix = "[Y/n]"
    }

    while ($true) {
        $answer = (Read-Host "$Prompt $suffix").Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $DefaultYes
        }

        if ($answer -in @("y", "yes", "是")) {
            return $true
        }

        if ($answer -in @("n", "no", "否")) {
            return $false
        }

        Write-WarningMessage "请输入 y 或 n。"
    }
}

function ConvertTo-PlainText {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Assert-RunningAsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $administratorRole = [Security.Principal.WindowsBuiltInRole]::Administrator

    if (-not $principal.IsInRole($administratorRole)) {
        Stop-Installation "请关闭当前窗口，右键 PowerShell，选择【以管理员身份运行】，然后重新执行脚本。"
    }
}

function Assert-DotNetRuntime {
    $dotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
    if ($null -eq $dotnetCommand) {
        Stop-Installation "没有找到 dotnet.exe。请先安装 .NET 10 ASP.NET Core Runtime x64，然后重新运行脚本。"
    }

    $runtimes = @(& $dotnetCommand.Source --list-runtimes 2>&1)
    $hasAspNetCore = @($runtimes | Where-Object { $_ -match '^Microsoft\.AspNetCore\.App 10\.' }).Count -gt 0
    $hasDotNetCore = @($runtimes | Where-Object { $_ -match '^Microsoft\.NETCore\.App 10\.' }).Count -gt 0

    if (-not $hasAspNetCore -or -not $hasDotNetCore) {
        Write-Host ($runtimes -join [Environment]::NewLine)
        Stop-Installation "没有检测到完整的 .NET 10 ASP.NET Core Runtime x64。请安装后重新运行脚本。"
    }

    Write-Success "已检测到 .NET 10 ASP.NET Core Runtime。"
    return $runtimes
}

function Get-NormalizedDeployRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.Path]::IsPathRooted($Path)) {
        Stop-Installation "部署目录必须是绝对路径，例如 D:\FlowPilot。"
    }

    $normalized = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $root = [IO.Path]::GetPathRoot($normalized).TrimEnd('\', '/')

    if ([string]::Equals($normalized, $root, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Installation "部署目录不能直接使用磁盘根目录。请使用类似 D:\FlowPilot 的目录。"
    }

    if ($normalized.StartsWith('\\')) {
        Stop-Installation "部署目录不能使用网络共享，必须使用服务器本机 NTFS 磁盘。"
    }

    try {
        $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($normalized))
        if (-not $drive.IsReady -or $drive.DriveFormat -ne "NTFS") {
            Stop-Installation "部署目录必须位于已经就绪的本机 NTFS 磁盘。"
        }
        if ($drive.AvailableFreeSpace -lt 3GB) {
            Stop-Installation "部署磁盘可用空间不足 3 GiB。请先清理或扩容。"
        }
    }
    catch {
        Stop-Installation "无法确认部署磁盘类型和可用空间：$($_.Exception.Message)"
    }

    return $normalized
}

function Assert-ReleaseId {
    param([Parameter(Mandatory = $true)][string]$ReleaseId)

    if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        Stop-Installation "releaseId 只能包含字母、数字、点、下划线和连字符，长度不能超过 64。"
    }
}

function Assert-AllowedHost {
    param([Parameter(Mandatory = $true)][string]$HostName)

    if ($HostName -match '[:][/][/]' -or
        $HostName.Contains('/') -or
        $HostName.Contains('\') -or
        $HostName.Contains('*') -or
        $HostName.Contains('@') -or
        $HostName.Contains(';')) {
        Stop-Installation "网站域名只能填写主机名或 IP，不能包含 http://、路径、通配符或分号。"
    }
}

function Assert-EmailAddress {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$FieldName
    )

    try {
        $address = New-Object System.Net.Mail.MailAddress($Value)
        if (-not [string]::Equals($address.Address, $Value, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Installation "$FieldName 不是有效的邮箱地址。"
        }
    }
    catch {
        Stop-Installation "$FieldName 不是有效的邮箱地址。"
    }
}

function Assert-SqlConnectionString {
    param([Parameter(Mandatory = $true)][string]$ConnectionString)

    try {
        $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder($ConnectionString)
    }
    catch {
        Stop-Installation "SQL Server 连接字符串格式无效。请向 DBA 索取完整的运行账号连接字符串。"
    }

    if ([string]::IsNullOrWhiteSpace($builder.DataSource) -or
        [string]::IsNullOrWhiteSpace($builder.InitialCatalog) -or
        [string]::IsNullOrWhiteSpace($builder.UserID) -or
        [string]::IsNullOrWhiteSpace($builder.Password)) {
        Stop-Installation "连接字符串必须包含 Server、Database、User ID 和 Password。"
    }

    if ($builder.IntegratedSecurity) {
        Stop-Installation "当前部署要求使用 SQL 账号，不能使用 Integrated Security。"
    }

    if (-not $builder.ContainsKey("Encrypt") -or -not $builder.Encrypt) {
        Stop-Installation "生产连接字符串必须设置 Encrypt=true。"
    }

    if (-not $builder.ContainsKey("TrustServerCertificate") -or $builder.TrustServerCertificate) {
        Stop-Installation "生产连接字符串必须设置 TrustServerCertificate=false。"
    }
}

function Resolve-PackageRoot {
    param([Parameter(Mandatory = $true)][string]$ExtractDirectory)

    $candidates = New-Object System.Collections.Generic.List[string]
    $candidates.Add($ExtractDirectory)

    $topLevelDirectories = @(Get-ChildItem -LiteralPath $ExtractDirectory -Force -Directory)
    if ($topLevelDirectories.Count -eq 1) {
        $candidates.Add($topLevelDirectories[0].FullName)
    }

    foreach ($candidate in $candidates) {
        $apiExe = Join-Path $candidate "api\FlowPilot.Api.exe"
        $webIndex = Join-Path $candidate "web\index.html"
        $manifest = Join-Path $candidate "release.json"

        if ((Test-Path -LiteralPath $apiExe -PathType Leaf) -and
            (Test-Path -LiteralPath $webIndex -PathType Leaf) -and
            (Test-Path -LiteralPath $manifest -PathType Leaf)) {
            return $candidate
        }
    }

    Stop-Installation "压缩包结构不正确。解压后必须包含 api、web 和 release.json。"
}

function Read-ReleaseManifest {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    $manifestPath = Join-Path $PackageRoot "release.json"
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        Stop-Installation "release.json 不是有效的 JSON，请联系开发人员重新提供发布包。"
    }

    $releaseProperty = $manifest.PSObject.Properties["releaseId"]
    if ($null -eq $releaseProperty -or [string]::IsNullOrWhiteSpace([string]$releaseProperty.Value)) {
        Stop-Installation "release.json 缺少 releaseId，请联系开发人员重新提供发布包。"
    }

    Assert-ReleaseId ([string]$releaseProperty.Value)
    return $manifest
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $json = $Value | ConvertTo-Json -Depth 10
    # Windows PowerShell 5.1 and Windows Server 2016 Notepad require the BOM
    # to display Chinese configuration values reliably.
    $encoding = New-Object Text.UTF8Encoding($true)
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $encoding)

    try {
        Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json | Out-Null
    }
    catch {
        Stop-Installation "脚本写出的配置文件无法读取：$Path"
    }
}

function Add-AccessRule {
    param(
        [Parameter(Mandatory = $true)][Security.AccessControl.FileSystemSecurity]$Acl,
        [Parameter(Mandatory = $true)][Security.Principal.SecurityIdentifier]$Sid,
        [Parameter(Mandatory = $true)][Security.AccessControl.FileSystemRights]$Rights,
        [bool]$IsDirectory
    )

    if ($IsDirectory) {
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $Sid,
            $Rights,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
    }
    else {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $Sid,
            $Rights,
            [Security.AccessControl.AccessControlType]::Allow)
    }

    [void]$Acl.AddAccessRule($rule)
}

function Set-ExactDirectoryAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][Security.Principal.SecurityIdentifier]$ServiceSid,
        [Security.AccessControl.FileSystemRights]$ServiceRights,
        [bool]$GrantService = $true
    )

    $systemSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)

    Add-AccessRule $acl $systemSid ([Security.AccessControl.FileSystemRights]::FullControl) $true
    Add-AccessRule $acl $administratorsSid ([Security.AccessControl.FileSystemRights]::FullControl) $true
    if ($GrantService) {
        Add-AccessRule $acl $ServiceSid $ServiceRights $true
    }

    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-ExactFileAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][Security.Principal.SecurityIdentifier]$ServiceSid,
        [Parameter(Mandatory = $true)][Security.AccessControl.FileSystemRights]$ServiceRights
    )

    $systemSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)

    Add-AccessRule $acl $systemSid ([Security.AccessControl.FileSystemRights]::FullControl) $false
    Add-AccessRule $acl $administratorsSid ([Security.AccessControl.FileSystemRights]::FullControl) $false
    Add-AccessRule $acl $ServiceSid $ServiceRights $false
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-ExactTreeAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][Security.Principal.SecurityIdentifier]$ServiceSid,
        [Parameter(Mandatory = $true)][Security.AccessControl.FileSystemRights]$ServiceRights,
        [bool]$GrantService = $true
    )

    $reparsePoints = @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop |
        Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
    if ($reparsePoints.Count -gt 0) {
        Stop-Installation "发布目录包含不允许的目录联接或符号链接：$($reparsePoints[0].FullName)"
    }

    Set-ExactDirectoryAcl $Path $ServiceSid $ServiceRights $GrantService

    $directories = @(Get-ChildItem -LiteralPath $Path -Force -Recurse -Directory)
    foreach ($directory in $directories) {
        Set-ExactDirectoryAcl $directory.FullName $ServiceSid $ServiceRights $GrantService
    }

    $files = @(Get-ChildItem -LiteralPath $Path -Force -Recurse -File)
    foreach ($file in $files) {
        $systemSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
        $administratorsSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        Add-AccessRule $acl $systemSid ([Security.AccessControl.FileSystemRights]::FullControl) $false
        Add-AccessRule $acl $administratorsSid ([Security.AccessControl.FileSystemRights]::FullControl) $false
        if ($GrantService) {
            Add-AccessRule $acl $ServiceSid $ServiceRights $false
        }
        Set-Acl -LiteralPath $file.FullName -AclObject $acl
    }
}

function Add-DeployRootTraversePermission {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][Security.Principal.SecurityIdentifier]$ServiceSid
    )

    $acl = Get-Acl -LiteralPath $Path
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $ServiceSid,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-MarkerSearch {
    param(
        [Parameter(Mandatory = $true)][string]$StartDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedRoot
    )

    $markers = New-Object System.Collections.Generic.List[string]
    $current = New-Object IO.DirectoryInfo([IO.Path]::GetFullPath($StartDirectory))

    for ($index = 0; $null -ne $current -and $index -lt 6; $index++) {
        if (Test-Path -LiteralPath (Join-Path $current.FullName "flowpilot.root") -PathType Leaf) {
            $markers.Add($current.FullName.TrimEnd('\', '/'))
        }
        $current = $current.Parent
    }

    if ($markers.Count -ne 1 -or
        -not [string]::Equals($markers[0], $ExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Installation "flowpilot.root 位置不正确或搜索范围内存在多个标记。请联系开发人员检查部署目录。"
    }
}

function Assert-CurrentJunction {
    param(
        [Parameter(Mandatory = $true)][string]$CurrentPath,
        [Parameter(Mandatory = $true)][string]$ExpectedTarget
    )

    $item = Get-Item -LiteralPath $CurrentPath
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        Stop-Installation "App\current 已存在，但它不是目录联接。脚本不会覆盖它。"
    }

    $target = [IO.Path]::GetFullPath([string]$item.Target).TrimEnd('\', '/')
    $expected = [IO.Path]::GetFullPath($ExpectedTarget).TrimEnd('\', '/')
    if (-not [string]::Equals($target, $expected, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Installation "App\current 指向其他版本。此脚本只用于首次安装或同版本中断后继续。"
    }
}

function Invoke-HealthCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Uri
    )

    $lastError = ""
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 10
            if ([string]::Equals([string]$response.status, "ok", [StringComparison]::OrdinalIgnoreCase)) {
                Write-Success "$Name 返回 ok。"
                return $true
            }
            $lastError = "接口返回的 status 不是 ok。"
        }
        catch {
            $lastError = $_.Exception.Message
        }

        if ($attempt -lt 6) {
            Start-Sleep -Seconds 5
        }
    }

    Write-Host "[失败] $Name 未通过：$lastError" -ForegroundColor Red
    return $false
}

function Remove-TemporaryExtractDirectory {
    if ([string]::IsNullOrWhiteSpace($script:TemporaryExtractDirectory)) {
        return
    }

    if (-not (Test-Path -LiteralPath $script:TemporaryExtractDirectory)) {
        return
    }

    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($script:TemporaryExtractDirectory).TrimEnd('\', '/')
    $expectedPrefix = $temporaryRoot + [IO.Path]::DirectorySeparatorChar + "FlowPilotInstall-"

    if (-not $candidate.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Write-WarningMessage "临时目录不在预期边界内，脚本未自动删除：$candidate"
        return
    }

    try {
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
    catch {
        Write-WarningMessage "无法自动清理临时解压目录，请稍后由管理员删除：$candidate"
    }
}

if (-not $LibraryOnly) {
try {
    Clear-Host
    Write-Title "FlowPilot 后端首次安装向导"
    Write-Host "本脚本将创建部署目录、写入配置、设置权限、创建 current、注册 Windows 服务并执行健康检查。"
    Write-Host "本脚本不会初始化数据库，也不会保存数据库迁移账号。"
    Write-Host ""

    if (-not (Read-YesNo "是否继续" $false)) {
        Write-Host "已取消。"
        exit 0
    }

    Assert-RunningAsAdministrator

    Write-Step "检查 .NET 运行环境"
    $installedRuntimes = Assert-DotNetRuntime

    Write-Step "读取并检查发布压缩包"
    $packagePath = Read-RequiredValue "请输入发布 zip 完整路径"
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        Stop-Installation "找不到发布压缩包：$packagePath"
    }
    if ([IO.Path]::GetExtension($packagePath) -ne ".zip") {
        Stop-Installation "发布包必须是 .zip 文件。"
    }

    $script:TemporaryExtractDirectory = Join-Path ([IO.Path]::GetTempPath()) ("FlowPilotInstall-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $script:TemporaryExtractDirectory | Out-Null
    Expand-Archive -LiteralPath $packagePath -DestinationPath $script:TemporaryExtractDirectory
    $packageRoot = Resolve-PackageRoot $script:TemporaryExtractDirectory
    $manifest = Read-ReleaseManifest $packageRoot
    $releaseId = [string]$manifest.releaseId
    Write-Success "发布包结构正确，releaseId：$releaseId"

    Write-Step "收集部署信息"
    $deployRootInput = Read-RequiredValue "请输入部署目录" "D:\FlowPilot"
    $deployRoot = Get-NormalizedDeployRoot $deployRootInput
    $externalHost = Read-RequiredValue "请输入网站域名或 IP（不要带 http://）"
    Assert-AllowedHost $externalHost
    $expectedCollation = Read-RequiredValue "请输入 DBA 确认的数据库排序规则" "Chinese_PRC_CI_AS"
    $serviceAccount = Read-RequiredValue "请输入 Windows 服务账号，例如 DOMAIN\svc_flowpilot"

    try {
        $serviceNtAccount = New-Object Security.Principal.NTAccount($serviceAccount)
        $serviceSid = $serviceNtAccount.Translate([Security.Principal.SecurityIdentifier])
    }
    catch {
        Stop-Installation "服务器无法识别服务账号 $serviceAccount。请检查账号名称、域连接和账号状态。"
    }

    $useHttps = Read-YesNo "用户最终是否通过 HTTPS 访问" $false

    Write-Host "请粘贴 DBA 提供的 SQL 运行账号连接字符串。输入内容不会显示在屏幕上。" -ForegroundColor Yellow
    $connectionStringSecure = Read-Host "SQL 运行账号连接字符串" -AsSecureString
    $connectionString = ConvertTo-PlainText $connectionStringSecure
    Assert-SqlConnectionString $connectionString

    $enableLdap = Read-YesNo "本次是否启用域账号登录（LDAPS）" $false
    $ldapUrl = ""
    $ldapBaseDn = ""
    $ldapUpnSuffix = ""
    if ($enableLdap) {
        $ldapUrl = Read-RequiredValue "LDAPS 地址，例如 ldaps://dc01.internal.example"
        $ldapBaseDn = Read-RequiredValue "Base DN，例如 DC=internal,DC=example"
        $ldapUpnSuffix = Read-RequiredValue "UPN 后缀，例如 internal.example"

        $ldapUri = $null
        if (-not [Uri]::TryCreate($ldapUrl, [UriKind]::Absolute, [ref]$ldapUri) -or
            $ldapUri.Scheme -ne "ldaps" -or
            [string]::IsNullOrWhiteSpace($ldapUri.Host) -or
            -not [string]::IsNullOrEmpty($ldapUri.UserInfo) -or
            $ldapUri.AbsolutePath -ne "/" -or
            -not [string]::IsNullOrEmpty($ldapUri.Query) -or
            -not [string]::IsNullOrEmpty($ldapUri.Fragment)) {
            Stop-Installation "LDAPS 地址无效。请只填写类似 ldaps://dc01.internal.example 的服务器地址。"
        }
    }

    $enableSmtp = Read-YesNo "本次是否启用邮件发送" $false
    $smtpHost = ""
    $smtpPort = 587
    $smtpUserName = ""
    $smtpPassword = ""
    $smtpFrom = ""
    $smtpFromName = "FlowPilot"
    $smtpTestEmail = ""
    if ($enableSmtp) {
        $smtpHost = Read-RequiredValue "SMTP 主机"
        $smtpPortText = Read-RequiredValue "SMTP 端口" "587"
        $parsedSmtpPort = 0
        if (-not [int]::TryParse($smtpPortText, [ref]$parsedSmtpPort) -or
            $parsedSmtpPort -lt 1 -or $parsedSmtpPort -gt 65535) {
            Stop-Installation "SMTP 端口必须是 1 到 65535。"
        }
        $smtpPort = $parsedSmtpPort
        $smtpUserName = Read-OptionalValue "SMTP 账号（服务器不要求认证时直接回车）"
        if (-not [string]::IsNullOrWhiteSpace($smtpUserName)) {
            $smtpPasswordSecure = Read-Host "SMTP 密码（输入内容不会显示）" -AsSecureString
            $smtpPassword = ConvertTo-PlainText $smtpPasswordSecure
            if ([string]::IsNullOrWhiteSpace($smtpPassword)) {
                Stop-Installation "填写 SMTP 账号后必须填写密码。"
            }
        }
        $smtpFrom = Read-RequiredValue "固定发件邮箱"
        Assert-EmailAddress $smtpFrom "固定发件邮箱"
        $smtpFromNameInput = Read-OptionalValue "发件人名称 [FlowPilot]"
        if (-not [string]::IsNullOrWhiteSpace($smtpFromNameInput)) {
            $smtpFromName = $smtpFromNameInput
        }
        $smtpTestEmail = Read-OptionalValue "联调测试邮箱（暂不限制收件人时直接回车）"
        if (-not [string]::IsNullOrWhiteSpace($smtpTestEmail)) {
            Assert-EmailAddress $smtpTestEmail "联调测试邮箱"
        }
    }

    Write-Step "确认 DBA 状态"
    Write-Host "DBA 必须已经使用同版本 DatabaseTool 完成 initialize、seed、verify。" -ForegroundColor Yellow
    $dbaConfirmation = Read-Host "确认完成后请输入 DBA-READY"
    if ($dbaConfirmation -cne "DBA-READY") {
        Stop-Installation "未确认数据库准备完成。请联系 DBA，完成后重新运行脚本。"
    }

    Write-Title "请核对安装信息"
    Write-Host "发布包：       $packagePath"
    Write-Host "releaseId：    $releaseId"
    Write-Host "部署目录：     $deployRoot"
    Write-Host "网站域名/IP：  $externalHost"
    Write-Host "数据库排序规则：$expectedCollation"
    Write-Host "服务账号：     $serviceAccount"
    Write-Host "HTTPS：        $useHttps"
    Write-Host "LDAPS：        $enableLdap"
    Write-Host "SMTP：         $enableSmtp"
    Write-Host "SQL 和 SMTP 密码不会显示。"
    Write-Host ""
    $installConfirmation = Read-Host "确认无误后请输入 INSTALL"
    if ($installConfirmation -cne "INSTALL") {
        Stop-Installation "用户取消安装。"
    }

    Write-Step "创建部署目录"
    $releasePath = Join-Path $deployRoot "App\releases\$releaseId"
    $configDirectory = Join-Path $deployRoot "Config"
    $secretsDirectory = Join-Path $deployRoot "Secrets"
    $attachmentsDirectory = Join-Path $deployRoot "Data\Attachments"
    $logsDirectory = Join-Path $deployRoot "Logs"
    $tempDirectory = Join-Path $deployRoot "Temp"
    $backupDirectory = Join-Path $deployRoot "Backup"
    $rootMarker = Join-Path $deployRoot "flowpilot.root"

    @(
        $releasePath,
        $configDirectory,
        $secretsDirectory,
        $attachmentsDirectory,
        $logsDirectory,
        $tempDirectory,
        $backupDirectory
    ) | ForEach-Object {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }

    if (Test-Path -LiteralPath $rootMarker -PathType Container) {
        Stop-Installation "flowpilot.root 已存在但它是目录，必须由管理员处理。"
    }
    if (-not (Test-Path -LiteralPath $rootMarker -PathType Leaf)) {
        New-Item -ItemType File -Path $rootMarker | Out-Null
    }

    $existingReleaseFiles = @(Get-ChildItem -LiteralPath $releasePath -Force)
    if ($existingReleaseFiles.Count -eq 0) {
        Get-ChildItem -LiteralPath $packageRoot -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $releasePath -Recurse
        }
    }
    else {
        Write-WarningMessage "release 目录已有文件，脚本将按同版本中断恢复处理，不会覆盖这些文件。"
    }

    $deployedPackageRoot = Resolve-PackageRoot $releasePath
    $deployedManifest = Read-ReleaseManifest $deployedPackageRoot
    if (-not [string]::Equals([string]$deployedManifest.releaseId, $releaseId, [StringComparison]::Ordinal)) {
        Stop-Installation "服务器 release 目录中的 releaseId 与压缩包不一致。"
    }
    Write-Success "部署目录和发布文件准备完成。"

    Write-Step "设置服务账号文件权限"
    Add-DeployRootTraversePermission $deployRoot $serviceSid
    $appDirectory = Join-Path $deployRoot "App"
    Set-ExactDirectoryAcl $appDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::ReadAndExecute) $true
    Set-ExactTreeAcl (Join-Path $appDirectory "releases") $serviceSid ([Security.AccessControl.FileSystemRights]::ReadAndExecute) $true
    Set-ExactTreeAcl $configDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::Read) $true
    Set-ExactTreeAcl $secretsDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::Read) $true
    Set-ExactTreeAcl $attachmentsDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::Modify) $true
    Set-ExactTreeAcl $logsDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::Modify) $true
    Set-ExactTreeAcl $tempDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::Modify) $true
    Set-ExactTreeAcl $backupDirectory $serviceSid ([Security.AccessControl.FileSystemRights]::FullControl) $false
    Set-ExactFileAcl $rootMarker $serviceSid ([Security.AccessControl.FileSystemRights]::Read)
    Write-Success "已设置 SYSTEM、本机 Administrators 和服务账号权限。"

    Write-Step "生成生产配置"
    $allowedHosts = "$externalHost;127.0.0.1"
    $config = [ordered]@{
        FlowPilot = [ordered]@{
            Http = [ordered]@{
                AllowedHosts = $allowedHosts
            }
            Authentication = [ordered]@{
                CookieSecure = $useHttps
            }
            Database = [ordered]@{
                ExpectedCollation = $expectedCollation
                ApplicationCommandTimeoutSeconds = 30
                ReadinessCommandTimeoutSeconds = 5
                SchemaProbeCommandTimeoutSeconds = 15
                MigrationPreflightCommandTimeoutSeconds = 15
                MigrationCommandTimeoutSeconds = 300
            }
            Attachments = [ordered]@{
                MaximumFileSizeMb = 100
                MinimumFreeSpaceBytes = 2147483648
            }
            Logging = [ordered]@{
                FileSizeLimitBytes = 52428800
                RetainedFileCountLimit = 30
            }
        }
    }

    $secretsFlowPilot = [ordered]@{}
    if ($enableLdap) {
        $secretsFlowPilot.Ldap = [ordered]@{
            Url = $ldapUrl
            BaseDn = $ldapBaseDn
            UpnSuffix = $ldapUpnSuffix
            TimeoutSeconds = 10
        }
    }

    if ($enableSmtp) {
        $secretsFlowPilot.Smtp = [ordered]@{
            Enabled = $true
            TestEMail = $smtpTestEmail
            Host = $smtpHost
            Port = $smtpPort
            Security = "starttls"
            UserName = $smtpUserName
            Password = $smtpPassword
            From = $smtpFrom
            FromName = $smtpFromName
        }
    }
    else {
        $secretsFlowPilot.Smtp = [ordered]@{
            Enabled = $false
        }
    }

    $secrets = [ordered]@{
        ConnectionStrings = [ordered]@{
            FlowPilot = $connectionString
        }
        FlowPilot = $secretsFlowPilot
    }

    $configFile = Join-Path $configDirectory "appsettings.Production.json"
    $secretsFile = Join-Path $secretsDirectory "secrets.Production.json"

    foreach ($existingFile in @($configFile, $secretsFile)) {
        if (Test-Path -LiteralPath $existingFile -PathType Leaf) {
            if (-not (Read-YesNo "配置文件已存在，是否使用本次输入覆盖：$existingFile" $false)) {
                Stop-Installation "为避免新旧配置混用，脚本已停止。"
            }
        }
    }

    Write-JsonFile $config $configFile
    Write-JsonFile $secrets $secretsFile
    Set-ExactFileAcl $configFile $serviceSid ([Security.AccessControl.FileSystemRights]::Read)
    Set-ExactFileAcl $secretsFile $serviceSid ([Security.AccessControl.FileSystemRights]::Read)
    $connectionString = $null
    $connectionStringSecure = $null
    $smtpPassword = $null
    $smtpPasswordSecure = $null
    $secretsFlowPilot = $null
    $secrets = $null
    Write-Success "Config 和 Secrets 已生成并通过 JSON 格式检查。"

    Write-Step "创建并验证 current"
    $currentPath = Join-Path $deployRoot "App\current"
    if (Test-Path -LiteralPath $currentPath) {
        Assert-CurrentJunction $currentPath $releasePath
        Write-WarningMessage "current 已存在且指向同一 release，按中断恢复继续。"
    }
    else {
        New-Item -ItemType Junction -Path $currentPath -Target $releasePath | Out-Null
    }

    Assert-MarkerSearch (Join-Path $releasePath "api") $deployRoot
    Assert-MarkerSearch (Join-Path $currentPath "api") $deployRoot
    Write-Success "current 正确指向 $releasePath"

    Write-Step "注册并启动 Windows 服务"
    $stableApiExe = Join-Path $currentPath "api\FlowPilot.Api.exe"
    $existingService = Get-CimInstance Win32_Service -Filter "Name='FlowPilot API'" -ErrorAction SilentlyContinue
    if ($null -eq $existingService) {
        Write-Host "系统将弹出凭据窗口，请输入 $serviceAccount 的密码。" -ForegroundColor Yellow
        $serviceCredential = Get-Credential -UserName $serviceAccount
        if ($null -eq $serviceCredential -or
            -not [string]::Equals($serviceCredential.UserName, $serviceAccount, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Installation "凭据窗口中的账号与填写的服务账号不一致。"
        }
        $serviceCommand = "`"$stableApiExe`" --environment Production"
        New-Service -Name $script:ServiceName -BinaryPathName $serviceCommand -DisplayName $script:ServiceName -Description "FlowPilot ASP.NET Core API" -StartupType Automatic -Credential $serviceCredential | Out-Null
        sc.exe config $script:ServiceName start= delayed-auto | Out-Null
        sc.exe failure $script:ServiceName reset= 86400 actions= restart/60000/restart/300000/restart/900000 | Out-Null
        sc.exe failureflag $script:ServiceName 1 | Out-Null
        Write-Success "Windows 服务已注册。"
    }
    else {
        if ($existingService.PathName.IndexOf($stableApiExe, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            $existingService.PathName.IndexOf("--environment Production", [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Stop-Installation "已存在的 FlowPilot API 服务执行路径与本次安装不一致，脚本不会修改它。"
        }
        try {
            $existingServiceAccount = New-Object Security.Principal.NTAccount([string]$existingService.StartName)
            $existingServiceSid = $existingServiceAccount.Translate([Security.Principal.SecurityIdentifier])
        }
        catch {
            Stop-Installation "无法确认已存在服务的登录账号，脚本不会修改它。"
        }
        if ($existingServiceSid.Value -ne $serviceSid.Value) {
            Stop-Installation "已存在的 FlowPilot API 服务使用其他服务账号，脚本不会修改它。"
        }
        Write-WarningMessage "Windows 服务已存在且路径正确，按中断恢复继续。"
    }

    $service = Get-Service -Name $script:ServiceName
    if ($service.Status -eq [ServiceProcess.ServiceControllerStatus]::Running) {
        Restart-Service -Name $script:ServiceName -Force
    }
    else {
        Start-Service -Name $script:ServiceName
    }
    Write-Success "FlowPilot API 服务已启动。"

    Write-Step "执行健康检查"
    $liveOk = Invoke-HealthCheck "health/live" "http://127.0.0.1:3000/api/flowpilot/v1/health/live"
    $readyOk = Invoke-HealthCheck "health/ready" "http://127.0.0.1:3000/api/flowpilot/v1/health/ready"

    $listenOk = $false
    $listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0 -and
        @($listeners | Where-Object { $_.LocalAddress -ne "127.0.0.1" }).Count -eq 0) {
        $listenOk = $true
        Write-Success "端口 3000 只监听 127.0.0.1。"
    }
    else {
        Write-Host "[失败] 端口 3000 未监听，或监听了非 loopback 地址。" -ForegroundColor Red
    }

    $reportPath = Join-Path $logsDirectory ("deployment-{0}.txt" -f $releaseId)
    $reportLines = @(
        "FlowPilot 后端部署结果",
        "时间：$([DateTimeOffset]::Now.ToString('o'))",
        "releaseId：$releaseId",
        "部署目录：$deployRoot",
        "网站域名/IP：$externalHost",
        "服务账号：$serviceAccount",
        "current：$releasePath",
        "health/live：$liveOk",
        "health/ready：$readyOk",
        "仅监听 127.0.0.1:3000：$listenOk"
    )
    $reportEncoding = New-Object Text.UTF8Encoding($true)
    [IO.File]::WriteAllLines($reportPath, $reportLines, $reportEncoding)
    Set-ExactFileAcl $reportPath $serviceSid ([Security.AccessControl.FileSystemRights]::Modify)

    if (-not $liveOk -or -not $readyOk -or -not $listenOk) {
        Write-Title "安装未完全通过"
        Write-Host "服务和文件已经安装，但检查没有全部通过。" -ForegroundColor Red
        Write-Host "请查看：$logsDirectory"
        Write-Host "部署结果：$reportPath"
        Write-Host "不要删除数据库、覆盖 current 或给账号管理员权限。"
        exit 1
    }

    Write-Title "FlowPilot 后端安装完成"
    Write-Host "Windows 服务：$($script:ServiceName)"
    Write-Host "服务地址：    http://127.0.0.1:3000"
    Write-Host "部署结果：    $reportPath"
    Write-Host ""
    Write-Host "下一步：交给 IIS 管理员配置 /flowpilot 和 /api/flowpilot/* 反向代理。" -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "[安装停止] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请根据提示修正后重新运行脚本。不要手工删除数据库或覆盖 current。" -ForegroundColor Yellow
    exit 1
}
finally {
    Remove-TemporaryExtractDirectory
}
}
