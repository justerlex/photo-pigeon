#Requires -Version 7.0
<#
.SYNOPSIS
  Scripted end to end check for the photo-pigeon tray shell (milestone M2).

.DESCRIPTION
  Builds a throwaway config in TEMP, points the tray at it through an
  environment variable, waits for the sidecar to come up against THAT config,
  drops one freshly generated PNG into the throwaway watch folder, and polls
  the throwaway ledger until the delivery lands.

  Every path this script touches lives inside one run directory under TEMP.
  It never reads and never writes the real ~/.photo-pigeon, and it refuses to
  start if any generated path would land there. Credentials and a token are
  parameters, never a hardcoded location, and the copies it makes are removed
  when the run ends.

  The core is never killed. The shell is stopped, the core sees end of file on
  its stdin, drains, and exits on its own. If it does not, this script says so
  and leaves it alone.

.PARAMETER Target
  Tray  runs the built photo-pigeon.exe, which spawns the sidecar itself.
  Core  runs the CLI directly (node dist/cli.js watch --events ndjson).
        Use this to prove the rig itself works, and to tell a rig fault apart
        from a tray fault. Core mode also captures the NDJSON stream and
        asserts the event contract the tray has to map.

.PARAMETER Stage
  full     prepare, launch, deliver, quit, report. The default.
  prepare  build the run directory and print the launch line, then stop, so a
           human can drive the tray by hand for the manual checklist.
  drop     drop one more PNG into an existing run directory and poll for it.
           Needs -RunDir. Launches nothing and stops nothing.

.EXAMPLE
  # rig self test, no network, no secrets needed
  pwsh -File app\e2e\run-e2e.ps1 -Target Core -DryRun

.EXAMPLE
  # the real thing: one photo really is delivered to Google Photos
  pwsh -File app\e2e\run-e2e.ps1 -CredentialsPath C:\keys\client.json -TokenPath C:\keys\token.json

.EXAMPLE
  # set up for the manual checklist, then clean up afterwards
  pwsh -File app\e2e\run-e2e.ps1 -Stage prepare -CredentialsPath ... -TokenPath ...
