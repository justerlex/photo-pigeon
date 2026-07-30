#Requires -Version 5.1
<#
.SYNOPSIS
  The install matrix, walked by a script, on a machine that can afford to be
  wrong. Runs inside Windows Sandbox and refuses to run anywhere else.

.DESCRIPTION
  WHAT THIS PROVES, AND WHAT IT DOES NOT. Read this before the first line of
  output, because half of M5 cannot be proved here and pretending otherwise is
  the only way this rig could do harm.

  It proves the INSTALL MATRIX: a fresh machine, an uninstall, a reinstall over
  the residue, and an install over a live install. It proves the shape of what
  lands on disk, the Run value the shell writes, the Desktop the installer hook
  has to keep clean, and the one law that matters most on somebody else's
  machine: **an uninstall does not touch the state directory.** It walks all of
  that with no hand on a mouse and writes every assertion to a transcript that
  is mapped back out of the sandbox.

  It does NOT prove the walk a stranger takes. There is no Google account in
  here, so the wizard cannot finish, no photo can be delivered, and the
  first-delivery toast cannot be seen. And it cannot show the SmartScreen wall:
  the installer arrives through a mapped folder, which carries no mark of the
  web, so Windows has nothing to warn about. **Section 1 of the M5 pass in
  `app/e2e/CHECKLIST.md` stays a human row on a real fresh machine, and nothing
  in this transcript may be read as having walked it.**

  THE RAILS. This script installs and uninstalls the real product under the real
  name, which no other script in this repository is allowed to do. Four things
  must all be true before it touches anything, and every one of them fails
  closed: the account is WDAGUtilityAccount, there is no state directory yet,
  there is no install yet, and the caller passed -ConfirmSandbox. The rails
  themselves live in `sandbox-assert.ps1` as a function of their arguments, so
  they are tested on the dev machine by `rig-selftest.ps1`, both ways.

  IT NEVER KILLS ANYTHING. The silent installer and the silent uninstaller both
  kill a running shell by themselves: `CheckIfAppIsRunning` in the generated
  `utils.nsh` does it without asking under `IfSilent`. That is the installer's
  own behaviour and one more thing this venue gets to observe, so the script
  launches the tray and then lets the installer deal with it, exactly as an
  update on a stranger's machine would.

  POWERSHELL 5.1. Windows Sandbox ships Windows PowerShell and no pwsh, so this
  script and `sandbox-assert.ps1` are both 5.1 and neither may dot-source
  `rig-common.ps1`, which requires 7.0.

.PARAMETER ConfirmSandbox
  The fourth rail. The .wsb passes it; a hand has to type it.

.EXAMPLE
  Double-click app\e2e\sandbox\photo-pigeon.wsb on the host. The logon command
  runs this script with every path already mapped.

.NOTES
  Background: docs/TRAY-DESIGN.md section 5 (two more release rules), section 6
  (the M5 working plan, rows 12, 13 and 20), app/e2e/CHECKLIST.md M5 item 0.5.
#>
[CmdletBinding()]
param(
  [switch]$ConfirmSandbox,
  [string]$InstallerDir = 'C:\pigeon\installer',
  [string]$OutDir = 'C:\pigeon\out',
  [string]$FactsPath = '',
  [int]$SettleSeconds = 12,
  [int]$InstallTimeoutSeconds = 420,
  [int]$UninstallTimeoutSeconds = 300
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'sandbox-assert.ps1')

# ---------------------------------------------------------------------------
# The transcript. Written as it happens rather than at the end, because the run
# worth reading is the one that stopped halfway.
# ---------------------------------------------------------------------------

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Records = New-Object System.Collections.ArrayList
$script:Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$script:TranscriptPath = $null

function Initialize-Transcript {
  $dir = $OutDir
  try {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
      $null = New-Item -ItemType Directory -Path $dir -Force
    }
    $probe = Join-Path $dir '.write-probe'
    [System.IO.File]::WriteAllText($probe, 'probe', $script:Utf8NoBom)
    Remove-Item -LiteralPath $probe -Force
  }
  catch {
    # A read-only or absent mapping is a venue fault, not a reason to lose the
    # run. Keep going somewhere writable and say so loudly at both ends.
    $dir = Join-Path $env:TEMP 'photo-pigeon-sandbox'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
      $null = New-Item -ItemType Directory -Path $dir -Force
    }
    Write-Host "  the mapped out folder could not be written to, so the transcript is going to $dir INSIDE the sandbox, where it dies with the sandbox. Fix the .wsb mapping." -ForegroundColor Yellow
  }
  $script:TranscriptPath = Join-Path $dir "transcript-$($script:Stamp).txt"
}

