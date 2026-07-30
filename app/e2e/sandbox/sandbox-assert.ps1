#Requires -Version 5.1
<#
.SYNOPSIS
  What an installed Photo Pigeon has to look like, as functions that answer with
  records instead of writing to a console.

.DESCRIPTION
  This is the half of the Windows Sandbox rig that can be tested without a
  Windows Sandbox. Every function here is pure in the way that matters: it reads
  paths and strings it was handed and returns check records. Nothing here
  installs, launches, kills or deletes anything, and nothing here knows where
  the real machine keeps its things. That is what lets `rig-selftest.ps1` run all
  of it against a fake directory tree under TEMP, on a dev machine where an
  installer must never run.

  `bootstrap.ps1` is the other half: the venue, the install, the uninstall and
  the transcript. It owns every side effect and it refuses to run anywhere but
  inside a sandbox.

  **PowerShell 5.1, deliberately.** Windows Sandbox ships Windows PowerShell and
  no `pwsh`, and downloading one into a disposable VM so that a test can run is a
  dependency the test does not need. So nothing in this file may use PowerShell 7
  syntax, and `rig-common.ps1` cannot be dot-sourced from here: that file
  declares `#Requires -Version 7.0` on its first line and would refuse to load.

  The one thing that wall costs is `Split-PigeonRunValue`, which is a second copy
  of `rig-common.ps1`'s `Split-RunValue`. A second copy of a safety-shaped parser
  is exactly what `rig-common.ps1`'s own header forbids, so this one is held to
  the original by a test rather than by good intentions: `rig-selftest.ps1` runs
  both functions over the same Run value shapes, including the broken ones from
  the M3 blocker note, and fails if they ever disagree about any field.

.NOTES
  Background: docs/TRAY-DESIGN.md section 0 (the frozen names), section 5 (two
  more release rules: the uninstaller never deletes the ledger), section 6 (the
  M5 working plan, rows 12, 13 and 20), and app/e2e/CHECKLIST.md M5.
#>

Set-StrictMode -Version 3.0

# ---------------------------------------------------------------------------
# The frozen list, written down once.
#
# docs/TRAY-DESIGN.md section 0 freezes five machine identifiers and one display
# name, each for its own reason, and every one of them is load bearing for an
# install: the install directory is the display name, the Run value the
# uninstaller deletes is the display name, the exe is a machine name and does not
# follow it, and the shell's own log directory is the bundle identifier.
#
# These are the expectations. Get-PigeonInstallFacts reads what the repository
# actually declares, and Get-PigeonFactsChecks compares the two. The point of
# writing the law down here is that a rename shows up as a failed check in a
# release rig rather than as a surprise in an installer.
# ---------------------------------------------------------------------------

$script:PigeonFrozen = @{
  displayName  = 'Photo Pigeon'
  exeName      = 'photo-pigeon.exe'
  npmName      = 'photo-pigeon'
  identifier   = 'io.github.justerlex.photopigeon'
  sidecarExe   = 'pigeon-core.exe'
  stateDirName = '.photo-pigeon'
  bootFlag     = '--autostart'
}

# The WebView2 runtime's Edge Update client id, read out of the generated
# app/src-tauri/target/release/nsis/x64/installer.nsi (WEBVIEW2APPGUID) rather
# than off the internet. It is here because a venue with no WebView2 runtime and
# no network cannot install this product at all: INSTALLWEBVIEW2MODE is
# downloadBootstrapper, so the installer would try to fetch one and abort.
$script:PigeonWebView2AppGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

function Get-PigeonWebView2AppGuid {
  return $script:PigeonWebView2AppGuid
}

# ---------------------------------------------------------------------------
# Records. The same five-word status vocabulary rig-common.ps1 uses, so a
# transcript out of the sandbox reads like a rig report and not like a second
# language.
# ---------------------------------------------------------------------------

function New-PigeonCheck {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'warn', 'info', 'skip')][string]$Status,
    [string]$Detail = ''
  )
  return [pscustomobject]@{
    name   = $Name
    status = $Status
    detail = $Detail
    at     = (Get-Date).ToString('o')
  }
}

function New-PigeonVerdict {
  param([Parameter(Mandatory)][bool]$Condition, [string]$WhenFalse = 'fail')
  if ($Condition) { return 'pass' }
  return $WhenFalse
}

<#
  How many of a list of records failed. Every caller wants this number and none
  of them should write the filter out again.
#>
function Get-PigeonFailCount {
  param([object[]]$Checks)
  if ($null -eq $Checks) { return 0 }
  return @($Checks | Where-Object { $_.status -eq 'fail' }).Count
}

