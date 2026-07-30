#Requires -Version 7.0
<#
.SYNOPSIS
  The M4 scenarios: first run without a terminal, and what a window costs.

.DESCRIPTION
  M4's exit criterion is one sentence: "a machine with no config reaches a first
  delivery, and the only text the user typed was their Google password." A
  script cannot type a Google password and must never try, so this rig splits
  that sentence at the one place it is honest to split it.

    setup     a temp environment with NO config drives the real core's
              `setup --events ndjson` end to end, answering every ask from a
              script, and a real config file lands in the temp directory
    doctor    `doctor --json` reads that temp environment and comes back green,
              with every check it is not happy about named
    delivery  a photo appears in the watched folder and is delivered. The
              delivery is SIMULATED, by the fake core in app\e2e\fake-core.mjs,
              because a rig has no Google account. What it really proves is the
              shell's half: a file becoming a delivered event on the machine
              channel, and the first-ever truth arriving on the event
    window     the setup window opens, its page really runs, closing it destroys
              it, and no webview process outlives the close
    orphan     the window is killed mid flow. Nothing half written is left
              behind and the setup sidecar exits
    handles    open and close a window three times and watch the shape of the
              handle count. TRAY-DESIGN section 6 asks for exactly this at M4:
              "164 fresh against 415 after a day, which is worth confirming
              settles rather than climbing"

  What no script can see is the glass: whether the window is legible, whether
  the five steps read in the right order, whether the unverified-app screenshot
  is the right screenshot. All of that is CHECKLIST.md, and the M4 section says
  so in the same order as the scenarios here.

.PARAMETER Scenario
  One or more of setup, doctor, delivery, window, orphan, handles, or all. The
  first three need no tray. The last three launch one.

.PARAMETER OpenWindowCommand
  A command line that makes an ALREADY RUNNING tray open its setup window.

  The handle probe needs to open a window more than once in one process, and
  there is no scriptable way to do that today: the trigger is a tray menu item
  and the rig cannot see a menu. With this empty the probe still runs, using the
  one window a first run opens by itself, and reports the first-open cost with
  the slope marked skip rather than inventing a number. The same shape as
  run-e2e.ps1's -QuitCommand, and for the same reason.

.EXAMPLE
  # everything that needs no tray, no network, no secrets
  pwsh -File app\e2e\run-m4.ps1 -Scenario setup,doctor

.EXAMPLE
  # the whole milestone against a repo build of the shell
  pwsh -File app\e2e\run-m4.ps1 -Scenario all -ExePath app\src-tauri\target\release\photo-pigeon.exe

.NOTES
  SAFETY. Everything run-m3.ps1 promises, plus the three M4 adds, and the third
  is the one that matters most because setup is the first thing this project has
  ever run that WRITES a config.

  * THE RIG CANNOT REACH THE REAL CONFIG, and that is asserted rather than
    intended, on two independent rails:
      1. the config flag. The run refuses to start unless the built CLI declares
         `-c, --config` on `setup`, because a build that ignores it writes into
         ~/.photo-pigeon and the only symptom is a folder nobody was watching.
      2. the home directory. Every child is launched with USERPROFILE pointing
         into TEMP, and the run refuses to start until node has been asked, in
         that environment, where its home is. A setup that ignored every flag it
         was given would still land under TEMP.
    Afterwards the production folder is compared against a witness taken before
    anything launched: nothing created, nothing removed, and the three files a
    wizard would write untouched to the byte.

  * NOTHING IS EVER INSTALLED. Not under the product name and not under any
    other one. The rig refuses to drive a binary out of %LOCALAPPDATA% or
    Program Files at all, because that is where the real installed Photo Pigeon
    on this machine lives and these scenarios post messages at windows and terminate webview
    hosts on purpose.

  * NO CORE IS KILLED, ever, on any path. The one thing this rig does terminate
    is a WebView2 host process that is a descendant of a tray IT launched, in
    the orphan scenario, on purpose, because "the window died" is the state
    being constructed. The core is asked to stop with a word and left to drain.
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'setup', 'doctor', 'delivery', 'window', 'orphan', 'handles')]
  [string[]]$Scenario = @('all'),

  [string]$ExePath,
  [string]$Album = 'photo-pigeon e2e',

  [string]$ConfigEnvName = 'PHOTO_PIGEON_CONFIG',
  [string]$AutostartNameEnv = '',
  [string]$BootFlag = '',
  [string]$CoreJs,
  [string]$NodeExe,

  [string]$OpenWindowCommand = '',

  [int]$ReadySec = 45,
  [int]$SetupTimeoutSec = 180,
  [int]$WindowOpenSec = 30,
  [int]$WindowCloseSec = 30,
  [int]$DeliverTimeoutSec = 120,
  [int]$DrainTimeoutSec = 300,

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
$script:RealConfigBefore = $null
$script:AnswerLog = [System.Collections.Generic.List[object]]::new()

# ---------------------------------------------------------------------------
# The contracts this rig is written against.
# ---------------------------------------------------------------------------

$protocolPath = Join-Path $PSScriptRoot 'm4-protocol.json'
if (-not (Test-Path -LiteralPath $protocolPath -PathType Leaf)) {
  throw "no protocol contract at $protocolPath. It is the file that says which events, which answer form and which budgets this rig asserts on."
}
$protocol = Get-Content -LiteralPath $protocolPath -Raw | ConvertFrom-Json

$vocabPath = Join-Path $PSScriptRoot 'm3-vocabulary.json'
$vocab = if (Test-Path -LiteralPath $vocabPath -PathType Leaf) {
  Get-Content -LiteralPath $vocabPath -Raw | ConvertFrom-Json
}
else { $null }

$layout = Read-LayoutContract -RepoRoot $repoRoot
$fakeCorePath = Join-Path $PSScriptRoot 'fake-core.mjs'

<#
  The M4 shell, told apart from the M3 one by what it declares rather than by a
  version string.

  sidecar-layout.json is the file the shell is held against by a drift test in
  paths.rs, so a `setup` block there is the shell saying it knows how to spawn a
  setup channel, which is the whole M4 feature. No block means the shell in
  front of this rig predates the milestone, and every window scenario skips
  WITHOUT LAUNCHING ANYTHING. That matters: launching an M3 tray at a config
  path that does not exist puts it in a respawn loop against a core that cannot
  read its config, which proves nothing and takes a minute to do it.
#>
function Test-M4Shell {
  if ($null -eq $layout) { return $false }
  if ($layout.PSObject.Properties.Name -contains 'setup') { return $true }
  if (($layout.PSObject.Properties.Name -contains 'spawn') -and
    ($layout.spawn.PSObject.Properties.Name -contains 'setupArgs')) {
    return $true
  }
  return $false
}

<#
  The setup arguments, preferring the shell's own contract over this rig's copy.
  {configPath} is the only placeholder, exactly as spawn.watchArgs works today.
#>
function Get-SetupArgs {
  param([Parameter(Mandatory)][string]$ConfigPath)
  $template = @($protocol.setup.args)
  if ($null -ne $layout -and ($layout.PSObject.Properties.Name -contains 'spawn') -and
    ($layout.spawn.PSObject.Properties.Name -contains 'setupArgs')) {
    # The shell's own vector starts with the core bundle path, which is the
    # shell's business and not ours: this rig runs dist\cli.js directly.
    $template = @($layout.spawn.setupArgs | Where-Object { $_ -ne '{coreBundleAbsPath}' })
  }
  return @($template | ForEach-Object { [string]$_ -replace '\{configPath\}', $ConfigPath })
}

function Get-EventNames {
  param([Parameter(Mandatory)][string]$Key)
  return @($protocol.events.$Key)
}

# ---------------------------------------------------------------------------
# Small readers over what a run leaves behind.
# ---------------------------------------------------------------------------

# Get-CoreEvents, Get-FieldOrNull, Send-ScriptedAnswer and the ask loop itself
# all live in rig-common.ps1, so that rig-selftest.ps1 can drive the loop
# against app\e2e\fake-setup.mjs and prove it before an M4 core exists.

# New-SyntheticClientJson and New-SyntheticToken live in rig-common.ps1, so the
# self test can make the same files this scenario makes.

<#
  Build a unique PNG outside the watch folder and move it in, so the watcher can
  never see a half written file and no settle race is possible. The same trick
  run-m3.ps1 uses, for the same reason.
