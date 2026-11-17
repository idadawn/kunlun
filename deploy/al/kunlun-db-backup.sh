#!/bin/bash
# Back up one Kunlun PostgreSQL database on al with pg_dump -Fc.
# Installed as /usr/local/sbin/kunlun-db-backup and run by kunlun-db-backup@<env>.timer; see deploy/al/README.md.
# Usage: kunlun-db-backup prod|test
set -euo pipefail
umask 077
exec < /dev/null # docker compose exec forwards stdin; never let it swallow the caller's input

env_name=${1:-}
case "$env_name" in
  prod) project_dir=/opt/kunlun;      database=kunlun_prod; keep_days=14 ;;
  test) project_dir=/opt/kunlun-test; database=kunlun_test; keep_days=7 ;;
  *) echo "usage: kunlun-db-backup prod|test" >&2; exit 2 ;;
esac

backup_dir=/var/backups/kunlun/$env_name
log_file=/var/log/kunlun-db-backup.log
min_free_mib=1024 # the root disk is shared with every site on al; never fill it

stamp=$(date +%Y%m%d-%H%M%S)
dump=$backup_dir/$database-$stamp.dump
partial=$backup_dir/.$database-$stamp.dump.partial
started=$SECONDS

log() { printf '%s %s %s\n' "$(date '+%F %T')" "$env_name" "$*" | tee -a "$log_file"; }
finish() {
  local status=$?
  rm -f "$partial"
  [ "$status" -eq 0 ] || log "FAILED exit=$status; details: journalctl -u kunlun-db-backup@$env_name"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP

compose() { docker compose --project-directory "$project_dir" -f "$project_dir/compose.yaml" "$@"; }

install -d -m 700 /var/backups/kunlun "$backup_dir"
exec 9> "/run/lock/kunlun-db-backup-$env_name.lock"
flock -n 9 || { echo "another $env_name backup is still running" >&2; exit 1; }

free_mib=$(df -Pm "$backup_dir" | awk 'NR == 2 { print $4 }')
if [ "$free_mib" -lt "$min_free_mib" ]; then
  echo "only $free_mib MiB free under $backup_dir (minimum $min_free_mib MiB)" >&2
  exit 1
fi

# Right after boot (the timer's Persistent= catch-up) the database container may still be starting.
for _ in $(seq 30); do
  compose exec -T database pg_isready -q -U postgres -d "$database" && break
  sleep 10
done

compose exec -T database pg_dump --username=postgres --dbname="$database" --format=custom > "$partial"
[ -s "$partial" ] || { echo "pg_dump wrote an empty file" >&2; exit 1; }
# Read the whole archive back inside the container so a truncated or corrupt file never becomes a backup.
compose exec -T database pg_restore --file=/dev/null < "$partial"
sync "$partial"
mv "$partial" "$dump"

# Prune only after a verified backup, so a run of failures never deletes the last good copies.
# -maxdepth 1 keeps anything copied into keep/ (e.g. pre-release backups) out of reach.
find "$backup_dir" -maxdepth 1 -type f -name "$database-*.dump" -mmin +$((keep_days * 1440)) -print -delete |
  while read -r old; do log "pruned $old"; done
find "$backup_dir" -maxdepth 1 -type f -name ".$database-*.dump.partial" -mmin +1440 -delete

log "OK $dump $(du -h "$dump" | cut -f1) $((SECONDS - started))s"
