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

  Compacting Docker's disk (asked from the Studio): the helper stops Docker Desktop, runs diskpart as administrator
  (Windows asks the user), starts Docker and the Studio again, and serves the progress on http://localhost:8790
  while the Studio is down.

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
  [switch]$Uninstall,
  [switch]$Compact,
  [string]$CompactId,
  [switch]$StatusServer,
  [int]$StatusPort = 8790
)

$ErrorActionPreference = 'Stop'
$StudioDir = $PSScriptRoot
$HelperDir = Join-Path $StudioDir 'host-helper'
$EnvFile = Join-Path $StudioDir '.env'
$LogFile = Join-Path $HelperDir 'helper.log'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Agents Manager Studio helper.lnk'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$CompactFile = Join-Path $HelperDir 'compaction.json'
$StudioUrl = 'http://studio.localhost'

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
  # Docker's virtual disk (it grows and only gives space back to Windows when compacted).
  $dockerDisk = $null
  $vhdx = Get-DockerVhdx
  if ($vhdx) { $dockerDisk = @{ path = $vhdx; size = [double](Get-Item -LiteralPath $vhdx).Length } }
  return @{
    dockerDisk = $dockerDisk
    cpuPercent = [double]$cpu
    memoryTotal = [double]$os.TotalVisibleMemorySize * 1024
    memoryUsed = ([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory) * 1024
    disks = $disks
    sampledAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}

# Docker's virtual disk file, from Docker Desktop's settings ($null when not found).
function Get-DockerVhdx {
  try {
    $settings = Get-Content -LiteralPath (Join-Path $env:APPDATA 'Docker\settings-store.json') -Raw | ConvertFrom-Json
    $dataDir = if ($settings.CustomWslDistroDir) { $settings.CustomWslDistroDir } else { Join-Path $env:LOCALAPPDATA 'Docker\wsl' }
    $vhdx = Join-Path $dataDir 'disk\docker_data.vhdx'
    if (Test-Path -LiteralPath $vhdx) { return $vhdx }
  } catch { }
  return $null
}

function Get-DockerDesktopExe {
  foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'), (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'))) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Test-DockerUp {
  $ErrorActionPreference = 'Continue'
  & docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Test-StudioUp {
  try { return ((Invoke-WebRequest -UseBasicParsing -Uri "$StudioUrl/api/health" -TimeoutSec 5).StatusCode -eq 200) } catch { return $false }
}

# Stops Docker, compacts its disk file with diskpart (elevated), starts Docker and the Studio again. The state goes to
# compaction.json (read by the status page and, once it is back, by the Studio, which resumes the paused agents).
function Invoke-Compaction([string]$Id) {
  $state = [ordered]@{ id = $Id; status = 'running'; step = 'stopping_docker'; percent = $null; vhdxPath = $null; sizeBefore = $null; sizeAfter = $null; error = $null
    startedAt = (Get-Date).ToUniversalTime().ToString('o'); updatedAt = $null; finishedAt = $null }
  $save = { $state.updatedAt = (Get-Date).ToUniversalTime().ToString('o'); Write-Json $CompactFile $state }
  $setStep = { param($name) $state.step = $name; & $save; Write-Log "compaction $($Id): $name" }
  $ErrorActionPreference = 'Continue'
  try {
    $vhdx = Get-DockerVhdx
    if (-not $vhdx) { throw 'vhdx_not_found' }
    $state.vhdxPath = $vhdx
    $state.sizeBefore = [double](Get-Item -LiteralPath $vhdx).Length
    & $setStep 'stopping_docker'
    & docker desktop stop 2>&1 | Out-Null
    Stop-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -Force -ErrorAction SilentlyContinue
    & wsl --shutdown 2>&1 | Out-Null
    Start-Sleep -Seconds 15

    & $setStep 'compacting'
    $script = Join-Path $HelperDir 'compact-diskpart.txt'
    $output = Join-Path $HelperDir 'compact-diskpart.log'
    Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($script, ("select vdisk file=`"$vhdx`"`r`nattach vdisk readonly`r`ncompact vdisk`r`ndetach vdisk`r`nexit`r`n"), (New-Object System.Text.ASCIIEncoding))
    # Windows asks the user to allow it (administrator); refusing ends with an error and Docker starts again.
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c diskpart /s `"$script`" > `"$output`" 2>&1" -Verb RunAs -WindowStyle Hidden -PassThru
    while (-not $process.HasExited) {
      Start-Sleep -Seconds 5
      if (Test-Path -LiteralPath $output) {
        $match = Select-String -LiteralPath $output -Pattern '(\d+)\s+(percent|por cento)' -AllMatches -ErrorAction SilentlyContinue | Select-Object -Last 1
        if ($match) {
          $value = [int]$match.Matches[-1].Groups[1].Value
          if ($value -ne $state.percent) { $state.percent = $value; & $save }
        }
      }
    }
    $log = if (Test-Path -LiteralPath $output) { Get-Content -LiteralPath $output -Raw } else { '' }
    # Success by the exit code; the message (English or Portuguese Windows) is a second check.
    $ok = ($process.ExitCode -eq 0) -or ($log -match 'successfully compacted|compactou com .xito')
    if (-not $ok) { throw "diskpart: $(($log -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' ')" }
    $state.percent = 100
    $state.sizeAfter = [double](Get-Item -LiteralPath $vhdx).Length
  } catch {
    $state.error = "$($_.Exception.Message)"
    Write-Log "compaction $($Id) failed: $($state.error)"
  }

  # Docker and the Studio come back in any case.
  try {
    & $setStep 'starting_docker'
    if (-not (Test-DockerUp)) {
      $exe = Get-DockerDesktopExe
      if ($exe) { Start-Process -FilePath $exe | Out-Null }
      $deadline = (Get-Date).AddMinutes(10)
      while (-not (Test-DockerUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
      if (-not (Test-DockerUp)) { throw 'docker_did_not_start' }
    }
    & $setStep 'starting_studio'
    Invoke-Compose
    $deadline = (Get-Date).AddMinutes(5)
    while (-not (Test-StudioUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
  } catch {
    if (-not $state.error) { $state.error = "$($_.Exception.Message)" }
  }
  $state.status = $(if ($state.error) { 'error' } else { 'done' })
  $state.step = 'finished'
  $state.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  & $save
  Write-Log "compaction $($Id) $($state.status)"
}

# The progress page while the Studio is down (ASCII only: accents as HTML entities).
$StatusPage = @'
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compress&atilde;o do disco</title>
<style>
:root{--bg:#0b0d12;--panel:#141821;--line:#232937;--muted:#8b93a7;--text:#e9ecf2;--accent:#7c9cff;--ok:#6ee7b7;--err:#fca5a5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(1200px 600px at 50% -10%,#1a2140 0,var(--bg) 60%);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:620px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 20px 60px #0008}
.top{display:flex;align-items:center;gap:12px}.dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 6px #7c9cff22;animation:pulse 1.6s infinite}
.dot.ok{background:var(--ok);box-shadow:0 0 0 6px #6ee7b722;animation:none}.dot.err{background:var(--err);box-shadow:0 0 0 6px #fca5a522;animation:none}
@keyframes pulse{50%{box-shadow:0 0 0 10px #7c9cff11}}
h1{font-size:18px;margin:0}.sub{color:var(--muted);margin:6px 0 0}
.big{display:flex;align-items:baseline;gap:10px;margin:26px 0 8px}.pct{font-size:64px;font-weight:700;letter-spacing:-2px;font-variant-numeric:tabular-nums}.pct small{font-size:28px;color:var(--muted);font-weight:600}
.step{color:var(--muted)}.bar{height:12px;background:#0e1118;border:1px solid var(--line);border-radius:999px;overflow:hidden}
.bar div{height:100%;width:0;background:linear-gradient(90deg,#5b7cff,#9ab0ff);border-radius:999px;transition:width .8s ease}
.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:8px;font-variant-numeric:tabular-nums}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0}.card{background:#0e1118;border:1px solid var(--line);border-radius:12px;padding:12px}
.card b{display:block;font-size:18px;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:12px}
ol{list-style:none;padding:0;margin:0;display:grid;gap:8px}li{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;color:var(--muted)}
li i{width:20px;height:20px;border-radius:50%;border:2px solid var(--line);flex:none;display:grid;place-items:center;font-style:normal;font-size:12px}
li.done{color:var(--text)}li.done i{border-color:var(--ok);color:var(--ok)}li.now{color:var(--text);border-color:#7c9cff66;background:#7c9cff0d}
li.now i{border-color:var(--accent);border-top-color:transparent;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.err{color:var(--err);margin-top:16px}.foot{color:var(--muted);font-size:12px;margin-top:18px}a{color:var(--accent)}
@media(max-width:520px){.cards{grid-template-columns:1fr}.pct{font-size:52px}}
</style></head><body><main>
<div class="top"><span id="dot" class="dot"></span><div><h1>Compress&atilde;o do disco do Docker</h1>
<p class="sub">O Studio fica desligado enquanto o disco &eacute; comprimido. Esta p&aacute;gina &eacute; do helper do Windows; quando o Studio voltar, ela leva voc&ecirc; para ele.</p></div></div>
<div class="big"><span class="pct" id="pct">&ndash;</span><span class="step" id="label">Preparando</span></div>
<div class="bar"><div id="bar"></div></div><div class="meta"><span id="elapsed"></span><span id="eta"></span></div>
<div class="cards"><div class="card"><span>Antes</span><b id="before">&ndash;</b></div><div class="card"><span>Depois</span><b id="after">&ndash;</b></div><div class="card"><span>Devolvido ao Windows</span><b id="freed">&ndash;</b></div></div>
<ol id="steps"></ol><div id="error" class="err"></div><p class="foot" id="foot"></p></main>
<script>
const STEPS=[["stopping_docker","Parando o Docker"],["compacting","Comprimindo o arquivo do disco"],["starting_docker","Ligando o Docker"],["starting_studio","Ligando o Studio"],["finished","Pronto"]];
const $=id=>document.getElementById(id),gb=b=>b?(b/1073741824).toFixed(1)+" GB":"\u2013";
const fmt=s=>{s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return h?h+"h "+m+"min":m?m+"min "+r+"s":r+"s"};
let seen=[];
function overall(s){const at=STEPS.findIndex(x=>x[0]===s.step);if(s.step==="finished")return 100;if(s.step==="compacting")return 5+(s.percent||0)*0.85;return [2,5,90,95,100][Math.max(0,at)]}
async function tick(){let s;try{s=await (await fetch("/status.json",{cache:"no-store"})).json()}catch(e){return}
const at=STEPS.findIndex(x=>x[0]===s.step),done=s.status!=="running",p=s.step==="compacting"&&s.percent!=null?s.percent:null;
$("pct").innerHTML=p!=null?p+"<small>%</small>":done?(s.status==="done"?"100<small>%</small>":"!"):"&ndash;";
$("label").textContent=done?(s.status==="done"?"Conclu\u00eddo":"Terminou com erro"):(STEPS[at]?STEPS[at][1]:"Preparando");
$("bar").style.width=(p!=null?p:overall(s))+"%";$("dot").className="dot"+(done?(s.status==="done"?" ok":" err"):"");
$("steps").innerHTML=STEPS.map((x,i)=>{const c=(i<at||s.step==="finished")?"done":i===at?"now":"";return '<li class="'+c+'"><i>'+(c==="done"?"\u2713":"")+"</i>"+x[1]+(x[0]==="compacting"&&p!=null&&c==="now"?" \u00b7 "+p+"%":"")+"</li>"}).join("");
const started=s.startedAt?new Date(s.startedAt):null,end=s.finishedAt?new Date(s.finishedAt):new Date();
$("elapsed").textContent=started?"Tempo: "+fmt((end-started)/1000):"";
if(p!=null){seen.push([Date.now(),p]);seen=seen.filter(x=>Date.now()-x[0]<600000);const a=seen[0];const rate=(p-a[1])/((Date.now()-a[0])/1000);
$("eta").textContent=rate>0?"Faltam ~"+fmt((100-p)/rate)+" na compress\u00e3o":"Calculando o tempo restante\u2026"}else $("eta").textContent=done?"":"";
$("before").textContent=gb(s.sizeBefore);$("after").textContent=gb(s.sizeAfter);$("freed").textContent=s.sizeAfter&&s.sizeBefore?gb(s.sizeBefore-s.sizeAfter):"\u2013";
$("error").textContent=s.error?"Erro: "+s.error:"";
$("foot").innerHTML=done?'<a href="__STUDIO__/sistema/compressao">Voltar ao Studio</a> (em instantes leva voc\u00ea sozinho)':"Atualiza sozinho a cada 3 segundos.";
if(done)setTimeout(()=>location.href="__STUDIO__/sistema/compressao",8000)}
tick();setInterval(tick,3000);
</script></body></html>
'@

function Start-StatusServer {
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://localhost:$StatusPort/")
  try { $listener.Start() } catch { Write-Log "status page could not start: $($_.Exception.Message)"; return }
  Write-Log "status page on http://localhost:$StatusPort"
  $page = [Text.Encoding]::UTF8.GetBytes($StatusPage.Replace('__STUDIO__', $StudioUrl))
  $finishedAt = $null
  while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(2000)) {
      # Stays up 10 minutes after the compaction ends, so the page can show the result and send the user back.
      $current = $null
      try { $current = Get-Content -LiteralPath $CompactFile -Raw | ConvertFrom-Json } catch { }
      if ($current -and $current.status -ne 'running') { if (-not $finishedAt) { $finishedAt = Get-Date } }
      if ($finishedAt -and ((Get-Date) - $finishedAt).TotalMinutes -gt 10) { $listener.Stop(); return }
    }
    $context = $listener.EndGetContext($async)
    $response = $context.Response
    $response.Headers.Add('Access-Control-Allow-Origin', '*')
    if ($context.Request.Url.AbsolutePath -eq '/status.json') {
      $json = if (Test-Path -LiteralPath $CompactFile) { [IO.File]::ReadAllText($CompactFile) } else { '{}' }
      $bytes = [Text.Encoding]::UTF8.GetBytes($json)
      $response.ContentType = 'application/json; charset=utf-8'
    } else {
      $bytes = $page
      $response.ContentType = 'text/html; charset=utf-8'
    }
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
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
      if ($request -and $request.type -eq 'compact-docker') {
        # Its own processes: the compaction (it stops Docker) and the progress page; this loop keeps its heartbeat.
        Write-Json $CompactFile @{ id = $request.id; status = 'running'; step = 'starting'; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
        $common = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        if ($Dev) { $common += '-Dev' }
        Start-Process -FilePath 'powershell.exe' -ArgumentList ($common + @('-StatusServer')) -WindowStyle Hidden | Out-Null
        Start-Process -FilePath 'powershell.exe' -ArgumentList ($common + @('-Compact', '-CompactId', $request.id)) -WindowStyle Hidden | Out-Null
      }
    }
    Start-Sleep -Seconds 2
  }
}

if ($Watch) { Start-Watch; return }
if ($Compact) { Invoke-Compaction $CompactId; return }
if ($StatusServer) { Start-StatusServer; return }

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
