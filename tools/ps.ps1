# Dot-source this file, then use Run-Remote.
#
#   . .\vm\ps.ps1
#   Run-Remote 'id'
#   Run-Remote 'cat > /tmp/x' -StdinFile .\local.bin
#
# Password auth on Windows OpenSSH: with no TTY on stdin, ssh delegates the
# passphrase to SSH_ASKPASS. Redirection keeps stdin non-interactive so the
# prompt never blocks.

$ErrorActionPreference = 'Continue'
$script:VMHost = ("$env:VM_USER@$env:VM_HOST")
$script:NullIn = Join-Path $env:TEMP 'vm-null-in.txt'
if (-not (Test-Path $script:NullIn)) { Set-Content -Path $script:NullIn -Value '' -Encoding ascii }

$env:SSH_ASKPASS = $PSScriptRoot + '\xap.cmd'
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY = ':0'

function Run-Remote {
  param(
    [Parameter(Mandatory, Position = 0)][string]$Command,
    [string]$StdinFile,
    [int]$TimeoutSec = 300
  )
  $o = [IO.Path]::GetTempFileName()
  $e = [IO.Path]::GetTempFileName()
  $inFile = if ($StdinFile) { (Resolve-Path $StdinFile).Path } else { $script:NullIn }
  # PowerShell 5.1 joins -ArgumentList with spaces and does not quote, so a
  # command containing quotes gets shredded. Ship it base64-encoded instead:
  # the remote side decodes and runs it, and the wire form needs no quoting.
  # The stdin-file form must stay a plain command because bash would eat stdin.
  if ($StdinFile) {
    $remote = $Command
  } else {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
    $remote = 'printf %s ' + $b64 + ' | base64 -d | bash'
  }
  $argList = @(
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=20',
    '-o', 'PreferredAuthentications=password',
    '-o', 'PubkeyAuthentication=no',
    $script:VMHost,
    $remote
  )
  $p = Start-Process -FilePath 'ssh' -ArgumentList $argList -NoNewWindow -PassThru `
    -RedirectStandardInput $inFile -RedirectStandardOutput $o -RedirectStandardError $e
  $ok = $p.WaitForExit($TimeoutSec * 1000)
  if (-not $ok) {
    try { $p.Kill() } catch {}
    Write-Output "TIMEOUT after ${TimeoutSec}s: $Command"
  }
  $stdout = Get-Content $o -Raw -ErrorAction SilentlyContinue
  $stderr = Get-Content $e -Raw -ErrorAction SilentlyContinue
  Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
  if ($stdout) { Write-Output $stdout.TrimEnd() }
  if ($stderr) { Write-Output ('[stderr] ' + $stderr.TrimEnd()) }
}
