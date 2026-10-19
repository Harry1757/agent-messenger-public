param(
  [ValidateSet('install','remove')][string]$Action = 'install',
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$ProjectPath
)
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "AgentMessenger-$sid"
if ($Action -eq 'remove') {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Write-Output 'Background task removed. Configuration and logs retained.'
  exit
}
$entry = Join-Path $ProjectPath 'daemon\background.ts'
$arguments = '--experimental-strip-types --disable-warning=ExperimentalWarning "' + $entry + '"'
$taskAction = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Background task installed. Starts at sign-in and restarts after failure.'
