#Requires -Version 7.0
<#
.SYNOPSIS
  The M3 scenarios: the words, the pause that holds, the detach that finishes,
  the Run key, and a delivery after a cold relaunch.

.DESCRIPTION
  run-e2e.ps1 proves one delivery end to end. This script proves the four
  promises M3 adds, each one reduced to something a machine can fail:

    vocabulary  the core answers pause, resume, rescan and detach, and still
                answers an unknown word by name on stderr
    pause       a real pause: same pid, same lock, no respawn. A photo dropped
                while paused is NOT delivered, and IS delivered after resume
    rescan      Deliver now is a word the core acts on, not a word it ignores
    detach      the sequence the quit menu really sends, stop then detach then
                the shell dying, finishes the batch that was in flight and exits
                0. The impatient path never runs
    runkey      the Run value the shell writes is QUOTED, is REG_SZ, names the
                exe it was launched from, and carries the boot flag
    stalepath   a Run value pointing somewhere else is repaired on the next launch
    coldstart   quit, launch again with the boot flag as the only argument, drop
                a photo, it arrives. The machine half of the M3 exit criterion

  The literal reboot is a human step, and it is item 1 of the M3 section of
  CHECKLIST.md. So are the four toasts: nothing here can see a toast.

.PARAMETER Scenario
  One or more of vocabulary, pause, rescan, detach, runkey, stalepath,
  coldstart, or all. Core scenarios run first because they cost nothing and
  need no tray.

.PARAMETER DryRun
  No network, no secrets. The core hashes and records in the side index instead
  of uploading, and every assertion below moves to the side index with it. The
  vocabulary, pause, rescan and detach scenarios are fully meaningful this way;
  detach is weaker, because nothing is genuinely mid-upload.

.EXAMPLE
  # everything the core owes M3, no secrets, no tray, no network
  pwsh -File app\e2e\run-m3.ps1 -Scenario vocabulary,pause,rescan,detach -DryRun

.EXAMPLE
  # the whole milestone, for real, against the built tray
  pwsh -File app\e2e\run-m3.ps1 -CredentialsPath C:\keys\client.json -TokenPath C:\keys\token.json

.NOTES
  SAFETY, in the same terms as run-e2e.ps1, plus one more.

  * Every path is under TEMP and Assert-OutsideRealConfig refuses anything that
    would land in ~/.photo-pigeon.
  * No core is ever killed. The rig writes words on stdin and closes the pipe.
  * THE RUN KEY IS READ, NOT WRITTEN. The shell writes the value; this script
    reads it back. The only name it may delete starts photo-pigeon-e2e-, and
    Remove-RigRunValue refuses anything else. A snapshot of the whole key is
    taken before the first launch and compared at the end, so "nobody else's
    autostart was touched" is an assertion rather than an intention.
  * The tray scenarios refuse to launch at all unless the shell declares the
    environment variable that moves the Run value name aside, because a tray
    that ignores it would write the PRODUCTION value name, pointing at a
    throwaway build, on the machine running the rig.
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'vocabulary', 'pause', 'rescan', 'detach', 'runkey', 'stalepath', 'coldstart')]
  [string[]]$Scenario = @('all'),

  [string]$ExePath,
  [string]$CredentialsPath,
  [string]$TokenPath,

  [string]$Album = 'photo-pigeon e2e',
  [switch]$DryRun,

  [string]$ConfigEnvName = 'PHOTO_PIGEON_CONFIG',
  [string]$AutostartNameEnv = '',
  [string]$BootFlag = '',
  [string]$CoreJs,
  [string]$NodeExe,

  [int]$ReadySec = 45,
  [int]$TimeoutSec = 240,
  [int]$HoldSec = 25,
  [int]$DrainTimeoutSec = 300,
  [int]$BigFileMB = 24,

  [switch]$KeepSecrets,
  [switch]$KeepRunDirs,
  [switch]$AllowExistingTray
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['*:ErrorAction'] = 'Stop'

. "$PSScriptRoot\rig-common.ps1"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# Everything this run launched or created, so the finally block can put the
# machine back without guessing.
$script:RunDirs = [System.Collections.Generic.List[object]]::new()
$script:OpenShells = [System.Collections.Generic.List[object]]::new()
$script:OpenCores = [System.Collections.Generic.List[object]]::new()
$script:RunKeyBefore = $null
# $script:RigRunValues is NOT declared here. It moved into rig-common.ps1 at M4
# along with the rest of the tray rail, because run-m4.ps1 needs the same list
# and a guard that can tell one of its own names from a stray one cannot have
# two lists to look in.
$script:dryRunMode = [bool]$DryRun

# ---------------------------------------------------------------------------
# The contracts this rig is written against.
# ---------------------------------------------------------------------------

$vocabPath = Join-Path $PSScriptRoot 'm3-vocabulary.json'
if (-not (Test-Path -LiteralPath $vocabPath -PathType Leaf)) {
  throw "no vocabulary contract at $vocabPath. It is the file that says which words and events this rig asserts on."
}
$vocab = Get-Content -LiteralPath $vocabPath -Raw | ConvertFrom-Json
$layout = Read-LayoutContract -RepoRoot $repoRoot

<#
  The autostart facts, preferring the shell's own contract file over the rig's
  fallback. The shell is held against sidecar-layout.json by a drift test, and
  nothing holds the rig's copy to anything, so the shell's copy wins whenever it
  exists.

  The resolution itself moved into rig-common.ps1 at M4, unchanged, because
  run-m4.ps1 launches trays too and the rule about which contract wins must not
  exist twice. This is the M3 fallback being handed to it.
#>
function Get-AutostartFacts {
  return Resolve-AutostartFacts -Fallback $vocab.autostart -Layout $layout `
    -BootFlagOverride $BootFlag -NameEnvOverride $AutostartNameEnv `
    -FallbackSource 'app\e2e\m3-vocabulary.json (fallback)'
}

# ---------------------------------------------------------------------------
# Small readers over what a run leaves behind.
# ---------------------------------------------------------------------------

# Get-CoreEvents and Get-CoreEventTypes moved into rig-common.ps1 at M4,
# unchanged: run-m4.ps1's setup driver reads the same kind of stream.

<#
  Wait for one more event of a type than there were when we started looking.

  Counting rather than timestamping on purpose: the events carry an ISO `at`,
  but a rig that parses timestamps to decide whether something is new has two
  clocks in it, and one of them is wrong.
#>
function Wait-ForMoreEvents {
  param(
    [Parameter(Mandatory)][object]$Launched,
    [Parameter(Mandatory)][string[]]$OfType,
    [Parameter(Mandatory)][int]$Baseline,
    [int]$TimeoutSeconds = 30
  )
  $seen = $Baseline
  $ok = Wait-Until -TimeoutSeconds $TimeoutSeconds -PollMs 400 -Condition {
    $script:_countNow = (@(Get-CoreEvents -Launched $Launched -OfType $OfType)).Count
    return $script:_countNow -gt $Baseline
  }
  if ($ok) { $seen = (@(Get-CoreEvents -Launched $Launched -OfType $OfType)).Count }
  return [pscustomobject]@{ arrived = $ok; count = $seen }
}

