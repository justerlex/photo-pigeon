#Requires -Version 5.1
<#
.SYNOPSIS
  Write photo-pigeon.wsb and install-facts.json for THIS checkout, on THIS
  machine. Run it on the host before opening the sandbox.

.DESCRIPTION
  A Windows Sandbox configuration cannot hold a relative path and cannot hold an
  environment variable: every `HostFolder` is an absolute path that has to exist
  before the sandbox will start at all. So the .wsb in this directory is
  generated rather than hand written, and this is the generator.

  It does four things, and the middle two are checks rather than plumbing:

  1. Reads the install facts off the files that own them, and writes them to
     `install-facts.json` for the sandbox to read. Nothing inside the sandbox
     guesses the install directory, the exe name or the Run value name.
  2. **Refuses to generate if any frozen name has moved.** The five machine
     identifiers and the display name are frozen by section 0 of
     docs/TRAY-DESIGN.md, and every one of them is load bearing for an install:
     the install directory and the Run value the uninstaller deletes are both the
     display name, the exe is a machine name that must not follow it.
  3. **Refuses to generate if the bundle directory holds more than one
     installer.** That is row 13 of the M5 working plan and item 4.2 of the M5
     checklist, wired into the front door of the rig rather than left as a thing
     to remember: two near-identical installers side by side is how the wrong one
     ships, and a sandbox that silently picked one would be worse than no
     sandbox at all.
  4. Creates the writable folder the transcript comes back through, outside the
     repository, and writes the .wsb pointing at all three.

  It installs nothing, launches nothing and starts no sandbox. Everything it
  writes is a file.

.EXAMPLE
  pwsh -File app\e2e\sandbox\make-wsb.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File app\e2e\sandbox\make-wsb.ps1 -OutDir D:\pigeon-sandbox-out

.NOTES
  Background: docs/TRAY-DESIGN.md section 6, the M5 working plan. The rig itself
  is app/e2e/sandbox/bootstrap.ps1 and its README is beside it.
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [string]$InstallerDir = '',
  [int]$MemoryInMB = 4096,
  [ValidateSet('Default', 'Disable')][string]$Networking = 'Default'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'sandbox-assert.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$sandboxDir = $PSScriptRoot

Write-Host ''
Write-Host 'photo-pigeon sandbox configuration' -ForegroundColor White
Write-Host "  repository  $repoRoot" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# The facts, and the frozen names.
# ---------------------------------------------------------------------------

$facts = Get-PigeonInstallFacts -RepoRoot $repoRoot
$checks = @(Get-PigeonFactsChecks -Facts $facts)

foreach ($check in $checks) {
  $colour = switch ($check.status) { 'pass' { 'Green' } 'fail' { 'Red' } 'warn' { 'Yellow' } default { 'Gray' } }
  $mark = switch ($check.status) { 'pass' { 'PASS' } 'fail' { 'FAIL' } 'warn' { 'WARN' } default { '    ' } }
  Write-Host "  $mark  $($check.name) : $($check.detail)" -ForegroundColor $colour
}

if ((Get-PigeonFailCount -Checks $checks) -gt 0) {
  Write-Host ''
  throw "refusing to generate a sandbox configuration: a frozen name has moved. Fix the name or the law, not this script."
}

# ---------------------------------------------------------------------------
# Exactly one installer.
# ---------------------------------------------------------------------------

$bundleDir = if ($InstallerDir -ne '') { $InstallerDir } else {
  Join-Path $repoRoot 'app\src-tauri\target\release\bundle\nsis'
}

if (-not (Test-Path -LiteralPath $bundleDir -PathType Container)) {
  throw "no installer directory at $bundleDir. Build one first: npm run build in app, or tauri build."
}

$installers = @(Get-ChildItem -LiteralPath $bundleDir -Filter '*-setup.exe' -File)
if ($installers.Count -eq 0) {
  throw "no installer in $bundleDir. Build one first."
}
if ($installers.Count -gt 1) {
  Write-Host ''
  foreach ($file in $installers) {
    Write-Host "  $($file.Name)  $($file.Length) bytes  $($file.LastWriteTime)" -ForegroundColor Yellow
  }
  throw "$($installers.Count) installers in $bundleDir. Two near-identical installers side by side is how the wrong file ships: delete everything that is not the build you mean to test. This is item 4.2 of the M5 checklist."
}