function Write-Transcript {
  param([string]$Line = '')
  if ($null -eq $script:TranscriptPath) { return }
  try { [System.IO.File]::AppendAllText($script:TranscriptPath, "$Line`r`n", $script:Utf8NoBom) } catch { }
}

function Write-Both {
  param([string]$Line = '', [string]$Colour = 'Gray')
  Write-Host $Line -ForegroundColor $Colour
  Write-Transcript $Line
}

function Write-Section {
  param([Parameter(Mandatory)][string]$Text)
  Write-Both ''
  Write-Both "== $Text" 'Cyan'
}

function Add-Record {
  param([Parameter(Mandatory)][object]$Check)
  $null = $script:Records.Add($Check)
  $mark = switch ($Check.status) {
    'pass' { 'PASS' }
    'fail' { 'FAIL' }
    'warn' { 'WARN' }
    'skip' { 'SKIP' }
    default { '    ' }
  }
  $colour = switch ($Check.status) {
    'pass' { 'Green' }
    'fail' { 'Red' }
    'warn' { 'Yellow' }
    'skip' { 'DarkGray' }
    default { 'Gray' }
  }
  $line = if ([string]::IsNullOrEmpty($Check.detail)) { "  $mark  $($Check.name)" } else { "  $mark  $($Check.name) : $($Check.detail)" }
  Write-Host $line -ForegroundColor $colour
  Write-Transcript $line
}

function Add-Records {
  param([object[]]$Checks)
  foreach ($check in @($Checks)) { Add-Record -Check $check }
}

function Add-Result {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'warn', 'info', 'skip')][string]$Status,
    [string]$Detail = ''
  )
  Add-Record -Check (New-PigeonCheck -Name $Name -Status $Status -Detail $Detail)
}

function Add-Verdict {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Condition,
    [string]$Detail = '',
    [string]$WhenFalse = 'fail'
  )
  Add-Result -Name $Name -Status (New-PigeonVerdict -Condition $Condition -WhenFalse $WhenFalse) -Detail $Detail
}

function Write-Summary {
  $passes = @($script:Records | Where-Object { $_.status -eq 'pass' }).Count
  $fails = @($script:Records | Where-Object { $_.status -eq 'fail' }).Count
  $warns = @($script:Records | Where-Object { $_.status -eq 'warn' }).Count
  $skips = @($script:Records | Where-Object { $_.status -eq 'skip' }).Count

  Write-Both ''
  Write-Both ('-' * 72) 'DarkGray'
  if ($fails -gt 0) {
    Write-Both "  FAILED   $passes passed, $fails failed, $warns warnings, $skips skipped" 'Red'
  }
  else {
    Write-Both "  PASSED   $passes passed, $warns warnings, $skips skipped" 'Green'
  }
  Write-Both '  the install matrix only. The stranger walk, the SmartScreen wall and a' 'DarkGray'
  Write-Both '  real first delivery are section 1 of the M5 pass and stay a human row.' 'DarkGray'
  Write-Both ('-' * 72) 'DarkGray'
  Write-Both ''
  Write-Host "  transcript: $($script:TranscriptPath)" -ForegroundColor White

  if ($fails -gt 0) { return 1 }
  return 0
}

# ---------------------------------------------------------------------------
# Small helpers. None of them touch the product.
# ---------------------------------------------------------------------------

function Wait-For {
  param(
    [Parameter(Mandatory)][scriptblock]$Condition,
    [int]$TimeoutSeconds = 60,
    [int]$PollMs = 500
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $PollMs
  }
  return (& $Condition)
}

function Get-PigeonProcesses {
  param([Parameter(Mandatory)][string]$ExeName)
  $bare = [System.IO.Path]::GetFileNameWithoutExtension($ExeName)
  # The comma keeps the return from enumerating: a bare @() does not survive the
  # function boundary, so an empty result would reach callers as $null, and
  # Windows PowerShell 5.1 (the engine inside the sandbox) refuses .Count on
  # $null under strict mode. The .Count call sites below all rely on this
  # arriving as an array, whatever it holds.
  return ,@(Get-Process -Name $bare -ErrorAction SilentlyContinue)
}

<#
  Run an installer or an uninstaller and wait for it, then say how long it took.

  A silent NSIS uninstaller copies itself into TEMP and runs the copy so that it
  can delete itself, so its own exit is NOT the end of the uninstall. Every
  caller here therefore waits on a condition afterwards rather than trusting the
  exit code alone, and the exit code is reported as information for the install
  and as a check only where it is meaningful.
