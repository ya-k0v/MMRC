<#
.SYNOPSIS
    Build MMRC Player for Windows
#>

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir = Join-Path $ProjectDir "src\MMRCPlayer"
$PublishDir = Join-Path $ProjectDir "publish"
$Runtime = "win-x64"

Write-Host "=== MMRC Player Build ===" -ForegroundColor Cyan

# Step 1: Download LibVLC native binaries
Write-Host "`n[1/3] LibVLC setup..." -ForegroundColor Yellow
$setupScript = Join-Path $ProjectDir "setup-vlc.ps1"
& $setupScript
if (-not (Test-Path (Join-Path $ProjectDir "libvlc-native\libvlccore.dll"))) {
    Write-Host "ERROR: VLC setup failed" -ForegroundColor Red; exit 1
}

# Step 2: Publish
Write-Host "`n[2/3] Publishing (self-contained $Runtime)..." -ForegroundColor Yellow
if (Test-Path $PublishDir) { Remove-Item -Path $PublishDir -Recurse -Force }

Push-Location $SrcDir
& dotnet publish -c Release -r $Runtime --self-contained true -o $PublishDir
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

# Step 3: Verify
Write-Host "`n[3/3] Verification..." -ForegroundColor Yellow

$checks = [ordered]@{
    "MMRCPlayer.exe" = $null
    "libvlccore.dll" = $null
    "libvlc.dll" = $null
    "plugins/" = $null
}

foreach ($name in @("MMRCPlayer.exe", "libvlccore.dll", "libvlc.dll")) {
    $path = Join-Path $PublishDir $name
    if (Test-Path $path) {
        $size = [math]::Round((Get-Item $path).Length / 1KB, 0)
        Write-Host "  $name - $size KB" -ForegroundColor Green
    } else {
        Write-Host "  $name - MISSING!" -ForegroundColor Red
    }
}

$pluginDir = Join-Path $PublishDir "plugins"
if (Test-Path $pluginDir) {
    $cnt = (Get-ChildItem -Path $pluginDir -Filter "*.dll").Count
    $sz = [math]::Round((Get-ChildItem -Path $pluginDir -Filter "*.dll" | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    Write-Host "  plugins/ - $cnt DLLs ($sz MB)" -ForegroundColor Green
} else {
    Write-Host "  plugins/ - MISSING!" -ForegroundColor Red
}

$exePath = Join-Path $PublishDir "MMRCPlayer.exe"
$exeSize = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-Host "  Exe: $exeSize MB" -ForegroundColor $(if ($exeSize -lt 5) { "Red" } else { "Green" })

$totalMB = [math]::Round((Get-ChildItem -Path $PublishDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "`nDone! Total: $totalMB MB in publish/" -ForegroundColor Green
Write-Host "Run: publish\MMRCPlayer.exe" -ForegroundColor Yellow