# ---------------------------------------------------------------------------
# The facts, read off the repository rather than remembered.
# ---------------------------------------------------------------------------

<#
  Everything the sandbox needs to know about the product it is about to install,
  read from the files that own each fact.

  | Fact | Declared in |
  |---|---|
  | display name, exe name, bundle identifier | app/src-tauri/tauri.conf.json |
  | sidecar exe, bundled resources | app/scripts/sidecar-layout.json |
  | Run value name, boot flag | the same file's autostart block |
  | version | the repo root package.json, which is the one version there is |
  | state directory name | src/wizard/paths.ts, CONFIG_DIR_NAME |

  Nothing is defaulted. A file that cannot be read or a field that is missing
  throws here, because a sandbox run that guessed the install directory would
  pass while proving nothing at all.
#>
function Get-PigeonInstallFacts {
  param([Parameter(Mandatory)][string]$RepoRoot)

  $confPath = Join-Path (Join-Path $RepoRoot 'app') 'src-tauri\tauri.conf.json'
  $layoutPath = Join-Path (Join-Path $RepoRoot 'app') 'scripts\sidecar-layout.json'
  $pkgPath = Join-Path $RepoRoot 'package.json'
  $wizardPaths = Join-Path $RepoRoot 'src\wizard\paths.ts'

  foreach ($needed in @($confPath, $layoutPath, $pkgPath, $wizardPaths)) {
    if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) {
      throw "cannot read the install facts: $needed is not there. Is $RepoRoot the repository root?"
    }
  }

  $conf = Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json
  $layout = Get-Content -LiteralPath $layoutPath -Raw | ConvertFrom-Json
  $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json

  # The core's own name for its state directory, out of the file that exports it.
  # A rename that moved the export would land here as a throw rather than as a
  # rig quietly protecting a directory nothing writes to.
  $wizardText = Get-Content -LiteralPath $wizardPaths -Raw
  $stateMatch = [regex]::Match($wizardText, "CONFIG_DIR_NAME\s*=\s*'([^']+)'")
  if (-not $stateMatch.Success) {
    throw "src\wizard\paths.ts no longer exports CONFIG_DIR_NAME as a plain string literal, so the state directory name cannot be read from the file that owns it."
  }

  $productName = [string]$conf.productName
  $mainBinary = [string]$conf.mainBinaryName
  $sidecarName = [string]$layout.sidecarName

  return [pscustomobject]@{
    displayName        = $productName
    exeName            = "$mainBinary.exe"
    npmName            = [string]$pkg.name
    identifier         = [string]$conf.identifier
    sidecarExe         = "$sidecarName.exe"
    resources          = @($layout.bundleResources)
    runValueName       = [string]$layout.autostart.runValueName
    bootFlag           = [string]$layout.autostart.bootFlag
    stateDirName       = $stateMatch.Groups[1].Value
    version            = [string]$pkg.version
    installedLayout    = [string]$layout.resolution.windows.installedLayout
    installerFileName  = "${productName}_$([string]$pkg.version)_x64-setup.exe"
    readAt             = (Get-Date).ToString('o')
    readFrom           = @($confPath, $layoutPath, $pkgPath, $wizardPaths)
  }
}

<#
  The facts against the law.

  Nine checks, and every one of them is a thing that breaks an install rather
  than a tidiness. The two worth naming:

  * `runValueName` must equal the display name. The generated installer.nsi
    uninstalls with `DeleteRegValue HKCU "...\Run" "${PRODUCTNAME}"`, so a value
    written under any other name outlives the uninstall forever, on somebody
    else's machine, pointing at a directory that no longer exists.
  * `installedLayout` is the one sentence in the repository that writes down
    where an installed copy lives. It is a doc string, nothing parses it, and
    that is exactly why it can rot: it said `%LOCALAPPDATA%/photo-pigeon` for a
    day after the display name became "Photo Pigeon" and the install directory
    moved with it. A written-down fact that nothing checks is a written-down
    fact that will be wrong when somebody needs it.