<#
  Did these bytes land? The ledger is the answer in a real run and the side
  index is the answer in a dry one, because a dry run writes no ledger by
  design and the side index records a hash only for bytes the core read itself.
#>
function Test-HashLanded {
  param([Parameter(Mandatory)][object]$Run, [Parameter(Mandatory)][string]$Hash)
  $path = if ($script:dryRunMode) { $Run.sideIndexPath } else { $Run.ledgerPath }
  $lines = @(Read-JsonLines -Path $path)
  return @($lines | Where-Object {
      ($_.PSObject.Properties.Name -contains 'hash') -and ([string]$_.hash -eq $Hash)
    }).Count -gt 0
}

function Get-LandedPath {
  param([Parameter(Mandatory)][object]$Run)
  return $(if ($script:dryRunMode) { $Run.sideIndexPath } else { $Run.ledgerPath })
}

<#
  Build a unique PNG outside the watch folder and move it in, so the watcher can
  never see a half written file and no settle race is possible.
#>
function New-DroppedPng {
  param(
    [Parameter(Mandatory)][object]$Run,
    [string]$Tag = 'm3',
    [int]$MegaBytes = 0
  )
  $marker = "photo-pigeon-m3 $Tag $([System.Guid]::NewGuid().ToString())"
  $name = "pigeon-$Tag-$((Get-Date).ToString('HHmmss'))-$([System.Guid]::NewGuid().ToString('N').Substring(0,8)).png"
  if (-not (Test-Path -LiteralPath $Run.stagingDir)) { $null = New-Item -ItemType Directory -Path $Run.stagingDir -Force }
  $staged = Join-Path $Run.stagingDir $name

  $size = if ($MegaBytes -gt 0) { New-LargeTestPng -Path $staged -Marker $marker -MegaBytes $MegaBytes } else { New-TestPng -Path $staged -Marker $marker }
  $big = $MegaBytes -gt 0
  if ($big -and $size -lt 0) {
    Add-Check -Name 'a large photo could be generated' -Status 'warn' `
      -Detail 'the C# PNG writer would not compile, so the detach scenario runs on a 145 byte file and proves less about work in flight'
    $size = New-TestPng -Path $staged -Marker $marker
    $big = $false
  }

  $hash = Get-Sha256Hex -Path $staged
  $dropped = Join-Path $Run.watchDir $name
  Move-Item -LiteralPath $staged -Destination $dropped -Force
  return [pscustomobject]@{
    name    = $name
    path    = $dropped
    hash    = $hash
    size    = $size
    large   = $big
    droppedAt = Get-Date
  }
}

function Start-CoreForScenario {
  param([Parameter(Mandatory)][object]$Run, [int]$ReadySeconds = 45)
  $launched = Start-CoreDirect -Run $Run -RepoRoot $repoRoot
  $script:OpenCores.Add($launched)

  Start-Sleep -Seconds 2
  if ($launched.process.HasExited) {
    Add-Check -Name 'the core survived its first seconds' -Status 'fail' `
      -Detail "exit code $($launched.process.ExitCode). stderr tail: $(Get-FileTail -Path $launched.stderr -Lines 10)"
    throw 'the core exited immediately'
  }

  $ready = Wait-Until -TimeoutSeconds $ReadySeconds -Condition {
    if (Test-Path -LiteralPath $Run.lockPath) { return $true }
    return (Get-FileTail -Path $launched.ndjson -Lines 50) -match '"type"\s*:\s*"started"'
  }
  Add-Check -Name 'the core is watching the throwaway folder' -Status $(if ($ready) { 'pass' } else { 'fail' }) `
    -Detail $(if ($ready) { "pid $($launched.id), lock at $($Run.lockPath)" } else { "no lock and no started event within $ReadySeconds seconds" })
  if (-not $ready) { throw 'the core never reported started' }
  return $launched
}

<#
  The stop protocol, exactly: a bare word, then wait for the process to go on
  its own. Nothing here kills anything.
#>
function Stop-CoreAndWait {
  param([Parameter(Mandatory)][object]$Launched, [int]$TimeoutSeconds = 120)
  $null = Send-CoreLine -Launched $Launched -Line $vocab.words.stop
  $gone = Wait-Until -TimeoutSeconds $TimeoutSeconds -PollMs 500 -Condition { $Launched.process.HasExited }
  if (-not $gone) {
    Add-Check -Name 'the core exited after a stop' -Status 'fail' `
      -Detail "pid $($Launched.id) is still running $TimeoutSeconds seconds after the stop word. It was NOT killed: its config, ledger and lock are all under TEMP."
  }
  return $gone
}

# Assert-NoNewWatchCasualties moved into rig-common.ps1 at M4, unchanged.

# ---------------------------------------------------------------------------
# Scenario: the vocabulary.
#
# The cheapest scenario and the one that fails first when a word was never
# wired. The core answers an unrecognised line on stderr BY NAME, which is what
# makes this testable at all: send a word that cannot be real and the sentence
# appears, send a word that should be real and it must not.
# ---------------------------------------------------------------------------