#>
function New-DroppedPng {
  param([Parameter(Mandatory)][object]$Run, [string]$Tag = 'm4')
  $marker = "photo-pigeon-m4 $Tag $([System.Guid]::NewGuid().ToString())"
  $name = "pigeon-$Tag-$((Get-Date).ToString('HHmmss'))-$([System.Guid]::NewGuid().ToString('N').Substring(0,8)).png"
  if (-not (Test-Path -LiteralPath $Run.stagingDir)) { $null = New-Item -ItemType Directory -Path $Run.stagingDir -Force }
  $staged = Join-Path $Run.stagingDir $name
  $size = New-TestPng -Path $staged -Marker $marker
  $hash = Get-Sha256Hex -Path $staged
  $dropped = Join-Path $Run.watchDir $name
  Move-Item -LiteralPath $staged -Destination $dropped -Force
  return [pscustomobject]@{ name = $name; path = $dropped; hash = $hash; size = $size }
}

function Test-HashInLedger {
  param([Parameter(Mandatory)][string]$LedgerPath, [Parameter(Mandatory)][string]$Hash)
  return @(Read-JsonLines -Path $LedgerPath | Where-Object {
      ($_.PSObject.Properties.Name -contains 'hash') -and ([string]$_.hash -eq $Hash)
    }).Count -gt 0
}

<#
  What the core said about one named file's first-ever question.

  Per file rather than per log, because "the log contains firstEver=false
  somewhere" would pass on a run where the wrong delivery claimed the flag.
  Returns 'true', 'false' or '' when the file is not in the log at all.
#>
function Get-FirstEverForFile {
  param([Parameter(Mandatory)][string]$LogPath, [Parameter(Mandatory)][string]$FileName)
  foreach ($line in @(Get-FileText -Path $LogPath) -split "`n") {
    if ($line -notmatch [regex]::Escape($FileName)) { continue }
    if ($line -match 'firstEver=(true|false)') { return $Matches[1].ToLowerInvariant() }
  }
  return ''
}

# ---------------------------------------------------------------------------
# The two safety rails, proved before anything is launched.
# ---------------------------------------------------------------------------

<#
  Rail one: the build in front of us really takes a config flag on setup.

  This is the whole reason a setup scenario is allowed to exist. Commander
  refuses an unknown option and exits, which is safe; what is NOT safe is a
  build that accepts `-c` and ignores it, and the only cheap discriminator
  available before running anything is whether the option is declared at all.
  Rail two, the sandbox home, catches the ignore case, which is why there are
  two.

  The two failures below are deliberately different, and the difference is the
  whole point of asking --help two questions instead of one:

    no --events   this build predates M4. Nothing is wrong with it, the feature
                  is simply not there, and the scenario SKIPS.
    --events but  this build has the M4 setup channel and shipped without the
    no -c         one flag that keeps it off the machine's real folder. That is a
                  FAULT and it is reported as one. The scenario still does not
                  run: a wizard that cannot be pointed anywhere writes home.
#>
function Test-SetupIsSafeToRun {
  $help = Get-CliHelp -RepoRoot $repoRoot -Arguments @('setup', '--help')
  if ([string]::IsNullOrWhiteSpace($help)) {
    Add-Check -Name 'the setup command could be asked what it takes' -Status 'skip' `
      -Detail "nothing came back from setup --help. Is there a built CLI at $repoRoot\dist\cli.js? Run npm run build."
    return [pscustomobject]@{ ok = $false; help = '' }
  }

  $speaksNdjson = Test-CliDeclares -HelpText $help -Marker ([string]$protocol.detect.coreSetupHelpMarker)
  if (-not $speaksNdjson) {
    Add-Check -Name 'the setup command speaks the machine channel' -Status 'skip' `
      -Detail "setup --help does not declare $($protocol.detect.coreSetupHelpMarker), so `setup --events ndjson` would die on an unknown option. That call is the first IPC in the M4 exit criterion and this build predates it, so nothing here is run."
    return [pscustomobject]@{ ok = $false; help = $help }
  }
  Add-Check -Name 'the setup command speaks the machine channel' -Status 'pass' `
    -Detail 'setup --help declares --events, so setup --events ndjson is a real command on this build'

  if (-not (Test-CliDeclares -HelpText $help -Marker ([string]$protocol.detect.configOptionMarker))) {
    Add-Check -Name 'the setup command declares a config flag' -Status 'fail' `
      -Detail "setup --help declares $($protocol.detect.coreSetupHelpMarker) but not $($protocol.detect.configOptionMarker). A setup channel that cannot be pointed at a config writes into ~/.photo-pigeon, and there is no flag that stops it. The scenario was NOT run."
    return [pscustomobject]@{ ok = $false; help = $help }
  }
  Add-Check -Name 'the setup command declares a config flag' -Status 'pass' `
    -Detail "$($protocol.detect.configOptionMarker), read out of setup --help rather than assumed"
  return [pscustomobject]@{ ok = $true; help = $help }
}

# ---------------------------------------------------------------------------
# Scenario: the setup channel, driven to a written config.
# ---------------------------------------------------------------------------

<#
  Answer one ask. The loop, the answer form and the re-ask rule live in
  rig-common.ps1; this only records what happened so the report can carry it.
#>
function Register-Answer {
  param([Parameter(Mandatory)][object]$Record)
  $script:AnswerLog.Add($Record)
  Write-Note "ask $($Record.id) ($($Record.kind)) `"$($Record.message)`" -> $($Record.value)$(if ($Record.fellThrough) { '   [fell through to a catch-all]' })"
}

