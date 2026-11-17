#!/bin/bash
# Copy new Kunlun database backups from al to the Alibaba Cloud OSS bucket that holds the off-server copies.
# Installed as /usr/local/sbin/kunlun-db-offsite; kunlun-db-backup@<env>.service starts kunlun-db-offsite@<env>.service
# after every successful backup (OnSuccess=). See deploy/al/README.md.
# Usage: kunlun-db-offsite prod|test
#
# /etc/kunlun-db-offsite (700, root only) holds the bucket name in `bucket` and, in `ossutil.conf`, the AccessKey of a
# RAM user that may only put objects under prod/ and test/ of that bucket: it cannot list, read, overwrite or delete
# them. The bucket forbids overwrites and its lifecycle rules delete copies after the same number of days as here.
set -euo pipefail
umask 077
exec < /dev/null

env_name=${1:-}
case "$env_name" in
  prod) database=kunlun_prod; keep_days=14 ;;
  test) database=kunlun_test; keep_days=7 ;;
  *) echo "usage: kunlun-db-offsite prod|test" >&2; exit 2 ;;
esac

backup_dir=/var/backups/kunlun/$env_name
conf_dir=/etc/kunlun-db-offsite
state_dir=/var/lib/kunlun-db-offsite
state=$state_dir/$env_name.uploaded # names of the backups already copied to OSS
log_file=/var/log/kunlun-db-backup.log
ossutil=/usr/local/bin/ossutil

log() { printf '%s %s %s\n' "$(date '+%F %T')" "$env_name" "$*" | tee -a "$log_file"; }
finish() {
  local status=$?
  [ "$status" -eq 0 ] || log "OFFSITE FAILED exit=$status; details: journalctl -u kunlun-db-offsite@$env_name"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP

bucket=$(cat "$conf_dir/bucket")
[ -n "$bucket" ] || { echo "$conf_dir/bucket is empty" >&2; exit 1; }
[ -s "$conf_dir/ossutil.conf" ] || { echo "$conf_dir/ossutil.conf (the OSS AccessKey) is missing" >&2; exit 1; }
install -d -m 700 "$state_dir"
touch "$state"

exec 9> "/run/lock/kunlun-db-offsite-$env_name.lock"
flock -w 300 9 || { echo "another $env_name upload is still running" >&2; exit 1; }

# Every backup the bucket would still keep that has not been copied yet, so a failed run is made up by the next one.
# -maxdepth 1 leaves keep/ alone: it only holds copies of backups that were uploaded when they were made.
mapfile -t names < <(find "$backup_dir" -maxdepth 1 -type f -name "$database-*.dump" -mmin -$((keep_days * 1440)) \
  -printf '%f\n' | LC_ALL=C sort)
failures=0
copied=0
for name in "${names[@]}"; do
  grep -qxF -- "$name" "$state" && continue
  file=$backup_dir/$name
  key=$env_name/$name
  started=$SECONDS
  sha256=$(sha256sum "$file" | cut -d ' ' -f 1)
  # --forbid-overwrite: never replace a copy that is already there (the bucket forbids it as well). ossutil checks the
  # CRC-64 that OSS computes on arrival; the SHA-256 kept as object metadata lets a downloaded copy be checked later.
  if output=$("$ossutil" --config-file "$conf_dir/ossutil.conf" api put-object --bucket "$bucket" --key "$key" \
      --body "file://$file" --forbid-overwrite=true --metadata "sha256=$sha256" 2>&1); then
    log "OFFSITE OK oss://$bucket/$key $(du -h "$file" | cut -f 1) $((SECONDS - started))s"
  elif grep -q FileAlreadyExists <<< "$output"; then
    log "OFFSITE already in OSS: oss://$bucket/$key" # uploaded earlier, but the state file lost track of it
  else
    printf '%s\n' "$output" >&2
    echo "copying $file to oss://$bucket/$key failed" >&2
    failures=$((failures + 1))
    continue
  fi
  echo "$name" >> "$state"
  copied=$((copied + 1))
done

# Forget backups that the local pruning has deleted, so the state file stays small.
remaining=$(mktemp "$state_dir/.$env_name.XXXXXX")
while read -r name; do
  if [ -e "$backup_dir/$name" ]; then echo "$name"; fi
done < "$state" > "$remaining"
mv "$remaining" "$state"

[ "$failures" -eq 0 ] || exit 1
[ "$copied" -gt 0 ] || echo "nothing new to copy from $backup_dir"
