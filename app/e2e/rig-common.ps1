#Requires -Version 7.0
<#
.SYNOPSIS
  The rails every photo-pigeon E2E script runs on. Dot-sourced, never executed.

.DESCRIPTION
  This file exists because there are two rig scripts now, run-e2e.ps1 (one
  delivery, end to end) and run-m3.ps1 (the M3 scenarios), and the one thing
  that must never exist twice is the safety rail. A second copy of
  Assert-OutsideRealConfig is a second copy that can drift, and the drifted one
  is the one that will be running on the night it matters.

  So: every helper both scripts need lives here, and both dot-source it.

    . "$PSScriptRoot\rig-common.ps1"

  Dot-sourcing shares scope, so the `$script:` state below belongs to whichever
  script sourced it, and the functions read and write that script's copy. That
  is deliberate: two scripts running at once keep separate check lists.

  What this file promises, and what run-e2e.ps1's header has promised since M2:

  * Nothing here reads or writes ~/.photo-pigeon. Assert-OutsideRealConfig
    refuses any generated path that would land there.
  * Nothing here kills a core. Ever. The shell is stopped, the core reads end of
    file on stdin, and it drains on its own.
  * Nothing here writes to the real Run key. It reads it, it compares it before
    and after, and the only value it may ever delete is one whose name starts
    with the rig prefix below.

.NOTES
  Background: docs/TRAY-DESIGN.md sections 2, 3, 4 and 6.
#>

Set-StrictMode -Version 3.0

# ---------------------------------------------------------------------------
# Result recording. Everything a run learns lands in one list, which becomes
# the console table and report.json. A check is never printed twice and never
# printed only to the console.
# ---------------------------------------------------------------------------

$script:Checks = [System.Collections.Generic.List[object]]::new()
$script:Measurements = [ordered]@{}
$script:Failed = $false
$script:StartedAt = Get-Date

# Set before anything reads them, because strict mode refuses an unassigned
# variable and every one of these is written inside a poll loop.
$script:coreMaxSeen = 0.0
$script:shellMaxSeen = 0.0
$script:kidsFound = @()
$script:landedEntry = $null

function Add-Check {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'warn', 'info', 'skip')][string]$Status,
    [string]$Detail = ''
  )
  $script:Checks.Add([pscustomobject]@{
      name   = $Name
      status = $Status
      detail = $Detail
      at     = (Get-Date).ToString('o')
    })
  if ($Status -eq 'fail') { $script:Failed = $true }

  $mark = switch ($Status) {
    'pass' { 'PASS' }
    'fail' { 'FAIL' }
    'warn' { 'WARN' }
    'skip' { 'SKIP' }
    default { '    ' }
  }
  $colour = switch ($Status) {
    'pass' { 'Green' }
    'fail' { 'Red' }
    'warn' { 'Yellow' }
    'skip' { 'DarkGray' }
    default { 'Gray' }
  }
  $line = if ($Detail -ne '') { "  $mark  $Name : $Detail" } else { "  $mark  $Name" }
  Write-Host $line -ForegroundColor $colour
}

