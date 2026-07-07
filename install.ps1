# EAP — one-line installer for Windows PowerShell.
#
#   irm https://raw.githubusercontent.com/jqbit/EAP/main/install.ps1 | iex
#
# Pass flags via the EAP_ARGS env var, e.g.:
#   $env:EAP_ARGS='--only claude'; irm https://raw.githubusercontent.com/jqbit/EAP/main/install.ps1 | iex
#
# Env overrides: EAP_HOME (checkout dir, default ~\.eap-src), EAP_REPO
# (owner/repo), EAP_BRANCH (default main), EAP_NONINTERACTIVE=1.
#
# This bootstrap checks git + Node >=22, clones/updates the EAP repo, then runs
# the Node installer (interactive TUI in the console, or flags for automation).
$ErrorActionPreference = 'Stop'

$Repo    = if ($env:EAP_REPO)   { $env:EAP_REPO }   else { 'jqbit/EAP' }
$Branch  = if ($env:EAP_BRANCH) { $env:EAP_BRANCH } else { 'main' }
$EapHome = if ($env:EAP_HOME)   { $env:EAP_HOME }   else { Join-Path $HOME '.eap-src' }

function Say  ($m) { Write-Host $m -ForegroundColor Cyan }
function Warn ($m) { Write-Host $m -ForegroundColor Yellow }
function Fail ($m) { Write-Host $m -ForegroundColor Red; exit 1 }

Say 'EAP installer — checking prerequisites'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "EAP needs 'git'. Install: winget install Git.Git  (or https://git-scm.com/download/win)"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "EAP needs Node.js >= 22. Install: winget install OpenJS.NodeJS  (or https://nodejs.org)"
}
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) {
  Fail "EAP needs Node.js >= 22 (found $(node -v)). Upgrade: winget upgrade OpenJS.NodeJS"
}
if (-not (Get-Command python3 -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
  Warn '  note: python not found — the EAP-Context graph layer needs it (Voice + Runtime still work; use --no-context to skip).'
}

# Fetch or update the repo.
if (Test-Path (Join-Path $EapHome '.git')) {
  Say "Updating EAP in $EapHome"
  git -C $EapHome pull --ff-only --quiet
} else {
  Say "Cloning $Repo into $EapHome"
  git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" $EapHome
  if ($LASTEXITCODE -ne 0) { Fail "clone failed. If $Repo is private, make it public or run from a local clone." }
}

# Run the installer (console stdin drives the TUI). EAP_ARGS forwards flags.
$installer = Join-Path $EapHome 'bin/eap-install.mjs'
$eapArgs = @()
if ($env:EAP_ARGS) { $eapArgs = $env:EAP_ARGS -split '\s+' }
if ($env:EAP_NONINTERACTIVE) { $eapArgs = @('--non-interactive') + $eapArgs }
node $installer @eapArgs