function Invoke-SetupScenario {
  Write-Step 'First run: a machine with no config, answered by a script'

  $gate = Test-SetupIsSafeToRun
  if (-not $gate.ok) { return $null }
  $help = $gate.help

  $dir = New-RunDirectory -Tag 'setup'
  $watchDir = Join-Path $dir 'watch'
  $stagingDir = Join-Path $dir 'staging'
  foreach ($p in @($watchDir, $stagingDir)) {
    Assert-OutsideRealConfig -Path $p -Label 'a generated path'
    $null = New-Item -ItemType Directory -Path $p -Force
  }
  $run = Resume-RunConfig -Dir $dir
  $script:RunDirs.Add($run)

  # Nothing at the config path yet. That is the machine M4 describes, and the
  # assertion afterwards is worthless unless it starts true.
  Add-Check -Name 'the temp environment really has no config' `
    -Status $(if (-not (Test-Path -LiteralPath $run.configPath)) { 'pass' } else { 'fail' }) `
    -Detail $(if (-not (Test-Path -LiteralPath $run.configPath)) { "nothing at $($run.configPath)" } else { 'a config was already there, so nothing below proves a setup wrote one' })

  $sandbox = New-SandboxHome -Dir $dir
  Assert-HomeRedirectWorks -Sandbox $sandbox

  # A client JSON in the sandbox Downloads folder, under the name Google's own
  # download carries, so the wizard's intake finds it the ordinary way rather
  # than through the typed-path fallback.
  $projectId = "photo-pigeon-e2e-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
  $clientJson = Join-Path $sandbox.downloads 'client_secret_photo-pigeon-e2e.apps.googleusercontent.com.json'
  $null = New-SyntheticClientJson -Path $clientJson -ProjectId $projectId

  $tokens = @{
    watchDir        = $watchDir
    credentialsPath = $clientJson
    projectId       = $projectId
    albumName       = $Album
  }

  $args_ = Get-SetupArgs -ConfigPath $run.configPath
  if (Test-CliDeclares -HelpText $help -Marker ([string]$protocol.setup.noOpenFlag)) {
    $args_ = @($args_) + @([string]$protocol.setup.noOpenFlag)
    Write-Note "passing $($protocol.setup.noOpenFlag), so no browser opens on this desktop"
  }
  else {
    Add-Check -Name 'the setup run opens no browser' -Status 'warn' `
      -Detail "this build declares no $($protocol.setup.noOpenFlag), so the wizard may have handed console deep links to the system browser. Harmless, and noisy on somebody's desktop."
  }
  Write-Note "setup argv: $($args_ -join ' ')"

  $launched = Start-CoreDirect -Run $run -RepoRoot $repoRoot -Arguments $args_ `
    -NdjsonLeaf 'setup.ndjson' -StderrLeaf 'setup.stderr.log' -ChildEnv $sandbox.env
  $script:OpenCores.Add($launched)

  try {
    $walk = Invoke-SetupChannel -Launched $launched -Protocol $protocol -ConfigPath $run.configPath `
      -Tokens $tokens -TimeoutSeconds $SetupTimeoutSec -OnAnswer { param($record) Register-Answer -Record $record }

    Add-Check -Name 'the setup channel really asked questions' `
      -Status $(if ($walk.asked -gt 0) { 'pass' } else { 'fail' }) `
      -Detail $(if ($walk.asked -gt 0) { "$($walk.asked) ask events, every one answered on stdin with the one payload-carrying form" } else { "no $((Get-EventNames -Key 'ask') -join '/') event in $SetupTimeoutSec seconds. Either the wizard's input is not on the channel yet, or it is still calling the terminal prompts directly." })

    if ($null -ne $walk.failure) {
      Add-Check -Name 'the setup run did not fail' -Status 'fail' -Detail $walk.failure
    }
    if ($walk.timedOut) {
      Add-Check -Name 'the setup run finished inside its window' -Status 'fail' `
        -Detail "$SetupTimeoutSec seconds passed with no written event, no config on disk and no failure. A channel that goes quiet mid walk is the state a front end has no reading of."
    }
    if ($walk.exhausted.Count -gt 0) {
      $why = @($walk.refusals | ForEach-Object { Get-RefusalSentence -Refusal $_ -Protocol $protocol })
      Add-Check -Name 'no question was refused until the rig gave up on it' -Status 'fail' `
        -Detail "gave up on ask id(s) $($walk.exhausted -join ', ') after $($protocol.setup.maxAttemptsPerAsk) tries. The core's own sentences: $($why -join ' | '). Either a rule in m4-protocol.json answers that question wrongly, or the wizard's validation changed."
    }
    elseif ($walk.refusals.Count -gt 0) {
      $why = @($walk.refusals | ForEach-Object { Get-RefusalSentence -Refusal $_ -Protocol $protocol })
      Add-Check -Name 'a refused answer was answered again rather than waited on' -Status 'info' `
        -Detail "$($walk.refusals.Count) refusal(s), all recovered: $($why -join ' | ')"
    }

    # `configured` carries written:false when the user kept the config that was
    # already on disk, which is not the same thing as a setup having written one.
    if ($null -ne $walk.writtenEvent) {
      $writtenFlag = Get-FieldOrNull -Object $walk.writtenEvent -Name ([string]$protocol.writtenFields.written)
      if ($null -ne $writtenFlag) {
        Add-Check -Name 'the config was written rather than kept' `
          -Status $(if ([bool]$writtenFlag) { 'pass' } else { 'fail' }) `
          -Detail $(if ([bool]$writtenFlag) { 'written true, so this run really made a setup' } else { 'written false, which means the run found a config already there and kept it. Nothing below is testing a first run.' })
      }
    }

    # Every answer that fell through to a catch-all. Not a failure: the run
    # still finished. It is the thing to read when a green run looks too easy.
    $fell = @($script:AnswerLog | Where-Object { $_.fellThrough })
    if ($fell.Count -gt 0) {
      Add-Check -Name 'some questions were answered by a catch-all rule' -Status 'warn' `
        -Detail "$($fell.Count) of $($script:AnswerLog.Count): $((@($fell | ForEach-Object { $_.message })) -join ' | '). Add a rule to m4-protocol.json for each, or the wording changed under the rig."
    }
    elseif ($script:AnswerLog.Count -gt 0) {
      Add-Check -Name 'every question matched a rule written for it' -Status 'pass' `
        -Detail "$($script:AnswerLog.Count) answers, none of them a guess"
    }

    # --- the config that landed ------------------------------------------
    $wrote = Test-Path -LiteralPath $run.configPath -PathType Leaf
    Add-Check -Name 'a config was written to the temp environment' `
      -Status $(if ($wrote) { 'pass' } else { 'fail' }) `
      -Detail $(if ($wrote) { $run.configPath } else { "nothing at $($run.configPath) after $SetupTimeoutSec seconds" })

    if ($wrote) {
      $written = $null
      try { $written = Get-Content -LiteralPath $run.configPath -Raw | ConvertFrom-Json } catch { $written = $null }
      Add-Check -Name 'the written config is readable JSON' -Status $(if ($null -ne $written) { 'pass' } else { 'fail' }) `
        -Detail $(if ($null -ne $written) { "$((Get-Item -LiteralPath $run.configPath).Length) bytes" } else { 'it would not parse' })

      if ($null -ne $written) {
        $dirs = @(Get-FieldOrNull -Object $written -Name 'watchDirs')
        $watchesOurs = @($dirs | Where-Object { ([System.IO.Path]::GetFullPath([string]$_).TrimEnd('\')) -ieq ($watchDir.TrimEnd('\')) }).Count -gt 0
        Add-Check -Name 'the config watches the folder the script answered with' `
          -Status $(if ($watchesOurs) { 'pass' } else { 'fail' }) `
          -Detail "watchDirs: $($dirs -join ', ')"

        # THE SAFETY ASSERTION, and the strongest form of it available: the
        # config the CORE wrote names only paths under TEMP. Not a path the rig
        # generated and checked, a path the thing under test chose.
        $escaped = @()
        foreach ($name in @('credentialsPath', 'tokenPath', 'ledgerPath')) {
          $value = [string](Get-FieldOrNull -Object $written -Name $name)
          if ([string]::IsNullOrWhiteSpace($value)) { continue }
          if (Test-InsideRealConfig -Path $value) { $escaped += "$name -> $value" }
        }
        foreach ($d in $dirs) {
          if (Test-InsideRealConfig -Path ([string]$d)) { $escaped += "watchDirs -> $d" }
        }
        Add-Check -Name 'every path the core wrote into the config is outside the production folder' `
          -Status $(if ($escaped.Count -eq 0) { 'pass' } else { 'fail' }) `
          -Detail $(if ($escaped.Count -eq 0) { 'credentials, token, ledger and every watched folder are all under TEMP' } else { "these point into ~/.photo-pigeon: $($escaped -join '; ')" })

        $album = [string](Get-FieldOrNull -Object $written -Name 'albumName')
        Add-Check -Name 'the album answer reached the config' `
          -Status $(if ($album -eq $Album) { 'pass' } else { 'warn' }) `
          -Detail $(if ($album -eq $Album) { $album } else { "config says '$album', the script answered '$Album'" })
      }

      $creds = Join-Path $dir 'credentials.json'
      Add-Check -Name 'the client JSON was copied into the temp environment, not read from Downloads forever' `
        -Status $(if (Test-Path -LiteralPath $creds -PathType Leaf) { 'pass' } else { 'warn' }) `
        -Detail $(if (Test-Path -LiteralPath $creds -PathType Leaf) { $creds } else { "nothing at $creds" })
    }

    # --- rail two, checked after the fact ---------------------------------
    $fellHome = Test-Path -LiteralPath $sandbox.pigeonDir
    Add-Check -Name 'the config flag was obeyed rather than ignored' `
      -Status $(if (-not $fellHome) { 'pass' } else { 'fail' }) `
      -Detail $(if (-not $fellHome) { "nothing was written to $($sandbox.pigeonDir), which is where a setup that ignored -c would have landed" } else { "$($sandbox.pigeonDir) exists, so the run fell back to the home directory. On a machine without the USERPROFILE rail that folder would have been the real one." })

    # --- the OAuth law, on the wire ---------------------------------------
    $stream = Get-FileText -Path $launched.ndjson
    $leaked = $stream -match 'accounts\.google\.com'
    Add-Check -Name 'no consent URL was ever put on the machine channel' `
      -Status $(if (-not $leaked) { 'pass' } else { 'fail' }) `
      -Detail $(if (-not $leaked) { 'nothing matching accounts.google.com on stdout, so a window has no auth URL to render even by accident' } else { 'an accounts.google.com URL is on stdout. Consent opens the system browser and never a WebviewWindow, and a URL a page can read is the first half of breaking that.' })

    # stdout is the machine channel and carries nothing else. A single line of
    # prose in it is what the M1 review's second critical was about.
    $lines = @(Get-Content -LiteralPath $launched.ndjson -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne '' })
    $bad = @($lines | Where-Object { try { $null = $_ | ConvertFrom-Json; $false } catch { $true } })
    Add-Check -Name 'stdout carried one JSON line per event and nothing else' `
      -Status $(if ($bad.Count -eq 0) { 'pass' } else { 'fail' }) `
      -Detail $(if ($bad.Count -eq 0) { "$($lines.Count) lines, all of them JSON" } else { "$($bad.Count) line(s) would not parse, first: $($bad[0])" })
  }
  finally {
    # Stopped rather than left to sign in. The next thing the wizard does is
    # open a browser and wait for a human, and there is no human.
    if (-not $launched.process.HasExited) {
      Write-Note 'stopping the setup run before it reaches sign-in: a rig has no Google password and must never pretend to'
      $null = Send-CoreLine -Launched $launched -Line 'stop'
      $stopped = Wait-Until -TimeoutSeconds 30 -PollMs 300 -Condition { $launched.process.HasExited }
      if (-not $stopped) { $null = Close-CoreStdin -Launched $launched }
      $null = Wait-Until -TimeoutSeconds 30 -PollMs 300 -Condition { $launched.process.HasExited }
    }
    Add-Check -Name 'the setup run ended on a word rather than a kill' `
      -Status $(if ($launched.process.HasExited) { 'pass' } else { 'fail' }) `
      -Detail $(if ($launched.process.HasExited) { "exit code $($launched.process.ExitCode)" } else { "pid $($launched.id) is still running. It was NOT killed: everything it owns is under TEMP." })
  }

  return $run
}

# ---------------------------------------------------------------------------
# Scenario: doctor, against the temp environment.
# ---------------------------------------------------------------------------

function Invoke-DoctorScenario {
  Write-Step 'Health: doctor reads the throwaway setup and says what is wrong with it'

  $help = Get-CliHelp -RepoRoot $repoRoot -Arguments @('doctor', '--help')
  $speaksJson = Test-CliDeclares -HelpText $help -Marker ([string]$protocol.detect.coreDoctorHelpMarker)
  $takesConfig = Test-CliDeclares -HelpText $help -Marker ([string]$protocol.detect.configOptionMarker)

  if (-not $speaksJson) {
    Add-Check -Name 'doctor speaks JSON' -Status 'skip' `
      -Detail "doctor --help does not declare $($protocol.detect.coreDoctorHelpMarker). The shell's doctor_report() command returns structured findings, and today runDoctor resolves prose, so there is nothing structured for a health window to render."
    return
  }
  if (-not $takesConfig) {
    # Not a skip and not a run: doctor without a config flag reads the REAL
    # setup on this machine, which is a read this rig has no business making and
    # a report about a machine it is not testing.
    Add-Check -Name 'doctor can be pointed at a throwaway setup' -Status 'skip' `
      -Detail "doctor --help declares no $($protocol.detect.configOptionMarker), so the only setup it can report on is the real one. This rig will not run it: the answer would be about this machine rather than about the temp environment, and reading the real config is not this rig's business."
    return
  }

  $dir = New-RunDirectory -Tag 'doctor'
  $sandbox = New-SandboxHome -Dir $dir
  Assert-HomeRedirectWorks -Sandbox $sandbox

  $projectId = "photo-pigeon-e2e-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
  $seedCreds = New-SyntheticClientJson -Path (Join-Path $dir 'seed-client.json') -ProjectId $projectId
  $seedToken = New-SyntheticToken -Path (Join-Path $dir 'seed-token.json')

  $run = New-RunConfig -Dir $dir -CredentialsPath $seedCreds -TokenPath $seedToken -Album $Album
  $script:RunDirs.Add($run)

  $args_ = @($protocol.doctor.args | ForEach-Object { [string]$_ -replace '\{configPath\}', $run.configPath })
  Write-Note "doctor argv: $($args_ -join ' ')"

  $launched = Start-CoreDirect -Run $run -RepoRoot $repoRoot -Arguments $args_ `
    -NdjsonLeaf 'doctor.json' -StderrLeaf 'doctor.stderr.log' -ChildEnv $sandbox.env
  $script:OpenCores.Add($launched)
  $null = Wait-Until -TimeoutSeconds 60 -PollMs 300 -Condition { $launched.process.HasExited }

  $raw = Get-FileText -Path $launched.ndjson
  $report = $null
  try { $report = $raw | ConvertFrom-Json } catch { $report = $null }

  Add-Check -Name 'doctor --json returned one JSON document' -Status $(if ($null -ne $report) { 'pass' } else { 'fail' }) `
    -Detail $(if ($null -ne $report) { "$($raw.Trim().Length) bytes" } else { "would not parse. First 200 characters: $($raw.Substring(0, [Math]::Min(200, $raw.Length)))" })
  if ($null -eq $report) { return }

  $okField = [string]$protocol.doctor.okField
  $ok = [bool](Get-FieldOrNull -Object $report -Name $okField)
  $checks = @(Get-FieldOrNull -Object $report -Name ([string]$protocol.doctor.checksField))

  Add-Check -Name 'the report carries the individual checks, not just a verdict' `
    -Status $(if ($checks.Count -gt 0) { 'pass' } else { 'fail' }) `
    -Detail $(if ($checks.Count -gt 0) { "$($checks.Count) checks" } else { "no $($protocol.doctor.checksField) array. A health window rendering one boolean is a health window nobody can act on." })

  # Every check that is not plainly ok, named. "doctor is red" with no line
  # number is a bug report nobody can act on.
  $levelField = [string]$protocol.doctor.levelField
  $failLevel = [string]$protocol.doctor.failLevel
  $failed = @($checks | Where-Object { ([string](Get-FieldOrNull -Object $_ -Name $levelField)) -eq $failLevel })
  foreach ($c in $checks) {
    $level = [string](Get-FieldOrNull -Object $c -Name $levelField)
    if ($level -eq 'ok') { continue }
    Add-Check -Name "doctor: $([string](Get-FieldOrNull -Object $c -Name 'title'))" `
      -Status $(if ($level -eq $failLevel) { 'fail' } else { 'info' }) `
      -Detail "$level. $([string](Get-FieldOrNull -Object $c -Name 'detail'))"
  }

  Add-Check -Name 'doctor is green against the throwaway environment' `
    -Status $(if ($ok -and $failed.Count -eq 0) { 'pass' } else { 'fail' }) `
    -Detail $(if ($ok -and $failed.Count -eq 0) { "$okField true, $($checks.Count) checks, none of them a failure. Notes and warnings are expected: a setup that has never signed in has nothing to say about a token." }
    else { "$okField is $ok with $($failed.Count) failing check(s), named above" })

  Add-Check -Name 'doctor exited on the code its verdict implies' `
    -Status $(if (($ok -and $launched.process.ExitCode -eq 0) -or (-not $ok -and $launched.process.ExitCode -ne 0)) { 'pass' } else { 'warn' }) `
    -Detail "exit code $($launched.process.ExitCode), verdict $okField=$ok"

  $fellHome = Test-Path -LiteralPath $sandbox.pigeonDir
  Add-Check -Name 'doctor wrote nothing anywhere' `
    -Status $(if (-not $fellHome) { 'pass' } else { 'fail' }) `
    -Detail $(if (-not $fellHome) { 'nothing appeared in the sandbox home, and doctor is documented as never writing anything' } else { "$($sandbox.pigeonDir) appeared during a doctor run" })
}

# ---------------------------------------------------------------------------
# Tray scenarios. Everything below launches the real shell.
# ---------------------------------------------------------------------------

function Start-M4Tray {
  param(
    [Parameter(Mandatory)][object]$Run,
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Tag,
    [string[]]$Arguments = @(),
    [hashtable]$ExtraEnv = @{},
    [string]$CoreOverride = '',
    [switch]$ExpectNoSidecar
  )
  return Start-TrayForScenario -Run $Run -Exe $Exe -Tag $Tag -Facts $facts `
    -ConfigEnvName $ConfigEnvName -Arguments $Arguments -ExtraEnv $ExtraEnv `
    -CoreJs $(if ($CoreOverride -ne '') { $CoreOverride } else { $CoreJs }) -NodeExe $NodeExe `
    -ReadySec $ReadySec -Register $script:OpenShells -ExpectNoSidecar:$ExpectNoSidecar
}

function Stop-M4Tray {
  param([Parameter(Mandatory)][object]$Session, [Parameter(Mandatory)][object]$Run, [string]$Tag = '')
  Stop-TrayAndWait -Session $Session -Run $Run -Tag $Tag -DrainTimeoutSec $DrainTimeoutSec
}

<#
  Wait for one titled, visible window belonging to the shell.

  Titled and visible together, because Tauri owns hidden helper windows and
  counting those would make the zero-windows law unfalsifiable. Returns the
  window, or $null when none arrived.
#>
function Wait-ForAppWindow {
  param([Parameter(Mandatory)][int]$ProcessId, [int]$TimeoutSeconds = 30)
  $found = $null
  $null = Wait-Until -TimeoutSeconds $TimeoutSeconds -PollMs 400 -Condition {
    $windows = @(Get-AppWindows -ProcessId $ProcessId)
    if ($windows.Count -gt 0) { $script:_windowFound = $windows[0]; return $true }
    return $false
  }
  if ($null -ne (Get-Variable -Name '_windowFound' -Scope Script -ErrorAction SilentlyContinue)) {
    $found = $script:_windowFound
    Remove-Variable -Name '_windowFound' -Scope Script -ErrorAction SilentlyContinue
  }
  return $found
}

<#
  The setup sidecar this shell spawned, found by what is on its command line.

  This is the rig's proof that the PAGE really ran rather than merely rendered:
  the only thing that spawns a setup channel is the window's own JavaScript
  calling setup_start, so a process running `setup` under this shell is the
  IPC round trip having happened.
#>
function Get-SetupSidecar {
  param([Parameter(Mandatory)][int]$ParentId)
  return @(Get-DescendantProcesses -ParentId $ParentId -Depth 4 | Where-Object {
      ([string]$_.commandLine) -match '\bsetup\b' -and $_.name -notlike 'msedgewebview2*'
    })
}

function Assert-NoWebviewsLeft {
  param([Parameter(Mandatory)][int]$ParentId, [Parameter(Mandatory)][string]$Label, [int]$TimeoutSeconds = 30)
  $gone = Wait-Until -TimeoutSeconds $TimeoutSeconds -PollMs 500 -Condition {
    (@(Get-WebviewProcesses -ParentId $ParentId -Name ([string]$protocol.window.webviewProcessName))).Count -eq 0
  }
  $left = @(Get-WebviewProcesses -ParentId $ParentId -Name ([string]$protocol.window.webviewProcessName))
  Add-Check -Name "zero webview processes $Label" -Status $(if ($gone) { 'pass' } else { 'fail' }) `
    -Detail $(if ($gone) { 'the whole no-window-at-idle law in one number' } else { "$($left.Count) still running: $((@($left | ForEach-Object { "$($_.name)/$($_.pid)" })) -join ', '). A window that was hidden rather than destroyed keeps its webview, and its RAM." })
  return $gone
}

function Invoke-WindowScenario {
  param([Parameter(Mandatory)][string]$Exe)
  Write-Step 'The first-run window: it opens, its page runs, and closing it destroys it'

  $dir = New-RunDirectory -Tag 'window'
  $watchDir = Join-Path $dir 'watch'
  $null = New-Item -ItemType Directory -Path $watchDir -Force
  $run = Resume-RunConfig -Dir $dir
  $script:RunDirs.Add($run)
  Add-Check -Name 'the window run starts from no config at all' `
    -Status $(if (-not (Test-Path -LiteralPath $run.configPath)) { 'pass' } else { 'fail' }) `
    -Detail "$($run.configPath) does not exist, which is the machine the exit criterion describes"

  $baselineWindows = 0
  $session = Start-M4Tray -Run $run -Exe $Exe -Tag 'window' -ExpectNoSidecar
  try {
    $shellPid = $session.launched.id

    $window = Wait-ForAppWindow -ProcessId $shellPid -TimeoutSeconds $WindowOpenSec
    if ($null -eq $window) {
      Add-Check -Name 'a tray with no config opens the first-run window by itself' -Status 'fail' `
        -Detail "no titled, visible window belonging to pid $shellPid within $WindowOpenSec seconds. A first run that shows nothing is a tray icon and a user with no way in."
      Write-Note ('shell log tail: ' + (Get-FileTail -Path $session.shellLog -Lines 20))
      return
    }
    Add-Check -Name 'a tray with no config opens the first-run window by itself' -Status 'pass' `
      -Detail "window `"$($window.title)`", handle $($window.handle)"

    Add-Check -Name 'the window title reads the display name' `
      -Status $(if ($window.title -match [regex]::Escape([string]$protocol.window.titleMarker)) { 'pass' } else { 'fail' }) `
      -Detail "title is `"$($window.title)`", and the naming law says every human surface reads $($protocol.window.titleMarker)"

    Add-Check -Name 'no em dash anywhere in the window title' `
      -Status $(if ($window.title -notmatch [char]0x2014) { 'pass' } else { 'fail' }) `
      -Detail $(if ($window.title -notmatch [char]0x2014) { 'plain punctuation' } else { "the title carries U+2014: `"$($window.title)`"" })

    $webviews = @(Get-WebviewProcesses -ParentId $shellPid -Name ([string]$protocol.window.webviewProcessName))
    Add-Check -Name 'the window is a real webview rather than an empty frame' `
      -Status $(if ($webviews.Count -gt 0) { 'pass' } else { 'fail' }) `
      -Detail "$($webviews.Count) $($protocol.window.webviewProcessName) processes"

    # The page really RAN, not merely rendered. Nothing spawns a setup channel
    # except the window's own script calling setup_start, so a setup process
    # under this shell is the IPC round trip having happened.
    $spawned = Wait-Until -TimeoutSeconds $WindowOpenSec -PollMs 500 -Condition {
      (@(Get-SetupSidecar -ParentId $shellPid)).Count -gt 0
    }
    $setupKids = @(Get-SetupSidecar -ParentId $shellPid)
    Add-Check -Name "the page loaded and its script reached the shell" `
      -Status $(if ($spawned) { 'pass' } else { 'warn' }) `
      -Detail $(if ($spawned) { "a setup sidecar is running under the shell: $($setupKids[0].name)/$($setupKids[0].pid). Only the page calling setup_start starts one." }
      else { "no setup sidecar within $WindowOpenSec seconds. The window may open its channel on a click rather than on load, which is a design choice and not a fault; it does mean this run cannot prove the page's script ran." })

    # Memory, with a window open. This is the row TRAY-DESIGN section 6 leaves
    # explicitly unfilled for M4.
    $shellMem = Get-ProcessMemoryDetail -Id $shellPid
    if ($null -ne $shellMem) {
      $script:Measurements['shellWithWindowOpen'] = $shellMem
      $private = $shellMem.privateWorkingSetMB
      if ($null -eq $private) {
        Add-Check -Name 'shell private working set with the window open' -Status 'warn' `
          -Detail "the performance counter would not answer, so only working set is available: $($shellMem.workingSetMB) MB. The budget is about private working set and this run cannot score it."
      }
      else {
        $status = if ($private -gt [double]$protocol.memory.shellPrivateCeilingMB) { 'fail' }
        elseif ($private -gt [double]$protocol.memory.shellPrivateTargetMB) { 'warn' }
        else { 'pass' }
        Add-Check -Name 'shell private working set with the window open' -Status $status `
          -Detail "$private MB private working set, target $($protocol.memory.shellPrivateTargetMB), reopen-the-decision above $($protocol.memory.shellPrivateCeilingMB). Working set was $($shellMem.workingSetMB) MB and is an observation only: most of it is Windows' own file-backed pages."
      }
    }
    $webviewPrivate = 0.0
    foreach ($w in $webviews) {
      $m = Get-ProcessMemoryDetail -Id $w.pid
      if ($null -ne $m -and $null -ne $m.privateWorkingSetMB) { $webviewPrivate += [double]$m.privateWorkingSetMB }
    }
    $script:Measurements['webviewPrivateWorkingSetMB'] = [math]::Round($webviewPrivate, 2)
    Add-Check -Name 'what the webview host costs while a window is open' -Status 'info' `
      -Detail "$([math]::Round($webviewPrivate, 2)) MB private working set across $($webviews.Count) process(es). Recorded, never scored: that is Microsoft's runtime and no budget has ever been ratified for it."

    # --- the close --------------------------------------------------------
    Write-Note 'posting WM_CLOSE, which is the message the X button sends'
    $null = Close-AppWindow -Handle $window.handle

    $destroyed = Wait-Until -TimeoutSeconds $WindowCloseSec -PollMs 400 -Condition {
      -not (Test-AppWindowAlive -Handle $window.handle)
    }
    Add-Check -Name 'closing the window destroyed it' -Status $(if ($destroyed) { 'pass' } else { 'fail' }) `
      -Detail $(if ($destroyed) { "handle $($window.handle) is not a window any more" } else { "handle $($window.handle) is still a window $WindowCloseSec seconds after the close. Hidden is not destroyed, and a hidden window keeps its webview forever." })

    $null = Assert-NoWebviewsLeft -ParentId $shellPid -Label 'after the window closed' -TimeoutSeconds $WindowCloseSec

    $stillTitled = @(Get-AppWindows -ProcessId $shellPid)
    Add-Check -Name 'the shell is back to zero windows' `
      -Status $(if ($stillTitled.Count -eq $baselineWindows) { 'pass' } else { 'fail' }) `
      -Detail "$($stillTitled.Count) titled, visible windows$(if ($stillTitled.Count -gt 0) { ": $((@($stillTitled | ForEach-Object { $_.title })) -join ', ')" })"

    Add-Check -Name 'the tray survived its own window closing' `
      -Status $(if (-not $session.launched.process.HasExited) { 'pass' } else { 'fail' }) `
      -Detail $(if (-not $session.launched.process.HasExited) { "pid $shellPid still running, which is what a tray does when a window goes" } else { "the shell exited with $($session.launched.process.ExitCode). Closing a window must not close the app." })

    $log = Get-FileText -Path $session.shellLog
    $saidSomething = ($log -match [regex]::Escape([string]$protocol.window.shellLogWindowMarkers.created))
    Add-Check -Name 'the shell log says something about its window' `
      -Status $(if ($saidSomething) { 'pass' } else { 'warn' }) `
      -Detail $(if ($saidSomething) { 'the log names the window, so a support conversation has something to read' } else { 'the shell log says nothing about a window being created or destroyed. Not a fault, and it is the difference between a bug report and a shrug.' })
  }
  finally {
    Stop-M4Tray -Session $session -Run $run -Tag 'window'
  }
}

