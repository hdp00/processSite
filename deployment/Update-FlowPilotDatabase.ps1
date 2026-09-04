#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ConfigurationFile = "",
    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Write-Success {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host "[完成] $Message" -ForegroundColor Green
}

function Stop-DatabaseUpdate {
    param([Parameter(Mandatory = $true)][string]$Message)

    throw $Message
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-DatabaseUpdate "找不到$DisplayName：$Path"
    }

    try {
        return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop |
            ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Stop-DatabaseUpdate "${DisplayName}不是有效的 JSON。请检查英文逗号、引号和大括号。"
    }
}

function Get-RequiredText {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$FieldName
    )

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        Stop-DatabaseUpdate "$FieldName 不能为空。"
    }

    return $text.Trim()
}

function Get-SqlConnectionStringBuilder {
    param(
        [Parameter(Mandatory = $true)][string]$ConnectionString,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    if ($ConnectionString.Contains("<") -or $ConnectionString.Contains(">")) {
        Stop-DatabaseUpdate "$DisplayName 仍包含尖括号占位内容，请先填写真实值。"
    }

    try {
        $outerBuilder = New-Object System.Data.Common.DbConnectionStringBuilder
        $outerBuilder.ConnectionString = $ConnectionString
        if ($outerBuilder.Count -eq 1 -and $outerBuilder.ContainsKey("ConnectionString")) {
            $ConnectionString = [string]$outerBuilder["ConnectionString"]
        }

        return New-Object System.Data.SqlClient.SqlConnectionStringBuilder($ConnectionString)
    }
    catch {
        Stop-DatabaseUpdate "$DisplayName 格式无效。"
    }
}

function Assert-ApprovedConnectionSettings {
    param(
        [Parameter(Mandatory = $true)]$Builder,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    if ([string]::IsNullOrWhiteSpace($Builder.DataSource) -or
        [string]::IsNullOrWhiteSpace($Builder.InitialCatalog) -or
        [string]::IsNullOrWhiteSpace($Builder.UserID) -or
        [string]::IsNullOrWhiteSpace($Builder.Password)) {
        Stop-DatabaseUpdate "$DisplayName 必须包含 Server、Database、User ID 和 Password。"
    }

    if ($Builder.IntegratedSecurity) {
        Stop-DatabaseUpdate "$DisplayName 必须使用 SQL 账号，不能使用 Windows 集成认证。"
    }

    if (-not $Builder.ContainsKey("Encrypt") -or $Builder.Encrypt) {
        Stop-DatabaseUpdate "$DisplayName 必须设置 Encrypt=false。"
    }

    if (-not $Builder.ContainsKey("TrustServerCertificate") -or
        -not $Builder.TrustServerCertificate) {
        Stop-DatabaseUpdate "$DisplayName 必须设置 TrustServerCertificate=true。"
    }
}

function Assert-SameDatabaseTarget {
    param(
        [Parameter(Mandatory = $true)]$MigrationBuilder,
        [Parameter(Mandatory = $true)]$RuntimeBuilder
    )

    if (-not [string]::Equals(
            $MigrationBuilder.DataSource,
            $RuntimeBuilder.DataSource,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(
            $MigrationBuilder.InitialCatalog,
            $RuntimeBuilder.InitialCatalog,
            [StringComparison]::OrdinalIgnoreCase)) {
        Stop-DatabaseUpdate "迁移账号与运行账号指向的 SQL Server 或数据库不一致。"
    }

}

function Assert-DotNet10Sdk {
    $sdkOutput = @(& dotnet --list-sdks 2>$null)
    if ($LASTEXITCODE -ne 0 -or
        -not ($sdkOutput | Where-Object { $_ -match "^10\." })) {
        Stop-DatabaseUpdate "开发机必须安装 .NET 10 SDK。"
    }
}

function Invoke-DotNet {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-DatabaseUpdate $FailureMessage
    }
}

function Get-ProcessEnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    return [Environment]::GetEnvironmentVariable($Name, "Process")
}

function Set-ProcessEnvironmentValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][string]$Value
    )

    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

