<#
.SYNOPSIS
  Starts the Agents Manager Studio and keeps a small helper running on Windows.

.DESCRIPTION
  The Studio runs in containers and cannot change its own folder mounts. This helper does it on the host:
  the server drops a request in host-helper\request.json, the helper checks the folder, updates .env and runs
  "docker compose up -d", which recreates the server with the new central folder.

  .\studio.ps1                     docker compose up -d, then starts the helper in the background
  .\studio.ps1 -Install            also starts the helper with Windows (shortcut in the user's Startup folder)
  .\studio.ps1 -Uninstall          removes that shortcut and stops the helper
  .\studio.ps1 -ProjectsDir E:/X   changes the central folder once, without the helper
  Add -Dev to use docker-compose.dev.yml (hot reload) in every mode.

  Only ASCII here: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#>
[CmdletBinding()]
param(
  [string]$ProjectsDir,
  [string]$Exclude,
  [switch]$NoExclude,
  [switch]$Dev,
  [switch]$Watch,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$StudioDir = $PSScriptRoot
$HelperDir = Join-Path $StudioDir 'host-helper'
$EnvFile = Join-Path $StudioDir '.env'
$LogFile = Join-Path $HelperDir 'helper.log'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Agents Manager Studio helper.lnk'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Get-ComposeArgs {
  $files = @('-f', (Join-Path $StudioDir 'docker-compose.yml'))
  if ($Dev) { $files += @('-f', (Join-Path $StudioDir 'docker-compose.dev.yml')) }
  return $files
}

function Write-Json([string]$Path, $Value) {
  $tmp = "$Path.tmp"
  [IO.File]::WriteAllText($tmp, ($Value | ConvertTo-Json -Compress -Depth 5), $Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Write-Log([string]$Text) {
  New-Item -ItemType Directory -Force -Path $HelperDir | Out-Null
  Add-Content -LiteralPath $LogFile -Value ('{0} {1}' -f (Get-Date -Format 's'), $Text)
}

# Same rules as the server (server/src/modules/studio-settings/projects-root.ts), plus "the folder exists".
function Test-ProjectsDir([string]$Dir) {
  $path = ($Dir.Trim() -replace '\\', '/').TrimEnd('/')
  if ($path -notmatch '^[A-Za-z]:/.+') { return @{ code = 'invalid_path' } }
  if ($path -match '["''`$;|&<>*?]') { return @{ code = 'invalid_path' } }
  if ($path -match '^[A-Za-z]:/(Windows|Program Files|Program Files \(x86\)|ProgramData)(/|$)') { return @{ code = 'system_folder' } }
  if ($path -match '^[A-Za-z]:/Users(/[^/]+)?$') { return @{ code = 'system_folder' } }
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { return @{ code = 'not_found' } }
  return @{ code = $null; path = $path }
}

function Set-EnvValues([hashtable]$Values) {
  if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'env_missing' }
  $text = [IO.File]::ReadAllText($EnvFile)
  # Keeps the file's own line endings.
  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = [Collections.Generic.List[string]]($text.TrimEnd("`r", "`n") -split "`r?`n")
  foreach ($name in $Values.Keys) {
    $line = "$name=$($Values[$name])"
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$name\s*=") { $index = $i; break } }
    if ($index -ge 0) { $lines[$index] = $line } else { $lines.Add($line) }
  }
  [IO.File]::WriteAllText($EnvFile, ([string]::Join($newline, $lines) + $newline), $Utf8NoBom)
}

function Invoke-Compose {
  $composeArgs = (Get-ComposeArgs) + @('up', '-d')
  # Compose prints progress on stderr; with 'Stop' PowerShell 5.1 would treat that as a failure.
  $ErrorActionPreference = 'Continue'
  $output = & docker compose @composeArgs 2>&1 | ForEach-Object { "$_" } | Out-String
  if ($output) { Write-Log $output.Trim() }
  if ($LASTEXITCODE -ne 0) { throw "compose_failed: $($output.Trim() | Select-Object -Last 1)" }
}

# Validates, updates .env and recreates the containers. Returns $null or an error code.
function Set-ProjectsDir([string]$Dir, $ExcludeNames) {
  $check = Test-ProjectsDir $Dir
  if ($check.code) { return $check.code }
  $values = @{ PROJECTS_HOST_DIR = $check.path }
  if ($null -ne $ExcludeNames) { $values['SCAN_EXCLUDE'] = (@($ExcludeNames) -join ',') }
  Set-EnvValues $values
  Write-Log "PROJECTS_HOST_DIR=$($check.path)"
  Invoke-Compose
  return $null
}

function Start-HelperInBackground {
  $arguments = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Watch')
  if ($Dev) { $arguments += '-Dev' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

function Stop-Helper {
  $state = Join-Path $HelperDir 'helper.json'
  if (-not (Test-Path -LiteralPath $state)) { return }
  $helperPid = (Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).pid
  $process = Get-Process -Id $helperPid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -like 'powershell*') { Stop-Process -Id $helperPid -Force }
  Remove-Item -LiteralPath $state -Force
}

# What the Windows machine is using (the Docker numbers miss everything outside the VM): CPU, memory and fixed disks.
function Get-HostStats {
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    @{ drive = $_.DeviceID; total = [double]$_.Size; free = [double]$_.FreeSpace }
  })
  return @{
    cpuPercent = [double]$cpu
    memoryTotal = [double]$os.TotalVisibleMemorySize * 1024
    memoryUsed = ([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory) * 1024
    disks = $disks
    sampledAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Start-Watch {
  # One helper per user session.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\AgentsManagerStudioHelper')
  if (-not $mutex.WaitOne(0)) { return }
  New-Item -ItemType Directory -Force -Path $HelperDir | Out-Null
  $requestFile = Join-Path $HelperDir 'request.json'
  $resultFile = Join-Path $HelperDir 'result.json'
  $stateFile = Join-Path $HelperDir 'helper.json'
  $startedAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-Log 'helper started'

  $hostStats = $null
  $tick = 0
  while ($true) {
    # Sampled every ~10 s: the CIM queries cost more than the heartbeat.
    if ($tick % 5 -eq 0) { try { $hostStats = Get-HostStats } catch { $hostStats = $null } }
    $tick++
    Write-Json $stateFile @{ pid = $PID; dev = [bool]$Dev; startedAt = $startedAt; heartbeatAt = (Get-Date).ToUniversalTime().ToString('o'); host = $hostStats }

    if (Test-Path -LiteralPath $requestFile) {
      $request = $null
      try { $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json } catch { }
      Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
      if ($request -and $request.type -eq 'projects-root') {
        Write-Json $resultFile @{ id = $request.id; status = 'applying'; code = $null; at = (Get-Date).ToUniversalTime().ToString('o') }
        $code = $null
        try { $code = Set-ProjectsDir $request.projectsDir $request.exclude } catch { $code = "$($_.Exception.Message)" }
        if ($code) { Write-Log "request $($request.id) failed: $code" }
        Write-Json $resultFile @{ id = $request.id; status = $(if ($code) { 'error' } else { 'done' }); code = $code; at = (Get-Date).ToUniversalTime().ToString('o') }
      }
    }
    Start-Sleep -Seconds 2
  }
}

if ($Watch) { Start-Watch; return }

if ($Uninstall) {
  if (Test-Path -LiteralPath $ShortcutPath) { Remove-Item -LiteralPath $ShortcutPath -Force }
  Stop-Helper
  Write-Host 'Helper removed from Startup and stopped.'
  return
}

if ($ProjectsDir) {
  $names = $null
  if ($NoExclude) { $names = @() } elseif ($Exclude) { $names = $Exclude -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
  $code = Set-ProjectsDir $ProjectsDir $names
  if ($code) { Write-Error "Central folder not changed: $code"; exit 1 }
  Write-Host "Central folder set to $ProjectsDir. The Studio is restarting."
  return
}

if ($Install) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = 'powershell.exe'
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Watch$(if ($Dev) { ' -Dev' })"
  $shortcut.WorkingDirectory = $StudioDir
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  Write-Host "Helper will start with Windows: $ShortcutPath"
}

Invoke-Compose
Start-HelperInBackground
Write-Host 'Studio started: http://studio.localhost (helper running in the background).'
