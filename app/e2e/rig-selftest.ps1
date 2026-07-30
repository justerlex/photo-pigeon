#Requires -Version 7.0
<#
.SYNOPSIS
  Tests the rig's own dangerous parts, without launching anything.

.DESCRIPTION
  Two of the helpers in rig-common.ps1 can change the machine: the one that
  writes a Run value and the one that deletes one. Everything else in the rig is
  read-only or lives under TEMP. So those two get a test, and it is this file.

  What it proves:

  * Split-RunValue takes a Run value apart the way Windows does, including the
    unquoted shape from the M3 blocker note that breaks for an account name with
    a space, and the trailing-space shape auto-launch writes with no arguments.
  * Remove-RigRunValue and Set-RigRunValue REFUSE any name that is not
    rig-scoped. This is the guard that stands between a test run and somebody's
    real startup, and a guard nobody has ever seen fire is a guard nobody knows
    works.
  * A rig-scoped value really can be written, read back as REG_SZ, and removed.
  * Find-RunValuesNaming finds a value by the exe its DATA names, which is how
    the rig finds photo-pigeon entries without knowing what productName is
    called this week.
  * The whole Run key is byte for byte what it was when the file started.

  It writes exactly one value, under a name beginning photo-pigeon-e2e-, and
  removes it again. Nothing else on the machine is touched.

.EXAMPLE
  pwsh -File app\e2e\rig-selftest.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\rig-common.ps1"

Write-Host ''
Write-Host 'rig self test' -ForegroundColor White

$before = Get-RunKeySnapshot

function Test-Case {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Condition, [string]$Detail = '')
  Add-Check -Name $Name -Status $(if ($Condition) { 'pass' } else { 'fail' }) -Detail $Detail
}

<#
  A guard that fires records a failed 'safety' check, because in a real run that
  is exactly what it is. Here it is the thing being tested, so the record is
  taken back off the list and the run's result recomputed from what is left.
#>
function Undo-SafetyRefusal {
  $last = $script:Checks | Select-Object -Last 1
  if ($null -ne $last -and $last.name -eq 'safety' -and $last.status -eq 'fail') {
    $null = $script:Checks.Remove($last)
  }
  $script:Failed = @($script:Checks | Where-Object { $_.status -eq 'fail' }).Count -gt 0
}

Write-Step 'Split-RunValue against the shapes in the M3 blocker note'

# The correct one, from the doc, with the account name that breaks the others.
$right = Split-RunValue -Data '"C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe" --autostart'
Test-Case -Name 'the correct value reads as quoted' -Condition $right.quoted
Test-Case -Name 'the path comes out whole, spaces and all' `
  -Condition ($right.exePath -eq 'C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe') -Detail $right.exePath
Test-Case -Name 'the argument comes out on its own' -Condition ($right.arguments -eq '--autostart') -Detail $right.arguments
Test-Case -Name 'the arguments are outside the closing quote' -Condition $right.argsOutsideQuotes

# The broken one auto-launch writes, and the reason this milestone had a blocker.
$broken = Split-RunValue -Data 'C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe --autostart'
Test-Case -Name 'the unquoted value is caught' -Condition (-not $broken.quoted)
Test-Case -Name 'and it reports the path Windows would really try' `
  -Condition ($broken.exePath -eq 'C:\Users\John') -Detail $broken.exePath

# Quotes around the whole line: just as broken, and easy to write by accident.
$swallowed = Split-RunValue -Data '"C:\Program Files\photo-pigeon\photo-pigeon.exe --autostart"'
Test-Case -Name 'quotes around the arguments too are not mistaken for correct' `
  -Condition ($swallowed.arguments -eq '') -Detail "arguments came out as '$($swallowed.arguments)'"

# auto-launch with no arguments leaves a trailing space, which is why naive
# equality against the exe path fails.
$trailing = Split-RunValue -Data '"C:\tools\photo-pigeon.exe" '
Test-Case -Name 'a trailing space is not read as an argument' -Condition ($trailing.arguments -eq '') `
  -Detail "path '$($trailing.exePath)', arguments '$($trailing.arguments)'"

Write-Step 'The guards on the two helpers that can change the machine'

$refusedDelete = $false
try { $null = Remove-RigRunValue -Name 'Photo Pigeon' } catch { $refusedDelete = $true }
Undo-SafetyRefusal
Test-Case -Name 'Remove-RigRunValue refuses the product name' -Condition $refusedDelete `
  -Detail "the guard between a test run and somebody's real startup entry, seen firing"

$refusedWrite = $false
try { $null = Set-RigRunValue -Name 'Steam' -Data 'nonsense' } catch { $refusedWrite = $true }
Undo-SafetyRefusal
Test-Case -Name 'Set-RigRunValue refuses a name that is not ours' -Condition $refusedWrite `
  -Detail 'a real value belonging to real software, left alone'

Test-Case -Name 'a rig-scoped name is recognised' -Condition (Test-RigRunValueName -Name 'photo-pigeon-e2e-123456-abcdef')
Test-Case -Name 'the product name is not' -Condition (-not (Test-RigRunValueName -Name 'Photo Pigeon'))

Write-Step 'One real write and one real delete, under a rig-scoped name'

$name = "$($script:RigRunValuePrefix)selftest-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
$exe = 'C:\photo-pigeon-selftest\photo-pigeon.exe'
$data = "`"$exe`" --autostart"
$wrote = Set-RigRunValue -Name $name -Data $data
Test-Case -Name 'a rig-scoped value can be written' -Condition $wrote -Detail $name

$read = Get-RunValue -Name $name
Test-Case -Name 'and read back exactly' -Condition ($null -ne $read -and $read.data -eq $data) -Detail $(if ($null -ne $read) { $read.data } else { '(nothing)' })
Test-Case -Name 'and its kind is REG_SZ' -Condition ($null -ne $read -and $read.kind -eq 'String') -Detail $(if ($null -ne $read) { $read.kind } else { '(nothing)' })

$found = @(Find-RunValuesNaming -Pattern ([regex]::Escape($exe)))
Test-Case -Name 'Find-RunValuesNaming finds it by the exe in its data' `
  -Condition ($found.Count -eq 1 -and $found[0].name -eq $name) -Detail "$($found.Count) match"

Write-Step 'Assert-RunValueShape, against a value this file wrote'

# The six assertions the runkey scenario makes, run here against a value the rig
# controls, so all of them are known to work before an M3 shell exists to write
# a real one. The exe has to exist, so one is made.
$fakeDir = Join-Path $env:TEMP "photo-pigeon-e2e\selftest-exe-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
$null = New-Item -ItemType Directory -Path $fakeDir -Force
$fakeExe = Join-Path $fakeDir 'photo-pigeon.exe'
Set-Content -LiteralPath $fakeExe -Value 'not really an exe' -Encoding utf8NoBOM

try {
  $null = Set-RigRunValue -Name $name -Data "`"$fakeExe`" --autostart"
  $mark = $script:Checks.Count
  $null = Assert-RunValueShape -Value (Get-RunValue -Name $name) -ExpectedExe $fakeExe -ExpectedFlag '--autostart' -Prefix 'a correct value:'
  $produced = @($script:Checks | Select-Object -Last ($script:Checks.Count - $mark))
  Test-Case -Name 'every shape assertion passes on a correct value' `
    -Condition (@($produced | Where-Object { $_.status -ne 'pass' }).Count -eq 0) `
    -Detail "$($produced.Count) assertions, $(@($produced | Where-Object { $_.status -eq 'pass' }).Count) passed"

  # And now the shape from the blocker note, which every one of them exists to
  # catch. The checks it records are taken back off the list: a caught fault is
  # a pass here, not a failure.
  $null = Set-RigRunValue -Name $name -Data "$fakeExe --hidden"
  $mark = $script:Checks.Count
  $null = Assert-RunValueShape -Value (Get-RunValue -Name $name) -ExpectedExe $fakeExe -ExpectedFlag '--autostart' -Prefix 'a broken value:'
  $produced = @($script:Checks | Select-Object -Last ($script:Checks.Count - $mark))
  $caught = @($produced | Where-Object { $_.status -eq 'fail' }).Count
  foreach ($check in $produced) { $null = $script:Checks.Remove($check) }
  $script:Failed = @($script:Checks | Where-Object { $_.status -eq 'fail' }).Count -gt 0
  Test-Case -Name 'the unquoted value with the wrong flag is caught' -Condition ($caught -ge 3) `
    -Detail "$caught of $($produced.Count) assertions failed on it, as they should"
}
finally {
  Remove-Item -LiteralPath $fakeDir -Recurse -Force -ErrorAction SilentlyContinue
}

