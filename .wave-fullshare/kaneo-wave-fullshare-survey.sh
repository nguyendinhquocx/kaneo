#!/bin/sh
# Read-only survey of the current kaneo production state (wave fullshare prep).
# No mutation. Prints stable, greppable key=value lines plus file copies into
# /tmp/kaneo-wave-fullshare-survey/ for byte-exact bundle preparation.
set -eu
OUT=/tmp/kaneo-wave-fullshare-survey
mkdir -p "$OUT"
cp /srv/kaneo/compose.yml "$OUT/compose.current.yml"
cp /srv/kaneo/recovery/backup-kaneo.sh "$OUT/backup-kaneo.host.sh"
cp /usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata "$OUT/kaneo-sync-recovery-metadata.host"
cp /usr/local/lib/home-server-recovery/kaneo-migration-verify "$OUT/kaneo-migration-verify.host"
cp /usr/local/lib/home-server-recovery/kaneo-backup-verify "$OUT/kaneo-backup-verify.host"
cp /usr/local/lib/home-server-recovery/kaneo-install-metadata "$OUT/kaneo-install-metadata.host" 2>/dev/null || true
chmod -R a+r "$OUT"

printf 'compose_sha256=%s\n' "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')"
printf 'compose_image=%s\n' "$(grep -E '^\s+image:' /srv/kaneo/compose.yml | tr -s ' ' | head -2 | tail -1 | tr -d ' ')"
printf 'wrapper_sha256=%s\n' "$(sha256sum /srv/kaneo/recovery/backup-kaneo.sh | awk '{print $1}')"
printf 'sync_sha256=%s\n' "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata | awk '{print $1}')"
printf 'migration_sha256=%s\n' "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-migration-verify | awk '{print $1}')"
printf 'backupverify_sha256=%s\n' "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-backup-verify | awk '{print $1}')"
printf 'metadata_revision=%s\n' "$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')"
printf 'metadata_snapshot_sha=%s\n' "$(sed -n 's/^snapshot_sha256=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')"
printf 'running_image=%s\n' "$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)"
printf 'container_health=%s\n' "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo 2>/dev/null || true)"
latest_receipt=$(ls -1t /var/lib/home-server-recovery/kaneo-outbox/kaneo-*.receipt.json 2>/dev/null | head -1 || true)
printf 'latest_receipt=%s\n' "$(basename "$latest_receipt")"
printf 'receipt_age_minutes=%s\n' "$(( ($(date +%s) - $(stat -c %Y "$latest_receipt")) / 60 ))"
printf 'backup_wrapper_pins:\n'
grep -E '^(PREVIOUS|CANDIDATE)_(COMPOSE_SHA256|IMAGE_REF)=' /srv/kaneo/recovery/backup-kaneo.sh
printf 'outbox_files=%s\n' "$(ls -1 /var/lib/home-server-recovery/kaneo-outbox | wc -l)"
