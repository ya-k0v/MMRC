<#
.SYNOPSIS
    Setup LibVLC native binaries for MMRC Player
.DESCRIPTION
    Copies LibVLC from installed VLC or NuGet cache
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LibVLCDir = Join-Path $ScriptDir "libvlc-native"

Write-Host "LibVLC Native Setup" -ForegroundColor Cyan

# Skip if already exists
$checkFile = Join-Path $LibVLCDir "libvlccore.dll"
if (Test-Path $checkFile) {
    $size = [math]::Round((Get-Item $checkFile).Length / 1KB, 0)
    Write-Host "  Already exists ($size KB). OK." -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path $LibVLCDir -Force | Out-Null

# Source 1: Installed VLC
$vlcPaths = @(
    "C:\Program Files\VideoLAN\VLC",
    "C:\Program Files (x86)\VideoLAN\VLC",
    "${env:ProgramFiles}\VideoLAN\VLC",
    "${env:ProgramFiles(x86)}\VideoLAN\VLC"
)

$copied = $false
foreach ($vlcPath in $vlcPaths) {
    $coreDll = Join-Path $vlcPath "libvlccore.dll"
    if (Test-Path $coreDll) {
        Write-Host "  Found installed VLC: $vlcPath" -ForegroundColor Green

        # Core DLLs
        @("libvlccore.dll", "libvlc.dll") | ForEach-Object {
            $src = Join-Path $vlcPath $_
            if (Test-Path $src) {
                Copy-Item $src -Destination $LibVLCDir -Force
                $size = [math]::Round((Get-Item $src).Length / 1KB, 0)
                Write-Host "    $_ ($size KB)" -ForegroundColor Green
            }
        }

        # Plugins
        $pluginsSrc = Join-Path $vlcPath "plugins"
        if (Test-Path $pluginsSrc) {
            $destPlugins = Join-Path $LibVLCDir "plugins"
            Copy-Item -Path $pluginsSrc -Destination $destPlugins -Recurse -Force
            $cnt = (Get-ChildItem -Path $destPlugins -Recurse -Filter "*.dll").Count
            $sz = [math]::Round((Get-ChildItem -Path $destPlugins -Recurse -Filter "*.dll" | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
            Write-Host "    plugins/ ($cnt DLLs, $sz MB)" -ForegroundColor Green
        }

        $copied = $true
        break
    }
}

# Source 2: NuGet cache fallback
if (-not $copied) {
    Write-Host "`n  Installed VLC not found. Trying NuGet cache..." -ForegroundColor Yellow

    $nugetLine = & dotnet nuget locals global-packages -l 2>$null
    $nugetCache = ($nugetLine -replace '.*?:\s*', '').Trim()

    if ($nugetCache -and (Test-Path $nugetCache)) {
        $vlcPkg = Get-ChildItem -Path $nugetCache -Directory -Filter "videolan.libvlc.windows*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1

        if ($vlcPkg) {
            Write-Host "    Package: $($vlcPkg.Name)" -ForegroundColor Gray
            $allDlls = Get-ChildItem -Path $vlcPkg.FullName -Recurse -Filter "*.dll"

            foreach ($dll in $allDlls) {
                if ($dll.Name -in @("libvlccore.dll", "libvlc.dll")) {
                    Copy-Item $dll.FullName -Destination $LibVLCDir -Force
                    Write-Host "    $($dll.Name) from $($dll.DirectoryName)" -ForegroundColor Green
                }
            }

            $pluginsDirs = Get-ChildItem -Path $vlcPkg.FullName -Recurse -Directory -Filter "plugins"
            foreach ($pDir in $pluginsDirs) {
                $pluginDlls = Get-ChildItem -Path $pDir.FullName -Filter "*.dll"
                if ($pluginDlls.Count -gt 0) {
                    $destPlugins = Join-Path $LibVLCDir "plugins"
                    New-Item -ItemType Directory -Path $destPlugins -Force | Out-Null
                    Copy-Item -Path "$($pDir.FullName)\*.dll" -Destination $destPlugins -Force
                    Write-Host "    plugins/ ($($pluginDlls.Count) DLLs)" -ForegroundColor Green
                    break
                }
            }

            $copied = $true
        }
    }
}

# Verify
if (-not (Test-Path (Join-Path $LibVLCDir "libvlccore.dll"))) {
    Write-Host "`nERROR: Could not find LibVLC" -ForegroundColor Red
    Write-Host "  Install VLC from https://www.videolan.org/vlc/" -ForegroundColor Yellow
    exit 1
}

$totalMB = [math]::Round((Get-ChildItem -Path $LibVLCDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "`n  Ready: $totalMB MB" -ForegroundColor Green
