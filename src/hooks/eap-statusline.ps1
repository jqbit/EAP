# EAP statusline companion for Windows / PowerShell.
# Resolves `node` like install.ps1 (Get-Command); never uses cmd.exe %VAR% syntax.
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Dir 'eap-statusline.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  exit 0
}
& node $Script
exit 0