#>
function Get-PigeonFactsChecks {
  param([Parameter(Mandatory)][object]$Facts)

  $frozen = $script:PigeonFrozen
  $checks = New-Object System.Collections.ArrayList

  $pairs = @(
    @{ label = 'the display name'; got = $Facts.displayName; want = $frozen.displayName; why = 'it names the install directory, the Start Menu entry and the Run value' },
    @{ label = 'the exe name'; got = $Facts.exeName; want = $frozen.exeName; why = 'a machine identifier, and it does not follow the display name' },
    @{ label = 'the npm name'; got = $Facts.npmName; want = $frozen.npmName; why = 'the published package, frozen since the first publish' },
    @{ label = 'the bundle identifier'; got = $Facts.identifier; want = $frozen.identifier; why = "it names the shell's own log directory, which is the only thing the uninstaller may delete on request" },
    @{ label = 'the sidecar exe name'; got = $Facts.sidecarExe; want = $frozen.sidecarExe; why = 'the renamed node.exe, staged beside the shell' },
    @{ label = 'the state directory name'; got = $Facts.stateDirName; want = $frozen.stateDirName; why = 'the ledger lives here and no installer may reach it' },
    @{ label = 'the boot flag'; got = $Facts.bootFlag; want = $frozen.bootFlag; why = 'the word the boot path parses' }
  )

  foreach ($pair in $pairs) {
    $ok = ([string]$pair.got -ceq [string]$pair.want)
    $null = $checks.Add((New-PigeonCheck -Name "$($pair.label) is still $($pair.want)" `
          -Status (New-PigeonVerdict -Condition $ok) `
          -Detail $(if ($ok) { $pair.why } else { "the repository says '$($pair.got)'. $($pair.why). Section 0 of TRAY-DESIGN freezes this name." })))
  }

  $sameName = ([string]$Facts.runValueName -ceq [string]$Facts.displayName)
  $null = $checks.Add((New-PigeonCheck -Name 'the Run value name equals the display name' `
        -Status (New-PigeonVerdict -Condition $sameName) `
        -Detail $(if ($sameName) { "both are '$($Facts.displayName)', which is what the uninstaller deletes" } else { "the Run value is '$($Facts.runValueName)' and the display name is '$($Facts.displayName)'. The uninstaller deletes the display name, so this value would outlive the uninstall forever." })))

  $versionOk = ($Facts.version -match '^\d+\.\d+\.\d+')
  $null = $checks.Add((New-PigeonCheck -Name 'the version reads like a version' `
        -Status (New-PigeonVerdict -Condition $versionOk) `
        -Detail "$($Facts.version), from the repo root package.json, which is the one place a version lives"))

  $hasCore = (@($Facts.resources | Where-Object { $_ -like '*core.mjs' }).Count -ge 1)
  $null = $checks.Add((New-PigeonCheck -Name 'the bundled resources include the core' `
        -Status (New-PigeonVerdict -Condition $hasCore) `
        -Detail ((@($Facts.resources)) -join ', ')))

  # The doc string that nothing parses, held to the directory the display name
  # really produces.
  $layoutNames = ([string]$Facts.installedLayout).Contains($Facts.displayName)
  $null = $checks.Add((New-PigeonCheck -Name "the layout file's installed layout names the real install directory" `
        -Status (New-PigeonVerdict -Condition $layoutNames) `
        -Detail $(if ($layoutNames) { [string]$Facts.installedLayout } else { "sidecar-layout.json says '$([string]$Facts.installedLayout)', which does not name '$($Facts.displayName)'. The install directory is `$LOCALAPPDATA\`${PRODUCTNAME} in the generated installer.nsi, so this sentence is the stale one." })))

  return $checks.ToArray()
}

# ---------------------------------------------------------------------------
# The Run value, parsed the way Windows parses it.
# ---------------------------------------------------------------------------

<#
  A second copy of rig-common.ps1's Split-RunValue, and the only reason it exists
  is that this file has to load under Windows PowerShell 5.1 inside a sandbox and
  that one declares 7.0.

  Same fields, same meanings, same reading of the M3 blocker note:

    "C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe" --autostart
     ^ quotes wrap the path only, arguments sit outside the closing quote

  rig-selftest.ps1 runs this function and the original over the same shapes and
  fails if any field disagrees, so the copy cannot drift in silence.
#>
function Split-PigeonRunValue {
  param([Parameter(Mandatory)][string]$Data)

  $raw = $Data
  $trimmed = $Data.Trim()
  if ($trimmed.StartsWith('"')) {
    $close = $trimmed.IndexOf('"', 1)
    if ($close -lt 0) {
      return [pscustomobject]@{
        raw = $raw; quoted = $false; exePath = $trimmed.Substring(1); arguments = '';
        argsOutsideQuotes = $false; note = 'an opening quote with no closing quote'
      }
    }
    return [pscustomobject]@{
      raw               = $raw
      quoted            = $true
      exePath           = $trimmed.Substring(1, $close - 1)
      arguments         = $trimmed.Substring($close + 1).Trim()
      argsOutsideQuotes = $true
      note              = ''
    }
  }

  # Unquoted. Windows splits at the first space, so that is what this reports:
  # not the path the writer meant, the path Windows will really try.
  $space = $trimmed.IndexOf(' ')
  $exe = if ($space -lt 0) { $trimmed } else { $trimmed.Substring(0, $space) }
  $rest = if ($space -lt 0) { '' } else { $trimmed.Substring($space + 1).Trim() }
  return [pscustomobject]@{
    raw               = $raw
    quoted            = $false
    exePath           = $exe
    arguments         = $rest
    argsOutsideQuotes = $false
    note              = 'no quotes at all, so an account name with a space breaks boot silently'
  }
}