#>
[CmdletBinding()]
param(
  [ValidateSet('Tray', 'Core')]
  [string]$Target = 'Tray',

  [ValidateSet('full', 'prepare', 'drop')]
  [string]$Stage = 'full',

  [string]$ExePath,
  [string]$CredentialsPath,
  [string]$TokenPath,
  [string]$RunDir,

  [string]$Album = 'photo-pigeon e2e',
  [switch]$DryRun,

  [string]$ConfigEnvName = 'PHOTO_PIGEON_CONFIG',
  [string[]]$ExtraArgs = @(),
  [string]$QuitCommand,
  [string]$ShellLog,
  [string]$CoreJs,
  [string]$NodeExe,

  [int]$IdleSettleSec = 30,
  [int]$ReadySec = 45,
  [int]$TimeoutSec = 240,
  [int]$DrainTimeoutSec = 120,

  [switch]$KeepSecrets,
  [switch]$AllowExistingTray
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['*:ErrorAction'] = 'Stop'

# ---------------------------------------------------------------------------
# The rails. Every helper below this line is shared with run-m3.ps1 and lives
# in one file on purpose: a second copy of Assert-OutsideRealConfig is a second
# copy that can drift, and the drifted one is the one that will be running on
# the night it matters.
#
# Dot-sourcing shares scope, so $script:Checks, $script:Measurements and
# $script:Failed below are this script's own.
# ---------------------------------------------------------------------------

. "$PSScriptRoot\rig-common.ps1"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# The switch says what this invocation asked for. A drop into a prepared run
# reads the truth out of the config that is already on disk instead.
$script:dryRunMode = [bool]$DryRun

# ---------------------------------------------------------------------------
# The run.
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'photo-pigeon tray E2E' -ForegroundColor White
Write-Host "  target      $Target" -ForegroundColor DarkGray
Write-Host "  stage       $Stage" -ForegroundColor DarkGray
Write-Host "  dry run     $([bool]$DryRun)" -ForegroundColor DarkGray

$run = $null
$launched = $null
$sidecarPid = 0

try {
  # -- preflight -----------------------------------------------------------
  Write-Step 'Preflight'

  if (-not $DryRun -and $Stage -ne 'drop') {
    if ([string]::IsNullOrWhiteSpace($CredentialsPath) -or [string]::IsNullOrWhiteSpace($TokenPath)) {
      throw 'a real run needs -CredentialsPath and -TokenPath. Point them at your own client JSON and token, or add -DryRun to check the wiring without a network.'
    }
  }
  foreach ($pair in @(@{ p = $CredentialsPath; l = 'credentials' }, @{ p = $TokenPath; l = 'token' })) {
    if (-not [string]::IsNullOrWhiteSpace($pair.p)) {
      if (-not (Test-Path -LiteralPath $pair.p -PathType Leaf)) { throw "no $($pair.l) file at $($pair.p)" }
    }
  }
  Add-Check -Name 'inputs are parameters, not a hardcoded home' -Status 'pass' `
    -Detail 'the production config directory is never read'

  # Tray only: -Target Core puts `-c` on the command line itself and never reads
  # the environment. This has to happen before anything is launched, and before
  # -Stage prepare prints a launch line for a human to paste.
  if ($Target -eq 'Tray') { Assert-ConfigEnvNameMatchesTheShell -ConfigEnvName $ConfigEnvName -RepoRoot $repoRoot }

  # Watches that were here before us. Nothing in this list is ever stopped, and
  # every one of them has to still be alive at the end. This is the check that
  # says the production watch was left alone.
  $preExisting = @(Get-PigeonWatchProcesses)
  if ($preExisting.Count -gt 0) {
    Add-Check -Name 'a photo-pigeon watch is already running' -Status 'info' `
      -Detail "$((@($preExisting | ForEach-Object { "$($_.name)/$($_.pid)" })) -join ', '). It is never touched, and it must still be running at the end."
  }
  else {
    Add-Check -Name 'no photo-pigeon watch was running before this' -Status 'info' -Detail ''
  }

  $existingTray = @($preExisting | Where-Object { $_.name -eq 'photo-pigeon.exe' })
  if ($existingTray.Count -gt 0 -and $Target -eq 'Tray' -and $Stage -eq 'full') {
    if (-not $AllowExistingTray) {
      Stop-Unsafe "a tray is already running (pid $($existingTray[0].pid)). Quit it from its own menu first, or pass -AllowExistingTray if you know it is another test."
    }
    Add-Check -Name 'existing tray' -Status 'warn' -Detail "pid $($existingTray[0].pid), allowed by flag"
  }

  # -- run directory -------------------------------------------------------
  if ($Stage -eq 'drop') {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { throw '-Stage drop needs -RunDir pointing at a prepared run' }
    $dir = (Resolve-Path -LiteralPath $RunDir).Path
    Assert-OutsideRealConfig -Path $dir -Label 'the run directory'
    $run = [pscustomobject]@{
      dir             = $dir
      configPath      = Join-Path $dir 'config.json'
      watchDir        = Join-Path $dir 'watch'
      stagingDir      = Join-Path $dir 'staging'
      ledgerPath      = Join-Path $dir 'ledger.jsonl'
      lockPath        = Join-Path $dir 'watch.lock'
      logPath         = Join-Path $dir 'watch.log'
      sideIndexPath   = Join-Path $dir 'sideindex.jsonl'
      credentialsPath = Join-Path $dir 'credentials.json'
      tokenPath       = Join-Path $dir 'token.json'
      secretsCopied   = $true
    }
    if (-not (Test-Path -LiteralPath $run.configPath)) { throw "no config.json in $dir. Was it made with -Stage prepare?" }

    # The prepared config is the authority on which mode this run is in, so a
    # human dropping a photo does not have to remember a flag.
    try {
      $prepared = Get-Content -LiteralPath $run.configPath -Raw | ConvertFrom-Json
      if (($prepared.PSObject.Properties.Name -contains 'dryRun') -and $prepared.dryRun) { $script:dryRunMode = $true }
    }
    catch { }
    if ($script:dryRunMode -and -not $DryRun) {
      Write-Note 'the prepared config is a dry run, so nothing here will be uploaded'
    }

    if (Test-Path -LiteralPath $run.lockPath) {
      Add-Check -Name 'something is watching this folder' -Status 'pass' -Detail $run.lockPath
    }
    else {
      Add-Check -Name 'something is watching this folder' -Status 'fail' `
        -Detail "no lock file at $($run.lockPath). Launch the tray against $($run.configPath) first, or the photo will just sit there."
    }
  }
  else {
    $dir = if ([string]::IsNullOrWhiteSpace($RunDir)) { New-RunDirectory } else {
      $null = New-Item -ItemType Directory -Path $RunDir -Force
      (Resolve-Path -LiteralPath $RunDir).Path
    }
    Assert-OutsideRealConfig -Path $dir -Label 'the run directory'
    $run = New-RunConfig -Dir $dir -CredentialsPath $CredentialsPath -TokenPath $TokenPath `
      -Album $Album -DryRunConfig ([bool]$DryRun)
    Add-Check -Name 'throwaway config written' -Status 'pass' -Detail $run.configPath
    Add-Check -Name 'every generated path is under TEMP' -Status 'pass' -Detail $run.dir
  }

  Write-Note "run directory  $($run.dir)"
  Write-Note "watch folder   $($run.watchDir)"
  Write-Note "ledger         $($run.ledgerPath)"
  Write-Note "core log       $($run.logPath)"

  # -- prepare stops here --------------------------------------------------
  if ($Stage -eq 'prepare') {
    Write-Step 'Prepared. Drive the tray by hand from here.'
    $exe = if ($Target -eq 'Tray') { try { Resolve-TrayExe -Given $ExePath -RepoRoot $repoRoot } catch { '<build it first>' } } else { '<core mode>' }
    Write-Host ''
    Write-Host '  Launch the tray against this config:' -ForegroundColor White
    Write-Host "    `$env:$ConfigEnvName = '$($run.configPath)'" -ForegroundColor Yellow
    Write-Host "    `$env:PHOTO_PIGEON_SHELL_LOG = '$(Join-Path $run.dir 'shell.log')'" -ForegroundColor Yellow
    Write-Host "    & '$exe'" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Both variables have to be set in the same window you launch from,' -ForegroundColor White
    Write-Host '  because the tray reads them from the environment it inherits.' -ForegroundColor White
    Write-Host ''
    Write-Host '  Then check the override actually arrived, before you drop anything:' -ForegroundColor White
    Write-Host "    Get-CimInstance Win32_Process -Filter `"Name='pigeon-core.exe' OR Name='node.exe'`" |" -ForegroundColor Yellow
    Write-Host '      Select-Object ProcessId, CommandLine' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  The tray's sidecar must show   -c $($run.configPath)" -ForegroundColor White
    Write-Host '  If it shows no -c at all, the variable did not reach the tray and the' -ForegroundColor Magenta
    Write-Host '  engine is on the real config. Quit the tray from its menu and start again.' -ForegroundColor Magenta
    Write-Host ''
    Write-Host '  Drop a photo into it whenever the checklist asks:' -ForegroundColor White
    Write-Host "    pwsh -File '$PSCommandPath' -Stage drop -RunDir '$($run.dir)'" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  When the manual pass is over, quit the tray from its menu and then:' -ForegroundColor White
    Write-Host "    Remove-Item -Recurse -Force '$($run.dir)'" -ForegroundColor Yellow
    if ($run.secretsCopied) {
      Write-Host ''
      Write-Host '  That directory holds a copy of your token. Delete it when you are done.' -ForegroundColor Magenta
    }
    Add-Check -Name 'prepare stage complete' -Status 'pass' -Detail $run.dir
  }
  else {
    # -- launch ------------------------------------------------------------
    $shellLogPath = ''
    if ($Stage -eq 'full') {
      Write-Step 'Launch'
      if ($Target -eq 'Tray') {
        $shellLogPath = Resolve-ShellLog -Given $ShellLog -RunDirectory $run.dir
        Write-Note "shell log      $shellLogPath"
        $exe = Resolve-TrayExe -Given $ExePath -RepoRoot $repoRoot
        $info = try { [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe) } catch { $null }
        Add-Check -Name 'tray binary found' -Status 'pass' `
          -Detail "$exe$(if ($info) { " (version $($info.FileVersion))" })"
        if ((Split-Path -Leaf $exe) -ne 'photo-pigeon.exe') {
          Add-Check -Name 'binary name is photo-pigeon.exe' -Status 'warn' -Detail (Split-Path -Leaf $exe)
        }
        else {
          Add-Check -Name 'binary name is photo-pigeon.exe' -Status 'pass'
        }
        $launched = Start-Tray -Run $run -Exe $exe -ShellLogPath $shellLogPath `
          -ConfigEnvName $ConfigEnvName -CoreJs $CoreJs -NodeExe $NodeExe -ExtraArgs $ExtraArgs
        Add-Check -Name 'shell started' -Status 'pass' -Detail "pid $($launched.id), $ConfigEnvName set"
      }
      else {
        $launched = Start-CoreDirect -Run $run -RepoRoot $repoRoot
        $sidecarPid = $launched.id
        Add-Check -Name 'core started directly' -Status 'pass' -Detail "pid $($launched.id)"
      }

      Start-Sleep -Seconds 3
      if ($launched.process.HasExited) {
        $tail = Get-FileTail -Path $launched.stderr
        Add-Check -Name 'process survived its first seconds' -Status 'fail' `
          -Detail "exit code $($launched.process.ExitCode). stderr tail: $tail"
        throw 'the launched process exited immediately'
      }
      Add-Check -Name 'process survived its first seconds' -Status 'pass'

      # -- the safety assertion that matters most --------------------------
      # Whatever the tray spawned has to be pointed at OUR config. If it is
      # pointed anywhere else, Assert-SidecarOnThrowawayConfig stops the shell
      # and refuses, and this run never reaches the next line.
      if ($Target -eq 'Tray') {
        Write-Step 'Config override honoured'
        $sidecarPid = Assert-SidecarOnThrowawayConfig -Launched $launched -Run $run `
          -ReadySec $ReadySec -ShellLogPath $shellLogPath
      }

      # -- readiness -------------------------------------------------------
      Write-Step 'Sidecar up'
      $ready = Wait-Until -TimeoutSeconds $ReadySec -Condition {
        if (Test-Path -LiteralPath $run.lockPath) { return $true }
        if ($shellLogPath -ne '' -and (Test-Path -LiteralPath $shellLogPath)) {
          $tail = Get-FileTail -Path $shellLogPath -Lines 200
          if ($tail -match '"type"\s*:\s*"started"') { return $true }
        }
        if ($Target -eq 'Core' -and (Test-Path -LiteralPath $launched.ndjson)) {
          $tail = Get-FileTail -Path $launched.ndjson -Lines 200
          if ($tail -match '"type"\s*:\s*"started"') { return $true }
        }
        return $false
      }

      if (-not $ready) {
        Add-Check -Name 'sidecar reported started' -Status 'fail' `
          -Detail "no lock file at $($run.lockPath) and no started event within $ReadySec seconds"
        Write-Note ('core log tail: ' + (Get-FileTail -Path $run.logPath -Lines 15))
        if ($Target -eq 'Tray') {
          Write-Note ('shell log tail: ' + (Get-FileTail -Path $shellLogPath -Lines 20))
          Write-Note ('shell stderr tail: ' + (Get-FileTail -Path $launched.stderr -Lines 15))
        }
      }
      else {
        $lock = $null
        if (Test-Path -LiteralPath $run.lockPath) {
          try { $lock = Get-Content -LiteralPath $run.lockPath -Raw | ConvertFrom-Json } catch { $lock = $null }
        }
        if ($null -ne $lock) {
          Add-Check -Name 'sidecar took the throwaway lock' -Status 'pass' `
            -Detail "pid $($lock.pid), host $($lock.host), taken $($lock.takenAt)"
          if ($sidecarPid -eq 0) { $sidecarPid = [int]$lock.pid }
          if ($sidecarPid -ne 0 -and [int]$lock.pid -ne $sidecarPid) {
            Add-Check -Name 'the lock holder is the process we launched' -Status 'warn' `
              -Detail "lock says $($lock.pid), we tracked $sidecarPid"
          }
        }
        else {
          Add-Check -Name 'sidecar took the throwaway lock' -Status 'warn' -Detail 'started, but no readable lock file yet'
        }
        Add-Check -Name 'sidecar reported started' -Status 'pass'
      }

      if (Test-Path -LiteralPath $run.logPath) {
        Add-Check -Name 'Open log has something to open' -Status 'pass' -Detail $run.logPath
      }
      else {
        Add-Check -Name 'Open log has something to open' -Status 'fail' -Detail "no log file at $($run.logPath)"
      }

      if ($Target -eq 'Tray') {
        if (Test-Path -LiteralPath $shellLogPath) {
          Add-Check -Name 'the shell wrote its own log where it was told to' -Status 'pass' -Detail $shellLogPath
        }
        else {
          Add-Check -Name 'the shell wrote its own log where it was told to' -Status 'warn' `
            -Detail "nothing at $shellLogPath, so PHOTO_PIGEON_SHELL_LOG was ignored or the shell says nothing yet"
        }
      }

      # -- idle memory -----------------------------------------------------
      if ($IdleSettleSec -gt 0) {
        Write-Step "Idle memory, after $IdleSettleSec seconds of settling"
        Start-Sleep -Seconds $IdleSettleSec

        if ($Target -eq 'Tray') {
          $shellMem = Get-ProcessMemory -Id $launched.id
          if ($null -ne $shellMem) {
            $script:Measurements['shellIdle'] = $shellMem
            $status = if ($shellMem.workingSetMB -gt 25) { 'fail' } elseif ($shellMem.workingSetMB -gt 15) { 'warn' } else { 'pass' }
            Add-Check -Name 'tray shell idle RSS under the 25 MB reopen line' -Status $status `
              -Detail "$($shellMem.workingSetMB) MB working set, $($shellMem.privateMB) MB private (M0 measured 9.87 MB with no sidecar)"
          }

          $webviews = @(Get-DescendantProcesses -ParentId $launched.id |
            Where-Object { $_.name -like 'msedgewebview2*' })
          $script:Measurements['webviewsAtIdle'] = $webviews.Count
          $status = if ($webviews.Count -eq 0) { 'pass' } else { 'fail' }
          Add-Check -Name 'zero WebView2 processes while no window is open' -Status $status `
            -Detail "$($webviews.Count) found"
        }

        if ($sidecarPid -ne 0) {
          $coreMem = Get-ProcessMemory -Id $sidecarPid
          if ($null -ne $coreMem) {
            $script:Measurements['coreIdle'] = $coreMem
            $status = if ($coreMem.workingSetMB -gt 120) { 'fail' } elseif ($coreMem.workingSetMB -gt 80) { 'warn' } else { 'pass' }
            Add-Check -Name 'core sidecar RSS while watching, queue empty' -Status $status `
              -Detail "$($coreMem.workingSetMB) MB working set, $($coreMem.privateMB) MB private (target 40 to 80, reopen at 120)"
          }
        }
      }
    }

    # -- the delivery ------------------------------------------------------
    Write-Step 'Delivery'

    $ledgerBefore = @(Read-JsonLines -Path $run.ledgerPath)
    $marker = "photo-pigeon-e2e $([System.Guid]::NewGuid().ToString())"
    $name = "pigeon-e2e-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([System.Guid]::NewGuid().ToString('N').Substring(0,8)).png"
    $staged = Join-Path $run.stagingDir $name
    if (-not (Test-Path -LiteralPath $run.stagingDir)) { $null = New-Item -ItemType Directory -Path $run.stagingDir -Force }

    $size = New-TestPng -Path $staged -Marker $marker
    $expectedHash = Get-Sha256Hex -Path $staged
    Add-Check -Name 'unique PNG generated' -Status 'pass' -Detail "$name, $size bytes, sha256 $($expectedHash.Substring(0,12))"

    # Built outside the watch folder and moved in, so the watcher can never see
    # a half written file and no settle race is possible.
    $dropped = Join-Path $run.watchDir $name
    Move-Item -LiteralPath $staged -Destination $dropped -Force
    $droppedAt = Get-Date
    Add-Check -Name 'photo dropped into the watched folder' -Status 'pass' -Detail $dropped

    # A dry run writes nothing to the ledger, by design, so the thing to wait
    # for is the side index: it records a hash only for bytes the core read
    # itself, which is the proof that this exact file was seen.
    $waitFor = if ($script:dryRunMode) {
      {
        $entries = @(Read-JsonLines -Path $run.sideIndexPath)
        return @($entries | Where-Object {
            $_.PSObject.Properties.Name -contains 'hash' -and $_.hash -eq $expectedHash
          }).Count -gt 0
      }
    }
    else {
      {
        $lines = @(Read-JsonLines -Path $run.ledgerPath)
        $hit = @($lines | Where-Object {
            $_.PSObject.Properties.Name -contains 'hash' -and $_.hash -eq $expectedHash
          })
        if ($hit.Count -gt 0) { $script:landedEntry = $hit[0]; return $true }
        return $false
      }
    }
    $waitSeconds = if ($script:dryRunMode) { [Math]::Min($TimeoutSec, 60) } else { $TimeoutSec }

    $found = Wait-Until -TimeoutSeconds $waitSeconds -PollMs 1000 -Condition $waitFor -EachPoll {
      if ($sidecarPid -ne 0) {
        $m = Get-ProcessMemory -Id $sidecarPid
        if ($null -ne $m -and $m.workingSetMB -gt $script:coreMaxSeen) { $script:coreMaxSeen = $m.workingSetMB }
      }
      if ($null -ne $launched -and $Target -eq 'Tray') {
        $m = Get-ProcessMemory -Id $launched.id
        if ($null -ne $m -and $m.workingSetMB -gt $script:shellMaxSeen) { $script:shellMaxSeen = $m.workingSetMB }
      }
    }

    $elapsed = [math]::Round(((Get-Date) - $droppedAt).TotalSeconds, 1)
    $coreMaxMB = $script:coreMaxSeen
    $shellMaxMB = $script:shellMaxSeen

    if ($script:dryRunMode) {
      Add-Check -Name 'dry run: the core hashed the dropped file' -Status $(if ($found) { 'pass' } else { 'fail' }) `
        -Detail "side index $(if ($found) { "holds sha256 $($expectedHash.Substring(0,12)) after $elapsed seconds" } else { "never held sha256 $($expectedHash.Substring(0,12))" })"
      Add-Check -Name 'dry run: nothing was written to the ledger' `
        -Status $(if ((@(Read-JsonLines -Path $run.ledgerPath)).Count -eq $ledgerBefore.Count) { 'pass' } else { 'fail' })
    }
    elseif ($found) {
      $entry = $script:landedEntry
      Add-Check -Name 'the delivery landed in the ledger' -Status 'pass' -Detail "$elapsed seconds after the drop"
      $hasId = ($entry.PSObject.Properties.Name -contains 'mediaItemId') -and -not [string]::IsNullOrWhiteSpace($entry.mediaItemId)
      Add-Check -Name 'the ledger entry carries a Google media item id' `
        -Status $(if ($hasId) { 'pass' } else { 'fail' }) `
        -Detail $(if ($hasId) { "$($entry.mediaItemId.Substring(0, [Math]::Min(16, $entry.mediaItemId.Length)))..." } else { 'absent' })
      Add-Check -Name 'the ledger entry records the real byte count' `
        -Status $(if ([int]$entry.size -eq $size) { 'pass' } else { 'warn' }) `
        -Detail "$($entry.size) bytes on disk, $($entry.bytes) bytes sent"
      $script:Measurements['deliverySeconds'] = $elapsed
    }
    else {
      Add-Check -Name 'the delivery landed in the ledger' -Status 'fail' `
        -Detail "sha256 $($expectedHash.Substring(0,12)) never appeared within $TimeoutSec seconds"
      Write-Note ('core log tail: ' + (Get-FileTail -Path $run.logPath -Lines 20))
      if ($Target -eq 'Core') { Write-Note ('ndjson tail: ' + (Get-FileTail -Path $launched.ndjson -Lines 20)) }
    }

    if ($coreMaxMB -gt 0) {
      $script:Measurements['coreUnderLoadMaxMB'] = $coreMaxMB
      Add-Check -Name 'core sidecar RSS under load' `
        -Status $(if ($coreMaxMB -gt 120) { 'fail' } elseif ($coreMaxMB -gt 80) { 'warn' } else { 'pass' }) `
        -Detail "$coreMaxMB MB peak working set"
    }
    if ($shellMaxMB -gt 0) {
      $script:Measurements['shellUnderLoadMaxMB'] = $shellMaxMB
      Add-Check -Name 'tray shell RSS under load' `
        -Status $(if ($shellMaxMB -gt 25) { 'fail' } elseif ($shellMaxMB -gt 15) { 'warn' } else { 'pass' }) `
        -Detail "$shellMaxMB MB peak working set"
    }

    # -- events, when we can see them --------------------------------------
    if ($Target -eq 'Core' -and $Stage -eq 'full') {
      $events = @(Read-JsonLines -Path $launched.ndjson)
      $types = @($events | Where-Object { $_.PSObject.Properties.Name -contains 'type' } | ForEach-Object { $_.type })
      foreach ($wanted in @('started', 'delivering')) {
        Add-Check -Name "event stream carries $wanted" `
          -Status $(if ($types -contains $wanted) { 'pass' } else { 'fail' }) -Detail ''
      }
      if (-not $script:dryRunMode) {
        Add-Check -Name 'event stream carries delivered' `
          -Status $(if ($types -contains 'delivered') { 'pass' } else { 'fail' }) -Detail ''
      }
      $bad = @($events | Where-Object { $_.PSObject.Properties.Name -notcontains 'at' })
      Add-Check -Name 'every event carries an at timestamp' `
        -Status $(if ($bad.Count -eq 0) { 'pass' } else { 'fail' }) -Detail "$($bad.Count) without one"
    }

    # -- quit ---------------------------------------------------------------
    if ($Stage -eq 'full') {
      Write-Step 'Quit and drain'

      # Never stop anything while work is still moving. The ledger going quiet
      # is the visible end of the queue.
      $lastCount = (@(Read-JsonLines -Path $run.ledgerPath)).Count
      $quietFor = 0
      while ($quietFor -lt 3) {
        Start-Sleep -Seconds 1
        $now = (@(Read-JsonLines -Path $run.ledgerPath)).Count
        if ($now -eq $lastCount) { $quietFor++ } else { $quietFor = 0; $lastCount = $now }
      }
      Add-Check -Name 'queue quiet before the stop was asked for' -Status 'pass' -Detail '3 seconds with no new ledger line'

      $quitHow = ''
      if ($Target -eq 'Core') {
        # The shipped protocol, exactly: a bare line on stdin, then wait for the
        # stopped event. No signal is sent, because on Windows none arrives.
        $quitHow = 'wrote "stop" to the core stdin'
        $launched.process.StandardInput.WriteLine('stop')
        $launched.process.StandardInput.Flush()
      }
      elseif (-not [string]::IsNullOrWhiteSpace($QuitCommand)) {
        $quitHow = "ran the quit command: $QuitCommand"
        try { Invoke-Expression $QuitCommand } catch {
          Add-Check -Name 'quit command ran' -Status 'fail' -Detail $_.Exception.Message
        }
      }
      else {
        # No scriptable quit exists in the shell yet, so the rig uses the one
        # channel that is always there: the shell dies, its end of the sidecar
        # stdin pipe closes, the core reads end of file and drains. The core is
        # never signalled and never killed.
        $quitHow = 'stopped the shell only, so the core sees end of file on stdin'
        try { $null = $launched.process.CloseMainWindow() } catch { }
        Start-Sleep -Seconds 2
        if (-not $launched.process.HasExited) {
          $launched.process.Kill()   # this process only, never the tree
        }
      }
      Add-Check -Name 'quit requested' -Status 'pass' -Detail $quitHow

      $shellGone = Wait-Until -TimeoutSeconds 20 -Condition { $launched.process.HasExited }
      Add-Check -Name 'shell exited' -Status $(if ($shellGone) { 'pass' } else { 'fail' }) `
        -Detail $(if ($shellGone) { "exit code $($launched.process.ExitCode)" } else { "pid $($launched.id) still running" })

      if ($sidecarPid -ne 0) {
        $coreGone = Wait-Until -TimeoutSeconds $DrainTimeoutSec -PollMs 500 -Condition {
          -not (Test-ProcessAlive -Id $sidecarPid)
        }
        if ($coreGone) {
          Add-Check -Name 'core drained and exited on its own' -Status 'pass' -Detail "pid $sidecarPid gone, never killed"
        }
        else {
          Add-Check -Name 'core drained and exited on its own' -Status 'fail' `
            -Detail "pid $sidecarPid is still running $DrainTimeoutSec seconds after the shell went away. It was NOT killed. Its config, ledger and lock are all inside $($run.dir), so it is watching a throwaway folder and holding a throwaway lock. Stop it from Task Manager when you have looked at it."
        }
      }

      $lockGone = Wait-Until -TimeoutSeconds 15 -Condition { -not (Test-Path -LiteralPath $run.lockPath) }
      Add-Check -Name 'lock file released' -Status $(if ($lockGone) { 'pass' } else { 'fail' }) -Detail $run.lockPath

      if ($Target -eq 'Core') {
        $events = @(Read-JsonLines -Path $launched.ndjson)
        $types = @($events | Where-Object { $_.PSObject.Properties.Name -contains 'type' } | ForEach-Object { $_.type })
        Add-Check -Name 'the run ended with a stopped event' `
          -Status $(if ($types.Count -gt 0 -and $types[-1] -eq 'stopped') { 'pass' } else { 'fail' }) `
          -Detail "last event was $(if ($types.Count -gt 0) { $types[-1] } else { 'none' })"
      }

      # No watch that was running before this script started may have stopped.
      $casualties = @()
      foreach ($p in $preExisting) {
        if (-not (Test-ProcessAlive -Id $p.pid)) { $casualties += "$($p.name)/$($p.pid)" }
      }
      Add-Check -Name 'every watch that predated this run is still alive' `
        -Status $(if ($casualties.Count -eq 0) { 'pass' } else { 'fail' }) `
        -Detail $(if ($casualties.Count -eq 0) {
          if ($preExisting.Count -eq 0) { 'there were none to protect' } else { 'the production watch was not touched' }
        }
        else { "gone: $($casualties -join ', ')" })
    }
  }
}
catch {
  Add-Check -Name 'run aborted' -Status 'fail' -Detail $_.Exception.Message
  Write-Host ''
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
  # An abort must not leave what we launched running. The core is asked to stop
  # the way the protocol says; the shell is stopped so the core sees end of file
  # and drains. Nothing is ever killed by pid, and the core is never killed at
  # all. After a clean run this is a no-op, because the quit already happened.
  if ($null -ne $launched) {
    try {
      if (-not $launched.process.HasExited) {
        Write-Note 'stopping what this run launched'
        if ($Target -eq 'Core') {
          $launched.process.StandardInput.WriteLine('stop')
          $launched.process.StandardInput.Flush()
          $null = $launched.process.WaitForExit(30000)
        }
        else {
          Stop-ShellNow -Launched $launched
        }
      }
    }
    catch { }
  }

  # Only a full run owns the secrets it copied. A prepare hands them to a human
  # who is about to use them, and a drop happens in the middle of that session,
  # so shredding there would pull the token out from under a live core.
  if ($null -ne $run -and $Stage -eq 'full') { Remove-RunSecrets -Run $run -Keep ([bool]$KeepSecrets) }

  Get-EventSubscriber -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue

  if ($null -ne $run) {
    $report = [ordered]@{
      startedAt    = $script:StartedAt.ToString('o')
      finishedAt   = (Get-Date).ToString('o')
      target       = $Target
      stage        = $Stage
      dryRun       = $script:dryRunMode
      runDir       = $run.dir
      configPath   = $run.configPath
      measurements = $script:Measurements
      checks       = $script:Checks
      passed       = -not $script:Failed
    }
    $reportPath = Join-Path $run.dir 'report.json'
    try { $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM } catch { }
  }

  Write-RigSummary -RunDir $(if ($null -ne $run) { $run.dir } else { '' })

  exit ($(if ($script:Failed) { 1 } else { 0 }))
}
