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
:root{--bg:#07080c;--ink:#eef1f7;--muted:#8a93a8;--faint:#5b6377;--line:rgba(255,255,255,.08);--glass:rgba(20,24,34,.72);--a1:#7aa2ff;--a2:#b38cff;--ok:#5eead4;--err:#fb7185;--ring:rgba(255,255,255,.06)}
@media (prefers-color-scheme:light){:root{--bg:#eef1f8;--ink:#141824;--muted:#5d6579;--faint:#8b93a8;--line:rgba(20,24,40,.09);--glass:rgba(255,255,255,.78);--ring:rgba(20,24,40,.07)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center;padding:28px 16px;overflow-x:hidden}
.aura{position:fixed;inset:-20%;z-index:-1;background:radial-gradient(40% 35% at 25% 20%,rgba(122,162,255,.22),transparent 70%),radial-gradient(35% 30% at 80% 75%,rgba(179,140,255,.18),transparent 70%);filter:blur(20px);animation:drift 18s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate3d(3%,-2%,0) scale(1.05)}}
main{width:100%;max-width:640px;background:var(--glass);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border:1px solid var(--line);border-radius:28px;padding:36px 36px 28px;box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 30px 80px rgba(0,0,0,.35)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.brand svg{width:18px;height:18px}.chip{font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted);display:flex;align-items:center;gap:7px}
.chip i{width:7px;height:7px;border-radius:50%;background:var(--a1);box-shadow:0 0 0 0 rgba(122,162,255,.6);animation:beat 1.8s infinite}
.chip.ok i{background:var(--ok);animation:none}.chip.err i{background:var(--err);animation:none}
@keyframes beat{70%{box-shadow:0 0 0 8px rgba(122,162,255,0)}}
.hero{display:grid;grid-template-columns:auto 1fr;gap:30px;align-items:center;margin:30px 0 26px}
.ring{position:relative;width:184px;height:184px}.ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.ring circle{fill:none;stroke-width:10}.ring .track{stroke:var(--ring)}.ring .fill{stroke:url(#g);stroke-linecap:round;transition:stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)}
.ring .center{position:absolute;inset:0;display:grid;place-items:center;text-align:center}
.pct{font:600 50px/1 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.pct sup{font-size:20px;color:var(--muted);margin-left:2px;vertical-align:top;position:relative;top:6px}
.ring .cap{font-size:11px;color:var(--faint);letter-spacing:.12em;text-transform:uppercase;margin-top:6px}
h1{font:600 24px/1.2 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;letter-spacing:-.02em;margin:0}
.now{margin:8px 0 0;color:var(--muted)}.eta{margin-top:16px;display:flex;gap:18px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.eta div{display:grid}.eta span{font-size:11px;color:var(--faint);letter-spacing:.1em;text-transform:uppercase}.eta b{font-weight:600;font-size:16px}
.steps{position:relative;display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin:6px 0 24px}
.steps .rail{position:absolute;left:10%;right:10%;top:13px;height:2px;background:var(--ring);border-radius:2px}.steps .rail div{height:100%;width:0;border-radius:2px;background:linear-gradient(90deg,var(--a1),var(--a2));transition:width 1s ease}
.step{position:relative;display:grid;justify-items:center;gap:8px;text-align:center;font-size:12px;color:var(--faint)}
.step i{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--bg);border:2px solid var(--ring);font-style:normal;font-size:13px;color:transparent;transition:all .4s}
.step.done{color:var(--muted)}.step.done i{border-color:transparent;background:linear-gradient(135deg,var(--a1),var(--a2));color:#fff}
.step.now{color:var(--ink)}.step.now i{border-color:var(--a1);box-shadow:0 0 0 6px rgba(122,162,255,.14)}.step.now i::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--a1);animation:beat 1.8s infinite}
.stats{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.stats div{padding:14px 16px}.stats div+div{border-left:1px solid var(--line)}.stats span{display:block;font-size:11px;color:var(--faint);letter-spacing:.1em;text-transform:uppercase}
.stats b{font:600 20px/1.3 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}.stats .gain b{background:linear-gradient(90deg,var(--ok),var(--a1));-webkit-background-clip:text;background-clip:text;color:transparent}
.error{display:none;margin-top:18px;padding:12px 14px;border-radius:14px;background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.3);color:var(--err);font-size:13px}
footer{margin-top:20px;display:flex;justify-content:space-between;gap:12px;color:var(--faint);font-size:12px}footer a{color:var(--a1);text-decoration:none}footer a:hover{text-decoration:underline}
@media(max-width:560px){main{padding:26px 20px}.hero{grid-template-columns:1fr;justify-items:center;text-align:center}.eta{justify-content:center}.ring{width:160px;height:160px}.stats{grid-template-columns:1fr}.stats div+div{border-left:0;border-top:1px solid var(--line)}.step{font-size:10px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="aura"></div><main>
<header><div class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>Agents Manager Studio</div>
<div class="chip" id="chip"><i></i><span id="chipText">Em andamento</span></div></header>
<section class="hero"><div class="ring"><svg viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7aa2ff"/><stop offset="1" stop-color="#b38cff"/></linearGradient></defs>
<circle class="track" cx="100" cy="100" r="88"/><circle class="fill" id="arc" cx="100" cy="100" r="88" stroke-dasharray="552.92" stroke-dashoffset="552.92"/></svg>
<div class="center"><div><div class="pct" id="pct">&ndash;</div><div class="cap" id="cap">compress&atilde;o</div></div></div></div>
<div><h1>Compress&atilde;o do disco do Docker</h1><p class="now" id="now">Preparando&hellip;</p>
<div class="eta"><div><span>Tempo decorrido</span><b id="elapsed">&ndash;</b></div><div><span>Previs&atilde;o</span><b id="eta">&ndash;</b></div></div></div></section>
<div class="steps" id="steps"><div class="rail"><div id="rail"></div></div></div>
<div class="stats"><div><span>Antes</span><b id="before">&ndash;</b></div><div><span>Depois</span><b id="after">&ndash;</b></div><div class="gain"><span>Devolvido</span><b id="freed">&ndash;</b></div></div>
<div class="error" id="error"></div>
<footer><span id="note">O Studio fica fora do ar durante a compress&atilde;o; esta p&aacute;gina &eacute; do helper do Windows.</span><span id="back"></span></footer></main>
<script>
const STEPS=[["stopping_docker","Parar o Docker"],["compacting","Comprimir"],["starting_docker","Ligar o Docker"],["starting_studio","Ligar o Studio"],["finished","Pronto"]];
const NOW={stopping_docker:"Parando o Docker e o WSL\u2026",compacting:"Comprimindo o arquivo do disco virtual com o diskpart.",starting_docker:"Ligando o Docker de novo\u2026",starting_studio:"Subindo o Studio e conferindo que ele responde\u2026"};
const $=id=>document.getElementById(id),C=552.92,gb=b=>b?(b/1073741824).toFixed(1)+" GB":"\u2013";
const fmt=s=>{s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return h?h+"h "+String(m).padStart(2,"0")+"min":m?m+"min "+String(r).padStart(2,"0")+"s":r+"s"};
$("steps").insertAdjacentHTML("beforeend",STEPS.map(x=>'<div class="step"><i>\u2713</i>'+x[1]+"</div>").join(""));
let seen=[];
async function tick(){let s;try{s=await (await fetch("/status.json",{cache:"no-store"})).json()}catch(e){return}
const at=Math.max(0,STEPS.findIndex(x=>x[0]===s.step)),done=s.status!=="running",ok=s.status==="done";
const p=s.step==="compacting"&&s.percent!=null?s.percent:null,shown=done?100:p!=null?p:(at>1?100:0);
$("arc").style.strokeDashoffset=C*(1-shown/100);
$("pct").innerHTML=(done&&!ok)?"!":(p!=null||done||at>1?shown+"<sup>%</sup>":"&ndash;");
$("cap").textContent=done?(ok?"conclu\u00eddo":"com erro"):p!=null?"compress\u00e3o":at>1?"comprimido":"aguardando";
$("now").textContent=done?(ok?"Tudo pronto. O Studio est\u00e1 de volta e retoma o trabalho sozinho.":"A compress\u00e3o terminou com um aviso; o Docker e o Studio foram religados."):(NOW[s.step]||"Preparando\u2026");
const chip=$("chip");chip.className="chip"+(done?(ok?" ok":" err"):"");$("chipText").textContent=done?(ok?"Conclu\u00eddo":"Terminou com aviso"):"Em andamento";
[...document.querySelectorAll(".step")].forEach((el,i)=>{el.className="step"+((i<at||s.step==="finished")?" done":i===at?" now":"")});
$("rail").style.width=(s.step==="finished"?100:at/(STEPS.length-1)*100)+"%";
const started=s.startedAt?new Date(s.startedAt):null,end=s.finishedAt?new Date(s.finishedAt):new Date();
$("elapsed").textContent=started?fmt((end-started)/1000):"\u2013";
if(p!=null){seen.push([Date.now(),p]);seen=seen.filter(x=>Date.now()-x[0]<900000);const a=seen[0],rate=(p-a[1])/((Date.now()-a[0])/1000);$("eta").textContent=rate>0?"~"+fmt((100-p)/rate):"calculando\u2026"}
else $("eta").textContent=done?"\u2013":at>1?"poucos minutos":"\u2013";
$("before").textContent=gb(s.sizeBefore);$("after").textContent=gb(s.sizeAfter);$("freed").textContent=s.sizeAfter&&s.sizeBefore?gb(s.sizeBefore-s.sizeAfter):"\u2013";
const err=$("error");err.style.display=s.error?"block":"none";err.textContent=s.error?"Aviso: "+s.error:"";
$("back").innerHTML=done?'<a href="__STUDIO__/sistema/compressao">Voltar ao Studio \u2192</a>':"Atualiza a cada 3 s";
if(done&&!window.__redir){window.__redir=1;setTimeout(()=>location.href="__STUDIO__/sistema/compressao",10000)}}
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
