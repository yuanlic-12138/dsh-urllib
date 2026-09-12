#requires -version 5.1
# dsh-urllib launcher.
# Starts the standalone local server (hidden window) if port 3090 is free, then
# opens the UI in the browser. The server removes itself after 180s with no request.
#
# Portable: everything is resolved relative to this file. Node.js is looked up in
# the folder first (drop a node.exe here for a no-install setup), then PATH, then
# the usual install locations.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as GBK.

$ErrorActionPreference = 'Stop'

$port = 3090
if ($env:URLLIB_PORT -and ($env:URLLIB_PORT -as [int])) { $port = [int]$env:URLLIB_PORT }
$url = "http://127.0.0.1:$port/"
$here = $PSScriptRoot
$server = Join-Path $here 'server.mjs'

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

function Test-Up {
    param([int]$P)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $P, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Open-Ui {
    param([string]$Target)
    # Hand the URL to the system default browser. No browser is hard-coded.
    Start-Process $Target | Out-Null
}

if (-not (Test-Up -P $port)) {
    $node = Find-Node
    if (-not $node) { exit 1 }
    Start-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory $here -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if (Test-Up -P $port) { break }
    }
}

Open-Ui -Target $url