function Invoke-VocabularyScenario {
  Write-Step 'Vocabulary: the words the shell is about to start sending'

  $run = New-RunConfig -Dir (New-RunDirectory -Tag 'vocab') -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)
  $launched = Start-CoreForScenario -Run $run -ReadySeconds $ReadySec

  try {
    $sentence = [string]$vocab.stderr.unknownWord

    # The control. A word that cannot ever be real, so the answer proves the
    # channel works before any conclusion is drawn from silence.
    $nonsense = "not-a-word-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
    $null = Send-CoreLine -Launched $launched -Line $nonsense
    $answered = Wait-Until -TimeoutSeconds 10 -PollMs 300 -Condition {
      (Get-FileText -Path $launched.stderr) -match [regex]::Escape($nonsense)
    }
    Add-Check -Name 'an unknown word is still answered on stderr, by name' `
      -Status $(if ($answered) { 'pass' } else { 'fail' }) `
      -Detail $(if ($answered) { "the core named $nonsense back" } else { "nothing about $nonsense on stderr within 10 seconds. A swallowed command is how a shell ends up waiting for a drain nobody started." })

    # Now the real words. Each one is a word the shell is about to wire a menu
    # item to, and a menu item wired to a word the core ignores is a lie the
    # user cannot see through.
    foreach ($word in @($vocab.words.pause, $vocab.words.resume, $vocab.words.rescan)) {
      $before = Get-FileText -Path $launched.stderr
      $null = Send-CoreLine -Launched $launched -Line $word
      Start-Sleep -Milliseconds 1500
      $after = Get-FileText -Path $launched.stderr
      $added = $after.Substring([Math]::Min($before.Length, $after.Length))
      $rejected = ($added -match [regex]::Escape($sentence)) -and ($added -match [regex]::Escape($word))
      Add-Check -Name "the core understands the word $word" `
        -Status $(if ($rejected) { 'fail' } else { 'pass' }) `
        -Detail $(if ($rejected) { "answered with `"$sentence`", so the menu item that sends it would do nothing" } else { 'accepted, not answered back as unknown' })
    }

    # detach is not sent here: it ends the run, and it has a scenario of its own.
    Add-Check -Name 'detach is exercised where it belongs' -Status 'info' `
      -Detail 'the detach scenario, because the word ends the run it is sent to'
  }
  finally {
    $null = Stop-CoreAndWait -Launched $launched -TimeoutSeconds $DrainTimeoutSec
  }
}

# ---------------------------------------------------------------------------
# Scenario: pause holds.
#
# The M2 pause was a stop and a respawn, so the two facts that say this one is
# real are the pid and the lock: a respawn changes the first and drops the
# second. Then the behaviour that the user actually feels: a photo dropped while
# paused stays where it is, and goes the moment the hold lifts.
# ---------------------------------------------------------------------------

function Invoke-PauseScenario {
  Write-Step 'Pause holds, and holds without a respawn'

  $run = New-RunConfig -Dir (New-RunDirectory -Tag 'pause') -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)
  $launched = Start-CoreForScenario -Run $run -ReadySeconds $ReadySec

  try {
    $pidBefore = $launched.id
    $lockBefore = ''
    try { $lockBefore = Get-Content -LiteralPath $run.lockPath -Raw } catch { $lockBefore = '' }

    $pausedTypes = @($vocab.events.paused)
    $baseline = (@(Get-CoreEvents -Launched $launched -OfType $pausedTypes)).Count
    $null = Send-CoreLine -Launched $launched -Line $vocab.words.pause

    $got = Wait-ForMoreEvents -Launched $launched -OfType $pausedTypes -Baseline $baseline -TimeoutSeconds 20
    Add-Check -Name 'pause is announced as an event' -Status $(if ($got.arrived) { 'pass' } else { 'fail' }) `
      -Detail $(if ($got.arrived) { "a $($pausedTypes -join '/') event arrived" } else { "no $($pausedTypes -join '/') event within 20 seconds, so the tray has nothing to turn its icon grey on" })

    if ($got.arrived) {
      $last = @(Get-CoreEvents -Launched $launched -OfType $pausedTypes)[-1]
      $reason = if ($last.PSObject.Properties.Name -contains 'reason') { [string]$last.reason } else { '' }
      Add-Check -Name 'a user pause is told apart from a quota pause' `
        -Status $(if ($reason -eq [string]$vocab.events.userPauseReason) { 'pass' } else { 'fail' }) `
        -Detail "reason was '$reason', expected '$($vocab.events.userPauseReason)'. The tray shows different words for the two, so one event with no reason is two states it cannot separate."
    }

    # The two facts that say this is a hold and not a stop and respawn.
    Start-Sleep -Seconds 2
    Add-Check -Name 'the paused core is the same process, not a respawn' `
      -Status $(if ((-not $launched.process.HasExited) -and $launched.id -eq $pidBefore) { 'pass' } else { 'fail' }) `
      -Detail $(if ($launched.process.HasExited) { "pid $pidBefore exited, so this was the M2 stop and respawn" } else { "pid $pidBefore throughout" })

    $lockNow = ''
    try { $lockNow = Get-Content -LiteralPath $run.lockPath -Raw } catch { $lockNow = '' }
    Add-Check -Name 'the lock was never let go while paused' `
      -Status $(if ($lockNow -ne '' -and $lockNow -eq $lockBefore) { 'pass' } else { 'fail' }) `
      -Detail $(if ($lockNow -eq '') { "no lock at $($run.lockPath): the core let go of the folder set, which is a stop wearing a pause's name" } else { 'the same lock file, unchanged' })

    # The behaviour the user feels.
    $photo = New-DroppedPng -Run $run -Tag 'held'
    Add-Check -Name 'a photo was dropped while paused' -Status 'pass' -Detail "$($photo.name), $($photo.size) bytes"

    Write-Note "holding for $HoldSec seconds, which is longer than the queue's own quiet flush"
    Start-Sleep -Seconds $HoldSec
    $leaked = Test-HashLanded -Run $run -Hash $photo.hash
    Add-Check -Name 'the photo dropped while paused was NOT delivered' `
      -Status $(if ($leaked) { 'fail' } else { 'pass' }) `
      -Detail $(if ($leaked) { "sha256 $($photo.hash.Substring(0,12)) reached $(Get-LandedPath -Run $run) while the run was paused" } else { "$HoldSec seconds and nothing moved" })

    # And nothing was lost by holding it.
    $resumedTypes = @($vocab.events.resumed)
    $resumeBaseline = (@(Get-CoreEvents -Launched $launched -OfType $resumedTypes)).Count
    $null = Send-CoreLine -Launched $launched -Line $vocab.words.resume
    $gotResume = Wait-ForMoreEvents -Launched $launched -OfType $resumedTypes -Baseline $resumeBaseline -TimeoutSeconds 20
    Add-Check -Name 'resume is announced as an event' -Status $(if ($gotResume.arrived) { 'pass' } else { 'fail' }) `
      -Detail $(if ($gotResume.arrived) { "a $($resumedTypes -join '/') event arrived" } else { 'nothing announced, so a grey tray icon has no clearing condition' })

    $landed = Wait-Until -TimeoutSeconds $TimeoutSec -PollMs 1000 -Condition { Test-HashLanded -Run $run -Hash $photo.hash }
    Add-Check -Name 'the held photo was delivered after resume, without being asked for twice' `
      -Status $(if ($landed) { 'pass' } else { 'fail' }) `
      -Detail $(if ($landed) { "sha256 $($photo.hash.Substring(0,12)) in $(Split-Path -Leaf (Get-LandedPath -Run $run))" } else { "never arrived within $TimeoutSec seconds of the resume" })

    Add-Check -Name 'the whole pause and resume cost no respawn' `
      -Status $(if ((-not $launched.process.HasExited) -and $launched.id -eq $pidBefore) { 'pass' } else { 'fail' }) `
      -Detail "pid $pidBefore. A respawn here is a full reconcile, which on a 100 GB library is the cost M3 exists to remove."
  }
  finally {
    $null = Stop-CoreAndWait -Launched $launched -TimeoutSeconds $DrainTimeoutSec
  }
}

# ---------------------------------------------------------------------------
# Scenario: rescan, which is what Deliver now sends.
# ---------------------------------------------------------------------------

function Invoke-RescanScenario {
  Write-Step 'Deliver now: one reconciliation pass, on demand'

  $run = New-RunConfig -Dir (New-RunDirectory -Tag 'rescan') -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)
  $launched = Start-CoreForScenario -Run $run -ReadySeconds $ReadySec

  try {
    # Let the startup walk finish, so the next one can only be ours.
    $scanTypes = @($vocab.events.scanning)
    $null = Wait-Until -TimeoutSeconds 20 -PollMs 400 -Condition {
      (@(Get-CoreEvents -Launched $launched -OfType $scanTypes)).Count -gt 0
    }
    $pidBefore = $launched.id
    $scanBaseline = (@(Get-CoreEvents -Launched $launched -OfType $scanTypes)).Count

    $null = Send-CoreLine -Launched $launched -Line $vocab.words.rescan
    $got = Wait-ForMoreEvents -Launched $launched -OfType $scanTypes -Baseline $scanBaseline -TimeoutSeconds 30
    Add-Check -Name 'rescan really walks the folders' -Status $(if ($got.arrived) { 'pass' } else { 'fail' }) `
      -Detail $(if ($got.arrived) { "a second $($scanTypes -join '/') event, $($got.count) in total" } else { 'no new scan within 30 seconds, so Deliver now is a menu item wired to nothing' })

    # It answered without restarting anything: a rescan is a pass, not a bounce.
    Add-Check -Name 'rescan cost no respawn and no stop' `
      -Status $(if ((-not $launched.process.HasExited) -and $launched.id -eq $pidBefore) { 'pass' } else { 'fail' }) `
      -Detail "pid $pidBefore, still watching"

    $types = Get-CoreEventTypes -Launched $launched
    Add-Check -Name 'rescan did not end the run' `
      -Status $(if ($types -notcontains [string]$vocab.events.stopped) { 'pass' } else { 'fail' }) `
      -Detail $(if ($types -notcontains [string]$vocab.events.stopped) { 'no stopped event' } else { 'a stopped event arrived, so Deliver now stopped the watch' })

    # And a photo dropped after it still goes, which is the ordinary path that a
    # broken on-demand walk would be easy to break.
    $photo = New-DroppedPng -Run $run -Tag 'after-rescan'
    $landed = Wait-Until -TimeoutSeconds $TimeoutSec -PollMs 1000 -Condition { Test-HashLanded -Run $run -Hash $photo.hash }
    Add-Check -Name 'the watch still delivers after a rescan' -Status $(if ($landed) { 'pass' } else { 'fail' }) `
      -Detail $(if ($landed) { "sha256 $($photo.hash.Substring(0,12)) landed" } else { 'the file never arrived, so the on-demand walk left the watch broken' })
  }
  finally {
    $null = Stop-CoreAndWait -Launched $launched -TimeoutSeconds $DrainTimeoutSec
  }
}