<#
  One Run value, raw, and the second copy of a reader for the same reason as the
  parser above: rig-common.ps1's Get-RunValue is behind a 7.0 requirement.

  REG_EXPAND_SZ is deliberately not expanded. The value has to be REG_SZ with an
  already expanded path, and expanding here would hide exactly the mistake the
  assertion exists to catch. rig-selftest.ps1 compares this reader against the
  original over every value in the real Run key, read only, and fails if the two
  ever disagree.
#>
function Get-PigeonRunValue {
  param(
    [Parameter(Mandatory)][string]$Name,
    [string]$SubKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
  )
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if ($null -eq $key) { return $null }
    $raw = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $raw) { return $null }
    return [pscustomobject]@{
      name = $Name
      data = [string]$raw
      kind = [string]$key.GetValueKind($Name)
    }
  }
  catch { return $null }
  finally { if ($null -ne $key) { $key.Dispose() } }
}

<#
  The six promises the M3 blocker note makes about one Run value, as records.

  The install directory contains a space on every machine now
  (`%LOCALAPPDATA%\Photo Pigeon`), so the quoting is load bearing rather than
  prudent, and a sandbox is the only venue where the value can be read on a
  machine whose account name the rig chose.
#>
function Get-PigeonRunValueChecks {
  param(
    [string]$Data,
    [string]$Kind = '',
    [Parameter(Mandatory)][string]$ExpectedExe,
    [Parameter(Mandatory)][string]$ExpectedFlag,
    [string]$Prefix = ''
  )

  $label = if ($Prefix -ne '') { "$Prefix " } else { '' }
  $checks = New-Object System.Collections.ArrayList

  if ([string]::IsNullOrEmpty($Data)) {
    $null = $checks.Add((New-PigeonCheck -Name "${label}the Run value exists" -Status 'fail' `
          -Detail "nothing under HKCU Run. The shell writes it within seconds of a first launch, so an absent value means the launch did not settle autostart at all."))
    return $checks.ToArray()
  }

  $null = $checks.Add((New-PigeonCheck -Name "${label}the Run value exists" -Status 'pass' -Detail $Data))

  $parts = Split-PigeonRunValue -Data $Data

  $null = $checks.Add((New-PigeonCheck -Name "${label}the Run value is QUOTED" `
        -Status (New-PigeonVerdict -Condition $parts.quoted) `
        -Detail $(if ($parts.quoted) { 'quotes wrap the path only' } else { "$($parts.note). Windows would look for $($parts.exePath)." })))

  $null = $checks.Add((New-PigeonCheck -Name "${label}the arguments sit outside the closing quote" `
        -Status (New-PigeonVerdict -Condition ($parts.quoted -and $parts.argsOutsideQuotes)) `
        -Detail "arguments: '$($parts.arguments)'"))

  $null = $checks.Add((New-PigeonCheck -Name "${label}the Run value is REG_SZ with an already expanded path" `
        -Status (New-PigeonVerdict -Condition ($Kind -eq 'String')) `
        -Detail "$Kind. REG_EXPAND_SZ would mean the path still holds a variable."))

  $same = $false
  try {
    $same = ([System.IO.Path]::GetFullPath($parts.exePath)).TrimEnd('\') -ieq ([System.IO.Path]::GetFullPath($ExpectedExe)).TrimEnd('\')
  }
  catch { $same = $false }
  $null = $checks.Add((New-PigeonCheck -Name "${label}the Run value points at the installed exe" `
        -Status (New-PigeonVerdict -Condition $same) `
        -Detail $(if ($same) { $parts.exePath } else { "value says $($parts.exePath), the install says $ExpectedExe" })))

  $null = $checks.Add((New-PigeonCheck -Name "${label}the boot flag in the value is the one the boot path parses" `
        -Status (New-PigeonVerdict -Condition ($parts.arguments.Trim() -eq $ExpectedFlag)) `
        -Detail "value carries '$($parts.arguments.Trim())', the contract says '$ExpectedFlag'"))

  $null = $checks.Add((New-PigeonCheck -Name "${label}the exe the Run value names exists" `
        -Status (New-PigeonVerdict -Condition (Test-Path -LiteralPath $parts.exePath -PathType Leaf)) `
        -Detail $parts.exePath))

  return $checks.ToArray()
}

# ---------------------------------------------------------------------------
# The install shape.
# ---------------------------------------------------------------------------

<#
  Read a shortcut's target without launching it. Returns $null when the shell
  COM object is not available, so a check can say "could not be read" instead of
  "wrong".
#>
function Get-PigeonShortcutTarget {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $shell = New-Object -ComObject WScript.Shell
    return [string]$shell.CreateShortcut($Path).TargetPath
  }
  catch { return $null }
}

<#
  Everything a finished install has to have, and one thing it must not.

  The Desktop row is the interesting one and it is the row only a silent install
  can produce. The generated installer.nsi creates a Desktop shortcut for silent
  and passive installers on purpose, because the finish page that normally offers
  it is skipped; `nsis-hooks.nsh` then deletes it in NSIS_HOOK_POSTINSTALL, which
  runs immediately afterwards. So "no Desktop shortcut after a silent install" is
  a live test of that hook, in the one mode where the hook is the only thing
  standing between this product and an icon on somebody's Desktop.
#>
function Get-PigeonInstallShapeChecks {
  param(
    [Parameter(Mandatory)][object]$Facts,
    [Parameter(Mandatory)][string]$InstallDir,
    [Parameter(Mandatory)][string]$LocalAppData,
    [Parameter(Mandatory)][string]$StartMenuDir,
    [Parameter(Mandatory)][string]$DesktopDir,
    [string]$Prefix = ''
  )

  $label = if ($Prefix -ne '') { "$Prefix " } else { '' }
  $checks = New-Object System.Collections.ArrayList

  $dirThere = Test-Path -LiteralPath $InstallDir -PathType Container
  $null = $checks.Add((New-PigeonCheck -Name "${label}the install directory is there" `
        -Status (New-PigeonVerdict -Condition $dirThere) -Detail $InstallDir))

  # Under LOCALAPPDATA and nowhere else: installMode is currentUser, so an
  # install that reached Program Files asked for elevation on the way, and this
  # product never should.
  $underLocal = $false
  try {
    $full = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $root = [System.IO.Path]::GetFullPath($LocalAppData).TrimEnd('\')
    $underLocal = $full.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase)
  }
  catch { $underLocal = $false }
  $null = $checks.Add((New-PigeonCheck -Name "${label}it is under LOCALAPPDATA, so nothing was elevated" `
        -Status (New-PigeonVerdict -Condition $underLocal) `
        -Detail $(if ($underLocal) { "installMode is currentUser and the install obeyed it" } else { "$InstallDir is not under $LocalAppData. Program Files would mean a UAC prompt a stranger did not expect." })))

  $leafOk = ((Split-Path -Leaf $InstallDir) -ceq $Facts.displayName)
  $null = $checks.Add((New-PigeonCheck -Name "${label}the directory is named for the display name" `
        -Status (New-PigeonVerdict -Condition $leafOk) `
        -Detail "$(Split-Path -Leaf $InstallDir), and the installer builds it as `$LOCALAPPDATA\`${PRODUCTNAME}"))

  # The files, each one named by a contract rather than by a guess.
  $wanted = New-Object System.Collections.ArrayList
  $null = $wanted.Add($Facts.exeName)
  $null = $wanted.Add($Facts.sidecarExe)
  $null = $wanted.Add('uninstall.exe')
  foreach ($resource in @($Facts.resources)) {
    $null = $wanted.Add(($resource -replace '/', '\'))
  }

  foreach ($relative in $wanted) {
    $path = Join-Path $InstallDir $relative
    $there = Test-Path -LiteralPath $path -PathType Leaf
    $size = if ($there) { (Get-Item -LiteralPath $path).Length } else { 0 }
    $null = $checks.Add((New-PigeonCheck -Name "${label}$relative is installed" `
          -Status (New-PigeonVerdict -Condition $there) `
          -Detail $(if ($there) { "$size bytes" } else { "nothing at $path" })))
  }

  # The exe is photo-pigeon.exe and not the M0 spike's photo-pigeon-tray.exe,
  # and nothing else claiming to be a tray came along.
  $stale = @(Get-ChildItem -LiteralPath $InstallDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne $Facts.exeName -and $_.Name -ne $Facts.sidecarExe -and $_.Name -ne 'uninstall.exe' })
  $null = $checks.Add((New-PigeonCheck -Name "${label}no other exe came along" `
        -Status (New-PigeonVerdict -Condition ($stale.Count -eq 0)) `
        -Detail $(if ($stale.Count -eq 0) { "$($Facts.exeName), $($Facts.sidecarExe), uninstall.exe, and nothing else" } else { "also found: $(($stale | ForEach-Object { $_.Name }) -join ', ')" })))

  # The Start Menu shortcut is not decoration: it carries the AppUserModelID,
  # and without it Windows files this product's toasts under whichever process
  # launched it. TRAY-DESIGN sections 1 and 5.
  $lnk = Join-Path $StartMenuDir "$($Facts.displayName).lnk"
  $lnkThere = Test-Path -LiteralPath $lnk -PathType Leaf
  $null = $checks.Add((New-PigeonCheck -Name "${label}the Start Menu shortcut is there" `
        -Status (New-PigeonVerdict -Condition $lnkThere) `
        -Detail $(if ($lnkThere) { $lnk } else { "nothing at $lnk, so toasts would be filed under the launching process" })))

  if ($lnkThere) {
    $target = Get-PigeonShortcutTarget -Path $lnk
    $expected = Join-Path $InstallDir $Facts.exeName
    if ($null -eq $target) {
      $null = $checks.Add((New-PigeonCheck -Name "${label}the shortcut points at the installed exe" -Status 'warn' `
            -Detail 'the shortcut target could not be read on this machine, so the target is unverified rather than wrong'))
    }
    else {
      $pointsRight = ($target.TrimEnd('\') -ieq $expected.TrimEnd('\'))
      $null = $checks.Add((New-PigeonCheck -Name "${label}the shortcut points at the installed exe" `
            -Status (New-PigeonVerdict -Condition $pointsRight) `
            -Detail $(if ($pointsRight) { $target } else { "it points at $target, the install is at $expected" })))
    }
  }

  # And the Desktop stays a work surface.
  $desktopLnk = Join-Path $DesktopDir "$($Facts.displayName).lnk"
  $desktopClean = -not (Test-Path -LiteralPath $desktopLnk)
  $null = $checks.Add((New-PigeonCheck -Name "${label}nothing was left on the Desktop" `
        -Status (New-PigeonVerdict -Condition $desktopClean) `
        -Detail $(if ($desktopClean) { 'a silent install creates one because the finish page is skipped, and NSIS_HOOK_POSTINSTALL deletes it. This is that hook, seen working.' } else { "$desktopLnk survived, so nsis-hooks.nsh did not run or no longer deletes it" })))

  return $checks.ToArray()
}

<#
  What an uninstall has to have taken away, and the one thing it has to have
  left.

  The application data directory is the shell's own log directory,
  `%LOCALAPPDATA%\<bundle identifier>`, and the generated installer.nsi deletes
  it only when the uninstaller's own checkbox was ticked. A silent uninstall
  never shows that page, so the state is unticked and the directory stays. That
  is the default case, and section 3.4 of the M5 checklist is the deliberate
  opposite: a human ticks it on purpose and the ledger still has to survive.
#>
function Get-PigeonRemovalChecks {
  param(
    [Parameter(Mandatory)][object]$Facts,
    [Parameter(Mandatory)][string]$InstallDir,
    [Parameter(Mandatory)][string]$StartMenuDir,
    [Parameter(Mandatory)][string]$DesktopDir,
    [Parameter(Mandatory)][string]$AppDataDir,
    [string]$Prefix = ''
  )

  $label = if ($Prefix -ne '') { "$Prefix " } else { '' }
  $checks = New-Object System.Collections.ArrayList

  $gone = -not (Test-Path -LiteralPath $InstallDir)
  # Assigned rather than taken from an if-expression: PowerShell unrolls an array
  # through one of those, so an empty result would arrive as $null and a single
  # result as a bare string, and .Count would then throw under strict mode.
  $leftovers = @()
  if (-not $gone) {
    $leftovers = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  $null = $checks.Add((New-PigeonCheck -Name "${label}the install directory is gone" `
        -Status (New-PigeonVerdict -Condition $gone) `
        -Detail $(if ($gone) { $InstallDir } else { "$InstallDir survived, holding $($leftovers.Count) item(s): $(($leftovers | Select-Object -First 6) -join ', '). A file still in use cannot be deleted, so a running core is the first suspect." })))

  foreach ($pair in @(
      @{ what = 'Start Menu'; path = (Join-Path $StartMenuDir "$($Facts.displayName).lnk") },
      @{ what = 'Desktop'; path = (Join-Path $DesktopDir "$($Facts.displayName).lnk") }
    )) {
    $clear = -not (Test-Path -LiteralPath $pair.path)
    $null = $checks.Add((New-PigeonCheck -Name "${label}the $($pair.what) shortcut is gone" `
          -Status (New-PigeonVerdict -Condition $clear) -Detail $pair.path))
  }

  $appDataThere = Test-Path -LiteralPath $AppDataDir -PathType Container
  $null = $checks.Add((New-PigeonCheck -Name "${label}the application data directory was left alone" `
        -Status (New-PigeonVerdict -Condition $appDataThere -WhenFalse 'warn') `
        -Detail $(if ($appDataThere) { "$AppDataDir survived, which is the unticked default the ledger law relies on" } else { "$AppDataDir is gone. A silent uninstall leaves the checkbox unticked, so something else deleted it." })))

  return $checks.ToArray()
}

# ---------------------------------------------------------------------------
# The ledger, and the law that no installer may reach it.
# ---------------------------------------------------------------------------

<#
  A witness on the state directory: every file, its size, its last write time
  and the sha256 of its bytes.

  This one reads file CONTENTS, which is why it carries a rail that
  rig-common.ps1's own metadata-only witness does not need. `~/.photo-pigeon`
  holds a real Google token and real credentials, and no test has any reason
  to open either. So: the current user's own state directory may only be read by
  the sandbox account, and on any other machine this throws.

  Nothing else is refused. A fake tree under TEMP is not inside
  `<UserProfile>\.photo-pigeon`, so rig-selftest.ps1 can exercise all of this on
  the dev machine, and it also proves the refusal by pointing it at the real one.
#>
function New-PigeonStateWitness {
  param(
    [Parameter(Mandatory)][string]$StateDir,
    [string]$SandboxAccount = 'WDAGUtilityAccount'
  )

  $real = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.photo-pigeon'
  $full = [System.IO.Path]::GetFullPath($StateDir).TrimEnd('\')
  $realFull = [System.IO.Path]::GetFullPath($real).TrimEnd('\')
  $isReal = ($full -eq $realFull) -or $full.StartsWith("$realFull\", [System.StringComparison]::OrdinalIgnoreCase)

  if ($isReal -and ($env:USERNAME -ne $SandboxAccount)) {
    throw "refusing to hash $StateDir. That is the live state directory on this machine and it holds a Google token. This witness runs inside a sandbox, under $SandboxAccount, and nowhere else."
  }

  $entries = New-Object System.Collections.ArrayList
  if (Test-Path -LiteralPath $StateDir -PathType Container) {
    foreach ($file in @(Get-ChildItem -LiteralPath $StateDir -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      $null = $entries.Add([pscustomobject]@{
          relative = $file.FullName.Substring($StateDir.TrimEnd('\').Length).TrimStart('\')
          length   = $file.Length
          written  = $file.LastWriteTimeUtc.ToString('o')
          sha256   = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        })
    }
  }

  return [pscustomobject]@{
    dir     = $StateDir
    present = (Test-Path -LiteralPath $StateDir -PathType Container)
    entries = @($entries.ToArray() | Sort-Object -Property relative)
    takenAt = (Get-Date).ToString('o')
  }
}

<#
  The ledger law, as three checks: nothing removed, nothing changed, nothing
  added.

  TRAY-DESIGN section 5 says the law holds by construction, because the
  uninstaller's deletions are confined to the install directory, the shortcuts,
  the uninstall keys, the Run value and `%LOCALAPPDATA%\<bundle identifier>`, and
  `~/.photo-pigeon` is in none of them. These checks are the guard on that, not
  the fix. A guard nobody has watched fire is a guard nobody knows works, so the
  marker file this compares is written by hand before the uninstall runs, with
  bytes that have never existed before.
#>
function Get-PigeonStateSurvivalChecks {
  param(
    [Parameter(Mandatory)][object]$Before,
    [Parameter(Mandatory)][object]$After,
    [string]$Prefix = ''
  )

  $label = if ($Prefix -ne '') { "$Prefix " } else { '' }
  $checks = New-Object System.Collections.ArrayList

  $null = $checks.Add((New-PigeonCheck -Name "${label}the state directory is still there" `
        -Status (New-PigeonVerdict -Condition $After.present) `
        -Detail $(if ($After.present) { $After.dir } else { "$($After.dir) is GONE. This is the ledger law broken: the durable record of every delivery ever made, deleted by an uninstaller." })))

  $beforeMap = @{}
  foreach ($entry in @($Before.entries)) { $beforeMap[$entry.relative] = $entry }
  $afterMap = @{}
  foreach ($entry in @($After.entries)) { $afterMap[$entry.relative] = $entry }

  $missing = @($beforeMap.Keys | Where-Object { -not $afterMap.ContainsKey($_) })
  $null = $checks.Add((New-PigeonCheck -Name "${label}every file that was there is still there" `
        -Status (New-PigeonVerdict -Condition ($missing.Count -eq 0)) `
        -Detail $(if ($missing.Count -eq 0) { "$($beforeMap.Keys.Count) file(s), all present" } else { "gone: $($missing -join ', ')" })))

  $changed = @($beforeMap.Keys | Where-Object {
      $afterMap.ContainsKey($_) -and (
        $afterMap[$_].sha256 -ne $beforeMap[$_].sha256 -or
        $afterMap[$_].length -ne $beforeMap[$_].length -or
        $afterMap[$_].written -ne $beforeMap[$_].written
      )
    })
  $null = $checks.Add((New-PigeonCheck -Name "${label}and byte for byte what it was" `
        -Status (New-PigeonVerdict -Condition ($changed.Count -eq 0)) `
        -Detail $(if ($changed.Count -eq 0) { 'same sha256, same size, same last write time, on every file' } else { "changed: $($changed -join ', ')" })))

  $added = @($afterMap.Keys | Where-Object { -not $beforeMap.ContainsKey($_) })
  $null = $checks.Add((New-PigeonCheck -Name "${label}and nothing was added to it" `
        -Status (New-PigeonVerdict -Condition ($added.Count -eq 0) -WhenFalse 'warn') `
        -Detail $(if ($added.Count -eq 0) { 'no installer, uninstaller or launch wrote into the state directory' } else { "new: $($added -join ', ')" })))

  return $checks.ToArray()
}

# ---------------------------------------------------------------------------
# The venue.
# ---------------------------------------------------------------------------

<#
  The rails that stand between this rig and a real machine, as a pure
  function of what it was told about where it is running.

  bootstrap.ps1 installs and uninstalls the real product under the real name.
  Run on the wrong machine it would replace a live install, kill a live tray and
  invite an uninstaller to walk past a real ledger. So four rails, all of which
  have to hold, and every one of them fails closed:

  1. The account is the sandbox account. Windows Sandbox logs in as
     WDAGUtilityAccount, which no interactive session on a real machine uses.
  2. There is no state directory yet. Every configured machine has one, and the
     one machine this must never run on has the ledger it is protecting.
  3. There is no install yet. A fresh sandbox has never seen this product.
  4. The caller said so. The .wsb passes -ConfirmSandbox and a hand at a prompt
     has to type it, which makes an accident require a sentence rather than a
     double click.

  It is a function of its parameters rather than of the machine so that
  rig-selftest.ps1 can run it both ways: once with what a sandbox looks like, and
  once with what a real machine looks like, where every rail must fire.
#>
function Get-PigeonVenueChecks {
  param(
    [string]$UserName = '',
    [bool]$StateDirPresent = $false,
    [bool]$InstallDirPresent = $false,
    [bool]$Confirmed = $false,
    [string]$SandboxAccount = 'WDAGUtilityAccount'
  )

  $checks = New-Object System.Collections.ArrayList

  $isSandboxAccount = ($UserName -eq $SandboxAccount)
  $null = $checks.Add((New-PigeonCheck -Name "the account is $SandboxAccount" `
        -Status (New-PigeonVerdict -Condition $isSandboxAccount) `
        -Detail $(if ($isSandboxAccount) { 'this is a Windows Sandbox session' } else { "the account is '$UserName'. This script installs and uninstalls the real product under the real name, and it runs in a disposable sandbox and nowhere else." })))

  $null = $checks.Add((New-PigeonCheck -Name 'there is no state directory on this machine yet' `
        -Status (New-PigeonVerdict -Condition (-not $StateDirPresent)) `
        -Detail $(if (-not $StateDirPresent) { 'nothing to protect and nothing to lose, which is what makes this venue usable at all' } else { 'a state directory is already here. On the machine this must never run on, that directory is the ledger.' })))

  $null = $checks.Add((New-PigeonCheck -Name 'the product is not installed on this machine yet' `
        -Status (New-PigeonVerdict -Condition (-not $InstallDirPresent)) `
        -Detail $(if (-not $InstallDirPresent) { 'a fresh machine, which is the first row of the install matrix' } else { 'an install is already here, so this is not a fresh machine and the first row cannot be walked' })))

  $null = $checks.Add((New-PigeonCheck -Name 'the caller confirmed the venue' `
        -Status (New-PigeonVerdict -Condition $Confirmed) `
        -Detail $(if ($Confirmed) { '-ConfirmSandbox was passed' } else { 'pass -ConfirmSandbox. The .wsb passes it; a hand has to type it.' })))

  return $checks.ToArray()
}
