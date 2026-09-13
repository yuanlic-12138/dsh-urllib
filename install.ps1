#requires -version 5.1
<#
  dsh-urllib installer / repair for the CURRENT machine.

  Does three things:
    1. finds a usable Node.js and reports its version
    2. creates an empty library.json if this is a fresh copy (never touches existing data)
    3. (re)creates the desktop shortcut that opens the URL library

  Run it by double-clicking install.vbs next to this file.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as GBK,
        so non-ASCII source text here would be corrupted on a Chinese system.
        The shortcut name is built from code points for exactly that reason.
#>
[CmdletBinding()]
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$allOk = $true

function Find-Node {
    $candidates = @(
        (Join-Path $here 'node.exe'),
        (Join-Path $here 'node\node.exe'),
        (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source,
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

Write-Host ''
Write-Host '  dsh-urllib - install on this machine' -ForegroundColor Cyan
Write-Host '  -----------------------------------' -ForegroundColor DarkGray
Write-Host "  folder: $here"
Write-Host ''

# ---- 1. Node.js ----
$node = Find-Node
if ($node) {
    $verText = ((& $node -v) 2>$null) -join ''
    $major = 0
    if ($verText -match '^v(\d+)') { $major = [int]$Matches[1] }
    if ($major -ge 14) {
        Write-Host "  [ok]   Node.js $verText" -ForegroundColor Green
        Write-Host "         $node"
    } else {
        $allOk = $false
        Write-Host "  [FAIL] Node.js $verText is too old (need v14 or newer)." -ForegroundColor Red
        Write-Host '         Install a current LTS from https://nodejs.org/ and run me again.'
    }
} else {
    $allOk = $false
    Write-Host '  [FAIL] Node.js not found.' -ForegroundColor Red
    Write-Host '         Either install the LTS build from https://nodejs.org/ ,'
    Write-Host '         or drop a portable node.exe into this folder and run me again.'
}

# ---- 2. data file ----
$dataFile = Join-Path $here 'library.json'
if (Test-Path $dataFile) {
    Write-Host '  [ok]   library.json found - your collection is kept as is.' -ForegroundColor Green
} else {
    $empty = @'
{
  "schema": "dsh-urllib/v1",
  "updatedAt": "",
  "items": []
}
'@
    Set-Content -Path $dataFile -Value $empty -Encoding ASCII
    Write-Host '  [ok]   created an empty library.json' -ForegroundColor Green
}

# ---- 3. desktop shortcut ----
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutName = [string]([char]0x7F51) + [char]0x5740 + [char]0x5E93   # wang zhi ku
    $lnkPath = Join-Path $desktop ($shortcutName + '.lnk')
    $vbs = Join-Path $here 'start-urllib.vbs'
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if (-not (Test-Path $vbs)) { throw "start-urllib.vbs is missing from $here" }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $wscript
    $lnk.Arguments = '"' + $vbs + '"'
    $lnk.WorkingDirectory = $here
    $lnk.Description = 'Open the URL library (standalone local server)'
    $lnk.Save()
    Write-Host '  [ok]   desktop shortcut created:' -ForegroundColor Green
    Write-Host "         $lnkPath"
} catch {
    $allOk = $false
    Write-Host "  [FAIL] could not create the desktop shortcut: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
if ($allOk) {
    Write-Host '  Done. Double-click the desktop icon to open the URL library.' -ForegroundColor Cyan
} else {
    Write-Host '  Finished with problems - see the FAIL lines above.' -ForegroundColor Yellow
}
Write-Host ''

if (-not $NoPause) {
    Write-Host 'Press Enter to close...'
    [void](Read-Host)
}