# ---------------------------------------------------------------------------
# Scenario: detach.
#
# The one that matters most, and the one M2's review named as the only real fix
# for a quit menu that promised a continuation the shell could not deliver.
#
# The rig is the shell here. It holds the only write handle on the core's stdin,
# exactly as the tray does, and closing that handle is precisely what the tray
# exiting looks like from inside the core. The shell's own second click is the
# a human checklist item, because nothing scriptable can press it.
#
# Two sequences, because the production one has two words in it:
#
#   stop, detach, EOF   the real quit menu: first click drains, second click
#                       says leave, then the shell dies
#   detach, EOF         a shell that leaves without having asked to stop
#
# And one control, which is the behaviour detach was invented to replace:
#
#   stop, EOF           the M2 path. Second stop, impatient, batch abandoned
# ---------------------------------------------------------------------------

function Invoke-DetachProbe {
  param(
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][string[]]$Sequence,
    [int]$MegaBytes = 0,
    [int]$IntakeSeconds = 14,
    [int]$GapMs = 400
  )

  $run = New-RunConfig -Dir (New-RunDirectory -Tag "detach-$Label") -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)
  $launched = Start-CoreForScenario -Run $run -ReadySeconds $ReadySec

  $photo = New-DroppedPng -Run $run -Tag 'inflight' -MegaBytes $MegaBytes
  Write-Note "$($photo.name), $([math]::Round($photo.size / 1MB, 1)) MB, sha256 $($photo.hash.Substring(0,12))"

  <#
    Wait for the queue to have really taken the file before saying anything.

    This is the difference between a test of detach and a test of nothing. A
    stop that arrives before intake has taken the file finds an empty queue,
    drains in milliseconds, and the process is gone before the second word can
    be written: no batch in flight, no drain to survive, and three assertions
    that fail for a reason that has nothing to do with detach. The queue's own
    quiet flush is ten seconds, so the wait is a little longer than that, and it
    ends early if the work turns out to be finished already.
  #>
  $intakeDeadline = (Get-Date).AddSeconds($IntakeSeconds)
  while ((Get-Date) -lt $intakeDeadline) {
    if (Test-HashLanded -Run $run -Hash $photo.hash) { break }
    Start-Sleep -Milliseconds 500
  }
  $landedEarly = Test-HashLanded -Run $run -Hash $photo.hash

  <#
    Every word, and whether the pipe was still there to take it.

    A word written into a process that has already exited is a race, not a
    failure, and the difference matters: one is a dry run with nothing to
    upload, the other is a bug.

    With a gap of zero the whole sequence goes in one flush. That is what a dry
    run needs, because there its drain is over in milliseconds and a gap of any
    size means the second word arrives at a process that has gone. It buys the
    composition of the words at the price of the timing, and the caller is told
    which half it got.
  #>
  $raced = $false
  $spoken = @()
  if ($launched.process.HasExited) {
    $raced = $true
  }
  elseif ($GapMs -le 0 -and $Sequence.Count -gt 1) {
    if (Send-CoreLines -Launched $launched -Lines $Sequence) { $spoken = $Sequence }
    else { $raced = $true }
  }
  else {
    foreach ($word in $Sequence) {
      if ($launched.process.HasExited) { $raced = $true; break }
      if (-not (Send-CoreLine -Launched $launched -Line $word)) { $raced = $true; break }
      $spoken += $word
      if ($GapMs -gt 0) { Start-Sleep -Milliseconds $GapMs }
    }
  }
  $closedAt = Get-Date
  $null = Close-CoreStdin -Launched $launched

  # Bounded on purpose, and it stops at the process rather than at the clock.
  # The control sequence is MEANT to abandon the batch, so waiting the full
  # drain timeout for something that will never arrive would cost five minutes
  # per run to learn nothing.
  $deadline = (Get-Date).AddSeconds($DrainTimeoutSec)
  $landed = $false
  $landedAt = $closedAt
  while ((Get-Date) -lt $deadline) {
    if (-not $landed -and (Test-HashLanded -Run $run -Hash $photo.hash)) {
      $landed = $true
      $landedAt = Get-Date
    }
    if ($launched.process.HasExited) { break }
    Start-Sleep -Milliseconds 400
  }
  # One last look after the exit: the final ledger append and the exit are the
  # same breath, and a poll can fall between them.
  Start-Sleep -Milliseconds 700
  if (-not $landed -and (Test-HashLanded -Run $run -Hash $photo.hash)) {
    $landed = $true
    $landedAt = Get-Date
  }
  $exited = Wait-Until -TimeoutSeconds 30 -PollMs 500 -Condition { $launched.process.HasExited }
  $exitCode = if ($exited) { $launched.process.ExitCode } else { $null }
  $lockGone = Wait-Until -TimeoutSeconds 20 -Condition { -not (Test-Path -LiteralPath $run.lockPath) }

  $stream = (Get-FileText -Path $launched.ndjson) + "`n" + (Get-FileText -Path $launched.stderr)
  $impatient = $stream -match [regex]::Escape([string]$vocab.stderr.impatient)
  $detached = (@(Get-CoreEvents -Launched $launched -OfType @($vocab.events.detached))).Count -gt 0

  return [pscustomobject]@{
    run             = $run
    launched        = $launched
    photo           = $photo
    raced           = $raced
    spoken          = $spoken
    sequence        = $Sequence
    landedEarly     = $landedEarly
    landed          = $landed
    # Only an orphan can have finished work that was still unfinished when the
    # pipe closed. Something already recorded before anybody said anything gets
    # no credit here, however late the poll noticed it.
    landedAfterEof  = $landed -and (-not $landedEarly) -and ($landedAt -gt $closedAt)
    drainSeconds    = [math]::Round(($landedAt - $closedAt).TotalSeconds, 1)
    exited          = $exited
    exitCode        = $exitCode
    lockGone        = $lockGone
    impatient       = $impatient
    detachedEvent   = $detached
  }
}

