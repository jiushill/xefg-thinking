# XeFG control surface for the experiment.
#
#   . .\vm\toggle.ps1
#   Show-Xefg
#   Set-Xefg -Enabled $false                      # baseline
#   Set-Xefg -Enabled $true -Gear default         # evidence gate on (ship default)
#   Set-Xefg -Enabled $true -Gear gateoff         # ablation: gate ignored
#
#   Set-XefgProtocol -Path .\vm\protocol-v1.txt   # hot-swap the protocol text
#   Clear-XefgProtocol                            # back to the built-in text

$script:XefgUrl = 'http://127.0.0.1:3080/xefg-think/state'

$script:GEARS = @{
  default  = @{ tauFlow = 0.45; tauRoundTrip = 0.35; tauSupport = 0.4; beta = 6; holeMax = 0.25; tauRedundant = 0.8; redundantMax = 0.5; weakAsHole = $false; maxRefDepth = 3; evidenceGate = 'hole' }
  strict   = @{ tauFlow = 0.55; tauRoundTrip = 0.35; tauSupport = 0.4; beta = 6; holeMax = 0.20; tauRedundant = 0.8; redundantMax = 0.5; weakAsHole = $true;  maxRefDepth = 3; evidenceGate = 'hole' }
  lenient  = @{ tauFlow = 0.35; tauRoundTrip = 0.35; tauSupport = 0.4; beta = 6; holeMax = 0.50; tauRedundant = 0.8; redundantMax = 0.5; weakAsHole = $false; maxRefDepth = 3; evidenceGate = 'hole' }
  gateoff  = @{ tauFlow = 0.45; tauRoundTrip = 0.35; tauSupport = 0.4; beta = 6; holeMax = 0.25; tauRedundant = 0.8; redundantMax = 0.5; weakAsHole = $false; maxRefDepth = 3; evidenceGate = 'off' }
  gatewarn = @{ tauFlow = 0.45; tauRoundTrip = 0.35; tauSupport = 0.4; beta = 6; holeMax = 0.25; tauRedundant = 0.8; redundantMax = 0.5; weakAsHole = $false; maxRefDepth = 3; evidenceGate = 'warn' }
}

function Show-Xefg {
  $s = Invoke-RestMethod -Uri $script:XefgUrl -Method GET -TimeoutSec 8
  # `params` arrives as an object from Invoke-RestMethod, but tolerate a string
  # in case a build serialises it differently.
  $p = if ($s.params -is [string]) { $s.params | ConvertFrom-Json } else { $s.params }
  [pscustomobject]@{
    enabled        = $s.enabled
    version        = $s.version
    engine         = $s.engine
    protocolCustom = $s.protocolCustom
    protocolChars  = $s.protocolChars
    calls          = $s.stats.calls
    holes          = $s.stats.holes
    assumed        = $s.stats.assumed
    dropped        = $s.stats.dropped
    saved          = $s.stats.tokensSaved
    gate           = $p.evidenceGate
  }
}

function Set-Xefg {
  param(
    [Parameter(Mandatory)][bool]$Enabled,
    [ValidateSet('default', 'strict', 'lenient', 'gateoff', 'gatewarn')][string]$Gear = 'default',
    [switch]$ResetStats
  )
  $body = @{ enabled = $Enabled; params = $script:GEARS[$Gear] }
  if ($ResetStats) { $body.resetStats = $true }
  $json = $body | ConvertTo-Json -Depth 6 -Compress
  $r = Invoke-RestMethod -Uri $script:XefgUrl -Method POST -ContentType 'application/json' -Body $json -TimeoutSec 8
  return $r
}

function Set-XefgProtocol {
  param([Parameter(Mandatory)][string]$Path)
  $out = & node (Join-Path $PSScriptRoot 'setproto.mjs') $Path
  "$out"
}

function Clear-XefgProtocol {
  $out = & node (Join-Path $PSScriptRoot 'setproto.mjs') --clear
  "$out"
}