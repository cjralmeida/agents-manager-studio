<#
.SYNOPSIS
  Installs the Agents Manager Studio on this machine from a package made by export-workspace.sh.

.DESCRIPTION
  Needs Docker Desktop (running) and Git for Windows. It:
    1. clones the Studio code from the package (origin pointing at GitHub);
    2. writes .env with this machine's folders (same keys: the saved tokens keep working);
    3. copies the skills to ~\.claude\skills;
    4. clones the workspace projects into <ProjetosDir>\<workspace>;
    5. restores the database (only that workspace) and the data of the unfinished agents;
    6. starts the Studio and its Windows helper (with Windows too).
  Workflows come back switched off. Run it again safely: steps already done are skipped.

  powershell -ExecutionPolicy Bypass -File .\instalar.ps1
  powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -ProjetosDir E:\Projetos

  Only ASCII here: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#>
[CmdletBinding()]
param(
  [string]$Pacote = $PSScriptRoot,
  [string]$ProjetosDir = $(if (Test-Path 'D:\') { 'D:\Projetos' } else { "$env:USERPROFILE\Projetos" }),
  [string]$StudioDir = '',
  [string]$AgentesDir = $(if (Test-Path 'D:\') { 'D:\AgentsWorktrees' } else { "$env:USERPROFILE\AgentsWorktrees" })
)
$ErrorActionPreference = 'Stop'
if (-not $StudioDir) { $StudioDir = Join-Path $ProjetosDir 'Pessoais\agents-manager-studio' }
$Workspace = (Get-Content (Join-Path $Pacote 'workspace.txt') -Raw).Trim()
$Fwd = { param($p) $p -replace '\\', '/' }

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Native { param([scriptblock]$Run, [string]$What) & $Run; if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" } }
function Compose { param([Parameter(ValueFromRemainingArguments)]$Rest) Push-Location $StudioDir; try { Native { docker compose -f docker-compose.yml -f docker-compose.dev.yml @Rest } 'docker compose' } finally { Pop-Location } }
function PostgresId { Push-Location $StudioDir; try { (docker compose ps -q postgres | Out-String).Trim() } finally { Pop-Location } }
# SQL goes through stdin: PowerShell 5.1 drops the inner double quotes of native arguments.
function Sql([string]$Query) { Push-Location $StudioDir; try { ($Query | docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d studio -At' | Out-String).Trim() } finally { Pop-Location } }

Step 'Checking Docker and Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git not found. Install it (winget install Git.Git) and run again.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker not found. Install Docker Desktop (winget install Docker.DockerDesktop), open it and run again.' }
$ErrorActionPreference = 'Continue'; docker info 2>&1 | Out-Null; $ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Open Docker Desktop, wait for it to start and run again.' }

Step "Studio code in $StudioDir"
if (Test-Path (Join-Path $StudioDir '.git')) {
  Write-Host 'Already there: kept as it is.'
} else {
  New-Item -ItemType Directory -Force (Split-Path $StudioDir) | Out-Null
  Native { git clone (Join-Path $Pacote 'studio.bundle') $StudioDir } 'git clone'
  $origin = (Get-Content (Join-Path $Pacote 'origin.txt') -Raw).Trim()
  Native { git -C $StudioDir remote set-url origin $origin } 'git remote'
}

Step '.env with this machine folders'
$envFile = Join-Path $StudioDir '.env'
if (Test-Path $envFile) {
  Write-Host 'Already there: kept as it is.'
} else {
  $skillsDir = Join-Path $env:USERPROFILE '.claude\skills'
  $values = @{ PROJECTS_HOST_DIR = (& $Fwd $ProjetosDir); AGENTS_HOST_DIR = (& $Fwd $AgentesDir); CLAUDE_SKILLS_HOST_DIR = (& $Fwd $skillsDir) }
  $lines = Get-Content (Join-Path $Pacote 'env.txt') | ForEach-Object {
    $key = ($_ -split '=', 2)[0].Trim()
    if ($values.ContainsKey($key)) { "$key=$($values[$key])" } else { $_ }
  }
  [IO.File]::WriteAllLines($envFile, [string[]]$lines)
  New-Item -ItemType Directory -Force $AgentesDir | Out-Null
}

Step 'Skills in ~\.claude\skills'
$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force $claudeDir | Out-Null
Native { tar -xzf (Join-Path $Pacote 'skills.tgz') -C $claudeDir } 'tar (skills)'

$switcher = Join-Path $Pacote 'claude-contas.ps1'
if (Test-Path $switcher) {
  Step 'Claude account switcher'
  $utilDir = if (Test-Path 'D:\') { 'D:\Programs\utilitaries' } else { "$env:USERPROFILE\Programs\utilitaries" }
  New-Item -ItemType Directory -Force $utilDir | Out-Null
  Copy-Item $switcher $utilDir -Force
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude contas.lnk'))
  $link.TargetPath = 'powershell.exe'
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$utilDir\claude-contas.ps1`""
  $link.Save()
  Write-Host "  $utilDir\claude-contas.ps1 (shortcut on the Desktop)"
}

Step "Projects of $Workspace in $ProjetosDir\$Workspace"
$wsDir = Join-Path $ProjetosDir $Workspace
New-Item -ItemType Directory -Force $wsDir | Out-Null
foreach ($line in Get-Content (Join-Path $Pacote 'projetos.txt')) {
  $name, $remote, $branch = $line -split '\|'
  if (-not $name) { continue }
  $dir = Join-Path $wsDir $name
  if (Test-Path $dir) { Write-Host "  $name - already there"; continue }
  if (-not $remote) { New-Item -ItemType Directory -Force $dir | Out-Null; Write-Host "  $name - no remote: empty folder created"; continue }
  Write-Host "  $name - cloning $remote"
  if ($branch) { Native { git clone -b $branch $remote $dir } "git clone $name" } else { Native { git clone $remote $dir } "git clone $name" }
}

Step 'Database'
Compose up -d postgres
$deadline = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Seconds 3
  $health = (docker inspect -f '{{.State.Health.Status}}' (PostgresId) | Out-String).Trim()
} until ($health -eq 'healthy' -or (Get-Date) -gt $deadline)
if ($health -ne 'healthy') { throw 'Postgres did not start.' }
if ((Sql "select count(*) from information_schema.tables where table_name = 'workspaces'") -eq '1') {
  Write-Host 'The database already has the Studio tables: not restored again.'
} else {
  $pg = PostgresId
  Native { docker cp (Join-Path $Pacote 'studio.dump') "${pg}:/tmp/studio.dump" } 'docker cp'
  Compose exec -T postgres sh -c 'pg_restore -U $POSTGRES_USER -d studio --no-owner --exit-on-error /tmp/studio.dump && rm /tmp/studio.dump'
  Write-Host 'Restored.'
}

Step 'Unfinished agents (Claude session and copy)'
docker volume create ams-agents | Out-Null
foreach ($file in Get-ChildItem (Join-Path $Pacote 'volumes') -Filter '*.tgz' -ErrorAction SilentlyContinue) {
  $id = $file.BaseName -replace '^(agent|copy)-', ''
  $volume = if ($file.BaseName -like 'agent-*') { "ams-agent-$id" } else { 'ams-agents' }
  Native { docker run --rm -v "${volume}:/v" -v "$($file.DirectoryName):/pkg:ro" alpine:3.20 sh -c "tar xzf /pkg/$($file.Name) -C /v" } "restore $($file.Name)"
  Write-Host "  $($file.Name)"
}

Step 'Agent image and Studio (first build takes a few minutes)'
Compose --profile tools build agent-runner
Native { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $StudioDir 'studio.ps1') -Install -Dev } 'studio.ps1'

Write-Host ''
Write-Host "Done. Open http://studio.localhost and log in with the same user and password." -ForegroundColor Green
Write-Host "The $Workspace workflows are off: switch them on in the Studio when you are ready."