$removed = @(Remove-RigRunValue -Name $name)
Test-Case -Name 'and it can be removed again' -Condition ($removed.Count -ge 1) -Detail ($removed -join ', ')
Test-Case -Name 'it is really gone' -Condition ($null -eq (Get-RunValue -Name $name))

Write-Step 'The machine is as it was'

$after = Get-RunKeySnapshot
$removedNames = @($before.Keys | Where-Object { -not $after.Contains($_) })
$changedNames = @($before.Keys | Where-Object { $after.Contains($_) -and $after[$_] -ne $before[$_] })
$addedNames = @($after.Keys | Where-Object { -not $before.Contains($_) })
Test-Case -Name 'no Run value was removed, changed or left behind' `
  -Condition ($removedNames.Count -eq 0 -and $changedNames.Count -eq 0 -and $addedNames.Count -eq 0) `
  -Detail "$($before.Count) values before, $($after.Count) after"

Write-Step 'The PNG writers'

$dir = Join-Path $env:TEMP "photo-pigeon-e2e\selftest-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
$null = New-Item -ItemType Directory -Path $dir -Force
try {
  $small = Join-Path $dir 'small.png'
  $bytes = New-TestPng -Path $small -Marker 'self test'
  Test-Case -Name 'the small PNG is written' -Condition ($bytes -gt 100 -and (Test-Path -LiteralPath $small)) -Detail "$bytes bytes"

  $sig = [System.IO.File]::ReadAllBytes($small)[0..7]
  Test-Case -Name 'and it starts with a PNG signature' `
    -Condition (($sig -join ',') -eq '137,80,78,71,13,10,26,10')

  $large = Join-Path $dir 'large.png'
  $largeBytes = New-LargeTestPng -Path $large -Marker 'self test' -MegaBytes 2
  Test-Case -Name 'the large PNG writer compiles and runs' -Condition ($largeBytes -gt 1MB) -Detail "$largeBytes bytes"

  $twoHashes = @((Get-Sha256Hex -Path $small), (Get-Sha256Hex -Path $large))
  Test-Case -Name 'the two files have different bytes' -Condition ($twoHashes[0] -ne $twoHashes[1])
}
finally {
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}

# ===========================================================================
# M4. Everything run-m4.ps1 needs that can be proved without a window, a tray
# or a setup channel, proved here so that none of it is first exercised on the
# night the milestone lands.
#
# The M0 to M3 pattern is that every shipped critical lived in a state the rig
# could not construct. These are the pieces of the M4 rig that CAN be
# constructed today, so they are.
# ===========================================================================

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$protocolPath = Join-Path $PSScriptRoot 'm4-protocol.json'
$protocol = if (Test-Path -LiteralPath $protocolPath -PathType Leaf) {
  Get-Content -LiteralPath $protocolPath -Raw | ConvertFrom-Json
}
else { $null }

Write-Step 'The M4 protocol contract is readable and complete'

Test-Case -Name 'm4-protocol.json parses' -Condition ($null -ne $protocol) -Detail $protocolPath
if ($null -ne $protocol) {
  foreach ($section in @('detect', 'setup', 'events', 'askFields', 'answerScript', 'doctor', 'window', 'handles', 'memory', 'firstDelivery')) {
    Test-Case -Name "it declares $section" -Condition ($protocol.PSObject.Properties.Name -contains $section)
  }
  Test-Case -Name 'the answer script ends in two catch-alls' `
    -Condition (@($protocol.answerScript.rules | Select-Object -Last 2 | Where-Object { $_.match -eq '.*' }).Count -eq 2) `
    -Detail 'a wizard question nobody wrote a rule for still gets an answer, so a wording change slows the rig down instead of hanging it'
}

Write-Step 'Measure-HandleSlope, against lines whose shape is known'

# The honest build: one big step when the first window maps the Windows UI
# stack in, then flat. This must PASS, and it is the case a naive probe fails.
$flat = Measure-HandleSlope -Baseline 164 -AfterClose @(430, 431, 430) -AfterOpen @(520, 521, 520) -PerCycleTolerance 12
Test-Case -Name 'a big first open then a flat line passes' -Condition ($flat.verdict -eq 'pass') -Detail $flat.detail
Test-Case -Name 'and the one-off step is reported rather than scored' -Condition ($flat.firstOpenCost -eq 266) `
  -Detail "$($flat.firstOpenCost) handles, which section 6 already explains"

# The leak: every cycle costs and nothing comes back.
$leak = Measure-HandleSlope -Baseline 164 -AfterClose @(430, 520, 610) -AfterOpen @(560, 650, 740) -PerCycleTolerance 12
Test-Case -Name 'a line that climbs every cycle fails' -Condition ($leak.verdict -eq 'fail') -Detail $leak.detail
Test-Case -Name 'and the slope is the per cycle number, not the total' -Condition ($leak.slope -eq 90) -Detail "$($leak.slope) per cycle"

# Noise inside the tolerance is not a leak.
$noisy = Measure-HandleSlope -Baseline 164 -AfterClose @(430, 437, 434) -AfterOpen @(520, 527, 524) -PerCycleTolerance 12
Test-Case -Name 'a few handles of noise is not called a leak' -Condition ($noisy.verdict -eq 'pass') -Detail $noisy.detail

# One cycle has no direction, and saying so is better than guessing one.
$single = Measure-HandleSlope -Baseline 164 -AfterClose @(430) -PerCycleTolerance 12
Test-Case -Name 'one cycle is a skip rather than a pass' -Condition ($single.verdict -eq 'skip') -Detail $single.detail

# A close that gives nothing back is caught even when the slope is flat.
$stuck = Measure-HandleSlope -Baseline 164 -AfterClose @(600, 600) -AfterOpen @(560, 560) -PerCycleTolerance 12
Test-Case -Name 'a close that ends higher than the open is caught' -Condition (-not $stuck.gaveBack) `
  -Detail "open $($stuck.afterOpen[-1]), closed $($stuck.afterClose[-1])"

Write-Step 'Resolve-AnswerForAsk, against the wizard prompts that really exist'

if ($null -ne $protocol) {
  $rules = @($protocol.answerScript.rules)
  $tokens = @{
    watchDir        = 'C:\temp\watch'
    credentialsPath = 'C:\temp\client.json'
    projectId       = 'pigeon-rig-project'
    albumName       = 'photo-pigeon e2e'
  }

  # Every question the wizard really asks, by the stable name it really uses
  # AND by the prose it really carries, both copied from src/wizard/steps.ts.
  # Two columns because the rig must answer a build that emits names and one
  # that does not, and a rule that only works one way is a rule that breaks
  # silently the day the other shape turns up.
  $cases = @(
    @{ name = 'project-created'; kind = 'confirm'; message = 'Project created?'; expect = $true },
    @{ name = 'project-id'; kind = 'input'; message = 'Paste the project id (or press Enter to skip):'; expect = 'pigeon-rig-project' },
    @{ name = 'api-enabled'; kind = 'confirm'; message = 'Photos Library API enabled?'; expect = $true },
    @{ name = 'consent-saved'; kind = 'confirm'; message = 'Sign-in screen saved?'; expect = $true },
    @{ name = 'published'; kind = 'confirm'; message = 'Publishing status now says In production?'; expect = $true },
    @{ name = 'use-found-credentials'; kind = 'confirm'; message = 'Found client_secret_x.json, saved 2 minutes. Use it?'; expect = $true },
    @{ name = 'credentials-path'; kind = 'input'; message = 'Waiting for the download. Or paste the full path to the JSON:'; expect = 'C:\temp\client.json' },
    @{ name = 'watch-dir'; kind = 'input'; message = 'Which folder should the pigeon watch?'; expect = 'C:\temp\watch' },
    @{ name = 'watch-dir'; kind = 'input'; message = 'Path of the next folder:'; expect = 'C:\temp\watch' },
    @{ name = 'another-folder'; kind = 'confirm'; message = 'Add another folder?'; expect = $false },
    @{ name = 'wants-album'; kind = 'confirm'; message = 'Put everything into one album in Google Photos?'; expect = $true },
    @{ name = 'album-name'; kind = 'input'; message = 'Album name:'; expect = 'photo-pigeon e2e' },
    @{ name = 'replace-setup'; kind = 'confirm'; message = 'Run through setup again and replace it?'; expect = $true }
  )

  foreach ($case in $cases) {
    # By the stable name, which is what a real build sends.
    $byName = Resolve-AnswerForAsk -Kind $case.kind -Message 'a prompt nobody has written yet' -Name $case.name `
      -Rules $rules -Tokens $tokens
    Test-Case -Name "the ask named $($case.name) is answered by its name" `
      -Condition (($byName.value -eq $case.expect) -and $byName.matchedName -and (-not $byName.fellThrough)) `
      -Detail "answered $($byName.value), rule $($byName.ruleIndex). The prose was deliberately wrong, so only the name can have matched."

    # And by the prose alone, for a build whose asks carry no name.
    $byProse = Resolve-AnswerForAsk -Kind $case.kind -Message $case.message -Rules $rules -Tokens $tokens
    Test-Case -Name "`"$($case.message)`" is answered by its prose too" `
      -Condition (($byProse.value -eq $case.expect) -and (-not $byProse.fellThrough)) `
      -Detail "answered $($byProse.value), rule $($byProse.ruleIndex)$(if ($byProse.fellThrough) { ', by a CATCH-ALL' })"
  }

  # A name the script has no rule for still falls to the catch-all rather than
  # hanging, and it says so.
  $strangeName = Resolve-AnswerForAsk -Kind 'confirm' -Message 'Something new?' -Name 'a-question-from-the-future' `
    -Default $true -Rules $rules -Tokens $tokens
  Test-Case -Name 'an ask with an unknown name still gets an answer' `
    -Condition (($strangeName.value -eq $true) -and $strangeName.fellThrough) `
    -Detail "answered $($strangeName.value), by a catch-all, and reported as one"

  # The third kind. A pick takes its own default: a rig choosing from a list
  # nobody wrote a rule for is a rig making a product decision.
  $pick = Resolve-AnswerForAsk -Kind 'pick' -Message 'Which one?' -Default 'the-default-choice' -Rules $rules -Tokens $tokens
  Test-Case -Name 'a pick takes the question default rather than choosing' `
    -Condition ($pick.value -eq 'the-default-choice') -Detail "answered $($pick.value)"

  # The catch-alls, which are what stops an unknown question hanging a run.
  $unknownConfirm = Resolve-AnswerForAsk -Kind 'confirm' -Message 'Some question nobody has written yet?' -Default $false -Rules $rules -Tokens $tokens
  Test-Case -Name 'an unknown confirm takes the question default' `
    -Condition (($unknownConfirm.value -eq $false) -and $unknownConfirm.fellThrough) -Detail "answered $($unknownConfirm.value), and said it fell through"

  $unknownInput = Resolve-AnswerForAsk -Kind 'input' -Message 'Some field nobody has written yet:' -Rules $rules -Tokens $tokens
  Test-Case -Name 'an unknown input answers empty and says it guessed' `
    -Condition (($unknownInput.value -eq '') -and $unknownInput.fellThrough) -Detail "answered '$($unknownInput.value)'"

  # And with no rules at all, it still answers rather than hanging.
  $bare = Resolve-AnswerForAsk -Kind 'confirm' -Message 'anything' -Default $true -Rules @() -Tokens @{}
  Test-Case -Name 'with no rules at all it still answers' -Condition (($bare.value -eq $true) -and ($bare.ruleIndex -eq -1))
}

Write-Step 'The two rails that stand between a setup run and the real config'

$sandboxRoot = Join-Path $env:TEMP "photo-pigeon-e2e\selftest-sandbox-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
$null = New-Item -ItemType Directory -Path $sandboxRoot -Force
try {
  $sandbox = New-SandboxHome -Dir $sandboxRoot
  Test-Case -Name 'a sandbox home is made under TEMP' `
    -Condition ((Test-Path -LiteralPath $sandbox.home) -and -not (Test-InsideRealConfig -Path $sandbox.home)) -Detail $sandbox.home
  Test-Case -Name 'it names the folder a setup that ignored -c would land in' `
    -Condition ($sandbox.pigeonDir -like "$($sandbox.home)*") -Detail $sandbox.pigeonDir
  Test-Case -Name 'it overrides the wizard Downloads lookup too' `
    -Condition ($sandbox.env.ContainsKey('PHOTO_PIGEON_DOWNLOADS')) `
    -Detail "without it the wizard watches the machine's real Downloads, which is a read this rig has no reason to make"

  # The one that matters: node really does read USERPROFILE for its home. This
  # is a live probe, not an assumption, and run-m4.ps1 refuses to run a setup
  # until it has passed.
  $mark = $script:Checks.Count
  Assert-HomeRedirectWorks -Sandbox $sandbox
  $produced = @($script:Checks | Select-Object -Last ($script:Checks.Count - $mark))
  Test-Case -Name 'the home redirect probe passes on this machine' `
    -Condition (@($produced | Where-Object { $_.status -ne 'pass' }).Count -eq 0) `
    -Detail 'a child launched with USERPROFILE in TEMP reports its home in TEMP, so a setup that ignored every flag still could not reach the real home directory'
}
finally {
  Remove-Item -LiteralPath $sandboxRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step 'The witness on the production config folder'

# Taken twice with nothing in between. It reads names, sizes and times and
# never opens a file: the token and the credentials in there are the real Google
# account of whoever runs this machine.
$witnessOne = New-RealConfigWitness
$mark = $script:Checks.Count
Assert-RealConfigUntouched -Before $witnessOne
$produced = @($script:Checks | Select-Object -Last ($script:Checks.Count - $mark))
Test-Case -Name 'the witness agrees with itself when nothing was done' `
  -Condition (@($produced | Where-Object { $_.status -eq 'fail' }).Count -eq 0) `
  -Detail "$(if ($witnessOne.present) { "$($witnessOne.entries.Count) entries" } else { 'the folder does not exist on this machine' }). A live watch moving its own ledger is reported as information, never as a failure."

Write-Step 'Resolve-TrayExe never offers the installed copy on this machine'

# Walked to the end of the candidate list on purpose: a directory with no build
# in it is what a machine that has only ever installed looks like to this
# function, and the old list answered that with the installed tray, which
# Assert-ExeIsNotAnInstalledCopy then refused two steps later. A candidate
# offered only to be aborted is a worse failure message than one never offered.
$emptyRoot = Join-Path $env:TEMP "photo-pigeon-e2e-resolve-$([System.Guid]::NewGuid().ToString('N').Substring(0, 6))"
$null = New-Item -ItemType Directory -Path $emptyRoot -Force
try {
  $resolved = $null
  $whyNot = ''
  try { $resolved = Resolve-TrayExe -Given '' -RepoRoot $emptyRoot } catch { $whyNot = $_.Exception.Message }

  Test-Case -Name 'a tree with no build in it fails instead of finding an install' `
    -Condition ($null -eq $resolved) `
    -Detail $(if ($null -ne $resolved) { "it offered $resolved, which the safety guard then refuses" } else { 'the candidate list is repo builds only' })

  # The two entries that were dropped, named exactly rather than by their root:
  # %TEMP% lives under %LOCALAPPDATA% on Windows, so a root-prefix test on this
  # message would be answered by the throwaway directory above it.
  $dropped = @(
    (Join-Path $env:LOCALAPPDATA 'Photo Pigeon\photo-pigeon.exe'),
    (Join-Path $env:LOCALAPPDATA 'photo-pigeon\photo-pigeon.exe')
  )
  $named = @($dropped | Where-Object { $whyNot.Contains($_, [StringComparison]::OrdinalIgnoreCase) -or ($resolved -eq $_) })
  Test-Case -Name 'and neither install directory is named, offered or accepted' `
    -Condition ($named.Count -eq 0) `
    -Detail $(if ($named.Count -gt 0) { "it still points at $($named -join ', ')" } else { 'the failure names the build command and -ExePath, which are the two things that can help' })
}
finally {
  Remove-Item -LiteralPath $emptyRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step 'The refusal to drive an installed copy'

$refusedInstalled = $false
try { Assert-ExeIsNotAnInstalledCopy -Exe (Join-Path $env:LOCALAPPDATA 'Photo Pigeon\photo-pigeon.exe') } catch { $refusedInstalled = $true }
Undo-SafetyRefusal
Test-Case -Name 'a binary under LOCALAPPDATA is refused' -Condition $refusedInstalled `
  -Detail 'that is where the real installed Photo Pigeon on this machine lives, and M4 posts messages at windows and terminates webview hosts'

$mark = $script:Checks.Count
Assert-ExeIsNotAnInstalledCopy -Exe (Join-Path $repoRoot 'app\src-tauri\target\release\photo-pigeon.exe')
$produced = @($script:Checks | Select-Object -Last ($script:Checks.Count - $mark))
Test-Case -Name 'a repo build is accepted' -Condition (@($produced | Where-Object { $_.status -ne 'pass' }).Count -eq 0)

Write-Step 'Asking the built CLI what it declares'

Test-Case -Name 'Test-CliDeclares finds a marker that is there' `
  -Condition (Test-CliDeclares -HelpText 'Options:  -c, --config <path>  read this' -Marker '-c, --config')
Test-Case -Name 'and does not find one that is not' `
  -Condition (-not (Test-CliDeclares -HelpText 'Options:  --events <format>' -Marker '-c, --config'))
Test-Case -Name 'and treats an unreadable help text as a no' `
  -Condition (-not (Test-CliDeclares -HelpText '' -Marker '-c, --config')) `
  -Detail 'silence is never read as yes: that is the difference between a gate and a formality'

$watchHelp = Get-CliHelp -RepoRoot $repoRoot -Arguments @('watch', '--help')
Test-Case -Name 'the built CLI can be asked for help at all' -Condition (-not [string]::IsNullOrWhiteSpace($watchHelp)) `
  -Detail $(if ([string]::IsNullOrWhiteSpace($watchHelp)) { "no dist\cli.js under $repoRoot, so run npm run build" } else { "watch --help came back, $($watchHelp.Length) characters" })
if (-not [string]::IsNullOrWhiteSpace($watchHelp)) {
  Test-Case -Name 'and watch really declares the two options the rig depends on' `
    -Condition ((Test-CliDeclares -HelpText $watchHelp -Marker '-c, --config') -and (Test-CliDeclares -HelpText $watchHelp -Marker '--events')) `
    -Detail 'the control: these two are known to be there, so a false negative from the gate would show up here'
}

Write-Step 'The window API compiles and answers'

Test-Case -Name 'the user32 bindings compile' -Condition (Initialize-WindowApi) `
  -Detail 'EnumWindows, GetWindowTextW, IsWindow and PostMessage, which is how a window gets opened and closed without a hand on the mouse'
if (Initialize-WindowApi) {
  $ours = @(Get-AppWindows -ProcessId $PID -IncludeHidden)
  Test-Case -Name 'enumerating a live process returns without throwing' -Condition ($null -ne $ours) `
    -Detail "$($ours.Count) top level windows belong to this pwsh (a console host usually owns none)"

  $dead = @(Get-AppWindows -ProcessId 999999)
  Test-Case -Name 'a process id that owns nothing gives an empty list rather than an error' -Condition ($dead.Count -eq 0)

  Test-Case -Name 'a handle that was never a window reads as not alive' `
    -Condition (-not (Test-AppWindowAlive -Handle ([System.IntPtr]::new(1))))
}

Write-Step 'Get-ProcessMemoryDetail reports the number the budget is about'

$mem = Get-ProcessMemoryDetail -Id $PID
Test-Case -Name 'it reads this process' -Condition ($null -ne $mem) -Detail $(if ($null -ne $mem) { "$($mem.name), $($mem.handles) handles" } else { '(nothing)' })
if ($null -ne $mem) {
  Test-Case -Name 'and it carries private working set, not just private bytes' `
    -Condition ($null -ne $mem.privateWorkingSetMB) `
    -Detail $(if ($null -ne $mem.privateWorkingSetMB) { "$($mem.privateWorkingSetMB) MB private working set against $($mem.privateBytesMB) MB private bytes and $($mem.workingSetMB) MB working set. Project decision: the first of those three is the number the budget is about." }
    else { 'the performance counter would not answer on this machine, so run-m4.ps1 will warn instead of scoring the RAM row' })
  Test-Case -Name 'and a handle count' -Condition ($mem.handles -gt 0) -Detail "$($mem.handles)"
}

Write-Step 'The fake core delivers, holds a pause, and stops on a word'

# The whole delivery machinery, exercised for real. No tray and no network:
# this is the rig driving its own stand-in the way the shell would.
$fakeCore = Join-Path $PSScriptRoot 'fake-core.mjs'
Test-Case -Name 'the fake core is in the rig folder' -Condition (Test-Path -LiteralPath $fakeCore -PathType Leaf) -Detail $fakeCore

if ((Test-Path -LiteralPath $fakeCore -PathType Leaf) -and -not [string]::IsNullOrWhiteSpace($watchHelp)) {
  $fakeDir = New-RunDirectory -Tag 'selftest-fake'
  try {
    $fakeRun = New-RunConfig -Dir $fakeDir

    # Launched exactly the way the shell launches a core: node, then the
    # script, then the argv sidecar-layout.json declares for a watch.
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Get-Command node).Source
    foreach ($a in @($fakeCore, 'watch', '--events', 'ndjson', '-c', $fakeRun.configPath)) { $null = $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $fake = [System.Diagnostics.Process]::new()
    $fake.StartInfo = $psi
    $null = $fake.Start()
    $fakeLaunched = [pscustomobject]@{ process = $fake; id = $fake.Id }

    $up = Wait-Until -TimeoutSeconds 20 -PollMs 300 -Condition { Test-Path -LiteralPath $fakeRun.lockPath }
    Test-Case -Name 'the fake core takes the throwaway lock' -Condition $up -Detail $fakeRun.lockPath

    if ($up) {
      # One photo, delivered, and called the first ever.
      $one = Join-Path $fakeRun.stagingDir 'one.png'
      $null = New-TestPng -Path $one -Marker "selftest one $([System.Guid]::NewGuid())"
      $oneHash = Get-Sha256Hex -Path $one
      Move-Item -LiteralPath $one -Destination (Join-Path $fakeRun.watchDir 'one.png') -Force

      $landed = Wait-Until -TimeoutSeconds 30 -PollMs 500 -Condition {
        @(Read-JsonLines -Path $fakeRun.ledgerPath | Where-Object { $_.PSObject.Properties.Name -contains 'hash' -and $_.hash -eq $oneHash }).Count -gt 0
      }
      Test-Case -Name 'a photo dropped in the watched folder reaches the ledger' -Condition $landed -Detail "sha256 $($oneHash.Substring(0,12))"

      $log = Get-FileText -Path $fakeRun.logPath
      Test-Case -Name 'and the core calls it the first delivery ever' -Condition ($log -match 'one\.png firstEver=true') `
        -Detail 'sampled before the ledger append, which is the project definition of what first ever means'

      # A pause really holds, and a resume really releases.
      $null = Send-CoreLine -Launched $fakeLaunched -Line 'pause'
      Start-Sleep -Milliseconds 800
      $two = Join-Path $fakeRun.stagingDir 'two.png'
      $null = New-TestPng -Path $two -Marker "selftest two $([System.Guid]::NewGuid())"
      $twoHash = Get-Sha256Hex -Path $two
      Move-Item -LiteralPath $two -Destination (Join-Path $fakeRun.watchDir 'two.png') -Force
      Start-Sleep -Seconds 3
      $leaked = @(Read-JsonLines -Path $fakeRun.ledgerPath | Where-Object { $_.PSObject.Properties.Name -contains 'hash' -and $_.hash -eq $twoHash }).Count -gt 0
      Test-Case -Name 'a photo dropped while the fake core is paused is held' -Condition (-not $leaked)

      $null = Send-CoreLine -Launched $fakeLaunched -Line 'resume'
      $released = Wait-Until -TimeoutSeconds 30 -PollMs 500 -Condition {
        @(Read-JsonLines -Path $fakeRun.ledgerPath | Where-Object { $_.PSObject.Properties.Name -contains 'hash' -and $_.hash -eq $twoHash }).Count -gt 0
      }
      Test-Case -Name 'and delivered after the resume' -Condition $released

      $log = Get-FileText -Path $fakeRun.logPath
      Test-Case -Name 'and the second photo is NOT the first delivery ever' -Condition ($log -match 'two\.png firstEver=false') `
        -Detail 'per delivery, not per run: a first batch of twelve photos raises one toast rather than twelve'

      # An unknown word is answered by name on stderr, the M3 rule. Read after
      # the exit rather than polled: peeking at a live pipe blocks.
      $null = Send-CoreLine -Launched $fakeLaunched -Line 'bananas'
      Start-Sleep -Milliseconds 500
    }

    $null = Send-CoreLine -Launched $fakeLaunched -Line 'stop'
    $ended = Wait-Until -TimeoutSeconds 30 -PollMs 300 -Condition { $fake.HasExited }
    $fakeStderr = if ($ended) { $fake.StandardError.ReadToEnd() } else { '' }
    Test-Case -Name 'an unknown word is answered by name on stderr' -Condition ($fakeStderr -match 'bananas') `
      -Detail $(if ($fakeStderr -match 'bananas') { 'named back, so a swallowed command is told apart from an accepted one' } else { "stderr said: $fakeStderr" })
    Test-Case -Name 'the fake core stops on a word and exits clean' -Condition ($ended -and $fake.ExitCode -eq 0) `
      -Detail "exit code $(if ($ended) { $fake.ExitCode } else { 'still running' })"
    Test-Case -Name 'and lets go of its lock on the way out' -Condition (-not (Test-Path -LiteralPath $fakeRun.lockPath)) `
      -Detail 'a killed watch always leaves its lock behind, so the absence of the file is the proof that this was not a kill'

    # And the refusal that matters: no config, no run.
    $refused = [System.Diagnostics.Process]::new()
    $rpsi = [System.Diagnostics.ProcessStartInfo]::new()
    $rpsi.FileName = (Get-Command node).Source
    foreach ($a in @($fakeCore, 'watch', '--events', 'ndjson')) { $null = $rpsi.ArgumentList.Add($a) }
    $rpsi.UseShellExecute = $false
    $rpsi.RedirectStandardError = $true
    $rpsi.CreateNoWindow = $true
    $refused.StartInfo = $rpsi
    $null = $refused.Start()
    $null = $refused.WaitForExit(15000)
    Test-Case -Name 'the fake core refuses to run with no config at all' -Condition ($refused.ExitCode -ne 0) `
      -Detail "exit code $($refused.ExitCode). A core with no config opens the default one, which is the real one."
  }
  finally {
    Remove-Item -LiteralPath $fakeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Step 'The setup driver, against a channel that answers nothing but the protocol'

# The rig's most intricate function is the ask loop, and on a branch cut before
# M4 there is no core in existence that can exercise it. app\e2e\fake-setup.mjs
# speaks the protocol and nothing else, so the loop is proved here rather than
# on the night the milestone lands. Nothing this proves is evidence about the
# CORE: run-m4.ps1's setup scenario drives the real one, and fake-core.mjs
# refuses `setup` outright so the two can never be confused.
$fakeSetup = Join-Path $PSScriptRoot 'fake-setup.mjs'
Test-Case -Name 'the fake setup channel is in the rig folder' -Condition (Test-Path -LiteralPath $fakeSetup -PathType Leaf) -Detail $fakeSetup

if ((Test-Path -LiteralPath $fakeSetup -PathType Leaf) -and $null -ne $protocol) {
  $setupDir = New-RunDirectory -Tag 'selftest-setup'
  try {
    $watchDir = Join-Path $setupDir 'watch'
    $null = New-Item -ItemType Directory -Path $watchDir -Force
    $setupRun = Resume-RunConfig -Dir $setupDir
    $sandbox = New-SandboxHome -Dir $setupDir
    $clientJson = New-SyntheticClientJson -Path (Join-Path $sandbox.downloads 'client_secret_selftest.json')

    Test-Case -Name 'the driver starts from a directory with no config' `
      -Condition (-not (Test-Path -LiteralPath $setupRun.configPath)) -Detail $setupRun.configPath

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Get-Command node).Source
    foreach ($a in @($fakeSetup, 'setup', '--events', 'ndjson', '-c', $setupRun.configPath)) { $null = $psi.ArgumentList.Add($a) }
    foreach ($name in $sandbox.env.Keys) { $psi.Environment[[string]$name] = [string]$sandbox.env[$name] }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $ndjson = Join-Path $setupDir 'setup.ndjson'
    Set-Content -LiteralPath $ndjson -Value '' -Encoding utf8NoBOM
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $null = $proc.Start()
    $null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $ndjson -Action {
      if ($null -ne $EventArgs.Data) { Add-Content -LiteralPath $Event.MessageData -Value $EventArgs.Data }
    }
    $proc.BeginOutputReadLine()
    $setupLaunched = [pscustomobject]@{ process = $proc; id = $proc.Id; ndjson = $ndjson }

    $walk = Invoke-SetupChannel -Launched $setupLaunched -Protocol $protocol -ConfigPath $setupRun.configPath `
      -Tokens @{
      watchDir        = $watchDir
      credentialsPath = $clientJson
      projectId       = 'pigeon-rig-project'
      albumName       = 'photo-pigeon e2e'
    } -TimeoutSeconds 90

    Test-Case -Name 'the driver answered every question it was asked' -Condition ($walk.asked -ge 9) `
      -Detail "$($walk.asked) answers sent across $($walk.questions) questions, including the retry"
    Test-Case -Name 'and it did not time out' -Condition (-not $walk.timedOut) `
      -Detail $(if ($walk.timedOut) { 'the loop went quiet, which is the deadlock a refusal causes when the driver does not know the question is still live' } else { 'the walk finished on its own' })
    Test-Case -Name 'and nothing failed on the way' -Condition ($null -eq $walk.failure) -Detail ([string]$walk.failure)
    Test-Case -Name 'and no question ran out of attempts' -Condition ($walk.exhausted.Count -eq 0) `
      -Detail $(if ($walk.exhausted.Count -eq 0) { 'nothing was refused three times, so no rule in the answer script is wrong' } else { "gave up on ask id(s): $($walk.exhausted -join ', ')" })

    # THE DEADLOCK, constructed on purpose. A refused answer leaves the question
    # LIVE and is not re-asked, so a driver that answers each ask once and waits
    # for the next one waits forever while both programs behave correctly.
    Test-Case -Name 'a refusal was seen and answered again' `
      -Condition (($walk.refusals.Count -ge 1) -and (@($walk.answers | Group-Object -Property id | Where-Object { $_.Count -gt 1 }).Count -ge 1)) `
      -Detail "$($walk.refusals.Count) refusal(s), and the question they named was answered a second time. This is the assertion that would fail if the driver ever went back to waiting for a second ask event."

    # The grammar the SHIPPED core reads, which is not the one this assertion
    # was first written for. `answer` then one JSON object carrying the id and
    # the value, checked through the protocol file so the wire stays written
    # down in exactly one place.
    $grammar = $(if ([string]$protocol.setup.answerForm -eq 'idThenValue') { '^answer\s+\S+\s+' } else { '^answer\s+\{' })
    Test-Case -Name 'the answers went out in the real grammar' `
      -Condition (@($walk.answers | Where-Object { $_.line -match $grammar }).Count -eq $walk.answers.Count) `
      -Detail "form '$([string]$protocol.setup.answerForm)'. Example: $($walk.answers[0].line)"

    # An ask on the shipped channel carries no stable name, so matching is on
    # the prose and that is not a weakness to assert away: what has to be true
    # is that every answer came from a RULE. A fall-through is the driver
    # guessing, and a guess that happens to be accepted is the failure this
    # catches, because it passes today and answers the wrong question tomorrow.
    Test-Case -Name 'and every answer came from a rule rather than a fallback' `
      -Condition (@($walk.answers | Where-Object { $_.fellThrough }).Count -eq 0) `
      -Detail "$(@($walk.answers | Where-Object { $_.matchedName }).Count) of $($walk.answers.Count) matched a stable name, the rest matched the prompt. Fell through: $(@($walk.answers | Where-Object { $_.fellThrough }).Count)"

    Test-Case -Name 'the driver wrote a real config' -Condition $walk.wroteConfig -Detail $setupRun.configPath

    if ($walk.wroteConfig) {
      $written = Get-Content -LiteralPath $setupRun.configPath -Raw | ConvertFrom-Json
      Test-Case -Name 'and the folder token arrived as a path rather than as its own name' `
        -Condition (@($written.watchDirs | Where-Object { $_ -eq $watchDir }).Count -eq 1) `
        -Detail "watchDirs: $($written.watchDirs -join ', ')"
      Test-Case -Name 'and the album answer reached it' -Condition ($written.albumName -eq 'photo-pigeon e2e') `
        -Detail ([string]$written.albumName)
      Test-Case -Name 'and every path in it is outside the production folder' `
        -Condition (@(@($written.watchDirs) + @($written.credentialsPath, $written.tokenPath, $written.ledgerPath) |
          Where-Object { $_ -and (Test-InsideRealConfig -Path ([string]$_)) }).Count -eq 0)
    }

    # An answer for a question that is not open is refused BY NAME. A window
    # that closed mid ask and reopened holds a dead id, and silence is the one
    # reading it must never get.
    $before = (Get-FileText -Path $ndjson)
    $deadLine = $(if ([string]$protocol.setup.answerForm -eq 'idThenValue') {
        'answer 999 true'
      }
      else {
        'answer ' + (([ordered]@{ id = '999'; value = $true }) | ConvertTo-Json -Compress)
      })
    $null = Send-CoreLine -Launched $setupLaunched -Line $deadLine
    Start-Sleep -Milliseconds 600
    $now = (Get-FileText -Path $ndjson)
    $added = $now.Substring([Math]::Min($before.Length, $now.Length))
    # Refused, whichever way this build says it. The shipped core says it on
    # `answered` with `accepted: false`; the other M4 seam said it on its own
    # `answer-refused` type. Silence is the one reading a window must never get,
    # and that is what this asserts against, so it is written to accept either
    # sentence rather than to pin the spelling.
    $refusedOnDeadId = ($added -match 'answer-refused') -or
                       ($added -match '"accepted"\s*:\s*false')
    Test-Case -Name 'an answer for a dead id is refused rather than swallowed' `
      -Condition $refusedOnDeadId -Detail "sent $deadLine, and the channel answered rather than swallowing it"

    $null = Send-CoreLine -Launched $setupLaunched -Line 'stop'
    $ended = Wait-Until -TimeoutSeconds 20 -PollMs 300 -Condition { $proc.HasExited }
    Test-Case -Name 'the setup channel stops on a word' -Condition ($ended -and $proc.ExitCode -eq 0) `
      -Detail "exit code $(if ($ended) { $proc.ExitCode } else { 'still running' })"

    # The reader that drains stdout is an event handler, so the last line can
    # still be in flight for a moment after the process itself has gone.
    $null = Wait-Until -TimeoutSeconds 10 -PollMs 200 -Condition {
      (Get-FileText -Path $ndjson) -match '"type"\s*:\s*"stopped"'
    }
    $stream = Get-FileText -Path $ndjson
    Test-Case -Name 'no consent URL ever travelled on the channel' -Condition ($stream -notmatch 'accounts\.google\.com') `
      -Detail 'consent opens the system browser and never a WebviewWindow, so there is nothing on the wire for a page to render even by accident'

    $lastLine = @($stream -split "`r?`n" | Where-Object { $_.Trim() -ne '' })[-1]
    Test-Case -Name 'stopped was the last line of the run' `
      -Condition ($lastLine -match '"type"\s*:\s*"stopped"') -Detail $lastLine

    Test-Case -Name 'the sandbox home was never written to' -Condition (-not (Test-Path -LiteralPath $sandbox.pigeonDir)) `
      -Detail "nothing at $($sandbox.pigeonDir), which is where a setup that ignored -c would have landed"
  }
  finally {
    Get-EventSubscriber -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $setupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ===========================================================================
# M5. The Windows Sandbox rig, which is the only venue the install matrix can be
# walked in: this machine holds an install, a Run value and the real ledger, so
# app/e2e/sandbox/bootstrap.ps1 must never run here.
#
# Everything below is app/e2e/sandbox/sandbox-assert.ps1, which is written as
# functions of their arguments for exactly this reason. The assertions run
# against a fake install tree under TEMP, the rails run against what a sandbox
# and what this machine look like, and the two second copies of rig-common
# helpers are held to their originals.
#
# Nothing here installs, launches, deletes or writes outside TEMP. The one thing
# it reads on the real machine is the Run key, read only, and one refusal is
# proved by pointing it at the machine's own state directory and watching it throw.
# ===========================================================================

Write-Step 'The sandbox rig loads under this PowerShell too'

$assertPath = Join-Path $PSScriptRoot 'sandbox\sandbox-assert.ps1'
Test-Case -Name 'sandbox-assert.ps1 is in the sandbox folder' `
  -Condition (Test-Path -LiteralPath $assertPath -PathType Leaf) -Detail $assertPath

if (Test-Path -LiteralPath $assertPath -PathType Leaf) {
  . $assertPath

  Test-Case -Name 'and its functions are here' `
    -Condition ($null -ne (Get-Command -Name 'Get-PigeonInstallShapeChecks' -ErrorAction SilentlyContinue)) `
    -Detail 'written for 5.1 because Windows Sandbox has no pwsh, and it has to keep working under 7 as well or this file cannot test it'

  Write-Step 'The two second copies, held to the originals in rig-common.ps1'

  # A second copy of a safety-shaped parser is what rig-common.ps1's own header
  # forbids, and the PowerShell version wall is the reason there is one anyway.
  # So the copy is pinned by behaviour, over the shapes the M3 blocker note is
  # about, including the ones that are broken.
  $shapes = @(
    '"C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe" --autostart',
    'C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe --autostart',
    '"C:\Program Files\photo-pigeon\photo-pigeon.exe --autostart"',
    '"C:\tools\photo-pigeon.exe" ',
    '"C:\tools\photo-pigeon.exe',
    'photo-pigeon.exe'
  )
  $disagreements = @()
  foreach ($shape in $shapes) {
    $mine = Split-PigeonRunValue -Data $shape
    $theirs = Split-RunValue -Data $shape
    foreach ($field in @('raw', 'quoted', 'exePath', 'arguments', 'argsOutsideQuotes', 'note')) {
      if ([string]$mine.$field -ne [string]$theirs.$field) {
        $disagreements += "$field on '$shape': '$($mine.$field)' against '$($theirs.$field)'"
      }
    }
  }
  Test-Case -Name 'Split-PigeonRunValue agrees with Split-RunValue on every field of every shape' `
    -Condition ($disagreements.Count -eq 0) `
    -Detail $(if ($disagreements.Count -eq 0) { "$($shapes.Count) shapes, 6 fields each, including the unquoted one and the one with the quotes around the arguments" } else { ($disagreements -join ' | ') })

  # The reader, over every value that is really in the key. Read only: this
  # compares two readers against each other and writes nothing.
  $keyNames = @((Get-RunKeySnapshot).Keys)
  $readerDisagreements = @()
  foreach ($name in $keyNames) {
    $mine = Get-PigeonRunValue -Name $name
    $theirs = Get-RunValue -Name $name
    if (($null -eq $mine) -ne ($null -eq $theirs)) { $readerDisagreements += "$name : one reader found it and the other did not" }
    elseif ($null -ne $mine -and (([string]$mine.data -ne [string]$theirs.data) -or ([string]$mine.kind -ne [string]$theirs.kind))) {
      $readerDisagreements += "$name : '$($mine.data)' / $($mine.kind) against '$($theirs.data)' / $($theirs.kind)"
    }
  }
  Test-Case -Name 'Get-PigeonRunValue agrees with Get-RunValue on every value in the real key' `
    -Condition ($readerDisagreements.Count -eq 0) `
    -Detail $(if ($readerDisagreements.Count -eq 0) { "$($keyNames.Count) values, data and kind, neither reader expanding a REG_EXPAND_SZ" } else { ($readerDisagreements -join ' | ') })

  Test-Case -Name 'and both answer nothing for a name that is not there' `
    -Condition ($null -eq (Get-PigeonRunValue -Name 'photo-pigeon-a-name-that-cannot-exist')) `
    -Detail 'an absent value reads as absent rather than as an empty one'

  Write-Step 'The install facts, read off the files that own each name'

  $facts = $null
  try { $facts = Get-PigeonInstallFacts -RepoRoot $repoRoot } catch { }
  Test-Case -Name 'the facts can be read from this checkout' -Condition ($null -ne $facts) `
    -Detail $(if ($null -ne $facts) { "$($facts.displayName) $($facts.version), exe $($facts.exeName), state dir $($facts.stateDirName)" } else { 'Get-PigeonInstallFacts threw, so one of the four contract files moved' })

  if ($null -ne $facts) {
    $factChecks = @(Get-PigeonFactsChecks -Facts $facts)
    Test-Case -Name 'and every frozen name is where section 0 froze it' `
      -Condition ((Get-PigeonFailCount -Checks $factChecks) -eq 0) `
      -Detail $(if ((Get-PigeonFailCount -Checks $factChecks) -eq 0) { "$($factChecks.Count) checks, including the one that holds the layout file's own installed-layout sentence to the directory the display name really produces" } else { (@($factChecks | Where-Object { $_.status -eq 'fail' } | ForEach-Object { $_.name }) -join '; ') })

    # And the same function against a rename, because a check that has only ever
    # been seen passing is a check nobody knows the shape of. Four names moved at
    # once: the display name, the exe, the Run value and the layout sentence.
    $moved = [pscustomobject]@{
      displayName     = 'PhotoPigeon'
      exeName         = 'pigeon.exe'
      npmName         = $facts.npmName
      identifier      = $facts.identifier
      sidecarExe      = $facts.sidecarExe
      resources       = $facts.resources
      runValueName    = 'Photo Pigeon'
      bootFlag        = $facts.bootFlag
      stateDirName    = $facts.stateDirName
      version         = 'not-a-version'
      installedLayout = $facts.installedLayout
    }
    $movedChecks = @(Get-PigeonFactsChecks -Facts $moved)
    $movedFails = @($movedChecks | Where-Object { $_.status -eq 'fail' })
    Test-Case -Name 'a moved name is caught, and the Run value mismatch with it' `
      -Condition ($movedFails.Count -ge 4) `
      -Detail "$($movedFails.Count) of $($movedChecks.Count) failed: $(@($movedFails | ForEach-Object { $_.name }) -join '; ')"

    Write-Step 'The four rails that keep the sandbox rig off this machine'

    $railsInSandbox = @(Get-PigeonVenueChecks -UserName 'WDAGUtilityAccount' `
        -StateDirPresent $false -InstallDirPresent $false -Confirmed $true)
    Test-Case -Name 'inside a sandbox all four rails pass' `
      -Condition ((Get-PigeonFailCount -Checks $railsInSandbox) -eq 0) -Detail "$($railsInSandbox.Count) rails"

    # What this machine looks like, which is what the rails exist for.
    $railsHere = @(Get-PigeonVenueChecks -UserName $env:USERNAME `
        -StateDirPresent (Test-Path -LiteralPath (Join-Path $HOME $facts.stateDirName)) `
        -InstallDirPresent (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA $facts.displayName)) `
        -Confirmed $false)
    $railsFired = @($railsHere | Where-Object { $_.status -eq 'fail' })
    Test-Case -Name 'and on this machine they fire' -Condition ($railsFired.Count -ge 2) `
      -Detail "$($railsFired.Count) of $($railsHere.Count) refused: $(@($railsFired | ForEach-Object { $_.name }) -join '; '). The account rail and the confirmation rail hold on any machine; the other two hold because this one is configured."

    Write-Step 'The install shape, against a tree that was built to satisfy it'

    $treeRoot = Join-Path $env:TEMP "photo-pigeon-e2e\selftest-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
    $null = New-Item -ItemType Directory -Path $treeRoot -Force
    try {
      $fakeLocal = Join-Path $treeRoot 'LocalAppData'
      $fakeInstall = Join-Path $fakeLocal $facts.displayName
      $fakeStart = Join-Path $treeRoot 'StartMenu'
      $fakeDesktop = Join-Path $treeRoot 'Desktop'
      foreach ($dir in @($fakeInstall, (Join-Path $fakeInstall 'resources'), $fakeStart, $fakeDesktop)) {
        $null = New-Item -ItemType Directory -Path $dir -Force
      }
      $fakeExe = Join-Path $fakeInstall $facts.exeName
      foreach ($leaf in @($facts.exeName, $facts.sidecarExe, 'uninstall.exe')) {
        Set-Content -LiteralPath (Join-Path $fakeInstall $leaf) -Value 'not really an exe' -Encoding utf8NoBOM
      }
      foreach ($resource in @($facts.resources)) {
        Set-Content -LiteralPath (Join-Path $fakeInstall ($resource -replace '/', '\')) -Value 'resource' -Encoding utf8NoBOM
      }

      # A real .lnk, so the shortcut reader is exercised rather than mocked.
      $lnkPath = Join-Path $fakeStart "$($facts.displayName).lnk"
      $comWorked = $false
      try {
        $wshell = New-Object -ComObject WScript.Shell
        $link = $wshell.CreateShortcut($lnkPath)
        $link.TargetPath = $fakeExe
        $link.Save()
        $comWorked = Test-Path -LiteralPath $lnkPath -PathType Leaf
      }
      catch { $comWorked = $false }

      if ($comWorked) {
        Test-Case -Name 'the shortcut reader reads a shortcut this file wrote' `
          -Condition ((Get-PigeonShortcutTarget -Path $lnkPath) -eq $fakeExe) `
          -Detail (Get-PigeonShortcutTarget -Path $lnkPath)
      }
      else {
        Add-Check -Name 'the shortcut reader reads a shortcut this file wrote' -Status 'skip' `
          -Detail 'WScript.Shell would not answer on this machine, so the shape check downgrades that one row to a warning rather than failing it'
      }

      $goodTree = @(Get-PigeonInstallShapeChecks -Facts $facts -InstallDir $fakeInstall `
          -LocalAppData $fakeLocal -StartMenuDir $fakeStart -DesktopDir $fakeDesktop)
      Test-Case -Name 'a complete install tree passes every shape check' `
        -Condition ((Get-PigeonFailCount -Checks $goodTree) -eq 0) `
        -Detail $(if ((Get-PigeonFailCount -Checks $goodTree) -eq 0) { "$($goodTree.Count) checks: the directory, its name, the exe, the sidecar, the uninstaller, $(@($facts.resources).Count) resources, the Start Menu shortcut and an empty Desktop" } else { (@($goodTree | Where-Object { $_.status -eq 'fail' } | ForEach-Object { $_.name }) -join '; ') })

      # Now break it in four ways at once, each of which has really happened or
      # really nearly happened: a resource that did not get staged, the M0
      # spike's old binary left behind, a Desktop shortcut the NSIS hook was
      # supposed to delete, and a shortcut pointing at the wrong exe.
      Remove-Item -LiteralPath (Join-Path $fakeInstall 'resources\core.mjs') -Force
      Set-Content -LiteralPath (Join-Path $fakeInstall 'photo-pigeon-tray.exe') -Value 'the M0 name' -Encoding utf8NoBOM
      Set-Content -LiteralPath (Join-Path $fakeDesktop "$($facts.displayName).lnk") -Value 'a desktop shortcut' -Encoding utf8NoBOM

      $brokenTree = @(Get-PigeonInstallShapeChecks -Facts $facts -InstallDir $fakeInstall `
          -LocalAppData $fakeLocal -StartMenuDir $fakeStart -DesktopDir $fakeDesktop)
      $brokenNames = @($brokenTree | Where-Object { $_.status -eq 'fail' } | ForEach-Object { $_.name })
      Test-Case -Name 'and a broken one fails exactly the three rows that are broken' `
        -Condition ($brokenNames.Count -eq 3 -and
          @($brokenNames | Where-Object { $_ -like '*core.mjs*' }).Count -eq 1 -and
          @($brokenNames | Where-Object { $_ -like '*no other exe*' }).Count -eq 1 -and
          @($brokenNames | Where-Object { $_ -like '*Desktop*' }).Count -eq 1) `
        -Detail ($brokenNames -join '; ')

      # An install directory outside LOCALAPPDATA means something elevated, and a
      # leaf that is not the display name means the uninstaller will look in the
      # wrong place.
      $wrongPlace = @(Get-PigeonInstallShapeChecks -Facts $facts -InstallDir (Join-Path $treeRoot 'Program Files\photo-pigeon') `
          -LocalAppData $fakeLocal -StartMenuDir $fakeStart -DesktopDir $fakeDesktop)
      $wrongNames = @($wrongPlace | Where-Object { $_.status -eq 'fail' } | ForEach-Object { $_.name })
      Test-Case -Name 'an install somewhere else is caught by place and by name' `
        -Condition (@($wrongNames | Where-Object { $_ -like '*under LOCALAPPDATA*' }).Count -eq 1 -and
          @($wrongNames | Where-Object { $_ -like '*named for the display name*' }).Count -eq 1) `
        -Detail "$($wrongNames.Count) failures, including the elevation row and the directory name row"

      Write-Step 'The uninstall, and the residue it is allowed to leave'

      $fakeAppData = Join-Path $fakeLocal $facts.identifier
      $null = New-Item -ItemType Directory -Path $fakeAppData -Force
      Remove-Item -LiteralPath $fakeInstall -Recurse -Force
      Remove-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath (Join-Path $fakeDesktop "$($facts.displayName).lnk") -Force -ErrorAction SilentlyContinue

      $cleanRemoval = @(Get-PigeonRemovalChecks -Facts $facts -InstallDir $fakeInstall `
          -StartMenuDir $fakeStart -DesktopDir $fakeDesktop -AppDataDir $fakeAppData)
      Test-Case -Name 'a finished uninstall passes every removal check' `
        -Condition ((Get-PigeonFailCount -Checks $cleanRemoval) -eq 0) `
        -Detail "$($cleanRemoval.Count) checks, and the application data directory is asserted PRESENT: a silent uninstall leaves that checkbox unticked, which is the default the ledger law relies on"

      # The failure that matters here is the one a running core causes: a file in
      # use cannot be deleted, so the directory survives with something in it.
      $null = New-Item -ItemType Directory -Path $fakeInstall -Force
      Set-Content -LiteralPath (Join-Path $fakeInstall $facts.sidecarExe) -Value 'still in use' -Encoding utf8NoBOM
      $stuckRemoval = @(Get-PigeonRemovalChecks -Facts $facts -InstallDir $fakeInstall `
          -StartMenuDir $fakeStart -DesktopDir $fakeDesktop -AppDataDir $fakeAppData)
      Test-Case -Name 'and a directory that survived the uninstall is named, with what is in it' `
        -Condition ((Get-PigeonFailCount -Checks $stuckRemoval) -eq 1 -and
          (@($stuckRemoval | Where-Object { $_.status -eq 'fail' })[0].detail -like "*$($facts.sidecarExe)*")) `
        -Detail (@($stuckRemoval | Where-Object { $_.status -eq 'fail' })[0].detail)

      Write-Step 'The ledger law, on a state directory this file made'

      $fakeState = Join-Path $treeRoot 'home\.photo-pigeon'
      $null = New-Item -ItemType Directory -Path $fakeState -Force
      $markerId = [System.Guid]::NewGuid().ToString()
      Set-Content -LiteralPath (Join-Path $fakeState 'sandbox-marker.txt') -Value $markerId -Encoding utf8NoBOM
      Set-Content -LiteralPath (Join-Path $fakeState 'ledger.jsonl') -Value '{"hash":"abc","mediaItemId":"one"}' -Encoding utf8NoBOM

      $before = New-PigeonStateWitness -StateDir $fakeState
      Test-Case -Name 'the witness carries a hash per file, not just a name' `
        -Condition ($before.entries.Count -eq 2 -and @($before.entries | Where-Object { $_.sha256.Length -eq 64 }).Count -eq 2) `
        -Detail "$($before.entries.Count) files, sha256 each. A name and a size cannot tell a rewritten ledger from an untouched one."

      $survived = @(Get-PigeonStateSurvivalChecks -Before $before -After (New-PigeonStateWitness -StateDir $fakeState))
      Test-Case -Name 'an untouched state directory passes the law' `
        -Condition ((Get-PigeonFailCount -Checks $survived) -eq 0) -Detail "$($survived.Count) checks"

      # The three ways the law can break, all at once: one file gone, one file
      # rewritten, one file added.
      Remove-Item -LiteralPath (Join-Path $fakeState 'sandbox-marker.txt') -Force
      Set-Content -LiteralPath (Join-Path $fakeState 'ledger.jsonl') -Value '{"hash":"rewritten"}' -Encoding utf8NoBOM
      Set-Content -LiteralPath (Join-Path $fakeState 'strange.txt') -Value 'who put this here' -Encoding utf8NoBOM
      $broken = @(Get-PigeonStateSurvivalChecks -Before $before -After (New-PigeonStateWitness -StateDir $fakeState))
      $brokenLaw = @($broken | Where-Object { $_.status -eq 'fail' } | ForEach-Object { $_.name })
      Test-Case -Name 'a missing file and a rewritten one both break it' `
        -Condition ($brokenLaw.Count -eq 2 -and
          @($brokenLaw | Where-Object { $_ -like '*still there*' }).Count -eq 1 -and
          @($brokenLaw | Where-Object { $_ -like '*byte for byte*' }).Count -eq 1) `
        -Detail ($brokenLaw -join '; ')
      Test-Case -Name 'and a file that appeared is a warning rather than a failure' `
        -Condition (@($broken | Where-Object { $_.status -eq 'warn' -and $_.name -like '*nothing was added*' }).Count -eq 1) `
        -Detail 'the law is about what was taken away. Something arriving is worth saying and is not the law breaking.'

      # And the whole directory gone, which is the law broken in the only way
      # that costs somebody their library.
      Remove-Item -LiteralPath $fakeState -Recurse -Force
      $gone = @(Get-PigeonStateSurvivalChecks -Before $before -After (New-PigeonStateWitness -StateDir $fakeState))
      Test-Case -Name 'a state directory that is gone fails first and loudest' `
        -Condition ($gone[0].status -eq 'fail' -and $gone[0].detail -like '*ledger law broken*') `
        -Detail $gone[0].detail
    }
    finally {
      Remove-Item -LiteralPath $treeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Step 'The witness refuses the state directory on this machine'

    # It hashes file CONTENTS, and the real one holds this machine's Google token
    # and credentials. So it is allowed to read a state directory only under
    # the sandbox account, and this is that refusal, seen firing.
    $refusedWitness = $false
    $refusalSaid = ''
    try { $null = New-PigeonStateWitness -StateDir (Join-Path $HOME '.photo-pigeon') }
    catch { $refusedWitness = $true; $refusalSaid = $_.Exception.Message }
    Test-Case -Name 'New-PigeonStateWitness refuses the live state directory' -Condition $refusedWitness `
      -Detail $(if ($refusedWitness) { $refusalSaid } else { 'it hashed the real directory, which means it opened the token' })

    Write-Step 'The Run value assertions, against a value under a rig-scoped name'

    # The same trick the M3 block above uses: a value the rig is allowed to write,
    # pointing at an exe the rig made, so all seven assertions are seen passing
    # before an installed copy exists to write a real one.
    $sbxDir = Join-Path $env:TEMP "photo-pigeon-e2e\selftest-sbxrun-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
    $null = New-Item -ItemType Directory -Path $sbxDir -Force
    $sbxExe = Join-Path $sbxDir $facts.exeName
    Set-Content -LiteralPath $sbxExe -Value 'not really an exe' -Encoding utf8NoBOM
    $sbxName = "$($script:RigRunValuePrefix)sandbox-$([System.Guid]::NewGuid().ToString('N').Substring(0,6))"
    try {
      $null = Set-RigRunValue -Name $sbxName -Data "`"$sbxExe`" $($facts.bootFlag)"
      $value = Get-PigeonRunValue -Name $sbxName
      $good = @(Get-PigeonRunValueChecks -Data $value.data -Kind $value.kind -ExpectedExe $sbxExe -ExpectedFlag $facts.bootFlag)
      Test-Case -Name 'a correct Run value passes all seven' `
        -Condition ((Get-PigeonFailCount -Checks $good) -eq 0) -Detail "$($good.Count) checks"

      $null = Set-RigRunValue -Name $sbxName -Data "$sbxExe --hidden"
      $value = Get-PigeonRunValue -Name $sbxName
      $bad = @(Get-PigeonRunValueChecks -Data $value.data -Kind $value.kind -ExpectedExe $sbxExe -ExpectedFlag $facts.bootFlag)
      Test-Case -Name 'and the unquoted value with the wrong flag fails at least three' `
        -Condition ((Get-PigeonFailCount -Checks $bad) -ge 3) `
        -Detail (@($bad | Where-Object { $_.status -eq 'fail' } | ForEach-Object { $_.name }) -join '; ')

      $absent = @(Get-PigeonRunValueChecks -Data '' -Kind '' -ExpectedExe $sbxExe -ExpectedFlag $facts.bootFlag)
      Test-Case -Name 'and no value at all is one failure that says what it means' `
        -Condition ($absent.Count -eq 1 -and $absent[0].status -eq 'fail') -Detail $absent[0].detail
    }
    finally {
      $null = Remove-RigRunValue -Name $sbxName
      Remove-Item -LiteralPath $sbxDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-RigSummary
exit ($(if ($script:Failed) { 1 } else { 0 }))
