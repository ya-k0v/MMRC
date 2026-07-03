<#
.SYNOPSIS
    Build MMRC Player for Windows
.DESCRIPTION
    Publishes MMRC Player as a self-contained single-file executable
.PARAMETER Runtime
    Target runtime (default: win-x64)
.EXAMPLE
    .\build.ps1
    .\build.ps1 -Runtime win-x64
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir = Join-Path $ProjectDir "src\MMRCPlayer"
$PublishDir = Join-Path $ProjectDir "publish"

Write-Host "Building MMRC Player..." -ForegroundColor Cyan
Write-Host "  Runtime: $Runtime" -ForegroundColor White

# Check dotnet
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    Write-Host "ERROR: .NET SDK not found." -ForegroundColor Red
    Write-Host "Install from: https://dotnet.microsoft.com/download/dotnet/8.0" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Restoring packages..." -ForegroundColor Yellow
Push-Location $SrcDir
dotnet restore -r $Runtime
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Restore failed." -ForegroundColor Red
    Pop-Location
    exit 1
}

Write-Host ""
Write-Host "Publishing..." -ForegroundColor Yellow
dotnet publish -c Release -r $Runtime --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -o $PublishDir
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Publish failed." -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# Copy appsettings.json
$SettingsSrc = Join-Path $SrcDir "appsettings.json"
$SettingsDst = Join-Path $PublishDir "appsettings.json"
if (Test-Path $SettingsSrc) {
    Copy-Item -Path $SettingsSrc -Destination $SettingsDst -Force
    Write-Host "Copied appsettings.json" -ForegroundColor Green
}

Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
$ExePath = Join-Path $PublishDir "MMRCPlayer.exe"
Write-Host "  Output: $ExePath" -ForegroundColor White
$Size = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)
Write-Host "  Size:   $Size MB" -ForegroundColor White
Write-Host ""
Write-Host "To install: .\install.ps1 -ServerUrl 'http://server:3000' -DeviceId 'WIN001'" -ForegroundColor Yellow