function Invoke-OrphanScenario {
  param([Parameter(Mandatory)][string]$Exe)
  Write-Step 'The window dies mid flow: nothing half written, and the sidecar goes with it'

  foreach ($mode in @('closed', 'killed')) {
    $dir = New-RunDirectory -Tag "orphan-$mode"
    $null = New-Item -ItemType Directory -Path (Join-Path $dir 'watch') -Force
    $run = Resume-RunConfig -Dir $dir
    $script:RunDirs.Add($run)

    $session = Start-M4Tray -Run $run -Exe $Exe -Tag "orphan-$mode" -ExpectNoSidecar
    try {
      $shellPid = $session.launched.id
      $window = Wait-ForAppWindow -ProcessId $shellPid -TimeoutSeconds $WindowOpenSec
      if ($null -eq $window) {
        Add-Check -Name "the window opened before it was $mode" -Status 'skip' `
          -Detail "no window within $WindowOpenSec seconds, so there is nothing to interrupt"
        continue
      }

      # Mid flow means: a setup channel is open and no config has been written.
      # Both halves are asserted, because interrupting a run that had already
      # finished would prove nothing at all.
      $null = Wait-Until -TimeoutSeconds $WindowOpenSec -PollMs 400 -Condition {
        (@(Get-SetupSidecar -ParentId $shellPid)).Count -gt 0
      }
      $sidecars = @(Get-SetupSidecar -ParentId $shellPid)
      Add-Check -Name "a setup run really was in flight ($mode)" `
        -Status $(if ($sidecars.Count -gt 0) { 'pass' } else { 'skip' }) `
        -Detail $(if ($sidecars.Count -gt 0) { "$($sidecars[0].name)/$($sidecars[0].pid), with no config written yet" } else { 'no setup sidecar to interrupt, so this probe has nothing to say' })
      if ($sidecars.Count -eq 0) { continue }

      $sidecarPid = [int]$sidecars[0].pid
      Add-Check -Name "nothing had been written before the interruption ($mode)" `
        -Status $(if (-not (Test-Path -LiteralPath $run.configPath)) { 'pass' } else { 'skip' }) `
        -Detail $(if (-not (Test-Path -LiteralPath $run.configPath)) { 'the config path is still empty, so the run really is mid flow' } else { 'the setup had already finished, and an interruption after the fact proves nothing' })

      if ($mode -eq 'closed') {
        Write-Note 'closing the window mid flow, the way a user who changed their mind does'
        $null = Close-AppWindow -Handle $window.handle
      }
      else {
        # The literal reading of "kill the setup window": the webview host dies
        # without warning, which is what a webview crash looks like from the
        # shell's side. Only processes that are descendants of a tray THIS RUN
        # launched are ever touched, and never the core.
        $hosts_ = @(Get-WebviewProcesses -ParentId $shellPid -Name ([string]$protocol.window.webviewProcessName))
        Write-Note "terminating $($hosts_.Count) webview host process(es) under pid $shellPid, which is what a webview crash looks like"
        foreach ($h in $hosts_) {
          if ($h.pid -eq $sidecarPid) { continue }
          try { Stop-Process -Id $h.pid -Force -ErrorAction SilentlyContinue } catch { }
        }
        Add-Check -Name 'only webview hosts were terminated, never a core' -Status 'pass' `
          -Detail "$($hosts_.Count) $($protocol.window.webviewProcessName) process(es), every one a descendant of the tray this run launched. The setup sidecar was not touched."
      }

      $sidecarGone = Wait-Until -TimeoutSeconds $WindowCloseSec -PollMs 400 -Condition {
        -not (Test-ProcessAlive -Id $sidecarPid)
      }
      Add-Check -Name "the setup sidecar exited when its window died ($mode)" `
        -Status $(if ($sidecarGone) { 'pass' } else { 'fail' }) `
        -Detail $(if ($sidecarGone) { "pid $sidecarPid is gone. It was asked to stop, not killed: the shell owns that pipe." } else { "pid $sidecarPid is still running $WindowCloseSec seconds after the window went. An orphaned wizard holds a channel nothing is listening to, and it is the process that writes the config." })

      $configAppeared = Test-Path -LiteralPath $run.configPath
      Add-Check -Name "no config was left behind by the interrupted run ($mode)" `
        -Status $(if (-not $configAppeared) { 'pass' } else { 'fail' }) `
        -Detail $(if (-not $configAppeared) { 'nothing at the config path, which is right: the run never got that far' } else { "a config exists at $($run.configPath) after a run that was interrupted before it finished. A half-made setup is worse than none: it is the one a watch would try to use." })

      # The atomic writer's own residue, named after the file it was making:
      # .<basename>.<unique>.tmp, in the same folder as the target.
      $residue = @(Get-ChildItem -LiteralPath $dir -Force -Filter '*.tmp' -ErrorAction SilentlyContinue)
      Add-Check -Name "no half written temp file was left behind ($mode)" `
        -Status $(if ($residue.Count -eq 0) { 'pass' } else { 'fail' }) `
        -Detail $(if ($residue.Count -eq 0) { 'no .tmp residue in the run directory' } else { "$((@($residue | ForEach-Object { $_.Name })) -join ', ')" })

      Add-Check -Name "the tray itself survived ($mode)" `
        -Status $(if (-not $session.launched.process.HasExited) { 'pass' } else { 'fail' }) `
        -Detail $(if (-not $session.launched.process.HasExited) { "pid $shellPid still running" } else { "the shell exited with $($session.launched.process.ExitCode)" })
    }
    finally {
      Stop-M4Tray -Session $session -Run $run -Tag "orphan-$mode"
    }
  }
}

