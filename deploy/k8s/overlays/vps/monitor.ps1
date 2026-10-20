# Chạy monitor.sh từ PowerShell bằng bash của Git for Windows ("bash" trong PowerShell có thể là bash của WSL).
#   .\deploy\k8s\overlays\vps\monitor.ps1 [ssh-host]
$gitBash = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) 'bin\bash.exe'
if (-not (Test-Path $gitBash)) { throw "Không thấy bash của Git for Windows ở $gitBash" }
& $gitBash (Join-Path $PSScriptRoot 'monitor.sh') @args
