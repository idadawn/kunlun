#!/bin/bash
# Restore drill for a Kunlun backup on al: load it into a throwaway PostgreSQL container started from the live
# database's image (no network, removed afterwards together with its volume) and compare per-table row counts
# with the live database. Nothing is written to the live database.
# Installed as /usr/local/sbin/kunlun-db-restore-check; see deploy/al/README.md.
# Usage: kunlun-db-restore-check prod|test [backup-file]   (default: the newest backup)
set -euo pipefail
umask 077
exec < /dev/null # docker compose exec forwards stdin; never let it swallow the caller's input

env_name=${1:-}
case "$env_name" in
  prod) project_dir=/opt/kunlun;      database=kunlun_prod; app_role=kunlun_app ;;
  test) project_dir=/opt/kunlun-test; database=kunlun_test; app_role=kunlun_test_app ;;
  *) echo "usage: kunlun-db-restore-check prod|test [backup-file]" >&2; exit 2 ;;
esac
backup_dir=/var/backups/kunlun/$env_name
log_file=/var/log/kunlun-db-backup.log
dump=${2:-$(find "$backup_dir" -maxdepth 1 -type f -name "$database-*.dump" | sort | tail -n 1)}
if [ -z "$dump" ] || [ ! -s "$dump" ]; then echo "no backup found in $backup_dir" >&2; exit 1; fi

compose() { docker compose --project-directory "$project_dir" -f "$project_dir/compose.yaml" "$@"; }
log() { printf '%s %s %s\n' "$(date '+%F %T')" "$env_name" "$*" >> "$log_file"; }

live=$(compose ps -q database)
[ -n "$live" ] || { echo "the live $env_name database container is not running" >&2; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$live")
scratch=kunlun-restore-check-$env_name-$$
work=$(mktemp -d)
finish() {
  local status=$?
  docker rm -f -v "$scratch" > /dev/null 2>&1 || true
  rm -rf "$work"
  [ "$status" -eq 0 ] || log "RESTORE-CHECK FAILED exit=$status ${summary:-backup=$dump}"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP

echo "backup:   $dump ($(du -h "$dump" | cut -f1))"
echo "image:    $image"
# No network and trust auth: the throwaway server is reachable only through docker exec as root.
docker run -d --rm --pull never --name "$scratch" --label "kunlun.restore-check=$env_name" \
  --network none --memory 256m -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" postgres -c shared_buffers=32MB > /dev/null

# The image's init step runs a socket-only server first; answering on TCP means the final server is up.
ready=
for _ in $(seq 60); do
  if docker exec "$scratch" pg_isready -q -h 127.0.0.1 -U postgres; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then docker logs --tail 20 "$scratch" >&2; echo "the scratch server did not start" >&2; exit 1; fi

# The same role and database init-database.sh creates on a fresh volume (the role only owns objects here).
docker exec "$scratch" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
  -c "CREATE ROLE $app_role NOLOGIN" -c "CREATE DATABASE $database OWNER $app_role"
started=$SECONDS
docker exec -i "$scratch" pg_restore -U postgres -d "$database" --single-transaction --exit-on-error < "$dump"
elapsed=$((SECONDS - started))

count_sql="SELECT table_schema || '.' || table_name,
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')"
compose exec -T database psql -X -At -F ' ' -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "$count_sql" |
  LC_ALL=C sort > "$work/live"
docker exec "$scratch" psql -X -At -F ' ' -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "$count_sql" |
  LC_ALL=C sort > "$work/restored"
LC_ALL=C join -a 1 -a 2 -e - -o 0,1.2,2.2 "$work/live" "$work/restored" > "$work/compare"

printf '\n%-60s %9s %9s\n' table live restored
awk '{ printf "%-60s %9s %9s%s\n", $1, $2, $3, ($2 == $3 ? "" : "  <- differs") }' "$work/compare"
tables=$(($(wc -l < "$work/restored")))
missing=$(($(awk '$3 == "-"' "$work/compare" | wc -l)))
differs=$(($(awk '$2 != $3' "$work/compare" | wc -l)))
summary="backup=$(basename "$dump") tables=$tables missing=$missing differs=$differs restore=${elapsed}s"

if [ "$tables" -eq 0 ] || [ "$missing" -gt 0 ]; then
  echo "FAILED: tables exist live but not in the restore. $summary" >&2
  exit 1
fi
log "RESTORE-CHECK OK $summary"
echo
echo "OK: $summary"
if [ "$differs" -gt 0 ]; then
  echo "Counts that differ can come from writes after the backup was taken; review them before relying on it."
fi