function Invoke-HandlesScenario {
  param([Parameter(Mandatory)][string]$Exe)
  Write-Step 'What a window costs: the handle count probe TRAY-DESIGN asks for at M4'

  $dir = New-RunDirectory -Tag 'handles'
  $null = New-Item -ItemType Directory -Path (Join-Path $dir 'watch') -Force
  $run = Resume-RunConfig -Dir $dir
  $script:RunDirs.Add($run)

  $wantedCycles = [int]$protocol.handles.cycles
  $settle = [int]$protocol.handles.settleSeconds
  $scriptable = -not [string]::IsNullOrWhiteSpace($OpenWindowCommand)
  if (-not $scriptable) {
    Write-Note 'no -OpenWindowCommand, so this probe gets the one window a first run opens by itself'
  }

  $session = Start-M4Tray -Run $run -Exe $Exe -Tag 'handles' -ExpectNoSidecar
  try {
    $shellPid = $session.launched.id

    # Baseline: idle, no window, after a settle. The same shape M2's idle
    # reading is taken in, so the two are comparable.
    Start-Sleep -Seconds $settle
    $baseline = Get-HandleCount -Id $shellPid
    $baselineMem = Get-ProcessMemoryDetail -Id $shellPid
    $script:Measurements['shellIdleBeforeAnyWindow'] = $baselineMem
    Add-Check -Name 'a baseline handle count was taken before any window existed' `
      -Status $(if ($baseline -gt 0) { 'pass' } else { 'fail' }) `
      -Detail "$baseline handles, $(if ($null -ne $baselineMem -and $null -ne $baselineMem.privateWorkingSetMB) { "$($baselineMem.privateWorkingSetMB) MB private working set" } else { 'private working set unavailable' })"

    $afterOpen = @()
    $afterClose = @()
    $cyclesRun = 0

    for ($cycle = 1; $cycle -le $wantedCycles; $cycle++) {
      if ($cycle -gt 1) {
        if (-not $scriptable) { break }
        Write-Note "cycle $cycle : asking the running tray to open its window again"
        try { Invoke-Expression $OpenWindowCommand | Out-Null } catch {
          Add-Check -Name "the reopen command worked (cycle $cycle)" -Status 'fail' -Detail $_.Exception.Message
          break
        }
      }

      $window = Wait-ForAppWindow -ProcessId $shellPid -TimeoutSeconds $WindowOpenSec
      if ($null -eq $window) {
        Add-Check -Name "a window opened for cycle $cycle" -Status $(if ($cycle -eq 1) { 'fail' } else { 'warn' }) `
          -Detail "nothing titled and visible under pid $shellPid within $WindowOpenSec seconds"
        break
      }

      Start-Sleep -Seconds $settle
      $afterOpen += (Get-HandleCount -Id $shellPid)

      $null = Close-AppWindow -Handle $window.handle
      $gone = Wait-Until -TimeoutSeconds $WindowCloseSec -PollMs 400 -Condition {
        -not (Test-AppWindowAlive -Handle $window.handle)
      }
      if (-not $gone) {
        Add-Check -Name "the window closed for cycle $cycle" -Status 'fail' `
          -Detail "handle $($window.handle) is still a window after $WindowCloseSec seconds, so the reading after it would be meaningless"
        break
      }
      $null = Wait-Until -TimeoutSeconds $WindowCloseSec -PollMs 500 -Condition {
        (@(Get-WebviewProcesses -ParentId $shellPid -Name ([string]$protocol.window.webviewProcessName))).Count -eq 0
      }
      Start-Sleep -Seconds $settle
      $afterClose += (Get-HandleCount -Id $shellPid)
      $cyclesRun++
      Write-Note "cycle $cycle : $($afterOpen[-1]) handles open, $($afterClose[-1]) after the close"
    }

    $script:Measurements['handleProbe'] = [pscustomobject]@{
      baseline   = $baseline
      afterOpen  = $afterOpen
      afterClose = $afterClose
    }

    if ($cyclesRun -eq 0) {
      Add-Check -Name 'the handle probe ran' -Status 'fail' -Detail 'not one open and close cycle completed'
      return
    }

    $verdict = Measure-HandleSlope -Baseline $baseline -AfterClose $afterClose -AfterOpen $afterOpen `
      -PerCycleTolerance ([int]$protocol.handles.perCycleTolerance)

    Add-Check -Name 'what the first window costs, once' -Status 'info' `
      -Detail "$($verdict.firstOpenCost) handles, kept after the close. TRAY-DESIGN's own A/B says what that is: the Windows shell and UI stack mapping in, fifty four modules the fresh process did not have. It is a step, not a slope, and it is the row section 6 leaves unfilled for M4."

    if ($verdict.verdict -eq 'skip') {
      Add-Check -Name 'the handle count settles rather than climbing' -Status 'skip' `
        -Detail "$($verdict.detail) There is no scriptable way to open the window twice in one process: the trigger is a tray menu item. Declare one and pass it as -OpenWindowCommand, and this becomes the number section 6 asks for. The same shape run-e2e.ps1's -QuitCommand already has."
    }
    else {
      Add-Check -Name 'the handle count settles rather than climbing' -Status $verdict.verdict `
        -Detail $verdict.detail
      Add-Check -Name 'closing the window really gave handles back' `
        -Status $(if ($verdict.gaveBack) { 'pass' } else { 'fail' }) `
        -Detail $(if ($verdict.gaveBack) { "the count after the last close is at or below the count while it was open" } else { "the count went UP across the close: open $($afterOpen[-1]), closed $($afterClose[-1])" })
    }

    $null = Assert-NoWebviewsLeft -ParentId $shellPid -Label 'at the end of the probe' -TimeoutSeconds $WindowCloseSec
  }
  finally {
    Stop-M4Tray -Session $session -Run $run -Tag 'handles'
  }
}

