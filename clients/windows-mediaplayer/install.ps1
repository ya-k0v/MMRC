<#
.SYNOPSIS
    MMRC Player for Windows - Installation Script
.DESCRIPTION
    Installs MMRC Player as a Windows service that starts on boot.
.PARAMETER ServerUrl
    MMRC server URL (e.g., http://192.168.1.100:3000)
.PARAMETER DeviceId
    Device identifier (e.g., WIN001)
.EXAMPLE
    .\install.ps1 -ServerUrl "http://192.168.1.100:3000" -DeviceId "WIN001"
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$ServerUrl = "http://localhost:3000",

    [Parameter(Mandatory=$false)]
    [string]$DeviceId = "win-001",

    [Parameter(Mandatory=$false)]
    [switch]$Uninstall
)

$TaskName = "MMRCPlayer"
$InstallDir = "$env:LOCALAPPDATA\MMRCPlayer"
$ExePath = "$InstallDir\MMRCPlayer.exe"

function Install-MMRCPlayer {
    Write-Host "Installing MMRC Player..." -ForegroundColor Cyan

    $currentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $sourceExe = Join-Path $currentDir "publish\MMRCPlayer.exe"

    if (-not (Test-Path $sourceExe)) {
        Write-Host "ERROR: MMRCPlayer.exe not found at $sourceExe" -ForegroundColor Red
        Write-Host "Run 'dotnet publish' first." -ForegroundColor Yellow
        exit 1
    }

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    Copy-Item -Path $sourceExe -Destination $ExePath -Force
    Write-Host "Copied to $ExePath" -ForegroundColor Green

    $config = @{
        ServerUrl = $ServerUrl
        DeviceId = $DeviceId
        ShowStatus = $false
        PingInterval = 20000
        ReconnectDelay = 5000
        WatchdogInterval = 60000
        BufferMinMs = 30000
        BufferMaxMs = 60000
        CacheSize = 209715200
        CrossfadeDurationMs = 500
    } | ConvertTo-Json

    $configPath = "$InstallDir\appsettings.json"
    $config | Out-File -FilePath $configPath -Encoding UTF8
    Write-Host "Config saved to $configPath" -ForegroundColor Green

    $action = New-ScheduledTaskAction -Execute $ExePath
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 365)

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "MMRC Digital Signage Player" `
        -Force

    Write-Host "Scheduled task '$TaskName' registered." -ForegroundColor Green

    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host "  Server: $ServerUrl" -ForegroundColor White
    Write-Host "  Device: $DeviceId" -ForegroundColor White
    Write-Host "  Path:   $ExePath" -ForegroundColor White
    Write-Host ""
    Write-Host "To start now: Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
    Write-Host "To uninstall: .\install.ps1 -Uninstall" -ForegroundColor Yellow
}

function Uninstall-MMRCPlayer {
    Write-Host "Uninstalling MMRC Player..." -ForegroundColor Cyan

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Scheduled task removed." -ForegroundColor Green
    }

    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Host "Install directory removed." -ForegroundColor Green
    }

    Write-Host "Uninstalled." -ForegroundColor Green
}

if ($Uninstall) {
    Uninstall-MMRCPlayer
} else {
    Install-MMRCPlayer
}