function Invoke-DetachScenario {
  Write-Step 'Detach: the quit menu leaves and the batch still finishes'

  $where = if ($script:dryRunMode) { 'the side index' } else { 'the ledger' }

  # 1. The production sequence, with a large file genuinely in flight.
  Write-Note 'sequence one: stop, detach, then the shell dies. This is what the quit menu really sends.'
  if ($script:dryRunMode) {
    Write-Note 'both words go in one write, because a dry run drains in milliseconds and there would be nothing left to say them to'
  }
  $r = Invoke-DetachProbe -Label 'quit-path' -Sequence @($vocab.words.stop, $vocab.words.detach) `
    -MegaBytes $BigFileMB -GapMs $(if ($script:dryRunMode) { 0 } else { 400 })

  if ($r.raced) {
    # The queue emptied before the second word could be written. In a dry run
    # that is ordinary: there is nothing to upload, so a drain takes
    # milliseconds and the process is gone. Not a finding, and not a pass.
    $why = if ($script:dryRunMode) {
      "a dry run has nothing to upload, so the drain finished before the word $($r.sequence[-1]) could be written. This sequence needs real credentials and a large file."
    }
    else {
      "the core was gone before the word $($r.sequence[-1]) could be written, with only $($r.spoken -join ', ') spoken. Raise -BigFileMB so the upload is still running."
    }
    Add-Check -Name 'the quit path sequence could be sent at all' -Status 'skip' -Detail $why
  }
  else {
    Add-Check -Name 'the work really was in flight when the shell left' `
      -Status $(if (-not $r.landedEarly) { 'pass' } elseif ($script:dryRunMode) { 'info' } else { 'warn' }) `
      -Detail $(if (-not $r.landedEarly) { "$([math]::Round($r.photo.size / 1MB, 1)) MB still unfinished at the moment stdin closed" }
      elseif ($script:dryRunMode) { 'it was already recorded: a dry run uploads nothing, so nothing can be mid flight. The timing half of this scenario needs credentials.' }
      else { 'it had already finished before the words were sent, so this run proves less than it looks. Raise -BigFileMB.' })

    Add-Check -Name 'detach is acknowledged before the drain, so the shell need not wait' `
      -Status $(if ($r.detachedEvent) { 'pass' } else { 'fail' }) `
      -Detail $(if ($r.detachedEvent) { "a $($vocab.events.detached -join '/') event arrived" } else { 'no detached event, so the tray has nothing to close itself on and goes back to waiting for a drain' })

    # Landing at all is the promise. Landing AFTER the pipe closed is the proof
    # that the orphan did it, and only a real upload is slow enough to show it.
    Add-Check -Name "the batch in flight reached $where" `
      -Status $(if ($r.landed) { 'pass' } else { 'fail' }) `
      -Detail $(if ($r.landed) { "sha256 $($r.photo.hash.Substring(0,12))" } else { "sha256 $($r.photo.hash.Substring(0,12)) never arrived. This is the abandoned half batch M3 exists to prevent." })

    Add-Check -Name 'and it got there after the shell was already gone' `
      -Status $(if ($r.landedAfterEof) { 'pass' } elseif (-not $r.landed) { 'skip' } elseif ($script:dryRunMode) { 'info' } else { 'warn' }) `
      -Detail $(if ($r.landedAfterEof) { "$($r.drainSeconds) seconds after end of file on stdin, by a process with no parent left" }
      elseif (-not $r.landed) { 'it never landed at all, which the check above already says' }
      elseif ($script:dryRunMode) { 'it was finished before stdin closed, which is what a dry run always does: there is no upload to be slow. Run this with credentials to watch the orphan work.' }
      else { 'it was finished before stdin closed, so nothing here proves an orphan did anything. Raise -BigFileMB until the upload outlasts the quit.' })

    Add-Check -Name 'end of file after a detach did NOT take the impatient path' `
      -Status $(if ($r.impatient) { 'fail' } else { 'pass' }) `
      -Detail $(if ($r.impatient) { "the impatient marker is in the stream, so the shell leaving was read as a second stop" } else { 'no impatient stop anywhere in the event stream or on stderr' })

    Add-Check -Name 'the orphan exited on its own, cleanly' `
      -Status $(if ($r.exited -and $r.exitCode -eq [int]$vocab.exitCodes.clean) { 'pass' } else { 'fail' }) `
      -Detail $(if (-not $r.exited) { "pid $($r.launched.id) is still running after the detach. It was NOT killed." }
      elseif ($r.exitCode -eq [int]$vocab.exitCodes.impatient) { "exit code $($r.exitCode), which is the second stop code: the batch in flight was dropped" }
      else { "exit code $($r.exitCode), expected $($vocab.exitCodes.clean)" })

    Add-Check -Name 'the detached run let go of its lock' -Status $(if ($r.lockGone) { 'pass' } else { 'fail' }) `
      -Detail $(if ($r.lockGone) { 'gone, which a killed watch never manages' } else { "still at $($r.run.lockPath)" })
  }

  # 2. A shell that leaves without ever having asked to stop. One word, so there
  #    is no race to lose: the core cannot be gone before the first thing
  #    anybody said to it.
  Write-Note 'sequence two: detach with no stop first, then the shell dies.'
  $c = Invoke-DetachProbe -Label 'cold' -Sequence @($vocab.words.detach) -MegaBytes 0

  Add-Check -Name 'a detach with no stop first is answered' `
    -Status $(if ($c.detachedEvent) { 'pass' } else { 'fail' }) `
    -Detail $(if ($c.detachedEvent) { 'the detached event arrived' } else { 'no detached event' })

  Add-Check -Name 'a detach with no stop first also finishes and exits cleanly' `
    -Status $(if ($c.landed -and $c.exited -and $c.exitCode -eq [int]$vocab.exitCodes.clean -and -not $c.impatient) { 'pass' } else { 'fail' }) `
    -Detail "landed $($c.landed), exit code $($c.exitCode), impatient $($c.impatient)"

  # 3. The control: the behaviour detach was invented to replace. A stop, then a
  #    shell that walks out, is still the impatient path on purpose, because
  #    that is the escape hatch the second click used to be. It can only show
  #    itself when there is something left to abandon, so a dry run cannot see
  #    it, and says so rather than pretending.
  Write-Note 'control: stop, then the shell dies without saying detach. This is the M2 behaviour, and it is meant to survive.'
  $ctl = Invoke-DetachProbe -Label 'control' -Sequence @($vocab.words.stop) -MegaBytes $(if ($script:dryRunMode) { 0 } else { $BigFileMB })
  $wasImpatient = $ctl.impatient -or ($ctl.exitCode -eq [int]$vocab.exitCodes.impatient)
  Add-Check -Name 'stop then a vanished shell is still read as impatient' `
    -Status $(if ($wasImpatient) { 'pass' } elseif ($script:dryRunMode) { 'info' } else { 'warn' }) `
    -Detail $(if ($wasImpatient) { "exit code $($ctl.exitCode): the two words really are different, which is the whole point of adding one" }
    elseif ($script:dryRunMode) { 'nothing was left in flight for an impatient stop to abandon, which is what a dry run always looks like' }
    else { "exit code $($ctl.exitCode) and no impatient marker, with work that should still have been running. stop and detach now behave identically, so nothing here can tell them apart." })
}