# ---------------------------------------------------------------------------
# Scenario: a delivery, simulated, through the real shell.
# ---------------------------------------------------------------------------

function Invoke-DeliveryScenario {
  param([Parameter(Mandatory)][string]$Exe)
  Write-Step 'A photo arrives: the last step of the exit criterion, with the upload simulated'

  if (-not (Test-Path -LiteralPath $fakeCorePath -PathType Leaf)) {
    Add-Check -Name 'the fake core is where the rig expects it' -Status 'fail' -Detail "nothing at $fakeCorePath"
    return
  }

  $dir = New-RunDirectory -Tag 'delivery'
  $run = New-RunConfig -Dir $dir -Album $Album
  $script:RunDirs.Add($run)

  Add-Check -Name 'the ledger is empty before the first photo' `
    -Status $(if (-not (Test-Path -LiteralPath $run.ledgerPath)) { 'pass' } else { 'fail' }) `
    -Detail 'an empty ledger before the delivery is exactly what "first ever" means, and the assertion below is worthless unless it starts true'

  Write-Note "the shell is pointed at $fakeCorePath. Nothing here reaches Google, and the delivery is simulated."
  $session = Start-M4Tray -Run $run -Exe $Exe -Tag 'delivery' -CoreOverride $fakeCorePath
  try {
    $photo = New-DroppedPng -Run $run -Tag 'first'
    Write-Note "$($photo.name), $($photo.size) bytes, sha256 $($photo.hash.Substring(0,12))"

    $landed = Wait-Until -TimeoutSeconds $DeliverTimeoutSec -PollMs 800 -Condition {
      Test-HashInLedger -LedgerPath $run.ledgerPath -Hash $photo.hash
    }
    Add-Check -Name 'the photo reached the ledger' -Status $(if ($landed) { 'pass' } else { 'fail' }) `
      -Detail $(if ($landed) { "sha256 $($photo.hash.Substring(0,12)) in $($run.ledgerPath). The upload was simulated; what this proves is the shell spawning a core, the core seeing the file, and the record being written." }
      else { "nothing within $DeliverTimeoutSec seconds. Core log tail: $(Get-FileTail -Path $run.logPath -Lines 10)" })

    # The M4 truth about the first photo, read from the core's own log because
    # the shell owns the pipe and the rig cannot see the event stream.
    $firstSaid = Get-FirstEverForFile -LogPath $run.logPath -FileName $photo.name
    Add-Check -Name 'the core called it the first delivery ever' `
      -Status $(if ($firstSaid -eq 'true') { 'pass' } elseif ($landed) { 'fail' } else { 'skip' }) `
      -Detail $(if ($firstSaid -eq 'true') { "$($photo.name) carried firstEver=true, sampled immediately before the ledger append. That is the project definition: an empty ledger BEFORE the delivery is what first ever means." }
      elseif ($landed) { "the delivery landed and the core said firstEver=$firstSaid. A count taken AFTER the write says one on a virgin install's first photo and never says zero again, which is the bug this assertion exists for." }
      else { 'nothing was delivered, so there is no first-ever question to answer' })

    # A second photo, to prove the truth is per delivery rather than per run.
    $second = New-DroppedPng -Run $run -Tag 'second'
    $landedTwo = Wait-Until -TimeoutSeconds $DeliverTimeoutSec -PollMs 800 -Condition {
      Test-HashInLedger -LedgerPath $run.ledgerPath -Hash $second.hash
    }
    $secondSaid = Get-FirstEverForFile -LogPath $run.logPath -FileName $second.name
    Add-Check -Name 'the second photo is not a first delivery' `
      -Status $(if ($landedTwo -and $secondSaid -eq 'false') { 'pass' } elseif (-not $landedTwo) { 'skip' } else { 'fail' }) `
      -Detail $(if ($landedTwo -and $secondSaid -eq 'false') { "$($second.name) carried firstEver=false. The happy toast fires once ever, and this is the line that says the second photo would not raise it." }
      elseif (-not $landedTwo) { 'the second photo never landed' }
      else { "$($second.name) carried firstEver=$secondSaid, so the toast would fire twice for one install" })

    # Project decision: the shell keeps no count of its own.
    $stateLeaf = [string]$protocol.firstDelivery.shellStateLeaf
    $statePath = Join-Path $run.dir $stateLeaf
    $retired = [string]$protocol.firstDelivery.retiredShellStateKey
    if (Test-M4Shell) {
      $stateText = Get-FileText -Path $statePath
      Add-Check -Name "the shell keeps no first-delivery flag of its own" `
        -Status $(if ($stateText -notmatch [regex]::Escape($retired)) { 'pass' } else { 'fail' }) `
        -Detail $(if ($stateText -notmatch [regex]::Escape($retired)) { "$stateLeaf carries no $retired, so the truth about the first photo lives in one place: the ledger, reported on the event" }
        else { "$stateLeaf still carries $retired. Two counts that can disagree, and the disagreement is silent." })
    }
    else {
      Add-Check -Name "the shell keeps no first-delivery flag of its own" -Status 'skip' `
        -Detail "this shell predates M4, and $retired is still its own fact. The migration that deletes it is M4's."
    }
  }
  finally {
    Stop-M4Tray -Session $session -Run $run -Tag 'delivery'
  }
}

