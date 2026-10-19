#!/usr/bin/env bash
# Builds a package that installs the Studio on another Windows machine with ONE workspace: its board, workflows,
# profiles, accounts and secrets, the agents that are not finished (Claude session and copy) and the skills.
# The package holds secrets (.env, encrypted tokens): carry it on your own drive, never share it.
#
# Usage (Git Bash, from the Studio folder, Studio running):  infra/migrate/export-workspace.sh Celcode /d/StudioCelcode
# Then on the other machine: powershell -ExecutionPolicy Bypass -File <package>\instalar.ps1
set -euo pipefail
export MSYS_NO_PATHCONV=1

WS=${1:?workspace name}
OUT=${2:?package folder}
cd "$(dirname "$0")/../.."
compose() { docker compose -f docker-compose.yml -f docker-compose.dev.yml "$@"; }
pg() { compose exec -T postgres sh -c "$1"; }
q() { pg "psql -U \$POSTGRES_USER -d studio_export -At -F '|' -c \"$1\""; }

mkdir -p "$OUT/volumes"
echo "== Banco: copia temporaria, so com o workspace $WS"
pg 'pg_dump -U $POSTGRES_USER -Fc studio > /tmp/full.dump && dropdb -U $POSTGRES_USER --if-exists studio_export && createdb -U $POSTGRES_USER studio_export && pg_restore -U $POSTGRES_USER -d studio_export --no-owner /tmp/full.dump && rm /tmp/full.dump'
compose exec -T postgres sh -c "psql -U \$POSTGRES_USER -d studio_export -v ws='$WS'" < infra/migrate/prune-workspace.sql

q "select p.name, coalesce(p.git_remote_url,''), coalesce(p.base_branch,'') from projects p" > "$OUT/projetos.txt"
q "select a.id, a.workdir from agents a where a.status not in ('COMPLETED','FAILED','CANCELLED') and a.kind = 'TASK'" > "$OUT/agentes.txt"
pg 'pg_dump -U $POSTGRES_USER -Fc studio_export' > "$OUT/studio.dump"
pg 'dropdb -U $POSTGRES_USER studio_export'

echo "== Agentes nao terminados: sessao do Claude e copia"
while IFS='|' read -r id workdir; do
  [ -n "$id" ] || continue
  docker run --rm -v "ams-agent-$id:/v:ro" alpine:3.20 tar czf - -C /v . > "$OUT/volumes/agent-$id.tgz"
  case "$workdir" in
    vol:*) sub=${workdir#vol:}; docker run --rm -v "ams-agents:/v:ro" alpine:3.20 tar czf - -C /v "$sub" > "$OUT/volumes/copy-$id.tgz" ;;
  esac
  echo "  $id"
done < "$OUT/agentes.txt"

echo "== Codigo do Studio, skills e configuracao"
git bundle create "$OUT/studio.bundle" "$(git rev-parse --abbrev-ref HEAD)"
git remote get-url origin > "$OUT/origin.txt"
tar czf "$OUT/skills.tgz" -C "$HOME/.claude" skills
cp .env "$OUT/env.txt"
# Claude account switcher (company/personal), when this machine has it.
SWITCHER=${CLAUDE_SWITCHER:-/d/Programs/utilitaries/claude-contas.ps1}
[ -f "$SWITCHER" ] && cp "$SWITCHER" "$OUT/"
cp infra/migrate/instalar.ps1 infra/migrate/LEIA-ME.txt "$OUT/"
echo "$WS" > "$OUT/workspace.txt"
du -sh "$OUT"
echo "Pacote pronto em $OUT"