# ---------------------------------------------------------------------------
# Tray scenarios. Everything below launches the real shell.
# ---------------------------------------------------------------------------

# Assert-TrayScenarioIsSafe, New-RigRunValueName, Start-TrayForScenario,
# Assert-NoStrayRunValue and Stop-TrayAndWait ALL MOVED INTO rig-common.ps1 at
# M4, with their behaviour unchanged. They are the rail that stands between a
# test run and the machine's real startup entry, run-m4.ps1 launches trays too,
# and a rail with two copies is a rail with one that drifts. What used to be
# read out of this script's scope is passed in now: the autostart facts, the
# config override name, the core overrides, and the list a launched shell is
# registered in.
#
# These two bind this script's context to the shared rail once, so the
# scenarios below read the same as they did before the move.

function Start-M3Tray {
  param(
    [Parameter(Mandatory)][object]$Run,
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Tag,
    [string[]]$Arguments = @(),
    [hashtable]$ExtraEnv = @{}
  )
  return Start-TrayForScenario -Run $Run -Exe $Exe -Tag $Tag -Facts $facts `
    -ConfigEnvName $ConfigEnvName -Arguments $Arguments -ExtraEnv $ExtraEnv `
    -CoreJs $CoreJs -NodeExe $NodeExe -ReadySec $ReadySec -Register $script:OpenShells
}

function Stop-M3Tray {
  param([Parameter(Mandatory)][object]$Session, [Parameter(Mandatory)][object]$Run, [string]$Tag = '')
  Stop-TrayAndWait -Session $Session -Run $Run -Tag $Tag -DrainTimeoutSec $DrainTimeoutSec
}

function Invoke-RunKeyScenario {
  param([Parameter(Mandatory)][object]$Facts, [Parameter(Mandatory)][string]$Exe)
  Write-Step 'Start with Windows: the value that has to be right or boot does nothing'

  $run = New-RunConfig -Dir (New-RunDirectory -Tag 'runkey') -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)

  $valueName = New-RigRunValueName
  Write-Note "the shell is told to use the Run value name $valueName, so the real one is never touched"

  $session = Start-M3Tray -Run $run -Exe $Exe -Tag 'runkey' -ExtraEnv @{ $Facts.nameEnv = $valueName }
  try {
    $appeared = Wait-Until -TimeoutSeconds 30 -PollMs 500 -Condition { $null -ne (Get-RunValue -Name $valueName) }
    Add-Check -Name 'start with Windows is ON at first run, without being asked for' `
      -Status $(if ($appeared) { 'pass' } else { 'fail' }) `
      -Detail $(if ($appeared) { "the shell wrote $valueName within 30 seconds of its first launch" } else { "no $valueName under HKCU\...\Run within 30 seconds. Either the default is off, or the name override was ignored, and the second one is the dangerous case." })

    if ($appeared) {
      $value = Get-RunValue -Name $valueName
      Write-Note "value data: $($value.data)"
      $null = Assert-RunValueShape -Value $value -ExpectedExe $Exe -ExpectedFlag $Facts.bootFlag

      # Task Manager's Startup tab reads a different value, and a user who turns
      # the app off there must stay off. Informational: what matters is that the
      # rig sees whatever the shell wrote, and deletes it again.
      $approved = $null
      $key = $null
      try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:StartupApprovedSubKey, $false)
        if ($null -ne $key) { $approved = $key.GetValue($valueName, $null) }
      }
      catch { }
      finally { if ($null -ne $key) { $key.Dispose() } }
      Add-Check -Name 'the Task Manager companion value' -Status 'info' `
        -Detail $(if ($null -eq $approved) { 'absent, which reads as enabled until the user turns it off there' } else { "present, $(($approved | ForEach-Object { $_.ToString('x2') }) -join ' ')" })
    }
  }
  finally {
    Stop-M3Tray -Session $session -Run $run -Tag 'runkey'
  }
}

function Invoke-StalePathScenario {
  param([Parameter(Mandatory)][object]$Facts, [Parameter(Mandatory)][string]$Exe)
  Write-Step 'A stale Run value is repaired on the next launch'

  $run = New-RunConfig -Dir (New-RunDirectory -Tag 'stale') -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)

  $valueName = New-RigRunValueName
  $first = Start-M3Tray -Run $run -Exe $Exe -Tag 'stale-a' -ExtraEnv @{ $Facts.nameEnv = $valueName }
  $written = Wait-Until -TimeoutSeconds 30 -PollMs 500 -Condition { $null -ne (Get-RunValue -Name $valueName) }
  Stop-M3Tray -Session $first -Run $run -Tag 'stale-a'

  if (-not $written) {
    Add-Check -Name 'a stale Run value is rewritten on launch' -Status 'skip' `
      -Detail 'nothing was written on the first launch, so there is nothing to make stale.'
    return
  }

  # Break it the way a reinstall into a different directory would: right shape,
  # wrong path. Set-RigRunValue refuses any name but a rig-scoped one.
  $bogus = "`"C:\photo-pigeon-that-moved\photo-pigeon.exe`" $($Facts.bootFlag)"
  $null = Set-RigRunValue -Name $valueName -Data $bogus
  Write-Note "value made stale on purpose: $bogus"

  $second = Start-M3Tray -Run $run -Exe $Exe -Tag 'stale-b' -ExtraEnv @{ $Facts.nameEnv = $valueName }
  try {
    $repaired = Wait-Until -TimeoutSeconds 30 -PollMs 500 -Condition {
      $v = Get-RunValue -Name $valueName
      if ($null -eq $v) { return $false }
      return ($v.data -ne $bogus)
    }
    Add-Check -Name 'a stale Run value is rewritten on launch' -Status $(if ($repaired) { 'pass' } else { 'fail' }) `
      -Detail $(if ($repaired) { 'the launch noticed the recorded path was not its own and rewrote it' } else { "still $bogus after 30 seconds. A reinstall into another directory would leave boot silently doing nothing, and is_enabled() only ever asks whether the value exists." })

    if ($repaired) {
      $value = Get-RunValue -Name $valueName
      $null = Assert-RunValueShape -Value $value -ExpectedExe $Exe -ExpectedFlag $Facts.bootFlag -Prefix 'after the repair,'
    }
  }
  finally {
    Stop-M3Tray -Session $second -Run $run -Tag 'stale-b'
  }
}