function Write-Step {
  param([Parameter(Mandatory)][string]$Text)
  Write-Host ''
  Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Note {
  param([Parameter(Mandatory)][string]$Text)
  Write-Host "     $Text" -ForegroundColor DarkGray
}

# A safety refusal is not a failed check, it is a stop. Nothing is launched and
# nothing is killed after one of these.
function Stop-Unsafe {
  param([Parameter(Mandatory)][string]$Reason)
  Add-Check -Name 'safety' -Status 'fail' -Detail $Reason
  throw "refusing to run: $Reason"
}

function Write-RigSummary {
  param([string]$RunDir = '')
  $passes = @($script:Checks | Where-Object { $_.status -eq 'pass' }).Count
  $fails = @($script:Checks | Where-Object { $_.status -eq 'fail' }).Count
  $warns = @($script:Checks | Where-Object { $_.status -eq 'warn' }).Count
  $skips = @($script:Checks | Where-Object { $_.status -eq 'skip' }).Count

  Write-Host ''
  Write-Host ('-' * 68) -ForegroundColor DarkGray
  if ($script:Failed) {
    Write-Host "  FAILED   $passes passed, $fails failed, $warns warnings, $skips skipped" -ForegroundColor Red
  }
  else {
    Write-Host "  PASSED   $passes passed, $warns warnings, $skips skipped" -ForegroundColor Green
  }
  if ($RunDir -ne '') { Write-Host "  evidence in $RunDir" -ForegroundColor DarkGray }
  Write-Host ('-' * 68) -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------------------
# Paths that must never be touched.
# ---------------------------------------------------------------------------

$script:RealConfigDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.photo-pigeon'

function Test-InsideRealConfig {
  param([Parameter(Mandatory)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $real = [System.IO.Path]::GetFullPath($script:RealConfigDir).TrimEnd('\')
  return ($full -eq $real) -or $full.StartsWith("$real\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-OutsideRealConfig {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
  if (Test-InsideRealConfig -Path $Path) {
    Stop-Unsafe "$Label resolves inside the production config directory ($Path). The production watch owns that folder."
  }
}

<#
  Stop the shell, and only the shell.

  Its exit closes its end of the sidecar's stdin, which the core reads as end of
  file, which is a stop request it answers with a drain. The core is never
  killed and never signalled, on any path in this rig including this one.
#>
function Stop-ShellNow {
  param([object]$Launched)
  if ($null -eq $Launched) { return }
  try {
    if (-not $Launched.process.HasExited) {
      $null = $Launched.process.CloseMainWindow()
      if (-not $Launched.process.WaitForExit(2000)) { $Launched.process.Kill() }
    }
  }
  catch { }
}

<#
  app/scripts/sidecar-layout.json, or nothing.

  It is the contract file the shell and the bundler both read, and since M3 it
  is also where the shell writes down its autostart facts: the Run value name,
  the boot flag it really parses, and the environment variable that moves the
  value name aside for a test. The rig reads them from there rather than
  guessing, for the same reason it reads the config override name from there.
#>
function Read-LayoutContract {
  param([Parameter(Mandatory)][string]$RepoRoot)
  $layoutPath = Join-Path $RepoRoot 'app\scripts\sidecar-layout.json'
  if (-not (Test-Path -LiteralPath $layoutPath -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $layoutPath -Raw | ConvertFrom-Json) }
  catch { return $null }
}

<#
  The config override only works under the one name the shell reads.

  This is the braces the belt was missing. The shell turns that variable into
  `-c <path>` on the sidecar's command line, and when it is not set the shell
  hands the core no config at all, so the core opens its own default: the real
  one, with the real ledger and the real watched folders. A DEBUG build refuses
  to spawn in that case (paths.rs, config_choice) and a RELEASE build does not,
  and this rig prefers the release build. So a name that never reaches the shell
  is a silent, total loss of the safety rail, and the only symptom is an
  argument that is not on a command line.

  Rather than infer that afterwards, the name is checked against the shell's own
  copy before anything is launched. app/scripts/sidecar-layout.json is where
  paths.rs's env names are written down for exactly this kind of cross check,
  and a drift test in paths.rs holds the two together.
#>
function Assert-ConfigEnvNameMatchesTheShell {
  param(
    [Parameter(Mandatory)][string]$ConfigEnvName,
    [Parameter(Mandatory)][string]$RepoRoot
  )
  $layout = Read-LayoutContract -RepoRoot $RepoRoot
  if ($null -eq $layout) {
    Stop-Unsafe "no readable layout contract at $RepoRoot\app\scripts\sidecar-layout.json, so -ConfigEnvName cannot be checked against the name the shell actually reads."
  }
  $declared = ''
  try { $declared = [string]$layout.env.config } catch { $declared = '' }
  if ([string]::IsNullOrWhiteSpace($declared)) {
    Stop-Unsafe "the layout contract names no config override variable, so there is nothing to check -ConfigEnvName against."
  }
  if ($ConfigEnvName -ne $declared) {
    Stop-Unsafe "-ConfigEnvName is '$ConfigEnvName' and the shell reads '$declared'. Setting the wrong name sets nothing at all, and a tray with no override runs the core against the production config."
  }
  Add-Check -Name 'the config override name is the one the shell reads' -Status 'pass' `
    -Detail "$declared, checked against app\scripts\sidecar-layout.json"
}

# ---------------------------------------------------------------------------
# The Run key. Read freely, delete almost never.
#
# HKCU\...\Run on a real desktop is full of other people's software: on this
# machine eighteen values before photo-pigeon ever asked for one. So the rules
# here are narrow on purpose.
#
#   * The rig NEVER writes a Run value. The shell writes it; the rig reads it
#     back. A rig that writes the value it is about to assert on proves nothing.
#   * The rig may delete exactly one shape of name, the rig-scoped one below,
#     and Remove-RigRunValue refuses anything else by name.
#   * The one exception, guarded twice: a value under the PRODUCT name that did
#     not exist before this run and points at the exe this run launched is ours,
#     it was created because an override was ignored, and leaving it behind
#     would start a throwaway build at every login forever. That one is removed
#     and loudly reported.
#   * A snapshot is taken before anything launches and compared at the end, so
#     "we did not touch anybody else's autostart" is an assertion rather than an
#     intention.
# ---------------------------------------------------------------------------

$script:RunKeySubKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$script:StartupApprovedSubKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$script:RigRunValuePrefix = 'photo-pigeon-e2e-'

function Test-RigRunValueName {
  param([Parameter(Mandatory)][string]$Name)
  return $Name.StartsWith($script:RigRunValuePrefix, [StringComparison]::OrdinalIgnoreCase)
}

<#
  One Run value, raw. REG_EXPAND_SZ is deliberately not expanded: the doc says
  the value must be REG_SZ with an already expanded path, and an expansion here
  would hide exactly the mistake that assertion exists to catch.
#>
function Get-RunValue {
  param([Parameter(Mandatory)][string]$Name)
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:RunKeySubKey, $false)
    if ($null -eq $key) { return $null }
    $raw = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $raw) { return $null }
    $kind = $key.GetValueKind($Name)
    return [pscustomobject]@{
      name = $Name
      data = [string]$raw
      kind = [string]$kind
    }
  }
  catch { return $null }
  finally { if ($null -ne $key) { $key.Dispose() } }
}

function Get-RunKeySnapshot {
  $key = $null
  $out = [ordered]@{}
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:RunKeySubKey, $false)
    if ($null -eq $key) { return $out }
    foreach ($name in $key.GetValueNames()) {
      $out[$name] = [string]$key.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
  }
  catch { }
  finally { if ($null -ne $key) { $key.Dispose() } }
  return $out
}

<#
  Delete one rig-scoped Run value, and its StartupApproved companion.

  The name guard is not a formality. Passing the product name here is how a rig
  turns into the thing that broke the user's startup, so the check is on the
  name and it is unconditional.
#>
function Remove-RigRunValue {
  param([Parameter(Mandatory)][string]$Name)
  if (-not (Test-RigRunValueName -Name $Name)) {
    Stop-Unsafe "refusing to delete the Run value '$Name': this rig may only delete names beginning '$($script:RigRunValuePrefix)'."
  }
  $removed = @()
  foreach ($pair in @(
      @{ sub = $script:RunKeySubKey; label = 'Run' },
      @{ sub = $script:StartupApprovedSubKey; label = 'StartupApproved\Run' }
    )) {
    $key = $null
    try {
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($pair.sub, $true)
      if ($null -eq $key) { continue }
      if ($key.GetValueNames() -contains $Name) {
        $key.DeleteValue($Name, $false)
        $removed += $pair.label
      }
    }
    catch { }
    finally { if ($null -ne $key) { $key.Dispose() } }
  }
  return $removed
}

<#
  Remove a Run value this run created under a name that is not rig-scoped.

  There is exactly one way that happens: a tray was launched with the value-name
  override set, ignored it, and wrote the name the product ships with. The value
  then points at a throwaway build and would start it at every login forever, so
  leaving it behind is not an option and deleting it by name alone is not safe.

  The guard is the DATA, not the name. The value must literally contain the path
  of the exe this run launched, which no other software on the machine can have
  written, and the caller must be able to name that exe.
#>
function Remove-StrayRunValueNamingExe {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Exe)
  if ([string]::IsNullOrWhiteSpace($Exe)) { return $false }
  $value = Get-RunValue -Name $Name
  if ($null -eq $value) { return $false }
  if ($value.data -notmatch [regex]::Escape($Exe)) { return $false }

  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:RunKeySubKey, $true)
    if ($null -eq $key) { return $false }
    $key.DeleteValue($Name, $false)
    return $true
  }
  catch { return $false }
  finally { if ($null -ne $key) { $key.Dispose() } }
}

<#
  Every Run value whose data names a given exe, whatever the value is called.

  Used two ways: to find the installed app's own entry without having to know
  what productName is called this week, and to catch a value this run caused to
  exist under a name nobody expected.
#>
function Find-RunValuesNaming {
  param([Parameter(Mandatory)][string]$Pattern)
  $out = [System.Collections.Generic.List[object]]::new()
  foreach ($pair in (Get-RunKeySnapshot).GetEnumerator()) {
    if (([string]$pair.Value) -match $Pattern) {
      $out.Add((Get-RunValue -Name ([string]$pair.Key)))
    }
  }
  return $out.ToArray()
}

<#
  Rewrite a rig-scoped Run value to something wrong on purpose.

  The only caller is the stale-path scenario, which needs a value that points
  somewhere the exe is not, so the next launch can be asked to notice and repair
  it. Same name guard as the delete, for the same reason.
#>
function Set-RigRunValue {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Data)
  if (-not (Test-RigRunValueName -Name $Name)) {
    Stop-Unsafe "refusing to write the Run value '$Name': this rig may only write names beginning '$($script:RigRunValuePrefix)'."
  }
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:RunKeySubKey, $true)
    if ($null -eq $key) { return $false }
    $key.SetValue($Name, $Data, [Microsoft.Win32.RegistryValueKind]::String)
    return $true
  }
  catch { return $false }
  finally { if ($null -ne $key) { $key.Dispose() } }
}

<#
  Take a Run value apart the way Windows does when it launches it.

  The whole M3 blocker note is about this shape:

    "C:\Users\John Smith\AppData\Local\photo-pigeon\photo-pigeon.exe" --autostart
     ^ quotes wrap the path only, arguments sit outside the closing quote

  Unquoted, Windows parses left to right and looks for C:\Users\John.exe. So
  `quoted` is the headline, and `argsOutsideQuotes` is the other half: quotes
  around the whole line, path and arguments together, is just as broken.
#>
function Split-RunValue {
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
    $exe = $trimmed.Substring(1, $close - 1)
    $rest = $trimmed.Substring($close + 1).Trim()
    return [pscustomobject]@{
      raw               = $raw
      quoted            = $true
      exePath           = $exe
      arguments         = $rest
      argsOutsideQuotes = $true
      note              = ''
    }
  }

  # Unquoted. Windows would split at the first space, so that is what this
  # reports: not the path the writer meant, the path Windows will try.
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
  Every promise the M3 blocker note makes about one Run value, checked against
  the value the shell really wrote.

  It lives here rather than beside the scenario that calls it so that
  rig-selftest.ps1 can run it against a value the rig wrote itself, which is the
  only way to see all six of these pass before an M3 shell exists.
#>
function Assert-RunValueShape {
  param(
    [Parameter(Mandatory)][object]$Value,
    [Parameter(Mandatory)][string]$ExpectedExe,
    [Parameter(Mandatory)][string]$ExpectedFlag,
    [string]$Prefix = ''
  )
  $label = if ($Prefix -ne '') { "$Prefix " } else { '' }
  $parts = Split-RunValue -Data $Value.data

  # The headline. Everything else in this milestone's blocker note is downstream
  # of these two quotes.
  Add-Check -Name "${label}the Run value is QUOTED" -Status $(if ($parts.quoted) { 'pass' } else { 'fail' }) `
    -Detail $(if ($parts.quoted) { 'quotes wrap the path only' } else { "$($parts.note). Windows would look for $($parts.exePath). Value: $($Value.data)" })

  Add-Check -Name "${label}the arguments sit outside the closing quote" `
    -Status $(if ($parts.quoted -and $parts.argsOutsideQuotes) { 'pass' } else { 'fail' }) `
    -Detail "arguments: '$($parts.arguments)'"

  Add-Check -Name "${label}the Run value is REG_SZ with an already expanded path" `
    -Status $(if ($Value.kind -eq 'String') { 'pass' } else { 'fail' }) `
    -Detail "$($Value.kind). REG_EXPAND_SZ would mean the path still holds a variable, and the doc says expanded."

  $same = $false
  try { $same = ([System.IO.Path]::GetFullPath($parts.exePath)).TrimEnd('\') -ieq ([System.IO.Path]::GetFullPath($ExpectedExe)).TrimEnd('\') } catch { $same = $false }
  Add-Check -Name "${label}the Run value points at the exe that wrote it" -Status $(if ($same) { 'pass' } else { 'fail' }) `
    -Detail $(if ($same) { $parts.exePath } else { "value says $($parts.exePath), the running exe is $ExpectedExe" })

  Add-Check -Name "${label}the boot flag in the value is the one the boot path parses" `
    -Status $(if ($parts.arguments.Trim() -eq $ExpectedFlag) { 'pass' } else { 'fail' }) `
    -Detail "value carries '$($parts.arguments.Trim())', the contract says '$ExpectedFlag'"

  Add-Check -Name "${label}the exe the Run value names exists" `
    -Status $(if (Test-Path -LiteralPath $parts.exePath -PathType Leaf) { 'pass' } else { 'fail' }) `
    -Detail $parts.exePath

  return $parts
}

# ---------------------------------------------------------------------------
# PNG generation. A real, valid PNG with bytes that have never existed before,
# so its sha256 cannot collide with anything already in a ledger. Built by hand
# because the point is unique bytes, not a picture.
# ---------------------------------------------------------------------------

$script:Crc32Table = $null

function Get-Crc32Table {
  if ($null -ne $script:Crc32Table) { return $script:Crc32Table }
  $table = New-Object 'System.UInt32[]' 256
  for ($n = 0; $n -lt 256; $n++) {
    [uint32]$c = [uint32]$n
    for ($k = 0; $k -lt 8; $k++) {
      if (($c -band 1) -ne 0) { $c = [uint32](0xEDB88320 -bxor ($c -shr 1)) }
      else { $c = [uint32]($c -shr 1) }
    }
    $table[$n] = $c
  }
  $script:Crc32Table = $table
  return $table
}

function Get-Crc32 {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  $table = Get-Crc32Table
  # [uint32]::MaxValue, not 0xFFFFFFFF: PowerShell reads that literal as the
  # signed int -1 and the cast then refuses it.
  [uint32]$c = [uint32]::MaxValue
  foreach ($b in $Bytes) {
    $idx = [int](($c -bxor [uint32]$b) -band 0xFF)
    $c = [uint32]($table[$idx] -bxor ($c -shr 8))
  }
  return [uint32]($c -bxor [uint32]::MaxValue)
}

function Get-Adler32 {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  [uint32]$a = 1
  [uint32]$b = 0
  foreach ($x in $Bytes) {
    $a = ($a + [uint32]$x) % 65521
    $b = ($b + $a) % 65521
  }
  return [uint32](($b -shl 16) -bor $a)
}

function ConvertTo-BigEndian {
  param([Parameter(Mandatory)][uint32]$Value)
  $bytes = [System.BitConverter]::GetBytes($Value)
  if ([System.BitConverter]::IsLittleEndian) { [Array]::Reverse($bytes) }
  return $bytes
}

function New-PngChunk {
  param([Parameter(Mandatory)][string]$Type, [byte[]]$Data = @())
  $typeBytes = [System.Text.Encoding]::ASCII.GetBytes($Type)
  $body = [byte[]]($typeBytes + $Data)
  return [byte[]]((ConvertTo-BigEndian ([uint32]$Data.Length)) + $body + (ConvertTo-BigEndian (Get-Crc32 -Bytes $body)))
}

<#
  One pixel, eight bit truecolour, a random RGB value and a tEXt chunk holding a
  fresh GUID. Two independent sources of uniqueness, so the file's sha256 is new
  even if the same colour comes up twice.
#>
function New-TestPng {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Marker)

  $signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)

  # bit depth 8, colour type 2 (RGB), deflate, adaptive filter, no interlace
  $ihdr = [byte[]]((ConvertTo-BigEndian ([uint32]1)) + (ConvertTo-BigEndian ([uint32]1)) + [byte[]](8, 2, 0, 0, 0))

  $rgb = New-Object 'byte[]' 3
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($rgb)
  $raw = [byte[]]([byte[]](0) + $rgb)  # filter byte 0, then the pixel

  # zlib stream holding one stored (uncompressed) deflate block. No compressor
  # needed and the result is a legal zlib stream that every decoder accepts.
  $len = [uint16]$raw.Length
  $nlen = [uint16]((-bnot $len) -band 0xFFFF)
  $zlib = [byte[]]([byte[]](0x78, 0x01, 0x01) +
    [System.BitConverter]::GetBytes($len) +
    [System.BitConverter]::GetBytes($nlen) +
    $raw +
    (ConvertTo-BigEndian (Get-Adler32 -Bytes $raw)))

  $text = [byte[]]([System.Text.Encoding]::ASCII.GetBytes('Comment') + [byte[]](0) +
    [System.Text.Encoding]::ASCII.GetBytes($Marker))

  $png = [byte[]]($signature +
    (New-PngChunk -Type 'IHDR' -Data $ihdr) +
    (New-PngChunk -Type 'tEXt' -Data $text) +
    (New-PngChunk -Type 'IDAT' -Data $zlib) +
    (New-PngChunk -Type 'IEND'))

  [System.IO.File]::WriteAllBytes($Path, $png)
  return $png.Length
}

<#
  The same idea at megabyte scale, for the detach scenario.

  A 145 byte PNG is delivered before a script can blink, so it can never be
  "in flight" while something else happens. This one is tens of megabytes of
  random pixels: slow to hash, slow to upload, and impossible to compress, so
  the size on disk is the size on the wire.

  It is built in C# rather than PowerShell because the checksums are per byte
  and 30 million PowerShell loop iterations take minutes. Add-Type compiles once
  per session. If that ever fails the caller is told and falls back to the small
  PNG, with the scenario downgraded rather than silently weakened.
#>
$script:BigPngReady = $null

function Initialize-BigPngWriter {
  if ($null -ne $script:BigPngReady) { return $script:BigPngReady }
  try {
    if (-not ('PigeonPng' -as [type])) {
      Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

public static class PigeonPng
{
    static uint[] table;

    static uint Crc32(byte[] data)
    {
        if (table == null)
        {
            table = new uint[256];
            for (uint n = 0; n < 256; n++)
            {
                uint c = n;
                for (int k = 0; k < 8; k++) c = ((c & 1) != 0) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
                table[n] = c;
            }
        }
        uint crc = 0xFFFFFFFFu;
        for (int i = 0; i < data.Length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFFu;
    }

    static void BeWrite(Stream s, uint v)
    {
        s.WriteByte((byte)(v >> 24));
        s.WriteByte((byte)(v >> 16));
        s.WriteByte((byte)(v >> 8));
        s.WriteByte((byte)v);
    }

    static void Chunk(Stream s, string type, byte[] data)
    {
        byte[] body = new byte[4 + data.Length];
        Encoding.ASCII.GetBytes(type, 0, 4, body, 0);
        Buffer.BlockCopy(data, 0, body, 4, data.Length);
        BeWrite(s, (uint)data.Length);
        s.Write(body, 0, body.Length);
        BeWrite(s, Crc32(body));
    }

    // Random RGB pixels, zlib framed with stored blocks. NoCompression is the
    // point: random bytes do not compress, so spending CPU on them would only
    // make the file take longer to write without making it smaller.
    public static long Write(string path, int width, int height, string marker)
    {
        int stride = 1 + width * 3;
        long total = (long)stride * height;
        if (total <= 0 || total > 512L * 1024L * 1024L)
            throw new ArgumentException("image size out of range for one buffer");

        byte[] raw = new byte[(int)total];
        using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(raw);
        // Filter byte 0 at the head of every scanline: "no filter", which is
        // what keeps the pixels incompressible and the file honest about size.
        for (int y = 0; y < height; y++) raw[y * stride] = 0;

        byte[] zlib;
        using (var ms = new MemoryStream())
        {
            using (var z = new ZLibStream(ms, CompressionLevel.NoCompression, true)) z.Write(raw, 0, raw.Length);
            zlib = ms.ToArray();
        }

        byte[] ihdr = new byte[13];
        ihdr[0] = (byte)(width >> 24); ihdr[1] = (byte)(width >> 16); ihdr[2] = (byte)(width >> 8); ihdr[3] = (byte)width;
        ihdr[4] = (byte)(height >> 24); ihdr[5] = (byte)(height >> 16); ihdr[6] = (byte)(height >> 8); ihdr[7] = (byte)height;
        ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

        byte[] key = Encoding.ASCII.GetBytes("Comment");
        byte[] val = Encoding.ASCII.GetBytes(marker);
        byte[] text = new byte[key.Length + 1 + val.Length];
        Buffer.BlockCopy(key, 0, text, 0, key.Length);
        text[key.Length] = 0;
        Buffer.BlockCopy(val, 0, text, key.Length + 1, val.Length);

        using (var f = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
        {
            f.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
            Chunk(f, "IHDR", ihdr);
            Chunk(f, "tEXt", text);
            Chunk(f, "IDAT", zlib);
            Chunk(f, "IEND", new byte[0]);
            f.Flush(true);
            return f.Length;
        }
    }
}
'@
    }
    $script:BigPngReady = $true
  }
  catch {
    $script:BigPngReady = $false
  }
  return $script:BigPngReady
}

function New-LargeTestPng {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Marker,
    [int]$MegaBytes = 24
  )
  if (-not (Initialize-BigPngWriter)) { return -1 }
  # stride = 1 + width*3. 2000 wide is 6001 bytes a row, so the height falls
  # straight out of the target size.
  $width = 2000
  $stride = 1 + $width * 3
  $height = [int][math]::Max(16, [math]::Round(($MegaBytes * 1MB) / $stride))
  try { return [PigeonPng]::Write($Path, $width, $height, $Marker) }
  catch { return -1 }
}

# ---------------------------------------------------------------------------
# Small helpers.
# ---------------------------------------------------------------------------

function Get-Sha256Hex {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-JsonLines {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $out = [System.Collections.Generic.List[object]]::new()
  # Shared read: the core has this file open and appends to it while we look.
  $stream = $null
  try {
    $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = [System.IO.StreamReader]::new($stream)
    while ($null -ne ($line = $reader.ReadLine())) {
      $trimmed = $line.Trim()
      if ($trimmed -eq '') { continue }
      try { $out.Add(($trimmed | ConvertFrom-Json)) } catch { }
    }
  }
  catch { return @() }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
  return $out.ToArray()
}

function Get-FileTail {
  param([Parameter(Mandatory)][string]$Path, [int]$Lines = 25)
  if (-not (Test-Path -LiteralPath $Path)) { return '(no file)' }
  try {
    return ((Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue) -join "`n")
  }
  catch { return '(unreadable)' }
}

function Get-FileText {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  # Shared read, because the shell has this log open and appends to it.
  $stream = $null
  try {
    $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = [System.IO.StreamReader]::new($stream)
    return $reader.ReadToEnd()
  }
  catch { return '' }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Get-DescendantProcesses {
  param([Parameter(Mandatory)][int]$ParentId, [int]$Depth = 3)
  $found = [System.Collections.Generic.List[object]]::new()
  $frontier = @($ParentId)
  for ($level = 0; $level -lt $Depth -and $frontier.Count -gt 0; $level++) {
    $next = [System.Collections.Generic.List[int]]::new()
    foreach ($id in $frontier) {
      $kids = @()
      try {
        $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue)
      }
      catch { $kids = @() }
      foreach ($kid in $kids) {
        $found.Add([pscustomobject]@{
            pid         = [int]$kid.ProcessId
            name        = [string]$kid.Name
            commandLine = [string]$kid.CommandLine
          })
        $next.Add([int]$kid.ProcessId)
      }
    }
    $frontier = $next.ToArray()
  }
  return $found.ToArray()
}

function Get-ProcessMemory {
  param([Parameter(Mandatory)][int]$Id)
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $null }
  return [pscustomobject]@{
    pid          = $Id
    name         = $p.ProcessName
    workingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 2)
    privateMB    = [math]::Round($p.PrivateMemorySize64 / 1MB, 2)
  }
}

<#
  Every photo-pigeon watch on this machine, found by what it is running rather
  than by reading anything it owns. The production watch on this machine looks
  like `node dist/cli.js watch`, an installed tray sidecar looks like
  pigeon-core.exe, so both shapes are matched. Shells are excluded: these
  scripts live in a folder called photo-pigeon and would otherwise match
  themselves.
#>
function Get-PigeonWatchProcesses {
  $rows = @()
  try {
    $rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $name = [string]$_.Name
        $cmd = [string]$_.CommandLine
        if ($name -match '^(pwsh|powershell|bash|sh|cmd|conhost|WindowsTerminal)\.exe$') { return $false }
        if ($name -in @('photo-pigeon.exe', 'pigeon-core.exe')) { return $true }
        return ($cmd -match '(photo-pigeon|cli\.js|core\.mjs|core\.cjs)') -and ($cmd -match '\bwatch\b')
      })
  }
  catch { $rows = @() }
  return @($rows | ForEach-Object {
      [pscustomobject]@{
        pid         = [int]$_.ProcessId
        name        = [string]$_.Name
        commandLine = [string]$_.CommandLine
      }
    })
}

function Test-ProcessAlive {
  param([Parameter(Mandatory)][int]$Id)
  return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Wait-Until {
  param(
    [Parameter(Mandatory)][scriptblock]$Condition,
    [Parameter(Mandatory)][int]$TimeoutSeconds,
    [int]$PollMs = 500,
    [scriptblock]$EachPoll
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    if ($EachPoll) { & $EachPoll }
    Start-Sleep -Milliseconds $PollMs
  }
  return (& $Condition)
}

# ---------------------------------------------------------------------------
# Where things are.
# ---------------------------------------------------------------------------

function Resolve-TrayExe {
  param([string]$Given, [Parameter(Mandatory)][string]$RepoRoot)
  if ($Given -ne '' -and $null -ne $Given) {
    if (-not (Test-Path -LiteralPath $Given -PathType Leaf)) {
      throw "no photo-pigeon.exe at $Given"
    }
    return (Resolve-Path -LiteralPath $Given).Path
  }
  # Repo builds only. The two install directories used to be on this list, for a
  # machine that had only ever installed, and from M4 that is not something to
  # offer: Assert-ExeIsNotAnInstalledCopy refuses anything under %LOCALAPPDATA%
  # or Program Files before a single window is opened, because that is where the
  # real installed Photo Pigeon on this machine lives and these scenarios post
  # messages at windows and terminate webview hosts. A candidate list that
  # answers "no build here" with the installed tray, only for the guard to abort
  # two steps later, tells
  # somebody less than a list that never offered it: the honest failure names the
  # build command, and building is the actual fix.
  $candidates = @(
    (Join-Path $RepoRoot 'app\src-tauri\target\release\photo-pigeon.exe'),
    (Join-Path $RepoRoot 'app\src-tauri\target\debug\photo-pigeon.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  throw @"
could not find photo-pigeon.exe. Looked in:
  $($candidates -join "`n  ")
Build it first (cd app; npm run build), or pass -ExePath at a build of your own.
An installed copy is never offered and never accepted: that is the real one on
this machine.
"@
}

<#
  The shell's own log. app/src-tauri/src/paths.rs declares
  PHOTO_PIGEON_SHELL_LOG for exactly this, so the rig names the file instead of
  hunting for it. -ShellLog still wins, for looking at a run somebody else
  started.
#>
function Resolve-ShellLog {
  param([string]$Given, [Parameter(Mandatory)][string]$RunDirectory, [string]$Leaf = 'shell.log')
  if (-not [string]::IsNullOrWhiteSpace($Given)) { return $Given }
  return (Join-Path $RunDirectory $Leaf)
}

# ---------------------------------------------------------------------------
# The run directory and the throwaway config.
# ---------------------------------------------------------------------------

function New-RunDirectory {
  param([string]$Tag = '')
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  if ($Tag -ne '') { $stamp = "$stamp-$Tag" }
  $root = Join-Path $env:TEMP 'photo-pigeon-e2e'
  $dir = Join-Path $root $stamp
  if (Test-Path -LiteralPath $dir) { $dir = "$dir-$([System.Guid]::NewGuid().ToString('N').Substring(0,4))" }
  $null = New-Item -ItemType Directory -Path $dir -Force
  return (Resolve-Path -LiteralPath $dir).Path
}

function New-RunConfig {
  param(
    [Parameter(Mandatory)][string]$Dir,
    [string]$CredentialsPath,
    [string]$TokenPath,
    [string]$Album = '',
    [bool]$DryRunConfig = $false
  )

  $watchDir = Join-Path $Dir 'watch'
  $stagingDir = Join-Path $Dir 'staging'
  $null = New-Item -ItemType Directory -Path $watchDir -Force
  $null = New-Item -ItemType Directory -Path $stagingDir -Force

  $configPath = Join-Path $Dir 'config.json'
  $ledgerPath = Join-Path $Dir 'ledger.jsonl'
  $credTarget = Join-Path $Dir 'credentials.json'
  $tokenTarget = Join-Path $Dir 'token.json'

  foreach ($p in @($watchDir, $stagingDir, $configPath, $ledgerPath, $credTarget, $tokenTarget)) {
    Assert-OutsideRealConfig -Path $p -Label 'a generated path'
  }

  # The token is rewritten on every refresh, and quota.json plus albums.json are
  # written beside it. Pointing at the real one would put this run's writes in
  # the production folder and race the production watch's request counter, so
  # both secrets are copied in and removed again when the run ends.
  $copied = $false
  if ($CredentialsPath -ne '' -and $null -ne $CredentialsPath) {
    if (-not (Test-Path -LiteralPath $CredentialsPath -PathType Leaf)) { throw "no credentials file at $CredentialsPath" }
    Copy-Item -LiteralPath $CredentialsPath -Destination $credTarget -Force
    $copied = $true
  }
  if ($TokenPath -ne '' -and $null -ne $TokenPath) {
    if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) { throw "no token file at $TokenPath" }
    Copy-Item -LiteralPath $TokenPath -Destination $tokenTarget -Force
    $copied = $true
  }

  $config = [ordered]@{
    watchDirs       = @($watchDir)
    credentialsPath = $credTarget
    tokenPath       = $tokenTarget
    ledgerPath      = $ledgerPath
    # One extension only. Nothing else in this folder can ever be picked up,
    # not even by accident.
    extensions      = @('.png')
  }
  if ($Album -ne '' -and $null -ne $Album) { $config['albumName'] = $Album }
  if ($DryRunConfig) { $config['dryRun'] = $true }

  $json = ($config | ConvertTo-Json -Depth 5)
  Set-Content -LiteralPath $configPath -Value $json -Encoding utf8NoBOM

  return [pscustomobject]@{
    dir             = $Dir
    configPath      = $configPath
    watchDir        = $watchDir
    stagingDir      = $stagingDir
    ledgerPath      = $ledgerPath
    lockPath        = Join-Path $Dir 'watch.lock'
    logPath         = Join-Path $Dir 'watch.log'
    sideIndexPath   = Join-Path $Dir 'sideindex.jsonl'
    credentialsPath = $credTarget
    tokenPath       = $tokenTarget
    secretsCopied   = $copied
  }
}

<#
  The same shape as New-RunConfig, for a directory somebody else prepared. A
  cold relaunch and a -Stage drop both need it: the config is already on disk
  and the point is to use it again rather than write a new one.
#>
function Resume-RunConfig {
  param([Parameter(Mandatory)][string]$Dir)
  $dir = (Resolve-Path -LiteralPath $Dir).Path
  Assert-OutsideRealConfig -Path $dir -Label 'the run directory'
  return [pscustomobject]@{
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
}

function Remove-RunSecrets {
  param([Parameter(Mandatory)][object]$Run, [bool]$Keep = $false)
  if ($Keep) {
    Add-Check -Name 'secret copies removed' -Status 'warn' -Detail "kept by -KeepSecrets, in $($Run.dir)"
    return
  }
  $removed = @()
  foreach ($p in @($Run.credentialsPath, $Run.tokenPath)) {
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
      $removed += (Split-Path -Leaf $p)
    }
  }
  if ($removed.Count -gt 0) {
    Add-Check -Name 'secret copies removed' -Status 'pass' -Detail ($removed -join ', ')
  }
}

# ---------------------------------------------------------------------------
# Launching.
# ---------------------------------------------------------------------------

function Start-Tray {
  param(
    [Parameter(Mandatory)][object]$Run,
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$ShellLogPath,
    [Parameter(Mandatory)][string]$ConfigEnvName,
    [string]$CoreJs = '',
    [string]$NodeExe = '',
    [string[]]$ExtraArgs = @(),
    [hashtable]$ExtraEnv = @{},
    [string]$StdoutLeaf = 'shell.stdout.log',
    [string]$StderrLeaf = 'shell.stderr.log'
  )

  $stdout = Join-Path $Run.dir $StdoutLeaf
  $stderr = Join-Path $Run.dir $StderrLeaf

  # The child inherits this process's environment block, which is how the
  # overrides reach the tray. Every name here is declared in
  # app/src-tauri/src/paths.rs, and the config one is a parameter so a rename on
  # the tray side costs a flag rather than an edit.
  Set-Item -Path "env:$ConfigEnvName" -Value $Run.configPath
  $env:PHOTO_PIGEON_SHELL_LOG = $ShellLogPath
  if (-not [string]::IsNullOrWhiteSpace($CoreJs)) { $env:PHOTO_PIGEON_CORE_JS = $CoreJs }
  if (-not [string]::IsNullOrWhiteSpace($NodeExe)) { $env:PHOTO_PIGEON_NODE = $NodeExe }
  # M5's updater checks GitHub twenty seconds after launch and then once a day. A
  # rig run is longer than twenty seconds, so without this line every run makes a
  # real request against a repository it has no business touching and leaves a
  # failed check in the log for whoever reads it next. Off by default here and
  # nowhere else in the product: update checks are on by default for real users.
  # Set before $ExtraEnv is applied, so a rig that wants a check on can ask for
  # one by passing this name with any other value.
  $env:PHOTO_PIGEON_UPDATE_CHECK = 'off'
  foreach ($name in $ExtraEnv.Keys) { Set-Item -Path "env:$name" -Value ([string]$ExtraEnv[$name]) }

  $startArgs = @{
    FilePath               = $Exe
    PassThru               = $true
    WindowStyle            = 'Hidden'
    RedirectStandardOutput = $stdout
    RedirectStandardError  = $stderr
  }
  if ($ExtraArgs.Count -gt 0) { $startArgs['ArgumentList'] = $ExtraArgs }

  $proc = Start-Process @startArgs
  return [pscustomobject]@{
    process = $proc
    id      = $proc.Id
    stdout  = $stdout
    stderr  = $stderr
    args    = $ExtraArgs
  }
}

function Start-CoreDirect {
  param(
    [Parameter(Mandatory)][object]$Run,
    [Parameter(Mandatory)][string]$RepoRoot,
    [string]$NdjsonLeaf = 'core.ndjson',
    [string]$StderrLeaf = 'core.stderr.log',
    # The argument vector after dist\cli.js. Empty means the watch vector every
    # caller before M4 wanted. M4's setup channel is the same kind of child over
    # the same kind of pipe, so it gets the same launcher rather than a second
    # one that could drift from it.
    [string[]]$Arguments = @(),
    # Environment for the CHILD only, never for the rig's own process. This is
    # how a setup run gets a sandbox home without the rig having to move its own
    # USERPROFILE out from under itself.
    [hashtable]$ChildEnv = @{}
  )

  $cli = Join-Path $RepoRoot 'dist\cli.js'
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "no built CLI at $cli. Run npm run build in the repo root first."
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if ($null -eq $node) { throw 'node is not on PATH' }

  $ndjson = Join-Path $Run.dir $NdjsonLeaf
  $stderr = Join-Path $Run.dir $StderrLeaf
  Set-Content -LiteralPath $ndjson -Value '' -Encoding utf8NoBOM
  Set-Content -LiteralPath $stderr -Value '' -Encoding utf8NoBOM

  $vector = if ($Arguments.Count -gt 0) { $Arguments } else { @('watch', '--events', 'ndjson', '-c', $Run.configPath) }

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $node.Source
  foreach ($a in (@($cli) + $vector)) { $null = $psi.ArgumentList.Add($a) }
  foreach ($name in $ChildEnv.Keys) { $psi.Environment[[string]$name] = [string]$ChildEnv[$name] }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  $null = $proc.Start()

  # Both pipes are drained by events, so a chatty child can never fill a buffer
  # and block. This is also the capture of the exact stream the tray parses.
  $null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $ndjson -Action {
    if ($null -ne $EventArgs.Data) { Add-Content -LiteralPath $Event.MessageData -Value $EventArgs.Data }
  }
  $null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $stderr -Action {
    if ($null -ne $EventArgs.Data) { Add-Content -LiteralPath $Event.MessageData -Value $EventArgs.Data }
  }
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()

  return [pscustomobject]@{
    process = $proc
    id      = $proc.Id
    ndjson  = $ndjson
    stderr  = $stderr
    args    = $vector
  }
}

<#
  One bare word on the core's stdin, the way the shell writes it.

  The protocol is a line, lower case, no JSON envelope. Nothing here ever
  closes the handle: closing it is end of file, end of file is a stop, and a
  stop nobody asked for is exactly the bug the detach word exists to fix.
  Close-CoreStdin is the separate, deliberate act.
#>
function Send-CoreLine {
  param([Parameter(Mandatory)][object]$Launched, [Parameter(Mandatory)][string]$Line)
  try {
    $Launched.process.StandardInput.WriteLine($Line)
    $Launched.process.StandardInput.Flush()
    return $true
  }
  catch { return $false }
}

<#
  Several words in one write, which is the only way to say two things to a core
  whose queue is about to empty.

  A drain with nothing in it finishes in milliseconds, so `stop` and then
  `detach` four hundred milliseconds later reaches a process that has already
  gone. One flush puts both lines in the pipe together and the core reads them
  out of the same chunk. It compresses the timing and proves the words compose;
  it does not prove anything about a real upload, and the caller says so.
#>
function Send-CoreLines {
  param([Parameter(Mandatory)][object]$Launched, [Parameter(Mandatory)][string[]]$Lines)
  try {
    foreach ($line in $Lines) { $Launched.process.StandardInput.WriteLine($line) }
    $Launched.process.StandardInput.Flush()
    return $true
  }
  catch { return $false }
}

<#
  End of file on the core's stdin: what the shell's own death looks like from
  inside the core. This is how the rig stands in for a shell that has gone.
#>
function Close-CoreStdin {
  param([Parameter(Mandatory)][object]$Launched)
  try { $Launched.process.StandardInput.Close(); return $true }
  catch { return $false }
}

# ---------------------------------------------------------------------------
# The safety assertion that matters most, shared by every script that launches
# a tray: whatever the tray spawned has to be pointed at OUR config.
#
# It returns the sidecar pid. It does not return at all if the answer is wrong:
# it stops the shell first and then refuses, because a rig that notices a core
# on the production config and carries on is a rig nobody should trust.
# ---------------------------------------------------------------------------

function Assert-SidecarOnThrowawayConfig {
  param(
    [Parameter(Mandatory)][object]$Launched,
    [Parameter(Mandatory)][object]$Run,
    [int]$ReadySec = 45,
    [string]$ShellLogPath = ''
  )

  $null = Wait-Until -TimeoutSeconds $ReadySec -Condition {
    # conhost is Windows bookkeeping, not the core.
    $script:kidsFound = @(Get-DescendantProcesses -ParentId $Launched.id |
      Where-Object { $_.name -notlike 'conhost*' -and $_.name -notlike 'WerFault*' })
    return $script:kidsFound.Count -gt 0
  }
  $kids = @($script:kidsFound)

  if ($kids.Count -eq 0) {
    # Nothing to check the override against, and a sidecar that turns up after
    # this point would be one nobody looked at. The shell goes.
    Add-Check -Name 'tray spawned a sidecar' -Status 'fail' `
      -Detail "no child process of pid $($Launched.id) within $ReadySec seconds"
    if ($ShellLogPath -ne '' -and (Test-Path -LiteralPath $ShellLogPath)) {
      Write-Note ('shell log tail: ' + (Get-FileTail -Path $ShellLogPath -Lines 20))
    }
    Write-Note ('shell stderr tail: ' + (Get-FileTail -Path $Launched.stderr -Lines 15))
    Stop-ShellNow -Launched $Launched
    Stop-Unsafe 'the tray spawned nothing this rig could check, so the config override is unproved. The shell was stopped rather than left running to spawn an unwatched sidecar later.'
  }

  # Prefer the child that names our config, so a webview helper can never be
  # mistaken for the core.
  $sidecar = $kids | Where-Object { ([string]$_.commandLine) -match [regex]::Escape($Run.configPath) } |
  Select-Object -First 1
  if ($null -eq $sidecar) {
    $sidecar = $kids | Where-Object { $_.name -notlike 'msedgewebview2*' } | Select-Object -First 1
  }
  if ($null -eq $sidecar) { $sidecar = $kids[0] }
  Add-Check -Name 'tray spawned a sidecar' -Status 'pass' -Detail "$($sidecar.name), pid $($sidecar.pid)"

  $cmd = [string]$sidecar.commandLine
  if ($cmd -ne '' -and ($cmd -match [regex]::Escape($script:RealConfigDir))) {
    # Stop the shell at once. The production watch holds the real lock, so the
    # core would be refused anyway, but a rig that notices this and carries on
    # is a rig nobody should trust.
    Stop-ShellNow -Launched $Launched
    Stop-Unsafe "the sidecar command line names the production config directory: $cmd"
  }

  if ($cmd -match [regex]::Escape($Run.configPath)) {
    Add-Check -Name 'sidecar carries the config override' -Status 'pass' -Detail '-c points at the throwaway config'
  }
  elseif ($cmd -eq '') {
    # The command line could not be read. The lock file is the other proof and
    # it is a good one: only a core that opened OUR config writes a lock beside
    # OUR ledger. No command line and no lock means nothing at all says where
    # this sidecar is pointed, and the run does not continue on nothing.
    $provedByLock = Wait-Until -TimeoutSeconds $ReadySec -Condition {
      Test-Path -LiteralPath $Run.lockPath
    }
    if (-not $provedByLock) {
      Stop-ShellNow -Launched $Launched
      Stop-Unsafe "the sidecar command line could not be read and no lock appeared at $($Run.lockPath) within $ReadySec seconds, so nothing proves this sidecar is on the throwaway config."
    }
    Add-Check -Name 'sidecar carries the config override' -Status 'warn' `
      -Detail "the command line could not be read; the lock at $($Run.lockPath) proves the config instead"
  }
  else {
    # paths.rs turns the override into `-c <path>` on this very command line, so
    # its absence means the override never reached the shell. A shell with no
    # override hands the core no config, and the core then opens its own
    # default: the production one. Only a debug build refuses that, and this rig
    # prefers the release build. So the run stops here instead of spending the
    # next four minutes polling while a core reads and writes the user's real
    # ledger.
    Stop-ShellNow -Launched $Launched
    Stop-Unsafe "the throwaway config is not on the sidecar command line, so the override never reached the shell and this core is on the default config: $cmd"
  }

  return [int]$sidecar.pid
}

# ===========================================================================
# M4. Windows arrive, and with them three things no earlier rig needed: a way
# to open and close one without a hand on the mouse, a way to count what that
# costs, and a much louder version of the M2 question about whether anything
# here can reach the production config.
#
# Everything below is shared rather than living in run-m4.ps1, for the reason
# stated at the top of this file: a second copy of a safety rail is a second
# copy that can drift, and the drifted one is the one that will be running on
# the night it matters.
# ===========================================================================

# ---------------------------------------------------------------------------
# The production config, watched from the outside and never opened.
#
# M2's rail is a refusal: no path this rig generates may resolve inside
# ~/.photo-pigeon. M4 needs a second one, because the setup wizard is the first
# thing this project has ever run that WRITES a config, and the folder it
# writes to is decided by the config flag and by the home directory rather than
# by any path the rig hands it. So the rig also watches the real folder from
# the outside and says afterwards whether anything appeared in it.
#
# The witness records NAMES, SIZES AND TIMES ONLY. Nothing here opens a file in
# that directory: the token and the credentials are the user's Google account
# and a rig has no business reading either, ever.
#
# What it may NOT assert is that the folder is byte for byte unchanged, because
# the machine's own watch is running against it the whole time and is supposed to
# be appending to its ledger and touching its lock. So the assertion is the one
# that is both true and load bearing: nothing was CREATED, nothing was REMOVED,
# and the three files a setup run would write are exactly as they were.
# ---------------------------------------------------------------------------

# The files a setup run writes. If any of these moves, a wizard reached the
# production folder, and that is the failure this witness exists for.
$script:WizardOwnedNames = @('config.json', 'setup.json', 'credentials.json')

function New-RealConfigWitness {
  $out = [ordered]@{}
  if (-not (Test-Path -LiteralPath $script:RealConfigDir -PathType Container)) {
    return [pscustomobject]@{ present = $false; entries = $out }
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $script:RealConfigDir -Force -ErrorAction SilentlyContinue)) {
    $out[$item.Name] = [pscustomobject]@{
      size  = $(if ($item.PSIsContainer) { -1 } else { [int64]$item.Length })
      ticks = [int64]$item.LastWriteTimeUtc.Ticks
    }
  }
  return [pscustomobject]@{ present = $true; entries = $out }
}

function Assert-RealConfigUntouched {
  param([Parameter(Mandatory)][object]$Before)

  $after = New-RealConfigWitness

  if (-not $Before.present -and -not $after.present) {
    Add-Check -Name 'the production config directory is still absent' -Status 'pass' `
      -Detail "$($script:RealConfigDir) did not exist before this run and does not exist now"
    return
  }
  if (-not $Before.present -and $after.present) {
    Add-Check -Name 'nothing in this run created the production config directory' -Status 'fail' `
      -Detail "$($script:RealConfigDir) did not exist before this run and does now. A setup ran against the real home."
    return
  }

  $added = @($after.entries.Keys | Where-Object { -not $Before.entries.Contains($_) })
  $removed = @($Before.entries.Keys | Where-Object { -not $after.entries.Contains($_) })

  Add-Check -Name 'nothing was created or removed in the production config directory' `
    -Status $(if ($added.Count -eq 0 -and $removed.Count -eq 0) { 'pass' } else { 'fail' }) `
    -Detail $(if ($added.Count -eq 0 -and $removed.Count -eq 0) { "$($Before.entries.Count) entries, the same names before and after" }
    else { "added: $($added -join ', '); removed: $($removed -join ', ')" })

  # The three the wizard would write. These are the ones that must not have
  # moved by so much as a byte.
  $moved = @()
  foreach ($name in $script:WizardOwnedNames) {
    if (-not $Before.entries.Contains($name) -or -not $after.entries.Contains($name)) { continue }
    if ($Before.entries[$name].size -ne $after.entries[$name].size -or
      $Before.entries[$name].ticks -ne $after.entries[$name].ticks) {
      $moved += $name
    }
  }
  Add-Check -Name 'no setup ever reached the production config' `
    -Status $(if ($moved.Count -eq 0) { 'pass' } else { 'fail' }) `
    -Detail $(if ($moved.Count -eq 0) { "$($script:WizardOwnedNames -join ', ') are exactly as they were" }
    else { "these were rewritten during the run: $($moved -join ', ')" })

  # Everything else in that folder belongs to the machine's own watch, which is
  # running and is supposed to be writing. Recorded so a reader can see it was
  # looked at, never scored.
  $others = @($Before.entries.Keys | Where-Object {
      $after.entries.Contains($_) -and $_ -notin $script:WizardOwnedNames -and
      ($Before.entries[$_].size -ne $after.entries[$_].size -or $Before.entries[$_].ticks -ne $after.entries[$_].ticks)
    })
  if ($others.Count -gt 0) {
    Add-Check -Name "the machine's own watch carried on working during this run" -Status 'info' `
      -Detail "$($others -join ', ') moved, which is what a live watch does. Nothing in this rig touched them."
  }
}

# ---------------------------------------------------------------------------
# The sandbox home.
#
# The wizard decides where to write from two things: the config path it is
# given, and os.homedir(). The config path is a flag and the rig controls it.
# The home directory is not, and that is the hole: a build whose setup command
# quietly ignores -c writes into the REAL ~/.photo-pigeon, and the only symptom
# is a folder nobody was looking at.
#
# So the rig closes it from the other side too. Node reads USERPROFILE before
# it asks Windows, so a child launched with USERPROFILE pointing into TEMP has
# its home directory in TEMP, and a setup that ignores every flag it was given
# still cannot reach the real folder. Two independent rails, and the run
# refuses to start unless BOTH are proved rather than assumed.
# ---------------------------------------------------------------------------

function New-SandboxHome {
  param([Parameter(Mandatory)][string]$Dir)

  $sandboxHome = Join-Path $Dir 'home'
  $downloads = Join-Path $Dir 'downloads'
  foreach ($p in @($sandboxHome, $downloads)) {
    Assert-OutsideRealConfig -Path $p -Label 'a sandbox path'
    $null = New-Item -ItemType Directory -Path $p -Force
  }
  $resolvedHome = (Resolve-Path -LiteralPath $sandboxHome).Path
  $resolvedDownloads = (Resolve-Path -LiteralPath $downloads).Path

  return [pscustomobject]@{
    home      = $resolvedHome
    downloads = $resolvedDownloads
    # Where a setup that ignored -c entirely would land. Asserted empty at the
    # end of every setup scenario: anything here means the flag did nothing.
    pigeonDir = Join-Path $resolvedHome '.photo-pigeon'
    env       = @{
      USERPROFILE = $resolvedHome
      HOME        = $resolvedHome
      # The wizard's own override for the folders it watches for a downloaded
      # client JSON. Without it the wizard watches the machine's real Downloads,
      # which is a read this rig has no reason to make.
      PHOTO_PIGEON_DOWNLOADS = $resolvedDownloads
    }
  }
}

<#
  The discriminating test, run before anything is launched.

  It asks node the one question that decides whether the second rail is real:
  with this environment, what is your home directory? An answer inside the
  sandbox means a setup that ignores every flag still cannot reach the real
  folder. Any other answer is a stop rather than a warning, because the whole
  point of a second rail is that it holds when the first one has already failed.
#>
function Assert-HomeRedirectWorks {
  param([Parameter(Mandatory)][object]$Sandbox)

  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if ($null -eq $node) { Stop-Unsafe 'node is not on PATH, so the home redirect cannot be proved and no setup may run.' }

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $node.Source
  foreach ($a in @('-p', 'require("os").homedir()')) { $null = $psi.ArgumentList.Add($a) }
  foreach ($name in $Sandbox.env.Keys) { $psi.Environment[[string]$name] = [string]$Sandbox.env[$name] }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  $null = $proc.Start()
  $seen = $proc.StandardOutput.ReadToEnd().Trim()
  $null = $proc.WaitForExit(20000)

  $sameFolder = $false
  try {
    $sameFolder = ([System.IO.Path]::GetFullPath($seen).TrimEnd('\')) -ieq ([System.IO.Path]::GetFullPath($Sandbox.home).TrimEnd('\'))
  }
  catch { $sameFolder = $false }

  if (-not $sameFolder) {
    Stop-Unsafe "a child node process with USERPROFILE set to the sandbox still reports its home directory as '$seen'. The second safety rail does not hold on this machine, so no setup is run: a build that ignored -c would write into this machine's real config folder."
  }
  Add-Check -Name "a child's home directory really is the sandbox" -Status 'pass' `
    -Detail "node reports $seen, so a setup that ignored every flag would still land under TEMP"
}

# ---------------------------------------------------------------------------
# Asking the built CLI what it declares.
#
# --help is the only source of truth about a build worth trusting: a version
# string says what somebody typed, --help says what shipped. This feeds the two
# gates that decide whether an M4 scenario may run at all.
# ---------------------------------------------------------------------------

function Get-CliHelp {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string[]]$Arguments,
    [int]$TimeoutSeconds = 60
  )
  $cli = Join-Path $RepoRoot 'dist\cli.js'
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { return '' }
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if ($null -eq $node) { return '' }

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $node.Source
  foreach ($a in (@($cli) + $Arguments)) { $null = $psi.ArgumentList.Add($a) }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  try {
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $null = $proc.Start()
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    $null = $proc.WaitForExit($TimeoutSeconds * 1000)
    return "$out`n$err"
  }
  catch { return '' }
}

function Test-CliDeclares {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$HelpText, [Parameter(Mandatory)][string]$Marker)
  if ([string]::IsNullOrWhiteSpace($HelpText)) { return $false }
  return $HelpText -match [regex]::Escape($Marker)
}

<#
  Refuse to drive the copy actually installed on this machine.

  Resolve-TrayExe's candidate list has always included the install directories,
  because a machine that has only installed still deserves a runnable rig. From
  M4 that is not good enough: these scenarios open windows, close them by
  posting messages at them, and in one case terminate a webview host on purpose.
  Every one of those is fine against a build out of the repo's target directory
  and none of them is fine against the tray somebody is relying on right now.

  So the exe is checked before anything is launched, and the answer is a stop
  rather than a warning. There is no flag to override it: an installed copy is
  never the right thing for this rig to drive.
#>
function Assert-ExeIsNotAnInstalledCopy {
  param([Parameter(Mandatory)][string]$Exe)

  $full = [System.IO.Path]::GetFullPath($Exe)
  $forbidden = @()
  foreach ($root in @($env:LOCALAPPDATA, $env:PROGRAMFILES, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $forbidden += [System.IO.Path]::GetFullPath($root)
  }
  foreach ($root in $forbidden) {
    if ($full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Unsafe "refusing to drive ${full}: that is an INSTALLED copy, and your installed Photo Pigeon lives there. Build the shell in the repo and point -ExePath at app\src-tauri\target\release\photo-pigeon.exe. This rig also never runs an installer under the product name, for the same reason."
    }
  }
  Add-Check -Name 'the binary under test is a repo build, not an installed copy' -Status 'pass' `
    -Detail "$full. Nothing in this run installs anything, and your installed Photo Pigeon is never launched."
}

# ---------------------------------------------------------------------------
# Windows, opened and closed without a hand on the mouse.
#
# Everything here is read-only about the desktop except Close-AppWindow, which
# posts WM_CLOSE to one window belonging to one process this rig launched. It
# is the same message the X button sends, so what it exercises is the real
# close path rather than a back door built for a test.
# ---------------------------------------------------------------------------

$script:WindowApiReady = $null

function Initialize-WindowApi {
  if ($null -ne $script:WindowApiReady) { return $script:WindowApiReady }
  try {
    if (-not ('PigeonWindows' -as [type])) {
      Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PigeonWindows
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

    const uint WM_CLOSE = 0x0010;

    // Every top level window belonging to one process. Tauri also owns hidden
    // helper windows, so the caller filters on visibility and title rather
    // than this doing it, which keeps the raw list available as evidence.
    public static IntPtr[] TopLevelOf(uint pid)
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumProc callback = delegate(IntPtr hwnd, IntPtr lParam)
        {
            uint windowPid;
            GetWindowThreadProcessId(hwnd, out windowPid);
            if (windowPid == pid) found.Add(hwnd);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return found.ToArray();
    }

    public static string TitleOf(IntPtr hwnd)
    {
        StringBuilder buffer = new StringBuilder(512);
        int n = GetWindowTextW(hwnd, buffer, buffer.Capacity);
        return n > 0 ? buffer.ToString() : "";
    }

    public static bool VisibleOf(IntPtr hwnd) { return IsWindowVisible(hwnd); }
    public static bool Alive(IntPtr hwnd) { return IsWindow(hwnd); }

    // The X button's own message. Not a kill: the app gets to run its close
    // handler, which is exactly the destroy-on-close path being tested.
    public static bool Close(IntPtr hwnd) { return PostMessageW(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
}
'@
    }
    $script:WindowApiReady = $true
  }
  catch {
    $script:WindowApiReady = $false
  }
  return $script:WindowApiReady
}

<#
  Every visible, titled top level window owned by one process.

  Visible and titled together, because Tauri owns message-only and helper
  windows that are neither, and counting those as "a window is open" would make
  the zero-windows-at-idle law unfalsifiable.
#>
function Get-AppWindows {
  param([Parameter(Mandatory)][int]$ProcessId, [switch]$IncludeHidden)
  if (-not (Initialize-WindowApi)) { return @() }
  $out = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [PigeonWindows]::TopLevelOf([uint32]$ProcessId)) {
    $title = [PigeonWindows]::TitleOf($handle)
    $visible = [PigeonWindows]::VisibleOf($handle)
    if (-not $IncludeHidden -and (-not $visible -or [string]::IsNullOrWhiteSpace($title))) { continue }
    $out.Add([pscustomobject]@{ handle = $handle; title = $title; visible = $visible })
  }
  return $out.ToArray()
}

function Close-AppWindow {
  param([Parameter(Mandatory)][System.IntPtr]$Handle)
  if (-not (Initialize-WindowApi)) { return $false }
  return [PigeonWindows]::Close($Handle)
}

function Test-AppWindowAlive {
  param([Parameter(Mandatory)][System.IntPtr]$Handle)
  if (-not (Initialize-WindowApi)) { return $false }
  return [PigeonWindows]::Alive($Handle)
}

<#
  The WebView2 host processes one shell owns.

  Zero of these while no window is open is the whole no-window-at-idle law, and
  it is the number the M2 rig already asserts at idle. M4 asserts it again
  after every close, because that is the only way to tell a window that was
  destroyed from one that was merely hidden.
#>
function Get-WebviewProcesses {
  param([Parameter(Mandatory)][int]$ParentId, [string]$Name = 'msedgewebview2')
  return @(Get-DescendantProcesses -ParentId $ParentId -Depth 4 | Where-Object { $_.name -like "$Name*" })
}

# ---------------------------------------------------------------------------
# Handles and memory.
#
# Private working set rather than working set, which is the number the RAM
# budget is written against. Get-Process cannot report it: PrivateMemorySize64 is private
# BYTES, which is commit rather than resident, and the two differ by half a
# megabyte in the numbers section 6 of TRAY-DESIGN records. The performance
# counter is where the real figure lives, and it is the same source that table
# was built from.
# ---------------------------------------------------------------------------

function Get-HandleCount {
  param([Parameter(Mandatory)][int]$Id)
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $p) { return -1 }
  try { return [int]$p.HandleCount } catch { return -1 }
}

function Get-ProcessMemoryDetail {
  param([Parameter(Mandatory)][int]$Id)
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $null }

  $privateWorkingSet = $null
  try {
    $counter = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=$Id" -ErrorAction SilentlyContinue |
    Select-Object -First 1
    if ($null -ne $counter) { $privateWorkingSet = [math]::Round(([int64]$counter.WorkingSetPrivate) / 1MB, 2) }
  }
  catch { $privateWorkingSet = $null }

  return [pscustomobject]@{
    pid                 = $Id
    name                = $p.ProcessName
    handles             = $(try { [int]$p.HandleCount } catch { -1 })
    workingSetMB        = [math]::Round($p.WorkingSet64 / 1MB, 2)
    privateBytesMB      = [math]::Round($p.PrivateMemorySize64 / 1MB, 2)
    privateWorkingSetMB = $privateWorkingSet
  }
}

<#
  The verdict on a handle count probe. Pure, so rig-selftest can prove it
  before any window exists to run it against.

  The shape of the answer matters more than its height, and this is where that
  is written down. TRAY-DESIGN's own A/B measured what the first window costs:
  the Windows shell and UI stack mapping in, fifty four modules the fresh
  process did not have, paid once and never given back. Scoring that as a leak
  would fail every honest build forever, so the FIRST cycle is recorded as
  evidence and the slope is measured across the cycles after it.

  Baseline is the reading before any window existed. AfterClose is one reading
  per cycle, taken after the window went. AfterOpen is optional and only feeds
  the "the close really gave something back" line.
#>
function Measure-HandleSlope {
  param(
    [Parameter(Mandatory)][int]$Baseline,
    [Parameter(Mandatory)][int[]]$AfterClose,
    [int[]]$AfterOpen = @(),
    [int]$PerCycleTolerance = 12
  )

  $cycles = $AfterClose.Count
  $firstOpenCost = if ($cycles -ge 1) { $AfterClose[0] - $Baseline } else { 0 }

  if ($cycles -lt 2) {
    return [pscustomobject]@{
      cycles        = $cycles
      baseline      = $Baseline
      firstOpenCost = $firstOpenCost
      afterClose    = $AfterClose
      afterOpen     = $AfterOpen
      slope         = 0.0
      settled       = $true
      gaveBack      = $true
      verdict       = 'skip'
      detail        = "only $cycles cycle(s), and a slope needs at least two closes to have a direction"
    }
  }

  $slope = [math]::Round((($AfterClose[$cycles - 1] - $AfterClose[0]) / [double]($cycles - 1)), 2)
  $settled = $slope -le $PerCycleTolerance

  $gaveBack = $true
  if ($AfterOpen.Count -eq $cycles) {
    $gaveBack = $AfterClose[$cycles - 1] -le $AfterOpen[$cycles - 1]
  }

  return [pscustomobject]@{
    cycles        = $cycles
    baseline      = $Baseline
    firstOpenCost = $firstOpenCost
    afterClose    = $AfterClose
    afterOpen     = $AfterOpen
    slope         = $slope
    settled       = $settled
    gaveBack      = $gaveBack
    verdict       = $(if ($settled) { 'pass' } else { 'fail' })
    detail        = "baseline $Baseline, closes $($AfterClose -join ' then '), $slope handles per cycle after the first, tolerance $PerCycleTolerance. The first open cost $firstOpenCost and is not counted: that is the Windows UI stack mapping in, paid once."
  }
}

<#
  Which answer this rig gives to one question the wizard asked. Pure, so the
  scripting can be proved before a setup channel exists to be scripted.

  Rules are tried in order and the first match wins, which is why the two
  catch-alls at the end of m4-protocol.json are last. A confirm nobody wrote a
  rule for takes the question's own default, which is what a user pressing
  Enter does; an input nobody wrote a rule for answers empty. Both are reported
  as having fallen through, so a run that answered a question by accident can
  be read afterwards rather than trusted.
#>
function Resolve-AnswerForAsk {
  param(
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Message,
    # The ask's stable name, when the build emits one. Matched before the prose,
    # because a name is chosen and a prompt is something somebody may reword.
    [AllowEmptyString()][string]$Name = '',
    [object]$Default = $null,
    # AllowEmptyCollection because "no rules at all" is a real state and the
    # answer to it is written below: a run that hangs on an unanswered question
    # is worse than one that answers with the question's own default.
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rules,
    [hashtable]$Tokens = @{}
  )

  for ($i = 0; $i -lt $Rules.Count; $i++) {
    $rule = $Rules[$i]
    $ruleKind = 'any'
    if ($rule.PSObject.Properties.Name -contains 'kind') { $ruleKind = [string]$rule.kind }
    if ($ruleKind -ne 'any' -and $ruleKind -ne $Kind) { continue }

    $ruleName = ''
    if ($rule.PSObject.Properties.Name -contains 'name') { $ruleName = [string]$rule.name }
    $pattern = [string]$rule.match

    # The name wins when both sides have one. Otherwise the prose decides, which
    # is what answers a build whose asks carry no name at all.
    $matched = $false
    if ($ruleName -ne '' -and $Name -ne '') { $matched = ($ruleName -eq $Name) }
    else { $matched = ($Message -match $pattern) }
    if (-not $matched) { continue }

    $why = ''
    if ($rule.PSObject.Properties.Name -contains '$why') { $why = [string]$rule.'$why' }

    $raw = $rule.value
    $value = $raw
    if ($raw -is [string]) {
      if ($raw -eq '{default}') {
        $value = $Default
      }
      else {
        $text = [string]$raw
        foreach ($token in $Tokens.Keys) { $text = $text.Replace("{$token}", [string]$Tokens[$token]) }
        $value = $text
      }
    }

    return [pscustomobject]@{
      value       = $value
      ruleIndex   = $i
      pattern     = $pattern
      matchedName = ($ruleName -ne '' -and $Name -ne '')
      why         = $why
      # A rule reached through its NAME is never a fall-through, even when its
      # pattern happens to be the catch-all: the name is an exact match on an
      # identifier the wizard chose.
      fellThrough = (($pattern -eq '.*') -and -not ($ruleName -ne '' -and $Name -ne ''))
    }
  }

  # No rule at all, not even a catch-all. Still answered, because a setup that
  # sits forever on an unanswered question proves nothing about anything.
  return [pscustomobject]@{
    value       = $(if ($Kind -eq 'confirm') { if ($null -ne $Default) { $Default } else { $true } } else { '' })
    ruleIndex   = -1
    pattern     = ''
    why         = 'no rule matched, so the answer is the question default'
    fellThrough = $true
  }
}

# ---------------------------------------------------------------------------
# Credentials that are not anybody's.
#
# This repo ships zero credentials and that is a law, not a habit. The files
# below are REAL in shape, because the wizard parses them and refuses anything
# that is not, and they are not credentials: the id and the secret are literal
# strings naming this rig, they authorise nothing anywhere, and nothing that
# uses them reaches a network at all.
# ---------------------------------------------------------------------------

function New-SyntheticClientJson {
  param([Parameter(Mandatory)][string]$Path, [string]$ProjectId = 'photo-pigeon-e2e')
  Assert-OutsideRealConfig -Path $Path -Label 'a synthetic client JSON'
  $body = [ordered]@{
    installed = [ordered]@{
      client_id     = 'photo-pigeon-e2e-not-a-real-client.apps.googleusercontent.com'
      project_id    = $ProjectId
      client_secret = 'photo-pigeon-e2e-not-a-real-secret'
      redirect_uris = @('http://localhost')
      auth_uri      = 'https://accounts.google.com/o/oauth2/auth'
      token_uri     = 'https://oauth2.googleapis.com/token'
    }
  }
  Set-Content -LiteralPath $Path -Value ($body | ConvertTo-Json -Depth 5) -Encoding utf8NoBOM
  return $Path
}

function New-SyntheticToken {
  param([Parameter(Mandatory)][string]$Path)
  Assert-OutsideRealConfig -Path $Path -Label 'a synthetic token'
  $body = [ordered]@{
    refresh_token = 'photo-pigeon-e2e-not-a-real-refresh-token'
    expiry_date   = [int64]([DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeMilliseconds())
  }
  Set-Content -LiteralPath $Path -Value ($body | ConvertTo-Json -Depth 5) -Encoding utf8NoBOM
  return $Path
}

# ---------------------------------------------------------------------------
# Reading an NDJSON stream, and driving the setup channel over it.
#
# The driver lives here rather than in run-m4.ps1 for one reason: it can be
# tested. app\e2e\fake-setup.mjs speaks the ask protocol and nothing else, so
# rig-selftest.ps1 drives the whole loop, including the re-ask and the dead-id
# paths, without an M4 core existing. The alternative was a scenario whose code
# first runs on the night the milestone lands, which is the pattern every review
# from M0 to M3 has named.
# ---------------------------------------------------------------------------

function Get-CoreEvents {
  param([Parameter(Mandatory)][object]$Launched, [string[]]$OfType = @())
  $events = @(Read-JsonLines -Path $Launched.ndjson)
  if ($OfType.Count -eq 0) { return $events }
  return @($events | Where-Object {
      ($_.PSObject.Properties.Name -contains 'type') -and ($OfType -contains [string]$_.type)
    })
}

function Get-CoreEventTypes {
  param([Parameter(Mandatory)][object]$Launched)
  $events = @(Read-JsonLines -Path $Launched.ndjson)
  return @($events | Where-Object { $_.PSObject.Properties.Name -contains 'type' } | ForEach-Object { [string]$_.type })
}

<#
  One field off an object, or $null. Strict mode refuses a property that is not
  there, and an event stream whose shape is still being written is exactly where
  that happens.
#>
function Get-FieldOrNull {
  param([Parameter(Mandatory)][object]$Object, [Parameter(Mandatory)][string]$Name)
  if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
  return $null
}

<#
  Answer one ask, and write down why that answer was given.

  Every answer is recorded, including the ones that fell through to a catch-all,
  because a run that answered a question it did not recognise still finished and
  is still green, and the only way to know that happened is to look.
#>
function Send-ScriptedAnswer {
  param(
    [Parameter(Mandatory)][object]$Launched,
    [Parameter(Mandatory)][object]$Ask,
    [Parameter(Mandatory)][object]$Protocol,
    [hashtable]$Tokens = @{}
  )
  $fields = $Protocol.askFields
  $id = [string](Get-FieldOrNull -Object $Ask -Name ([string]$fields.id))
  $kind = [string](Get-FieldOrNull -Object $Ask -Name ([string]$fields.kind))
  $name = [string](Get-FieldOrNull -Object $Ask -Name ([string]$fields.name))
  $default = Get-FieldOrNull -Object $Ask -Name ([string]$fields.default)

  # The prose lives on `prompt`, and on `message` in the shape this file
  # guessed before the protocol existed. Reading both costs one line.
  $message = [string](Get-FieldOrNull -Object $Ask -Name ([string]$fields.message))
  if ([string]::IsNullOrWhiteSpace($message) -and ($fields.PSObject.Properties.Name -contains 'messageFallback')) {
    $message = [string](Get-FieldOrNull -Object $Ask -Name ([string]$fields.messageFallback))
  }
  if ([string]::IsNullOrWhiteSpace($kind)) { $kind = [string]$fields.inputKind }

  $answer = Resolve-AnswerForAsk -Kind $kind -Message $message -Name $name -Default $default `
    -Rules @($Protocol.answerScript.rules) -Tokens $Tokens

  # The one payload-carrying form M4 is allowed to add, and it is a form rather
  # than a seventh word. Which shape, is the protocol file's to say: two were
  # written for M4 and the shipped core reads the object one.
  #
  #     object       answer {"id":"<ask id>","value":<json value>}
  #     idThenValue  answer <ask id> <json value>
  #
  # Everything goes through ConvertTo-Json rather than being interpolated,
  # because the payload is where a Windows path lives and C:\Users\casey is not a
  # JSON string until its backslashes are doubled.
  $form = [string](Get-FieldOrNull -Object $Protocol.setup -Name 'answerForm')
  if ([string]::IsNullOrWhiteSpace($form)) { $form = 'object' }
  if ($form -eq 'idThenValue') {
    $encoded = $answer.value | ConvertTo-Json -Compress
    $line = "$($Protocol.setup.answerWord) $id $encoded"
  }
  else {
    $idField = [string](Get-FieldOrNull -Object $Protocol.setup -Name 'answerIdField')
    if ([string]::IsNullOrWhiteSpace($idField)) { $idField = 'id' }
    $valueField = [string](Get-FieldOrNull -Object $Protocol.setup -Name 'answerValueField')
    if ([string]::IsNullOrWhiteSpace($valueField)) { $valueField = 'value' }
    $payload = [ordered]@{}
    $payload[$idField] = $id
    $payload[$valueField] = $answer.value
    $encoded = $payload | ConvertTo-Json -Compress
    $line = "$($Protocol.setup.answerWord) $encoded"
  }
  $sent = Send-CoreLine -Launched $Launched -Line $line

  return [pscustomobject]@{
    id          = $id
    name        = $name
    kind        = $kind
    message     = $message
    value       = $answer.value
    matchedName = $answer.matchedName
    fellThrough = $answer.fellThrough
    why         = $answer.why
    sent        = $sent
    line        = $line
  }
}

<#
  The sentence a refusal carries, whichever field this build puts it in.

  Two M4 protocols spelled it differently, `detail` and `error`, and a report
  that prints an empty string where the core's own explanation should be is
  worse than one that prints nothing at all: it looks like the core said
  nothing.
#>
function Get-RefusalSentence {
  param([Parameter(Mandatory)][object]$Refusal, [Parameter(Mandatory)][object]$Protocol)
  $fields = $Protocol.refusedFields
  $text = [string](Get-FieldOrNull -Object $Refusal -Name ([string]$fields.detail))
  if ([string]::IsNullOrWhiteSpace($text)) {
    $fallback = [string](Get-FieldOrNull -Object $fields -Name 'detailFallback')
    if (-not [string]::IsNullOrWhiteSpace($fallback)) {
      $text = [string](Get-FieldOrNull -Object $Refusal -Name $fallback)
    }
  }
  return $text
}

<#
  Drive a setup channel from its first ask to a written config.

  Stops on the first of: a written event, the config file appearing, a failed
  event, the process exiting, or the timeout. The config file appearing is
  deliberately one of them, because it is the one signal that does not depend on
  an event name being spelled the way this rig guessed.

  THE SUBTLE PART, and the reason this is a function with a test rather than a
  loop inside a scenario: what happens when an answer is refused.

  A refused answer produces `answer-refused` and the question STAYS LIVE. It is
  not re-asked. So a driver that answers each ask once and then waits for the
  next one waits forever, and both programs are behaving correctly while it
  does. The other plausible shape, a re-ask carrying the same id and an `error`,
  has the same cure, so this reads both:

    signals(id) = asks seen for that id + refusals seen naming that id
    answer again while attempts(id) < signals(id), up to maxAttemptsPerAsk

  The cap is not decoration. Without it a genuinely invalid answer, which is
  what a wrong rule in the answer script produces, becomes an infinite exchange
  between two correct programs. With it the run ends and the refusal's own
  sentence is in the report.
#>
function Invoke-SetupChannel {
  param(
    [Parameter(Mandatory)][object]$Launched,
    [Parameter(Mandatory)][object]$Protocol,
    [Parameter(Mandatory)][string]$ConfigPath,
    [hashtable]$Tokens = @{},
    [int]$TimeoutSeconds = 180,
    [scriptblock]$OnAnswer = $null
  )

  $askTypes = @($Protocol.events.ask)
  $writtenTypes = @($Protocol.events.written)
  $failedTypes = @($Protocol.events.failed)
  $refusedTypes = @($Protocol.events.refused)
  $idField = [string]$Protocol.askFields.id
  $refusedIdField = [string]$Protocol.refusedFields.id
  $maxAttempts = [int]$Protocol.setup.maxAttemptsPerAsk
  if ($maxAttempts -lt 1) { $maxAttempts = 3 }

  $answers = [System.Collections.Generic.List[object]]::new()
  $refusals = [System.Collections.Generic.List[object]]::new()
  $attempts = @{}
  $exhausted = @{}
  $reachedWritten = $false
  $writtenEvent = $null
  $failure = $null
  $timedOut = $true

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Launched.process.HasExited) { $timedOut = $false; break }

    $written = @(Get-CoreEvents -Launched $Launched -OfType $writtenTypes)
    if ($written.Count -gt 0) {
      $reachedWritten = $true
      $writtenEvent = $written[-1]
      $timedOut = $false
      break
    }
    $failures = @(Get-CoreEvents -Launched $Launched -OfType $failedTypes)
    if ($failures.Count -gt 0) {
      $failure = [string](Get-FieldOrNull -Object $failures[-1] -Name 'error')
      $timedOut = $false
      break
    }
    if (Test-Path -LiteralPath $ConfigPath) { $timedOut = $false; break }

    # Every refusal on the stream, so a question that was answered and pushed
    # back can be answered again. Refusals with no id belong to a line that was
    # not an answer at all and are recorded rather than acted on.
    # A receipt is not a refusal. The shipped core says both on one event type
    # and tells them apart with `accepted`, so counting an accepted answer as a
    # refusal makes the driver answer a question that is already closed, get
    # that refused, answer again, and burn the attempt cap on a run that was
    # going perfectly well.
    $acceptedField = [string](Get-FieldOrNull -Object $Protocol.refusedFields -Name 'accepted')
    $refusalsNow = @(Get-CoreEvents -Launched $Launched -OfType $refusedTypes | Where-Object {
        if ([string]::IsNullOrWhiteSpace($acceptedField)) { return $true }
        $verdict = Get-FieldOrNull -Object $_ -Name $acceptedField
        return ($verdict -ne $true)
      })
    $refusalCount = @{}
    foreach ($refusal in $refusalsNow) {
      $rid = [string](Get-FieldOrNull -Object $refusal -Name $refusedIdField)
      if ([string]::IsNullOrWhiteSpace($rid)) { continue }
      $refusalCount[$rid] = 1 + $(if ($refusalCount.ContainsKey($rid)) { $refusalCount[$rid] } else { 0 })
    }
    $refusals.Clear()
    foreach ($refusal in $refusalsNow) { $refusals.Add($refusal) }

    $askCount = @{}
    $latestAsk = @{}
    foreach ($ask in @(Get-CoreEvents -Launched $Launched -OfType $askTypes)) {
      $id = [string](Get-FieldOrNull -Object $ask -Name $idField)
      $askCount[$id] = 1 + $(if ($askCount.ContainsKey($id)) { $askCount[$id] } else { 0 })
      $latestAsk[$id] = $ask
    }

    foreach ($id in $latestAsk.Keys) {
      $made = $(if ($attempts.ContainsKey($id)) { $attempts[$id] } else { 0 })
      # How many times this question has really been PUT, which is not the same
      # as how many events mention it.
      #
      # The two M4 protocols differ here and the difference is a bug rather than
      # a preference. Where a refusal only refuses, the question is put once and
      # each refusal puts it again, so the count is asks plus refusals. Where a
      # refusal ALSO re-asks, which is what the shipped core does, that same sum
      # counts every refusal twice: once as the refusal event and once as the
      # re-ask it arrived with. The driver then answers a question that is
      # already closed, gets that refused as an unknown ask, answers again, and
      # burns the attempt cap on a walk that was going perfectly well.
      #
      # The maximum is right under both, and needs no flag that could drift from
      # the core: a re-asking build says it with the asks (2 asks, 1 refusal), a
      # non-re-asking one says it with the refusals (1 ask, 1 refusal), and both
      # mean the question has been put twice.
      $refused = $(if ($refusalCount.ContainsKey($id)) { $refusalCount[$id] } else { 0 })
      $signals = [Math]::Max([int]$askCount[$id], [int]$refused + 1)
      if ($made -ge $signals) { continue }
      if ($made -ge $maxAttempts) {
        if (-not $exhausted.ContainsKey($id)) { $exhausted[$id] = $true }
        continue
      }

      $record = Send-ScriptedAnswer -Launched $Launched -Ask $latestAsk[$id] -Protocol $Protocol -Tokens $Tokens
      $attempts[$id] = $made + 1
      $answers.Add($record)
      if ($null -ne $OnAnswer) { & $OnAnswer $record }
    }
    Start-Sleep -Milliseconds 250
  }

  return [pscustomobject]@{
    asked          = $answers.Count
    questions      = $attempts.Count
    answers        = $answers.ToArray()
    refusals       = $refusals.ToArray()
    exhausted      = @($exhausted.Keys)
    reachedWritten = $reachedWritten
    writtenEvent   = $writtenEvent
    failure        = $failure
    timedOut       = $timedOut
    wroteConfig    = (Test-Path -LiteralPath $ConfigPath -PathType Leaf)
  }
}

# ---------------------------------------------------------------------------
# The tray rail, moved here at M4.
#
# Every one of these came out of run-m3.ps1 with its behaviour unchanged,
# because run-m4.ps1 needs the same rail and this file's whole reason to exist
# is that a rail must have exactly one copy. The implicit dependencies run-m3
# had on its own script scope are parameters now, so a caller says what it
# means rather than relying on a variable happening to be in scope.
# ---------------------------------------------------------------------------

<#
  The autostart facts, preferring the shell's own contract file over a rig's
  fallback. The shell is held against sidecar-layout.json by a drift test, and
  nothing holds a rig's copy to anything, so the shell's copy wins whenever it
  exists.
#>
function Resolve-AutostartFacts {
  param(
    [Parameter(Mandatory)][object]$Fallback,
    [object]$Layout = $null,
    [string]$BootFlagOverride = '',
    [string]$NameEnvOverride = '',
    [string]$FallbackSource = 'the rig fallback'
  )

  $name = [string]$Fallback.runValueName
  $flag = [string]$Fallback.bootFlag
  $nameEnv = [string]$Fallback.nameEnv
  $marker = [string]$Fallback.shellLogBootMarker
  $source = $FallbackSource

  if ($null -ne $Layout -and ($Layout.PSObject.Properties.Name -contains 'autostart')) {
    $declared = $Layout.autostart
    $source = 'app\scripts\sidecar-layout.json'
    if ($declared.PSObject.Properties.Name -contains 'runValueName' -and -not [string]::IsNullOrWhiteSpace([string]$declared.runValueName)) {
      $name = [string]$declared.runValueName
    }
    if ($declared.PSObject.Properties.Name -contains 'bootFlag' -and -not [string]::IsNullOrWhiteSpace([string]$declared.bootFlag)) {
      $flag = [string]$declared.bootFlag
    }
    if ($declared.PSObject.Properties.Name -contains 'nameEnv' -and -not [string]::IsNullOrWhiteSpace([string]$declared.nameEnv)) {
      $nameEnv = [string]$declared.nameEnv
    }
    if ($declared.PSObject.Properties.Name -contains 'shellLogBootMarker' -and -not [string]::IsNullOrWhiteSpace([string]$declared.shellLogBootMarker)) {
      $marker = [string]$declared.shellLogBootMarker
    }
  }
  elseif ($null -ne $Layout -and ($Layout.PSObject.Properties.Name -contains 'env') -and
    ($Layout.env.PSObject.Properties.Name -contains 'autostartName')) {
    # A shell that declared only the environment name, which is the one fact
    # the tray scenarios cannot proceed without.
    $nameEnv = [string]$Layout.env.autostartName
    $source = 'app\scripts\sidecar-layout.json (env.autostartName) plus the rig fallback'
  }

  # Explicit flags beat every file. This is the escape hatch for the day the
  # contracts disagree and somebody has to prove which one is right.
  if (-not [string]::IsNullOrWhiteSpace($BootFlagOverride)) { $flag = $BootFlagOverride; $source = "$source, boot flag overridden on the command line" }
  if (-not [string]::IsNullOrWhiteSpace($NameEnvOverride)) { $nameEnv = $NameEnvOverride; $source = "$source, name variable overridden on the command line" }

  return [pscustomobject]@{
    runValueName = $name
    bootFlag     = $flag
    nameEnv      = $nameEnv
    logMarker    = $marker
    source       = $source
  }
}

<#
  The gate every tray scenario passes through.

  The refusal is the point. A tray launched without the value-name override
  writes the PRODUCTION Run value name, pointing at a throwaway build, on the
  machine running the rig, and it would start at the next login there. So the rig checks
  that the shell declares the override before it launches anything, rather than
  looking at the damage afterwards.
#>
function Assert-TrayScenarioIsSafe {
  param([Parameter(Mandatory)][object]$Facts)

  if ([string]::IsNullOrWhiteSpace($Facts.nameEnv)) {
    Add-Check -Name 'the shell declares a Run value name override' -Status 'skip' `
      -Detail 'no autostart.nameEnv in app\scripts\sidecar-layout.json and none passed on the command line, so this rig will not launch a tray that might write the production Run value name. Declare it on the shell side, or pass -AutostartNameEnv.'
    return $false
  }
  if ([string]::IsNullOrWhiteSpace($Facts.bootFlag)) {
    Add-Check -Name 'the shell declares its boot flag' -Status 'skip' `
      -Detail 'no autostart.bootFlag declared, and guessing between --autostart and --hidden is exactly the disagreement M3 had to settle.'
    return $false
  }
  Add-Check -Name 'the autostart facts came from a contract, not a guess' -Status 'pass' `
    -Detail "value name '$($Facts.runValueName)', boot flag '$($Facts.bootFlag)', name override '$($Facts.nameEnv)', from $($Facts.source)"
  return $true
}

# Every rig-scoped Run value name this session minted. Shared, because
# Assert-NoStrayRunValue has to tell one of its own from a tray that ignored
# the override, and the cleanup at the end of a run owns the whole list.
$script:RigRunValues = [System.Collections.Generic.List[string]]::new()

function New-RigRunValueName {
  $name = "$($script:RigRunValuePrefix)$((Get-Date).ToString('HHmmss'))-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
  $script:RigRunValues.Add($name)
  return $name
}

<#
  The second belt on the value-name override, and the one that catches the case
  the first cannot: a tray that read the variable and ignored it.

  The name it would then write is productName, and productName changed at M3
  from photo-pigeon to Photo Pigeon, so looking for a name is looking for the
  wrong thing. This looks for the DATA: any Run value naming the exe this run
  launched, under any name but the one we handed it. Finding one is a stop, not
  a failed check, and the value is removed on the way out because it would
  otherwise start a throwaway build at this machine's next login.

  Names this rig minted itself are the one exception: every scenario points the
  same exe at a fresh scoped name and the values are cleaned up at the end of
  the RUN, so scenario two always finds scenario one's value naming the same
  exe. A name out of New-RigRunValueName is by construction not the thing this
  guard is for, which is a tray that read the variable, ignored it and wrote
  under productName. That still stops the run.
#>
function Assert-NoStrayRunValue {
  param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Allowed,
    [object]$Launched,
    [string]$NameEnv = ''
  )
  foreach ($value in @(Find-RunValuesNaming -Pattern ([regex]::Escape($Exe)))) {
    if ($value.name -eq $Allowed) { continue }
    if ($script:RigRunValues -contains $value.name) {
      Write-Note "an earlier scenario in this run left $($value.name) behind. The cleanup at the end owns it."
      continue
    }
    $removed = Remove-StrayRunValueNamingExe -Name $value.name -Exe $Exe
    if ($null -ne $Launched) { Stop-ShellNow -Launched $Launched }
    Stop-Unsafe "the tray wrote a Run value called '$($value.name)' naming this run's exe, instead of the name it was handed in $NameEnv. $(if ($removed) { 'The rig removed it again.' } else { 'The rig COULD NOT remove it: delete it by hand before the next login.' }) Value: $($value.data)"
  }
}

<#
  The only place a rig launches a tray, so it is the only place the Run value
  name override has to be got right.

  Every launch carries it, including the ones whose scenario is not about the
  Run key at all: start with Windows is ON by default from M3 onwards, so ANY
  tray a rig starts would otherwise write the production value name, pointing
  at a throwaway build, on the machine running the rig.
#>
function Start-TrayForScenario {
  param(
    [Parameter(Mandatory)][object]$Run,
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][object]$Facts,
    [Parameter(Mandatory)][string]$ConfigEnvName,
    [string[]]$Arguments = @(),
    [hashtable]$ExtraEnv = @{},
    [string]$RunValueName = '',
    [string]$CoreJs = '',
    [string]$NodeExe = '',
    [int]$ReadySec = 45,
    [System.Collections.Generic.List[object]]$Register = $null,
    # A shell that finds no config is the M4 first-run case, and it is expected
    # to spawn no sidecar at all, so the M2 sidecar assertion would stop a run
    # it has no business stopping. The caller says which world it is in.
    [switch]$ExpectNoSidecar
  )
  $nameEnv = [string]$Facts.nameEnv
  if ([string]::IsNullOrWhiteSpace($nameEnv)) {
    Stop-Unsafe 'no Run value name override is known, so no tray may be launched: a tray that starts with Windows by default would write the production Run value name.'
  }
  if (-not $ExtraEnv.ContainsKey($nameEnv)) {
    $ExtraEnv[$nameEnv] = $(if ($RunValueName -ne '') { $RunValueName } else { New-RigRunValueName })
  }

  $shellLog = Join-Path $Run.dir "shell-$Tag.log"
  $launched = Start-Tray -Run $Run -Exe $Exe -ShellLogPath $shellLog -ConfigEnvName $ConfigEnvName `
    -CoreJs $CoreJs -NodeExe $NodeExe -ExtraArgs $Arguments -ExtraEnv $ExtraEnv `
    -StdoutLeaf "shell-$Tag.stdout.log" -StderrLeaf "shell-$Tag.stderr.log"
  if ($null -ne $Register) { $Register.Add($launched) }

  Start-Sleep -Seconds 3
  if ($launched.process.HasExited) {
    Add-Check -Name "the tray survived its first seconds ($Tag)" -Status 'fail' `
      -Detail "exit code $($launched.process.ExitCode). stderr tail: $(Get-FileTail -Path $launched.stderr -Lines 10)"
    throw 'the tray exited immediately'
  }

  $sidecarPid = 0
  if ($ExpectNoSidecar) {
    Add-Check -Name "no sidecar was expected for this launch ($Tag)" -Status 'info' `
      -Detail 'a shell with no config has nothing to watch, so there is no core to check the override against. The config override is still set, and the first-run window is the thing being tested.'
  }
  else {
    $sidecarPid = Assert-SidecarOnThrowawayConfig -Launched $launched -Run $Run -ReadySec $ReadySec -ShellLogPath $shellLog
  }
  Assert-NoStrayRunValue -Exe $Exe -Allowed ([string]$ExtraEnv[$nameEnv]) -Launched $launched -NameEnv $nameEnv

  return [pscustomobject]@{
    launched     = $launched
    shellLog     = $shellLog
    sidecarPid   = $sidecarPid
    runValueName = [string]$ExtraEnv[$nameEnv]
  }
}

<#
  Stop the shell, then wait for the core to drain on its own.

  Not a kill, on either process: the shell is asked to close, its death closes
  the pipe, and the core reads end of file and drains. The wait is the
  assertion that it really did.
#>
function Stop-TrayAndWait {
  param(
    [Parameter(Mandatory)][object]$Session,
    [Parameter(Mandatory)][object]$Run,
    [string]$Tag = '',
    [int]$DrainTimeoutSec = 300
  )
  Stop-ShellNow -Launched $Session.launched
  $null = Wait-Until -TimeoutSeconds 20 -Condition { $Session.launched.process.HasExited }
  if ($Session.sidecarPid -ne 0) {
    $gone = Wait-Until -TimeoutSeconds $DrainTimeoutSec -PollMs 500 -Condition { -not (Test-ProcessAlive -Id $Session.sidecarPid) }
    Add-Check -Name "the core drained and exited after the shell went away$(if ($Tag -ne '') { " ($Tag)" })" `
      -Status $(if ($gone) { 'pass' } else { 'fail' }) `
      -Detail $(if ($gone) { "pid $($Session.sidecarPid) gone, never killed" } else { "pid $($Session.sidecarPid) still running. It was NOT killed: everything it owns is under TEMP." })
  }
  $null = Wait-Until -TimeoutSeconds 20 -Condition { -not (Test-Path -LiteralPath $Run.lockPath) }
}

function Assert-NoNewWatchCasualties {
  # No Mandatory here on purpose: an empty list is the ordinary case on a
  # machine with nothing running, and Mandatory refuses an empty collection.
  param([object[]]$PreExisting = @())
  $casualties = @()
  foreach ($p in $PreExisting) {
    if (-not (Test-ProcessAlive -Id $p.pid)) { $casualties += "$($p.name)/$($p.pid)" }
  }
  Add-Check -Name 'every watch that predated this run is still alive' `
    -Status $(if ($casualties.Count -eq 0) { 'pass' } else { 'fail' }) `
    -Detail $(if ($casualties.Count -eq 0) {
      if ($PreExisting.Count -eq 0) { 'there were none to protect' } else { 'the production watch was not touched' }
    }
    else { "gone: $($casualties -join ', ')" })
}