# ---------------------------------------------------------------------------
# The run.
# ---------------------------------------------------------------------------

$wanted = if ($Scenario -contains 'all') {
  @('setup', 'doctor', 'delivery', 'window', 'orphan', 'handles')
}
else { @($Scenario) }
$trayWanted = @($wanted | Where-Object { $_ -in @('delivery', 'window', 'orphan', 'handles') })
$windowWanted = @($wanted | Where-Object { $_ -in @('window', 'orphan', 'handles') })

Write-Host ''
Write-Host 'photo-pigeon M4 scenarios' -ForegroundColor White
Write-Host "  scenarios   $($wanted -join ', ')" -ForegroundColor DarkGray

$facts = Resolve-AutostartFacts -Fallback $(if ($null -ne $vocab) { $vocab.autostart } else {
    [pscustomobject]@{ runValueName = ''; bootFlag = ''; nameEnv = ''; shellLogBootMarker = '' }
  }) -Layout $layout -BootFlagOverride $BootFlag -NameEnvOverride $AutostartNameEnv `
  -FallbackSource 'app\e2e\m3-vocabulary.json (fallback)'
$exe = ''
$preExisting = @()

try {
  Write-Step 'Preflight'

  # The witness on the production folder, taken before anything at all runs.
  $script:RealConfigBefore = New-RealConfigWitness
  Add-Check -Name 'the production config directory was photographed before anything launched' -Status 'pass' `
    -Detail $(if ($script:RealConfigBefore.present) { "$($script:RealConfigBefore.entries.Count) entries at $($script:RealConfigDir), names and times only. Nothing in it is ever opened." } else { "$($script:RealConfigDir) does not exist on this machine" })

  $script:RunKeyBefore = Get-RunKeySnapshot
  Add-Check -Name 'the Run key was photographed before anything launched' -Status 'pass' `
    -Detail "$($script:RunKeyBefore.Count) values, none of them ours to change"

  # Watches that were here before us. Nothing in this list is ever stopped, and
  # every one of them has to still be alive at the end.
  $preExisting = @(Get-PigeonWatchProcesses)
  if ($preExisting.Count -gt 0) {
    Add-Check -Name 'a photo-pigeon watch is already running' -Status 'info' `
      -Detail "$((@($preExisting | ForEach-Object { "$($_.name)/$($_.pid)" })) -join ', '). It is never touched, and it must still be running at the end."
  }

  if ($trayWanted.Count -gt 0) {
    Assert-ConfigEnvNameMatchesTheShell -ConfigEnvName $ConfigEnvName -RepoRoot $repoRoot

    $existingTray = @($preExisting | Where-Object { $_.name -eq 'photo-pigeon.exe' })
    if ($existingTray.Count -gt 0 -and -not $AllowExistingTray) {
      foreach ($s in $trayWanted) {
        Add-Check -Name "scenario $s" -Status 'skip' `
          -Detail "a tray is already running (pid $($existingTray[0].pid)), and on this machine that is your installed Photo Pigeon. Quit it from its own menu first, or pass -AllowExistingTray if you know it is another test."
      }
      $wanted = @($wanted | Where-Object { $_ -notin $trayWanted })
      $trayWanted = @()
      $windowWanted = @()
    }
  }

  if ($windowWanted.Count -gt 0 -and -not (Test-M4Shell)) {
    foreach ($s in $windowWanted) {
      Add-Check -Name "scenario $s" -Status 'skip' `
        -Detail 'app\scripts\sidecar-layout.json declares no setup block, so the shell in front of this rig has no first-run window to open. Nothing was launched: an M3 tray pointed at a config path that does not exist spends the next minute respawning a core that cannot read it, and proves nothing on the way.'
    }
    $wanted = @($wanted | Where-Object { $_ -notin $windowWanted })
    $trayWanted = @($trayWanted | Where-Object { $_ -notin $windowWanted })
  }

  if ($trayWanted.Count -gt 0) {
    if (Assert-TrayScenarioIsSafe -Facts $facts) {
      $exe = Resolve-TrayExe -Given $ExePath -RepoRoot $repoRoot
      Assert-ExeIsNotAnInstalledCopy -Exe $exe
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
      'setup' { $null = Invoke-SetupScenario }
      'doctor' { Invoke-DoctorScenario }
      'delivery' { Invoke-DeliveryScenario -Exe $exe }
      'window' { Invoke-WindowScenario -Exe $exe }
      'orphan' { Invoke-OrphanScenario -Exe $exe }
      'handles' { Invoke-HandlesScenario -Exe $exe }
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
        $null = Send-CoreLine -Launched $core -Line 'stop'
        $null = $core.process.WaitForExit(30000)
      }
    }
    catch { }
  }
  foreach ($shell in $script:OpenShells) {
    try { Stop-ShellNow -Launched $shell } catch { }
  }

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
        $removedStray = Remove-StrayRunValueNamingExe -Name $name -Exe $exe
        Add-Check -Name 'the shell honoured the Run value name override' -Status 'fail' `
          -Detail "it wrote a value called '$name' pointing at $exe. $(if ($removedStray) { 'The rig removed it again, because it did not exist before this run and it names a throwaway build.' } else { 'The rig COULD NOT remove it: delete it by hand before the next login.' })"
      }
      elseif (-not (Test-RigRunValueName -Name $name)) {
        Add-Check -Name 'a Run value appeared during this run' -Status 'info' `
          -Detail "$name, which is not ours and was left alone"
      }
    }
  }

  # The last word on the safety question this milestone exists to ask.
  if ($null -ne $script:RealConfigBefore) {
    Assert-RealConfigUntouched -Before $script:RealConfigBefore
  }

  Get-EventSubscriber -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue

  $reportDir = if ($script:RunDirs.Count -gt 0) { Split-Path -Parent $script:RunDirs[0].dir } else { '' }
  if ($reportDir -ne '') {
    $report = [ordered]@{
      startedAt    = $script:StartedAt.ToString('o')
      finishedAt   = (Get-Date).ToString('o')
      milestone    = 'M4'
      scenarios    = $wanted
      exe          = $exe
      autostart    = $facts
      answers      = $script:AnswerLog
      runDirs      = @($script:RunDirs | ForEach-Object { $_.dir })
      measurements = $script:Measurements
      checks       = $script:Checks
      passed       = -not $script:Failed
    }
    $reportPath = Join-Path $reportDir "report-m4-$((Get-Date).ToString('yyyyMMdd-HHmmss')).json"
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