function Invoke-ColdStartScenario {
  param([Parameter(Mandatory)][object]$Facts, [Parameter(Mandatory)][string]$Exe)
  Write-Step 'Cold relaunch: the machine half of "reboot, log in, drop a photo"'

  $run = New-RunConfig -Dir (New-RunDirectory -Tag 'cold') -CredentialsPath $CredentialsPath `
    -TokenPath $TokenPath -Album $Album -DryRunConfig ([bool]$DryRun)
  $script:RunDirs.Add($run)

  # Session one: an ordinary launch, one delivery, then quit. This is the state
  # a machine is in the moment before it is rebooted.
  $first = Start-M3Tray -Run $run -Exe $Exe -Tag 'cold-a'
  $before = New-DroppedPng -Run $run -Tag 'before'
  $landedBefore = Wait-Until -TimeoutSeconds $TimeoutSec -PollMs 1000 -Condition { Test-HashLanded -Run $run -Hash $before.hash }
  Add-Check -Name 'the first session delivered' -Status $(if ($landedBefore) { 'pass' } else { 'fail' }) `
    -Detail $(if ($landedBefore) { "sha256 $($before.hash.Substring(0,12))" } else { 'nothing arrived, so the cold relaunch cannot be told apart from a broken install' })
  Stop-M3Tray -Session $first -Run $run -Tag 'cold-a'

  # Session two: the Run key's own launch line, with the boot flag as the only
  # argument, against the config that was already there. Nothing is clicked.
  Write-Note "relaunching with $($Facts.bootFlag), which is what the Run value hands to Windows at login"
  $second = Start-M3Tray -Run $run -Exe $Exe -Tag 'cold-b' -Arguments @($Facts.bootFlag)
  try {
    $webviews = @(Get-DescendantProcesses -ParentId $second.launched.id | Where-Object { $_.name -like 'msedgewebview2*' })
    Add-Check -Name 'a boot launch opens no window' -Status $(if ($webviews.Count -eq 0) { 'pass' } else { 'fail' }) `
      -Detail "$($webviews.Count) WebView2 processes. Zero is the whole no-window-at-idle law, and a splash at every login is the loudest way to break it."

    $log = Get-FileText -Path $second.shellLog
    $sawFlag = ($log -match [regex]::Escape($Facts.bootFlag))
    $sawMarker = ($Facts.logMarker -ne '') -and ($log -match [regex]::Escape($Facts.logMarker))
    Add-Check -Name 'the boot flag that ships is the word the boot path parses' `
      -Status $(if ($sawFlag -or $sawMarker) { 'pass' } else { 'warn' }) `
      -Detail $(if ($sawFlag -or $sawMarker) { "the shell log names $($Facts.bootFlag)" } else { "the shell log says nothing about $($Facts.bootFlag), so this run cannot prove the flag was parsed rather than ignored. One log line on the boot path would settle it." })

    $after = New-DroppedPng -Run $run -Tag 'after-boot'
    $landedAfter = Wait-Until -TimeoutSeconds $TimeoutSec -PollMs 1000 -Condition { Test-HashLanded -Run $run -Hash $after.hash }
    Add-Check -Name 'a photo dropped after a cold relaunch arrives with nothing clicked' `
      -Status $(if ($landedAfter) { 'pass' } else { 'fail' }) `
      -Detail $(if ($landedAfter) { "sha256 $($after.hash.Substring(0,12)) in $(Split-Path -Leaf (Get-LandedPath -Run $run))" } else { "nothing within $TimeoutSec seconds. This is the M3 exit criterion, minus the reboot itself." })

    Add-Check -Name 'the second session used the ledger the first one left' `
      -Status $(if ($landedBefore -and $landedAfter) { 'pass' } else { 'skip' }) `
      -Detail "$((@(Read-JsonLines -Path (Get-LandedPath -Run $run))).Count) records in $(Split-Path -Leaf (Get-LandedPath -Run $run))"
  }
  finally {
    Stop-M3Tray -Session $second -Run $run -Tag 'cold-b'
  }
}

# ---------------------------------------------------------------------------
# The run.
# ---------------------------------------------------------------------------

$wanted = if ($Scenario -contains 'all') {
  @('vocabulary', 'pause', 'rescan', 'detach', 'runkey', 'stalepath', 'coldstart')
}
else { @($Scenario) }
$trayWanted = @($wanted | Where-Object { $_ -in @('runkey', 'stalepath', 'coldstart') })

Write-Host ''
Write-Host 'photo-pigeon M3 scenarios' -ForegroundColor White
Write-Host "  scenarios   $($wanted -join ', ')" -ForegroundColor DarkGray
Write-Host "  dry run     $([bool]$DryRun)" -ForegroundColor DarkGray

$facts = Get-AutostartFacts
$exe = ''
$preExisting = @()

try {
  Write-Step 'Preflight'

  if (-not $DryRun) {
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

  if ($trayWanted.Count -gt 0) {
    Assert-ConfigEnvNameMatchesTheShell -ConfigEnvName $ConfigEnvName -RepoRoot $repoRoot
  }

  # Watches that were here before us. Nothing in this list is ever stopped, and
  # every one of them has to still be alive at the end.
  $preExisting = @(Get-PigeonWatchProcesses)
  if ($preExisting.Count -gt 0) {
    Add-Check -Name 'a photo-pigeon watch is already running' -Status 'info' `
      -Detail "$((@($preExisting | ForEach-Object { "$($_.name)/$($_.pid)" })) -join ', '). It is never touched, and it must still be running at the end."
  }

  # The Run key as it was before this script existed. Everything at the end is
  # compared against this.
  $script:RunKeyBefore = Get-RunKeySnapshot
  Add-Check -Name 'the Run key was photographed before anything launched' -Status 'pass' `
    -Detail "$($script:RunKeyBefore.Count) values, none of them ours to change"

  # Read-only look at whatever photo-pigeon entries this machine already has.
  #
  # Found by the exe the value names rather than by the value's name, because
  # the value name is productName and productName is exactly the thing M3
  # changed. This is the one assertion in the rig that is about the real machine
  # rather than a throwaway, and it never writes.
  $live = @(Find-RunValuesNaming -Pattern 'photo-pigeon\.exe')
  if ($live.Count -eq 0) {
    Add-Check -Name "the installed app's own Run value" -Status 'info' `
      -Detail 'nothing under HKCU\...\Run names photo-pigeon.exe yet, so no machine is stranded on an unquoted value. That is luck rather than design, and it is the argument for writing the quoting fix before the default is turned on.'
  }
  foreach ($value in $live) {
    $liveParts = Split-RunValue -Data $value.data
    Add-Check -Name "the installed app's own Run value is quoted ($($value.name))" `
      -Status $(if ($liveParts.quoted) { 'pass' } else { 'fail' }) `
      -Detail "$($value.data)  [read only, never written by this rig]"
  }

  if ($trayWanted.Count -gt 0) {
    $existingTray = @($preExisting | Where-Object { $_.name -eq 'photo-pigeon.exe' })
    if ($existingTray.Count -gt 0 -and -not $AllowExistingTray) {
      foreach ($s in $trayWanted) {
        Add-Check -Name "scenario $s" -Status 'skip' `
          -Detail "a tray is already running (pid $($existingTray[0].pid)). Quit it from its own menu first, or pass -AllowExistingTray if you know it is another test."
      }
      $wanted = @($wanted | Where-Object { $_ -notin $trayWanted })
      $trayWanted = @()
    }
  }

  if ($trayWanted.Count -gt 0) {
    if (Assert-TrayScenarioIsSafe -Facts $facts) {
      $exe = Resolve-TrayExe -Given $ExePath -RepoRoot $repoRoot
      $info = try { [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe) } catch { $null }
      Add-Check -Name 'tray binary found' -Status 'pass' -Detail "$exe$(if ($info) { " (version $($info.FileVersion))" })"
    }
    else {
      foreach ($s in $trayWanted) {
        Add-Check -Name "scenario $s" -Status 'skip' -Detail 'the tray contract is not declared yet, see above'
      }
      $wanted = @($wanted | Where-Object { $_ -notin $trayWanted })
      $trayWanted = @()
    }
  }

  foreach ($name in $wanted) {
    switch ($name) {
      'vocabulary' { Invoke-VocabularyScenario }
      'pause' { Invoke-PauseScenario }
      'rescan' { Invoke-RescanScenario }
      'detach' { Invoke-DetachScenario }
      'runkey' { Invoke-RunKeyScenario -Facts $facts -Exe $exe }
      'stalepath' { Invoke-StalePathScenario -Facts $facts -Exe $exe }
      'coldstart' { Invoke-ColdStartScenario -Facts $facts -Exe $exe }
    }
  }

  Assert-NoNewWatchCasualties -PreExisting $preExisting
}
catch {
  Add-Check -Name 'run aborted' -Status 'fail' -Detail $_.Exception.Message
  Write-Host ''
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
  Write-Step 'Putting the machine back'

  # Anything still holding a pipe is asked to stop, the way the protocol says.
  # Nothing is killed by pid and no core is killed at all.
  foreach ($core in $script:OpenCores) {
    try {
      if (-not $core.process.HasExited) {
        Write-Note "asking core pid $($core.id) to stop"
        $null = Send-CoreLine -Launched $core -Line $vocab.words.stop
        $null = $core.process.WaitForExit(30000)
      }
    }
    catch { }
  }
  foreach ($shell in $script:OpenShells) {
    try { Stop-ShellNow -Launched $shell } catch { }
  }

  # The Run values this run caused to exist. Remove-RigRunValue refuses every
  # name but a rig-scoped one, so this loop cannot reach anybody else's.
  foreach ($name in $script:RigRunValues) {
    try {
      $removed = @(Remove-RigRunValue -Name $name)
      if ($removed.Count -gt 0) {
        Add-Check -Name 'the rig-scoped Run value was removed' -Status 'pass' -Detail "$name from $($removed -join ' and ')"
      }
    }
    catch {
      Add-Check -Name 'the rig-scoped Run value was removed' -Status 'fail' -Detail "$name could not be removed: $($_.Exception.Message)"
    }
  }

  # The comparison that says nobody else's autostart was touched. An added value
  # is somebody else's business unless it is the product name pointing at the exe
  # this run launched, which would be ours, written because an override was
  # ignored, and it would start a throwaway build at every login forever.
  if ($null -ne $script:RunKeyBefore) {
    $after = Get-RunKeySnapshot
    $removed = @($script:RunKeyBefore.Keys | Where-Object { -not $after.Contains($_) })
    $changed = @($script:RunKeyBefore.Keys | Where-Object { $after.Contains($_) -and $after[$_] -ne $script:RunKeyBefore[$_] })
    $added = @($after.Keys | Where-Object { -not $script:RunKeyBefore.Contains($_) })

    Add-Check -Name 'no Run value that predated this run was removed or changed' `
      -Status $(if ($removed.Count -eq 0 -and $changed.Count -eq 0) { 'pass' } else { 'fail' }) `
      -Detail $(if ($removed.Count -eq 0 -and $changed.Count -eq 0) { "$($script:RunKeyBefore.Count) values, all exactly as they were" } else { "removed: $($removed -join ', '); changed: $($changed -join ', ')" })

    foreach ($name in $added) {
      if ($exe -ne '' -and ([string]$after[$name]) -match [regex]::Escape($exe)) {
        # Ours, and dangerous. It exists because the name override did not reach
        # the shell, and it points at a build that will not be there. Matched on
        # the data rather than the name, because the name it would have used is
        # productName, and productName is what M3 changed.
        $removed = Remove-StrayRunValueNamingExe -Name $name -Exe $exe
        Add-Check -Name 'the shell honoured the Run value name override' -Status 'fail' `
          -Detail "it wrote a value called '$name' pointing at $exe. $(if ($removed) { 'The rig removed it again, because it did not exist before this run and it names a throwaway build.' } else { 'The rig COULD NOT remove it: delete it by hand before the next login.' })"
      }
      elseif (-not (Test-RigRunValueName -Name $name)) {
        Add-Check -Name 'a Run value appeared during this run' -Status 'info' `
          -Detail "$name, which is not ours and was left alone"
      }
    }
  }

  foreach ($run in $script:RunDirs) { Remove-RunSecrets -Run $run -Keep ([bool]$KeepSecrets) }

  Get-EventSubscriber -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue

  $reportDir = if ($script:RunDirs.Count -gt 0) { Split-Path -Parent $script:RunDirs[0].dir } else { '' }
  if ($reportDir -ne '') {
    $report = [ordered]@{
      startedAt    = $script:StartedAt.ToString('o')
      finishedAt   = (Get-Date).ToString('o')
      milestone    = 'M3'
      scenarios    = $wanted
      dryRun       = $script:dryRunMode
      exe          = $exe
      autostart    = $facts
      runDirs      = @($script:RunDirs | ForEach-Object { $_.dir })
      measurements = $script:Measurements
      checks       = $script:Checks
      passed       = -not $script:Failed
    }
    $reportPath = Join-Path $reportDir "report-m3-$((Get-Date).ToString('yyyyMMdd-HHmmss')).json"
    try {
      $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM
      Write-Note "report at $reportPath"
    }
    catch { }
  }

  if ($script:RunDirs.Count -gt 0 -and -not $KeepRunDirs) {
    Write-Note 'run directories are left on disk as evidence. Delete them when you are done:'
    foreach ($run in $script:RunDirs) { Write-Note "  Remove-Item -Recurse -Force '$($run.dir)'" }
  }

  Write-RigSummary -RunDir $reportDir
  exit ($(if ($script:Failed) { 1 } else { 0 }))
}

