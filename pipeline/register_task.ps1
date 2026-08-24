<#
.SYNOPSIS
    Register / unregister the JACK nightly pipeline as a Windows scheduled task.

.DESCRIPTION
    Registers pipeline\run_daily.cmd to run daily at 19:00 on the machine clock.

    THE CLOCK IS THE CONTRACT. Task Scheduler fires on LOCAL time, so "19:00 ET"
    only holds if the VPS clock is Eastern. Set it once:

        tzutil /s "Eastern Standard Time"

    (That id covers EDT too — Windows shifts it with DST automatically.) The
    orchestrator logs its timezone on every run, so a drift shows up in the
    record instead of silently moving the run relative to the close.
    Use -CheckClock to verify before registering.

.PARAMETER Unregister
    Remove the task entirely. Use this to pull the job if a run misbehaves.

.PARAMETER Disable
    Keep the task but stop it firing. Reversible with -Enable.

.PARAMETER Status
    Show the task's state, last run time, and last result.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1
    powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1 -Status
    powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1 -Disable
    powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1 -Unregister
#>

[CmdletBinding()]
param(
    [switch]$Unregister,
    [switch]$Disable,
    [switch]$Enable,
    [switch]$Status,
    [switch]$RunNow,
    [switch]$CheckClock,
    [string]$TaskName = 'JACK Daily Pipeline',
    [string]$Time     = '19:00',
    [int]$TimeLimitHours = 4
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CmdPath  = Join-Path $PSScriptRoot 'run_daily.cmd'

function Show-Clock {
    $tz = Get-TimeZone
    Write-Host "Machine clock : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Host "Timezone      : $($tz.Id)  ($($tz.DisplayName))"
    if ($tz.Id -notmatch 'Eastern') {
        Write-Warning "Timezone is NOT Eastern. A 19:00 trigger will NOT be 19:00 ET."
        Write-Warning 'Fix with:  tzutil /s "Eastern Standard Time"'
    } else {
        Write-Host "Eastern confirmed - a $Time trigger is $Time ET." -ForegroundColor Green
    }
}

if ($CheckClock) { Show-Clock; return }

if ($Status) {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host "Task '$TaskName' is NOT registered."; return }
    $i = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task        : $TaskName"
    Write-Host "State       : $($t.State)"
    Write-Host "Last run    : $($i.LastRunTime)"
    Write-Host "Last result : $($i.LastTaskResult)  (0=OK, 2x=pull, 3x=detect, 4x=ingest)"
    Write-Host "Next run    : $($i.NextRunTime)"
    Show-Clock
    return
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Unregistered '$TaskName'." -ForegroundColor Yellow
    } else {
        Write-Host "Task '$TaskName' was not registered - nothing to do."
    }
    return
}

if ($Disable) {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Disabled '$TaskName'. It stays registered but will not fire." -ForegroundColor Yellow
    return
}

if ($Enable) {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Enabled '$TaskName'." -ForegroundColor Green
    return
}

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started '$TaskName' now. Watch data\pipeline_state\logs\."
    return
}

# ---- register --------------------------------------------------------------

if (-not (Test-Path $CmdPath)) { throw "Wrapper not found: $CmdPath" }

Show-Clock
Write-Host ''
Write-Host "Registering '$TaskName' -> $CmdPath at $Time daily"

$action = New-ScheduledTaskAction -Execute $CmdPath -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# StartWhenAvailable   : a missed run (reboot, VPS asleep) still fires late
#                        rather than being skipped silently for the night.
# IgnoreNew            : a long pull must never overlap the next night's run.
# ExecutionTimeLimit   : the pull alone is ~30 min at 1s pacing over 1824
#                        tickers; 4h is a generous ceiling that still kills a
#                        genuinely hung run instead of letting it sit forever.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours $TimeLimitHours) `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

# S4U runs the task whether or not the user is logged in, without storing a
# password. On a VPS that matters: nobody is sitting at the console at 19:00.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'JACK nightly: Tiingo pull -> detector -> ingest -> alert. Exit code names the failing stage (20s pull, 30s detect, 40s ingest).' `
    -Force | Out-Null

Write-Host "Registered." -ForegroundColor Green
Write-Host ''
Write-Host "Verify   : powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1 -Status"
Write-Host "Test now : powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1 -RunNow"
Write-Host "Pull it  : powershell -ExecutionPolicy Bypass -File pipeline\register_task.ps1 -Unregister"
Write-Host "Logs     : $RepoRoot\data\pipeline_state\logs\"