$installer = $installers[0]
Write-Host "  PASS  exactly one installer : $($installer.Name), $($installer.Length) bytes" -ForegroundColor Green
if ($installer.Name -cne $facts.installerFileName) {
  Write-Host "  WARN  the file is '$($installer.Name)' and package.json implies '$($facts.installerFileName)'" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# The way back out. Outside the repository on purpose: a writable mapping into a
# checkout is a sandbox with a pen in the working tree.
# ---------------------------------------------------------------------------

$outDir = if ($OutDir -ne '') { $OutDir } else { Join-Path $env:TEMP 'photo-pigeon-sandbox' }
if (-not (Test-Path -LiteralPath $outDir -PathType Container)) {
  $null = New-Item -ItemType Directory -Path $outDir -Force
}

# ---------------------------------------------------------------------------
# Write the two files.
# ---------------------------------------------------------------------------

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$factsPath = Join-Path $sandboxDir 'install-facts.json'
[System.IO.File]::WriteAllText($factsPath, (($facts | ConvertTo-Json -Depth 6) + "`r`n"), $utf8NoBom)

$wsbPath = Join-Path $sandboxDir 'photo-pigeon.wsb'
$generated = (Get-Date).ToString('yyyy-MM-dd HH:mm')

$wsb = @"
<?xml version="1.0" encoding="utf-8"?>
<!--
  photo-pigeon, the install matrix in a disposable machine.

  GENERATED by app\e2e\sandbox\make-wsb.ps1 on $generated for
  $repoRoot
  Re-run the generator after moving the checkout or building a new installer:
  every path below is absolute because a .wsb cannot hold a relative one.

  Double-click this file. The logon command runs bootstrap.ps1, which installs
  silently, checks the shape, launches the tray, proves the state directory is
  untouched by an uninstall, reinstalls over the residue and installs over a live
  install. The transcript comes back out through the writable mapping.

  It proves the install matrix and NOT the walk a stranger takes: there is no
  Google account in here, and an installer that arrived through a mapped folder
  carries no mark of the web, so SmartScreen has nothing to warn about. Section 1
  of the M5 pass in app\e2e\CHECKLIST.md stays a human row.
-->
<Configuration>
  <!--
    Networking is on because the installer may need it. INSTALLWEBVIEW2MODE in
    the generated installer.nsi is downloadBootstrapper, so a machine with no
    WebView2 runtime downloads one, and a stranger's machine would do the same.
    Set it to Disable to model an offline install; the transcript will then show
    the installer aborting at its WebView2 step if the runtime is missing.
  -->
  <Networking>$Networking</Networking>
  <VGpu>Disable</VGpu>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>$MemoryInMB</MemoryInMB>
  <MappedFolders>
    <!-- The rig. Read only: nothing in the sandbox may edit the test. -->
    <MappedFolder>
      <HostFolder>$sandboxDir</HostFolder>
      <SandboxFolder>C:\pigeon\rig</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <!-- The installer. Read only, so a sandbox cannot corrupt the artifact. -->
    <MappedFolder>
      <HostFolder>$bundleDir</HostFolder>
      <SandboxFolder>C:\pigeon\installer</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <!--
      The way back out, and the only writable mapping. Everything else in the
      sandbox dies with it, including a transcript written anywhere else.
    -->
    <MappedFolder>
      <HostFolder>$outDir</HostFolder>
      <SandboxFolder>C:\pigeon\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File C:\pigeon\rig\bootstrap.ps1 -ConfirmSandbox</Command>
  </LogonCommand>
</Configuration>
"@

# Well formed before it is written, because a sandbox that will not start says
# very little about why.
$null = [xml]$wsb
[System.IO.File]::WriteAllText($wsbPath, $wsb, $utf8NoBom)

Write-Host ''
Write-Host "  wrote  $factsPath" -ForegroundColor Green
Write-Host "  wrote  $wsbPath" -ForegroundColor Green
Write-Host ''
Write-Host '  mapped in' -ForegroundColor White
Write-Host "    C:\pigeon\rig        $sandboxDir  (read only)" -ForegroundColor DarkGray
Write-Host "    C:\pigeon\installer  $bundleDir  (read only)" -ForegroundColor DarkGray
Write-Host "    C:\pigeon\out        $outDir  (writable, the transcript comes back here)" -ForegroundColor DarkGray
Write-Host ''

$feature = $null
try { $feature = Get-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' -ErrorAction Stop } catch { }
if ($null -ne $feature -and $feature.State -ne 'Enabled') {
  Write-Host '  Windows Sandbox is not enabled on this machine yet. As an administrator:' -ForegroundColor Yellow
  Write-Host '    Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM' -ForegroundColor Yellow
  Write-Host '  It needs a reboot, and virtualisation has to be on in the firmware.' -ForegroundColor Yellow
  Write-Host ''
}
elseif ($null -eq $feature) {
  Write-Host '  Could not ask whether Windows Sandbox is enabled (that query wants an' -ForegroundColor DarkGray
  Write-Host '  elevated shell). If the .wsb does nothing when opened, that is the reason.' -ForegroundColor DarkGray
  Write-Host ''
}

Write-Host "  Now double-click $wsbPath and read the transcript in $outDir." -ForegroundColor White
Write-Host ''