#>
function Invoke-Installer {
  param(
    [Parameter(Mandatory)][string]$Path,
    [string[]]$Arguments = @('/S'),
    [int]$TimeoutSeconds = 420
  )
  $started = Get-Date
  $proc = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  $code = $null
  if ($exited) { $code = $proc.ExitCode }
  return [pscustomobject]@{
    exited   = $exited
    exitCode = $code
    seconds  = $seconds
  }
}

function Get-WebView2Version {
  # Read out of the same place the generated installer.nsi reads it.
  $guid = Get-PigeonWebView2AppGuid
  foreach ($path in @(
      "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid",
      "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid",
      "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid"
    )) {
    try {
      $pv = (Get-ItemProperty -LiteralPath $path -Name 'pv' -ErrorAction Stop).pv
      if (-not [string]::IsNullOrWhiteSpace($pv)) { return [string]$pv }
    }
    catch { }
  }
  return ''
}

<#
  Every Add or Remove Programs entry with this display name, under both hives.

  A list rather than a boolean because the interesting answer is never "yes":
  install over install has to leave exactly one, and two entries for one product
  is the shape a rename produces.

  Callers wrap the result in @(), because a function returning a single element
  array hands back a bare scalar and .Count then throws under strict mode.
#>
function Get-UninstallEntries {
  param([Parameter(Mandatory)][string]$DisplayName)
  $found = New-Object System.Collections.ArrayList
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      try {
        $name = (Get-ItemProperty -LiteralPath $key.PSPath -Name 'DisplayName' -ErrorAction Stop).DisplayName
        if ([string]$name -eq $DisplayName) { $null = $found.Add([string]$key.PSPath) }
      }
      catch { }
    }
  }
  return @($found.ToArray())
}

function Find-ShellLog {
  param([Parameter(Mandatory)][string]$AppDataDir)
  if (-not (Test-Path -LiteralPath $AppDataDir -PathType Container)) { return '' }
  $hit = @(Get-ChildItem -LiteralPath $AppDataDir -Recurse -File -Filter 'tray.log' -ErrorAction SilentlyContinue |
      Sort-Object -Property LastWriteTimeUtc -Descending | Select-Object -First 1)
  if ($hit.Count -eq 0) { return '' }
  return $hit[0].FullName
}

function Get-TextOrEmpty {
  param([string]$Path)
  if ([string]::IsNullOrEmpty($Path)) { return '' }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  try { return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop) } catch { return '' }
}

# ===========================================================================
# The run.
# ===========================================================================

Initialize-Transcript

