# Runs IGNITRA on this PC around the clock. Once, in PowerShell as administrator:
#
#   powershell -ExecutionPolicy Bypass -File C:\ignitra-prod\deploy\windows\install.ps1
#
# 1. Registers the scheduled task "IGNITRA". It starts deploy/windows/supervisor.mjs at boot, before
#    anyone signs in, as the current user. Windows keeps no password for it: the task runs as
#    "S4U", which also means it cannot open network shares, and IGNITRA needs none. The task is
#    re-checked every minute, so a stopped supervisor is back within a minute; a running one is
#    left alone. It also keeps running on battery.
# 2. Keeps the PC awake while it is plugged in: no sleep, no hibernation, and closing the lid does
#    nothing. On battery nothing changes.
# 3. Starts the task.
#
# Safe to run again. Undo: Unregister-ScheduledTask -TaskName IGNITRA (and the power settings in
# Settings > System > Power).
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$supervisor = Join-Path $root "deploy\windows\supervisor.mjs"
if (-not (Test-Path (Join-Path $root ".env"))) { throw "no settings in $root\.env yet: run deploy/windows/deploy.mjs --domain <domain> first" }
$node = (Get-Command node -ErrorAction Stop).Source
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$supervisor`"" -WorkingDirectory $root
$atBoot = New-ScheduledTaskTrigger -AtStartup
$everyMinute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 5 `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName "IGNITRA" -Description "IGNITRA backend supervisor ($supervisor)" `
  -Action $action -Trigger $atBoot, $everyMinute -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "scheduled task IGNITRA: runs $supervisor as $user at boot, re-checked every minute"

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
Write-Host "power (plugged in): never sleep or hibernate; closing the lid does nothing"

Start-ScheduledTask -TaskName "IGNITRA"
Write-Host "started. Logs: $root\.data\logs  Health: http://127.0.0.1:4100/health (the port is API_PORT in $root\.env)"
