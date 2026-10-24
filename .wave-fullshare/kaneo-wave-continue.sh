#!/bin/sh
# Kaneo wave fullshare CONTINUATION: run 1 completed steps 1-5 (adapters
# staged, compose flipped, image healthy+id-matched, metadata rebound) and
# exited 2 somewhere in steps 6-9. This script re-verifies the post-flip
# state, then finishes the remaining read-only checks, snapshot, mirror,
# and receipt. Fail-closed: any mismatch blocks instead of repairing.
set -eu

BUNDLE=/home/quoc/kaneo-wave-fullshare
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e'
NEW_COMPOSE_SHA256=12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195
NEW_WRAPPER_SHA256=bd4f3e4fe6ac987be85112d7c057e20dd103905c89b749f3c93aea4bef2a788e
NEW_SYNC_SHA256=d5549b556ec06dad66c42d908dc38430bbcd895738f71be07eea167cbbf5762c
NEW_MIGRATION_SHA256=36bc0b41c94d12950c05ed2c5b56df0a430c51d6ff6020eff7109fbc96cd89f3
NEW_BACKUP_VERIFY_SHA256=6f06920e566ec6b0bb224ad6609805d5ba20c8b4db3ac2a8f898e43a332fc5ec

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== C1/7 re-verify post-flip state from run 1'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the fullshare pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running image is not the fullshare pin'
[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo)" = healthy ] || fail 'container is not healthy'
expected_image_id=$(docker image inspect --format '{{.Id}}' "$NEW_IMAGE")
[ "$(docker inspect --format '{{.Image}}' kaneo)" = "$expected_image_id" ] || fail 'running image id does not match the pinned digest'
[ "$(sha256sum /srv/kaneo/recovery/backup-kaneo.sh | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'wrapper is not the fullshare pin'
[ "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'sync-metadata is not the fullshare pin'
[ "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-migration-verify | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'migration-verify is not the fullshare pin'
[ "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-backup-verify | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify is not the fullshare pin'
meta_rev=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$meta_rev" = '09a9fe89298f0a1faad3389b5a733b046b49319e' ] || fail 'install metadata source revision is not the fullshare pin'

printf '%s\n' '== C2/7 migration/schema verify (read-only)'
/usr/local/lib/home-server-recovery/kaneo-migration-verify

printf '%s\n' '== C3/7 newest-backup verify (read-only, pre-snapshot receipt)'
/usr/local/lib/home-server-recovery/kaneo-backup-verify

printf '%s\n' '== C4/7 status (informational)'
sh "$STATUS_SCRIPT" || true

printf '%s\n' '== C5/7 fresh encrypted snapshot of the new release'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER" --snapshot --yes)
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== C6/7 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== C7/7 wave receipt'
printf '%s\n' "KANEO WAVE APPLY PASS: fullshare"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
