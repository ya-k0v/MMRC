param(
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublishDir = Join-Path $RootDir "publish"
$InstallerDir = Join-Path $RootDir "installer"
$OutputDir = Join-Path $RootDir "output"
$OutputFile = Join-Path $OutputDir "MMRCPlayer.msi"
$ComponentsFile = Join-Path $InstallerDir "components.wxs"
$MainWxs = Join-Path $InstallerDir "MMRCPlayer.wxs"

try {
    $wixVersion = & wix --version 2>$null
    Write-Host "WiX Toolset: $wixVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: WiX Toolset not installed." -ForegroundColor Red
    Write-Host "Install: dotnet tool install --global wix" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $PublishDir)) {
    Write-Host "ERROR: Publish directory not found: $PublishDir" -ForegroundColor Red
    Write-Host "Run .\build.ps1 first to build the application." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Write-Host "Building MSI installer v$Version..." -ForegroundColor Cyan
Write-Host "Generating components fragment..." -ForegroundColor Yellow

# Exclude only truly unnecessary files:
# - Localization satellite assemblies (not used by our app)
# - VLC web interface files (lua, html, js, css, images)
# - Debug/build artifacts (pdb, xml docs)
# - Zone.Identifier alternate data streams
$files = Get-ChildItem -Path $PublishDir -Recurse -File | Where-Object {
    $f = $_
    $full = $f.FullName
    $name = $f.Name

    # Always exclude
    if ($name -like "*Zone.Identifier*") { return $false }
    if ($name -like "*.pdb") { return $false }

    # Localization satellite assemblies (safe to remove - not used)
    if ($full -match "\\(cs|de|es|fr|it|ja|ko|pl|pt-BR|ru|tr|zh-Hans|zh-Hant)\\[^\\]+$") { return $false }

    # VLC web interface (not needed for playback)
    if ($full -match "\\libvlc\\.*\\(lua|hrtfs)\\") { return $false }
    if ($name -match "\.luac?$") { return $false }
    if ($name -match "\.(html?|js|css)$") { return $false }
    if ($name -match "^(browse|status|playlist|vlm|buttons|common|controllers|index|main|mobile|offset|stream|equalizer|error|batch|sandbox|create_stream|view|favicon)\.") { return $false }
    if ($name -match "^ui[-_]") { return $false }
    if ($name -match "^(Audio|Back|Folder|Other|Video|vlc)[-_]") { return $false }
    if ($name -match "\.(sofa|jar)$") { return $false }

    # VLC .lib import libraries (not needed at runtime)
    if ($name -match "\.lib$") { return $false }

    # Debug diagnostics (not needed for production)
    if ($name -match "^createdump\.exe$") { return $false }
    if ($name -match "^mscordaccore") { return $false }
    if ($name -match "^mscordbi\.dll$") { return $false }

    # LibVLC plugins: include ALL (safer for playback compatibility)
    # Only exclude truly unnecessary files
    if ($full -match "\\plugins\\") {
        # Keep all plugin DLLs
        if ($name -match "\.dll$") { return $true }
        # Exclude non-DLL files in plugins
        return $false
    }

    # Keep everything else (libvlc, plugins, WPF, .NET runtime, app DLLs)
    return $true
}

$componentId = 0
$sb = New-Object System.Text.StringBuilder
$sb.AppendLine('<?xml version="1.0" encoding="UTF-8"?>') | Out-Null
$sb.AppendLine('<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">') | Out-Null
$sb.AppendLine('  <Fragment>') | Out-Null
$sb.AppendLine('    <ComponentGroup Id="AppFiles" Directory="INSTALLFOLDER">') | Out-Null

foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($PublishDir.Length + 1).Replace('\', '\\')
    $componentId++
    $id = "cmp$componentId"
    $fileId = "fil$componentId"
    $sourcePath = "`$(var.PublishDir)\\$relativePath"

    $fileName = $file.Name
    $sb.AppendLine("      <Component Id=`"$id`" Guid=`"$([guid]::NewGuid())`" >") | Out-Null
    $sb.AppendLine("        <File Id=`"$fileId`" Name=`"$fileName`" Source=`"$sourcePath`" KeyPath=`"yes`" />") | Out-Null
    $sb.AppendLine("      </Component>") | Out-Null
}

$sb.AppendLine('    </ComponentGroup>') | Out-Null
$sb.AppendLine('  </Fragment>') | Out-Null
$sb.AppendLine('</Wix>') | Out-Null

$sb.ToString() | Out-File -FilePath $ComponentsFile -Encoding UTF8
Write-Host "Generated $componentId file components." -ForegroundColor Green

Write-Host "Building MSI..." -ForegroundColor Yellow

& wix build $MainWxs $ComponentsFile `
    -acceptEula wix7 `
    -d "PublishDir=$PublishDir" `
    -o $OutputFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: WiX build failed." -ForegroundColor Red
    exit 1
}

$msiSize = [math]::Round((Get-Item $OutputFile).Length / 1MB, 2)
Write-Host ""
Write-Host "SUCCESS!" -ForegroundColor Green
Write-Host "Output: $OutputFile" -ForegroundColor White
Write-Host "Size: $msiSize MB" -ForegroundColor White