$exitCode = 1
try {
  Write-Transcript "photo-pigeon sandbox rig, transcript $($script:Stamp)"
  Write-Transcript ''
  Write-Transcript 'WHAT THIS TRANSCRIPT IS: the install matrix, walked by a script inside'
  Write-Transcript 'Windows Sandbox. A fresh machine, an uninstall, a reinstall over the'
  Write-Transcript 'residue, an install over a live install, and the law that an uninstall'
  Write-Transcript 'never touches the state directory.'
  Write-Transcript ''
  Write-Transcript 'WHAT IT IS NOT: the walk a stranger takes. There is no Google account in'
  Write-Transcript 'here, so the wizard cannot finish and no photo is ever delivered, and an'
  Write-Transcript 'installer that arrived through a mapped folder carries no mark of the web,'
  Write-Transcript 'so SmartScreen has nothing to warn about. Section 1 of the M5 pass in'
  Write-Transcript 'app/e2e/CHECKLIST.md stays a human row on a real fresh machine.'
  Write-Transcript ''

  Write-Host ''
  Write-Host 'photo-pigeon sandbox rig' -ForegroundColor White
  Write-Host '  the install matrix, scripted. The stranger walk is not in here.' -ForegroundColor DarkGray

  # -----------------------------------------------------------------------
  Write-Section 'The venue, and the four rails that keep this off a real machine'

  $facts = $null
  $factsPath = if ($FactsPath -ne '') { $FactsPath } else { Join-Path $PSScriptRoot 'install-facts.json' }
  if (-not (Test-Path -LiteralPath $factsPath -PathType Leaf)) {
    Add-Result -Name 'the install facts came along' -Status 'fail' `
      -Detail "nothing at $factsPath. Run make-wsb.ps1 on the host: it reads tauri.conf.json, sidecar-layout.json, package.json and src\wizard\paths.ts and writes this file beside the .wsb."
    throw 'no install facts'
  }
  $facts = Get-Content -LiteralPath $factsPath -Raw | ConvertFrom-Json
  Add-Result -Name 'the install facts came along' -Status 'pass' `
    -Detail "$factsPath, generated $([string]$facts.readAt)"

  Add-Records (Get-PigeonFactsChecks -Facts $facts)

  $stateDir = Join-Path $env:USERPROFILE $facts.stateDirName
  $installDir = Join-Path $env:LOCALAPPDATA $facts.displayName
  $installedExe = Join-Path $installDir $facts.exeName
  $appDataDir = Join-Path $env:LOCALAPPDATA $facts.identifier
  $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $desktopDir = [Environment]::GetFolderPath('Desktop')

  Add-Records (Get-PigeonVenueChecks `
      -UserName $env:USERNAME `
      -StateDirPresent (Test-Path -LiteralPath $stateDir) `
      -InstallDirPresent (Test-Path -LiteralPath $installDir) `
      -Confirmed ([bool]$ConfirmSandbox))

  if ((Get-PigeonFailCount -Checks $script:Records) -gt 0) {
    Write-Both ''
    Write-Both '  STOPPING. A rail failed, so nothing was installed and nothing was touched.' 'Red'
    Write-Both '  This script runs inside Windows Sandbox and nowhere else.' 'Red'
    $exitCode = 2
    exit $exitCode
  }

  Write-Both "     product        $($facts.displayName) $($facts.version)"
  Write-Both "     install dir    $installDir"
  Write-Both "     state dir      $stateDir"
  Write-Both "     app data       $appDataDir"
  Write-Both "     account        $($env:USERNAME) on $($env:COMPUTERNAME)"
  Write-Transcript ''

  $webview = Get-WebView2Version
  Add-Result -Name 'the WebView2 runtime on this machine' -Status $(if ($webview -ne '') { 'info' } else { 'warn' }) `
    -Detail $(if ($webview -ne '') { "version $webview, so the installer skips its WebView2 step entirely" } else { 'not registered. INSTALLWEBVIEW2MODE is downloadBootstrapper, so the installer will try to fetch one and will abort if this sandbox has no network.' })

  # -----------------------------------------------------------------------
  Write-Section 'The installer, and there had better be exactly one of it'

  if (-not (Test-Path -LiteralPath $InstallerDir -PathType Container)) {
    Add-Result -Name 'the installer directory is mapped' -Status 'fail' -Detail "nothing at $InstallerDir"
    throw 'no installer directory'
  }
  $candidates = @(Get-ChildItem -LiteralPath $InstallerDir -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue)
  Add-Verdict -Name 'exactly one installer is mapped in' -Condition ($candidates.Count -eq 1) `
    -Detail $(if ($candidates.Count -eq 1) { "$($candidates[0].Name), $($candidates[0].Length) bytes, $($candidates[0].LastWriteTime)" } else { "$($candidates.Count) files: $(($candidates | ForEach-Object { $_.Name }) -join ', '). Two near-identical installers side by side is how the wrong one ships." })
  if ($candidates.Count -ne 1) { throw 'the installer directory does not hold exactly one installer' }

  $source = $candidates[0]
  Add-Verdict -Name 'its name carries the version the manifest carries' `
    -Condition ($source.Name -ceq $facts.installerFileName) `
    -Detail $(if ($source.Name -ceq $facts.installerFileName) { $source.Name } else { "the file is '$($source.Name)' and package.json says the build should be '$($facts.installerFileName)'" })

  # Copied out of the read-only mapping into the place a downloaded file would
  # land, which is also the only way to be sure the bytes under test are the
  # bytes on the host.
  $downloads = Join-Path $env:USERPROFILE 'Downloads'
  if (-not (Test-Path -LiteralPath $downloads -PathType Container)) { $null = New-Item -ItemType Directory -Path $downloads -Force }
  $installer = Join-Path $downloads $source.Name
  Copy-Item -LiteralPath $source.FullName -Destination $installer -Force
  $sourceHash = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash
  $copyHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
  Add-Verdict -Name 'the copy under test is the file on the host, byte for byte' `
    -Condition ($sourceHash -eq $copyHash) -Detail "sha256 $($copyHash.Substring(0, 16))"

  # -----------------------------------------------------------------------
  Write-Section '1. A fresh machine, installed silently'

  $run = Invoke-Installer -Path $installer -Arguments @('/S') -TimeoutSeconds $InstallTimeoutSeconds
  Add-Verdict -Name 'the silent install finished' -Condition $run.exited `
    -Detail $(if ($run.exited) { "$($run.seconds) seconds, exit code $($run.exitCode)" } else { "still running after $InstallTimeoutSeconds seconds" })
  Add-Verdict -Name 'and it exited 0' -Condition ($run.exitCode -eq 0) `
    -Detail $(if ($run.exitCode -eq 0) { 'nothing to elevate, nothing to click, nothing to answer' } else { "exit code $($run.exitCode). An NSIS abort here is usually the WebView2 step with no network." })

  $landed = Wait-For -TimeoutSeconds 60 -Condition { Test-Path -LiteralPath $installedExe -PathType Leaf }
  Add-Verdict -Name 'the exe is on disk' -Condition $landed -Detail $installedExe

  Add-Verdict -Name 'the tray did not start itself' -Condition ((Get-PigeonProcesses -ExeName $facts.exeName).Count -eq 0) `
    -Detail 'a silent install runs the app only when it is passed /R, and it was not'

  Write-Section '2. The shape of what landed'

  Add-Records (Get-PigeonInstallShapeChecks -Facts $facts -InstallDir $installDir `
      -LocalAppData $env:LOCALAPPDATA -StartMenuDir $startMenuDir -DesktopDir $desktopDir)

  $entries = @(Get-UninstallEntries -DisplayName $facts.displayName)
  Add-Verdict -Name 'one entry in Add or Remove Programs' -Condition ($entries.Count -eq 1) `
    -Detail $(if ($entries.Count -eq 1) { $entries[0] } else { "$($entries.Count) entries: $($entries -join ', ')" })

  Write-Section '3. Launched, and the state directory is still not there'

  $null = Start-Process -FilePath $installedExe -PassThru
  $up = Wait-For -TimeoutSeconds 60 -Condition { (Get-PigeonProcesses -ExeName $facts.exeName).Count -ge 1 }
  Add-Verdict -Name 'the tray is running' -Condition $up `
    -Detail $(if ($up) { "pid $(((Get-PigeonProcesses -ExeName $facts.exeName) | Select-Object -First 1).Id)" } else { 'no process. Its stderr goes nowhere, so the shell log below is the place to look.' })

  Start-Sleep -Seconds $SettleSeconds

  # The whole point of this row. A machine with no config must not acquire a
  # state directory by being launched: the ledger appears when a wizard finishes
  # and at no other moment.
  Add-Verdict -Name 'the state directory does NOT exist yet' -Condition (-not (Test-Path -LiteralPath $stateDir)) `
    -Detail $(if (-not (Test-Path -LiteralPath $stateDir)) { "nothing at $stateDir, which is what a machine nobody has set up looks like" } else { "$stateDir appeared, so something created it before any wizard finished" })

  Add-Verdict -Name 'and no core was spawned' -Condition ((Get-PigeonProcesses -ExeName $facts.sidecarExe).Count -eq 0) `
    -Detail 'no config, no watch. The shell opens the first-run window instead, and the core it never started is why the state directory is still absent.'

  $shellLog = Find-ShellLog -AppDataDir $appDataDir
  $logText = Get-TextOrEmpty -Path $shellLog
  Add-Verdict -Name "the shell wrote its log under the bundle identifier" -Condition ($shellLog -ne '') `
    -Detail $(if ($shellLog -ne '') { $shellLog } else { "nothing named tray.log under $appDataDir" })
  Add-Verdict -Name 'and it says this is a first run' -Condition ($logText -match 'first run, opening the setup window and spawning no core') `
    -Detail $(if ($logText -match 'first run, opening the setup window and spawning no core') { 'the decision is in the log, so it is the product deciding rather than a window happening to appear' } else { 'the first-run line is not in the log. Without it, an absent window and a window that never opened look the same.' }) `
    -WhenFalse 'warn'

  $webviews = @(Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue)
  Add-Result -Name 'webview hosts while the first-run window is open' -Status 'info' `
    -Detail "$($webviews.Count). A window is expected here: this machine has no config. Zero would mean the WebView2 runtime could not start, which is a venue fact and not a product fault."

  $runValue = Get-PigeonRunValue -Name $facts.runValueName
  Add-Records (Get-PigeonRunValueChecks `
      -Data $(if ($null -ne $runValue) { $runValue.data } else { '' }) `
      -Kind $(if ($null -ne $runValue) { $runValue.kind } else { '' }) `
      -ExpectedExe $installedExe -ExpectedFlag $facts.bootFlag)

  Write-Section '4. A state directory made by hand, with bytes that never existed before'

  # The installer never makes one and no wizard can finish in here, so the thing
  # the law protects has to be built. A GUID and a timestamp, so a surviving file
  # cannot be a coincidence and cannot be a file left by something else.
  $null = New-Item -ItemType Directory -Path $stateDir -Force
  $markerId = [System.Guid]::NewGuid().ToString()
  $marker = Join-Path $stateDir 'sandbox-marker.txt'
  [System.IO.File]::WriteAllText($marker, "photo-pigeon sandbox rig marker`r`n$markerId`r`n$((Get-Date).ToString('o'))`r`n", $script:Utf8NoBom)

  # A ledger with real-looking lines, because the law is about the ledger and a
  # rig that only protected its own marker file would prove less.
  $ledger = Join-Path $stateDir 'ledger.jsonl'
  $lines = New-Object System.Collections.ArrayList
  foreach ($i in 1..3) {
    $null = $lines.Add("{`"hash`":`"$([System.Guid]::NewGuid().ToString('N'))$([System.Guid]::NewGuid().ToString('N'))`",`"mediaItemId`":`"sandbox-$i`",`"at`":`"$((Get-Date).ToString('o'))`"}")
  }
  [System.IO.File]::WriteAllText($ledger, (($lines.ToArray() -join "`r`n") + "`r`n"), $script:Utf8NoBom)

  $witness = New-PigeonStateWitness -StateDir $stateDir
  Add-Verdict -Name 'the state directory now holds a marker and a ledger' -Condition ($witness.entries.Count -eq 2) `
    -Detail "$($witness.entries.Count) files, marker id $($markerId.Substring(0, 8)), ledger $($lines.Count) lines"

  # -----------------------------------------------------------------------
  Write-Section '5. Uninstalled silently, with the tray still running'

  $trayBefore = @(Get-PigeonProcesses -ExeName $facts.exeName)
  $coreBefore = @(Get-PigeonProcesses -ExeName $facts.sidecarExe)
  Add-Result -Name 'what was running when the uninstall started' -Status 'info' `
    -Detail "$($trayBefore.Count) tray, $($coreBefore.Count) core. The silent uninstaller kills the shell by itself, which is what the drain design absorbs: the shell dying closes the core's stdin and the core drains."

  $uninstaller = Join-Path $installDir 'uninstall.exe'
  Add-Verdict -Name 'the uninstaller is on disk' -Condition (Test-Path -LiteralPath $uninstaller -PathType Leaf) -Detail $uninstaller

  # And Add or Remove Programs points at it. An entry whose UninstallString names
  # a file that is not there is a product a person cannot remove from the only
  # place they know to look.
  $declared = ''
  if ($entries.Count -eq 1) {
    try { $declared = [string](Get-ItemProperty -LiteralPath $entries[0] -Name 'UninstallString' -ErrorAction Stop).UninstallString } catch { $declared = '' }
  }
  $declaredPath = $declared.Trim().Trim('"')
  Add-Verdict -Name 'and the Add or Remove Programs entry points at it' `
    -Condition ($declaredPath -ne '' -and (Test-Path -LiteralPath $declaredPath -PathType Leaf) -and ($declaredPath.TrimEnd('\') -ieq $uninstaller.TrimEnd('\'))) `
    -Detail $(if ($declaredPath -eq '') { 'the entry has no UninstallString' } else { $declared })

  $unrun = Invoke-Installer -Path $uninstaller -Arguments @('/S') -TimeoutSeconds $UninstallTimeoutSeconds
  Add-Result -Name 'the uninstaller was launched' -Status 'info' `
    -Detail "returned after $($unrun.seconds) seconds with exit code $([string]$unrun.exitCode). A silent NSIS uninstaller copies itself into TEMP and runs the copy, so this is not the end of the uninstall and the wait below is."

  $removed = Wait-For -TimeoutSeconds $UninstallTimeoutSeconds -PollMs 1000 -Condition {
    (-not (Test-Path -LiteralPath $installDir)) -and (@(Get-Process -Name 'Au_' -ErrorAction SilentlyContinue).Count -eq 0)
  }
  Start-Sleep -Seconds 3
  Add-Verdict -Name 'the uninstall really finished' -Condition $removed `
    -Detail $(if ($removed) { 'the install directory went and the temporary uninstaller exited' } else { "$installDir is still there after $UninstallTimeoutSeconds seconds" })

  Write-Section '6. What the uninstall took, and the one thing it may not touch'

  Add-Records (Get-PigeonRemovalChecks -Facts $facts -InstallDir $installDir `
      -StartMenuDir $startMenuDir -DesktopDir $desktopDir -AppDataDir $appDataDir)

  $trayGone = Wait-For -TimeoutSeconds 15 -Condition { (Get-PigeonProcesses -ExeName $facts.exeName).Count -eq 0 }
  Add-Verdict -Name 'no tray process outlived the uninstall' -Condition $trayGone `
    -Detail 'the uninstaller kills a running shell without asking under IfSilent, which is CheckIfAppIsRunning in the generated utils.nsh'

  Add-Verdict -Name 'the Run value is gone' -Condition ($null -eq (Get-PigeonRunValue -Name $facts.runValueName)) `
    -Detail "the uninstaller deletes HKCU Run '$($facts.runValueName)', and that is why the Run value name has to equal the display name"

  Add-Verdict -Name 'the Add or Remove Programs entry is gone' `
    -Condition (@(Get-UninstallEntries -DisplayName $facts.displayName).Count -eq 0) `
    -Detail 'nothing left in the uninstall key under either hive'

  # THE LEDGER LAW. Everything above is shape; this is the one that would cost a
  # stranger their whole library.
  $after = New-PigeonStateWitness -StateDir $stateDir
  Add-Records (Get-PigeonStateSurvivalChecks -Before $witness -After $after -Prefix 'the ledger law:')
  $markerText = Get-TextOrEmpty -Path $marker
  Add-Verdict -Name 'the ledger law: the marker still carries the id it was written with' `
    -Condition ($markerText -match [regex]::Escape($markerId)) `
    -Detail $(if ($markerText -match [regex]::Escape($markerId)) { "id $($markerId.Substring(0, 8)) read back out of $marker" } else { 'the marker file no longer carries its own id, so something rewrote it' })

  # -----------------------------------------------------------------------
  Write-Section '7. Installed again, over the residue'

  $residue = New-Object System.Collections.ArrayList
  if (Test-Path -LiteralPath $stateDir) { $null = $residue.Add($stateDir) }
  if (Test-Path -LiteralPath $appDataDir) { $null = $residue.Add($appDataDir) }
  Add-Result -Name 'what the uninstall left behind for this install to land on' -Status 'info' `
    -Detail $(if ($residue.Count -gt 0) { ($residue.ToArray() -join ', ') } else { 'nothing, which makes this row a fresh install again rather than the reinstall it is meant to be' })

  $again = Invoke-Installer -Path $installer -Arguments @('/S') -TimeoutSeconds $InstallTimeoutSeconds
  Add-Verdict -Name 'the reinstall exited 0' -Condition ($again.exitCode -eq 0) -Detail "$($again.seconds) seconds, exit code $([string]$again.exitCode)"
  $landedAgain = Wait-For -TimeoutSeconds 60 -Condition { Test-Path -LiteralPath $installedExe -PathType Leaf }
  Add-Verdict -Name 'the exe is back on disk' -Condition $landedAgain -Detail $installedExe

  Add-Records (Get-PigeonInstallShapeChecks -Facts $facts -InstallDir $installDir `
      -LocalAppData $env:LOCALAPPDATA -StartMenuDir $startMenuDir -DesktopDir $desktopDir -Prefix 'after the reinstall:')

  $entriesAgain = @(Get-UninstallEntries -DisplayName $facts.displayName)
  Add-Verdict -Name 'after the reinstall: still one entry in Add or Remove Programs' -Condition ($entriesAgain.Count -eq 1) `
    -Detail "$($entriesAgain.Count) entry"

  $afterReinstall = New-PigeonStateWitness -StateDir $stateDir
  Add-Records (Get-PigeonStateSurvivalChecks -Before $witness -After $afterReinstall -Prefix 'after the reinstall:')

  Write-Section '8. And it runs, with the same state directory it never asked about'

  $null = Start-Process -FilePath $installedExe -PassThru
  $upAgain = Wait-For -TimeoutSeconds 60 -Condition { (Get-PigeonProcesses -ExeName $facts.exeName).Count -ge 1 }
  Add-Verdict -Name 'the reinstalled tray runs' -Condition $upAgain -Detail $installedExe
  Start-Sleep -Seconds $SettleSeconds

  $runValueAgain = Get-PigeonRunValue -Name $facts.runValueName
  Add-Records (Get-PigeonRunValueChecks `
      -Data $(if ($null -ne $runValueAgain) { $runValueAgain.data } else { '' }) `
      -Kind $(if ($null -ne $runValueAgain) { $runValueAgain.kind } else { '' }) `
      -ExpectedExe $installedExe -ExpectedFlag $facts.bootFlag -Prefix 'after the reinstall:')

  Add-Result -Name 'what this row cannot prove' -Status 'info' `
    -Detail 'that a reinstall finds a real config and delivers without asking for anything. That needs a token and a Google account, so items 2.5 and 2.6 of the M5 pass stay in a human hand.'

  # -----------------------------------------------------------------------
  Write-Section '9. Installed over a live install, which is the update a stranger gets'

  $liveBefore = @(Get-PigeonProcesses -ExeName $facts.exeName)
  Add-Verdict -Name 'the tray is running as the install starts' -Condition ($liveBefore.Count -ge 1) `
    -Detail $(if ($liveBefore.Count -ge 1) { "$($liveBefore.Count) process. This is the row where the installer has to deal with a running app rather than the other way around." } else { 'nothing is running, so this is an install over a dead install and not the row it says it is. Read the rest of this section as shape only.' }) `
    -WhenFalse 'warn'

  $over = Invoke-Installer -Path $installer -Arguments @('/S') -TimeoutSeconds $InstallTimeoutSeconds
  Add-Verdict -Name 'the install over install exited 0' -Condition ($over.exitCode -eq 0) `
    -Detail "$($over.seconds) seconds, exit code $([string]$over.exitCode)"

  $liveStopped = Wait-For -TimeoutSeconds 15 -Condition { (Get-PigeonProcesses -ExeName $facts.exeName).Count -eq 0 }
  Add-Verdict -Name 'it stopped the running tray by itself' -Condition $liveStopped `
    -Detail 'IfSilent kill, in CheckIfAppIsRunning. A stranger updating over a running copy is never asked to close it first, and an exe that could not be replaced would have failed the install above.'

  Add-Records (Get-PigeonInstallShapeChecks -Facts $facts -InstallDir $installDir `
      -LocalAppData $env:LOCALAPPDATA -StartMenuDir $startMenuDir -DesktopDir $desktopDir -Prefix 'after install over install:')

  $entriesOver = @(Get-UninstallEntries -DisplayName $facts.displayName)
  Add-Verdict -Name 'after install over install: still one entry in Add or Remove Programs' `
    -Condition ($entriesOver.Count -eq 1) -Detail "$($entriesOver.Count) entry"

  $localCopies = @(Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $facts.displayName -or $_.Name -eq $facts.npmName })
  Add-Verdict -Name 'and no second install directory under another name' -Condition ($localCopies.Count -eq 1) `
    -Detail $(if ($localCopies.Count -eq 1) { $localCopies[0].FullName } else { "$($localCopies.Count) directories: $(($localCopies | ForEach-Object { $_.Name }) -join ', '). NSIS keys its uninstall entry on the display name, so an install under the old machine name is a different product and is neither upgraded nor removed." })

  # The Run value survives an install: only the uninstaller deletes it, and only
  # when it is not updating. A tool that silently stops starting is the failure
  # this row exists for.
  $runValueOver = Get-PigeonRunValue -Name $facts.runValueName
  Add-Records (Get-PigeonRunValueChecks `
      -Data $(if ($null -ne $runValueOver) { $runValueOver.data } else { '' }) `
      -Kind $(if ($null -ne $runValueOver) { $runValueOver.kind } else { '' }) `
      -ExpectedExe $installedExe -ExpectedFlag $facts.bootFlag -Prefix 'after install over install:')

  $afterOver = New-PigeonStateWitness -StateDir $stateDir
  Add-Records (Get-PigeonStateSurvivalChecks -Before $witness -After $afterOver -Prefix 'after install over install:')

  $exitCode = 0
}
catch {
  Add-Result -Name 'the run stopped early' -Status 'fail' -Detail ([string]$_.Exception.Message)
  Write-Transcript ''
  Write-Transcript ([string]$_.ScriptStackTrace)
  $exitCode = 1
}
finally {
  # A rail refusal keeps its own code: 2 says nothing was touched, which is a
  # different sentence from 1, a check failed on a machine that was installed to.
  $summaryVerdict = Write-Summary
  if ($exitCode -ne 2 -and $summaryVerdict -ne 0) { $exitCode = $summaryVerdict }

  try {
    $jsonPath = [System.IO.Path]::ChangeExtension($script:TranscriptPath, '.json')
    $report = [pscustomobject]@{
      rig      = 'app/e2e/sandbox/bootstrap.ps1'
      proves   = 'the install matrix: fresh machine, uninstall, reinstall over residue, install over install, and the uninstall-leaves-the-ledger law'
      notProve = 'the stranger walk, the SmartScreen wall, and any real delivery. Those are section 1 of the M5 pass in app/e2e/CHECKLIST.md.'
      stamp    = $script:Stamp
      account  = $env:USERNAME
      machine  = $env:COMPUTERNAME
      exitCode = $exitCode
      checks   = @($script:Records)
    }
    [System.IO.File]::WriteAllText($jsonPath, ($report | ConvertTo-Json -Depth 6), $script:Utf8NoBom)
    Write-Host "  machine readable: $jsonPath" -ForegroundColor DarkGray
  }
  catch { }

  Write-Host ''
  Write-Host '  This window is left open on purpose. Close the sandbox when you have read' -ForegroundColor DarkGray
  Write-Host '  the transcript on the host: everything in here goes with it.' -ForegroundColor DarkGray
}

exit $exitCode