function Test-AbsoluteWindowsPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return $Path -match "^[A-Za-z]:[\\/]" -or $Path -match "^\\\\[^\\]+\\[^\\]+"
}

function Invoke-FlowPilotDatabaseUpdate {
    $scriptDirectory = $PSScriptRoot
    $repositoryRoot = Split-Path -Parent $scriptDirectory
    $defaultConfigurationFile = Join-Path $scriptDirectory "database-update.local.json"
    $exampleConfigurationFile = Join-Path $scriptDirectory "database-update.example.json"
    $databaseToolProject = Join-Path $repositoryRoot "apps\api\tools\FlowPilot.DatabaseTool\FlowPilot.DatabaseTool.csproj"
    $solutionFile = Join-Path $repositoryRoot "apps\api\FlowPilot.slnx"

    $resolvedConfigurationFile = $ConfigurationFile
    if ([string]::IsNullOrWhiteSpace($resolvedConfigurationFile)) {
        $resolvedConfigurationFile = $defaultConfigurationFile
    }
    elseif (-not (Test-AbsoluteWindowsPath $resolvedConfigurationFile)) {
        $resolvedConfigurationFile = Join-Path (Get-Location) $resolvedConfigurationFile
    }
    $resolvedConfigurationFile = [IO.Path]::GetFullPath($resolvedConfigurationFile)

    Write-Host ""
    Write-Host "FlowPilot 数据库更新向导" -ForegroundColor White
    Write-Host "该向导只更新数据库，不切换程序版本，也不启动或停止服务。"

    Write-Step "读取本机更新配置"
    if (-not (Test-Path -LiteralPath $resolvedConfigurationFile -PathType Leaf)) {
        if (Test-Path -LiteralPath $exampleConfigurationFile -PathType Leaf) {
            Copy-Item -LiteralPath $exampleConfigurationFile -Destination $defaultConfigurationFile
            Stop-DatabaseUpdate "已创建 $defaultConfigurationFile。请填写迁移账号后重新运行。"
        }
        Stop-DatabaseUpdate "找不到数据库更新配置：$resolvedConfigurationFile"
    }

    $updateSettings = Read-JsonFile $resolvedConfigurationFile "数据库更新配置"
    $deployRoot = Get-RequiredText $updateSettings.DeploymentRoot "DeploymentRoot"
    if (-not (Test-AbsoluteWindowsPath $deployRoot)) {
        Stop-DatabaseUpdate "DeploymentRoot 必须是绝对路径。"
    }
    $deployRoot = [IO.Path]::GetFullPath($deployRoot).TrimEnd('\', '/')

    $rootMarker = Join-Path $deployRoot "flowpilot.root"
    $productionConfigFile = Join-Path $deployRoot "Config\appsettings.Production.json"
    $productionSecretsFile = Join-Path $deployRoot "Secrets\secrets.Production.json"
    if (-not (Test-Path -LiteralPath $rootMarker -PathType Leaf)) {
        Stop-DatabaseUpdate "部署根目录缺少 flowpilot.root：$deployRoot"
    }
    if (-not (Test-Path -LiteralPath $databaseToolProject -PathType Leaf) -or
        -not (Test-Path -LiteralPath $solutionFile -PathType Leaf)) {
        Stop-DatabaseUpdate "脚本必须放在 FlowPilot 仓库的 deployment 目录中运行。"
    }

    $productionConfig = Read-JsonFile $productionConfigFile "生产普通配置"
    $productionSecrets = Read-JsonFile $productionSecretsFile "生产敏感配置"
    $migrationConnectionString = Get-RequiredText $updateSettings.ConnectionStrings.FlowPilotMigration "ConnectionStrings.FlowPilotMigration"
    $runtimeConnectionString = Get-RequiredText $productionSecrets.ConnectionStrings.FlowPilot "生产 Secrets 中的 ConnectionStrings.FlowPilot"
    $expectedCollation = Get-RequiredText $productionConfig.FlowPilot.Database.ExpectedCollation "FlowPilot.Database.ExpectedCollation"

    $migrationBuilder = Get-SqlConnectionStringBuilder $migrationConnectionString "迁移连接字符串"
    $runtimeBuilder = Get-SqlConnectionStringBuilder $runtimeConnectionString "运行连接字符串"
    Assert-ApprovedConnectionSettings $migrationBuilder "迁移连接字符串"
    Assert-ApprovedConnectionSettings $runtimeBuilder "运行连接字符串"
    Assert-SameDatabaseTarget $migrationBuilder $runtimeBuilder
    Write-Success "配置格式和数据库目标检查通过。"

    Write-Step "确认数据库目标"
    Write-Host "SQL Server： $($migrationBuilder.DataSource)"
    Write-Host "数据库：     $($migrationBuilder.InitialCatalog)"
    Write-Host "排序规则：   $expectedCollation"

    Write-Step "编译当前版本数据库工具"
    Assert-DotNet10Sdk
    Push-Location $repositoryRoot
    try {
        Invoke-DotNet @("restore", $solutionFile, "--locked-mode", "-m:1") "数据库工具依赖还原失败。"
        Invoke-DotNet @("build", $databaseToolProject, "-c", "Release", "--no-restore", "-m:1") "数据库工具编译失败。"
    }
    finally {
        Pop-Location
    }
    Write-Success "数据库工具编译完成。"

    $environmentNames = @(
        "ConnectionStrings__FlowPilotMigration",
        "ConnectionStrings__FlowPilot",
        "FlowPilot__Database__ExpectedCollation",
        "FlowPilot__Bootstrap__SuperAdminPassword"
    )
    $originalEnvironment = @{}
    foreach ($name in $environmentNames) {
        $originalEnvironment[$name] = Get-ProcessEnvironmentValue $name
    }

    try {
        Set-ProcessEnvironmentValue "ConnectionStrings__FlowPilotMigration" $migrationConnectionString
        Set-ProcessEnvironmentValue "ConnectionStrings__FlowPilot" $runtimeConnectionString
        Set-ProcessEnvironmentValue "FlowPilot__Database__ExpectedCollation" $expectedCollation
        Set-ProcessEnvironmentValue "FlowPilot__Bootstrap__SuperAdminPassword" $null

        $commonArguments = @(
            "run",
            "--project", $databaseToolProject,
            "-c", "Release",
            "--no-build",
            "--no-restore",
            "--no-launch-profile",
            "--"
        )

        Write-Step "应用数据库结构更新"
        Invoke-DotNet ($commonArguments + @("initialize")) "数据库结构更新失败。服务保持停止，不要切换或启动新版本。"

        Write-Step "同步内置数据"
        Invoke-DotNet ($commonArguments + @("seed")) "内置数据同步失败。服务保持停止，不要切换或启动新版本。"

        Write-Step "使用运行账号验证"
        Invoke-DotNet ($commonArguments + @("verify")) "运行账号验证失败。服务保持停止，不要切换或启动新版本。"
    }
    finally {
        foreach ($name in $environmentNames) {
            Set-ProcessEnvironmentValue $name $originalEnvironment[$name]
        }
        $migrationConnectionString = $null
        $runtimeConnectionString = $null
    }

    Write-Host ""
    Write-Host "FlowPilot 数据库更新完成。" -ForegroundColor Green
    Write-Host "下一步：切换到匹配的新程序版本，再启动服务和 IIS 并检查 live、ready。"
}

if (-not $LibraryOnly) {
    try {
        Invoke-FlowPilotDatabaseUpdate
        exit 0
    }
    catch {
        Write-Host ""
        Write-Host "数据库更新停止：$($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
