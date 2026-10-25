#!/bin/sh
# Kaneo wave uatfix3 CONTINUATION: run 1 completed deploy (flip + health)
# and died in the health loop from a hung-up runner TTY. Re-verify the
# post-flip state, rebind metadata, run read-only checks, take the fresh
# snapshot, mirror to R2, print the receipt. Fail-closed.
set -eu

SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-708d1712-uatfix3@sha256:4e952ebe74c32bdea01c6d306643b811162454ab6f74f8dde63f214b19a7eb88'
NEW_COMPOSE_SHA256=c57926be993152afb037c69fc594a52584b384b2d140d1c34a1d9bad93843ddb
NEW_WRAPPER_SHA256=689298548be81b6f54a4037d29b9633fab81926e71b20fb22e3e1c956dee15ea
NEW_SYNC_SHA256=7ced12361d235d8db9b370ae47ea6df549c526fe65ed2b848e98b2598c4783fa
NEW_MIGRATION_SHA256=f3508c19fc549c52fb80d0fc0745293966a18be9aa142366a7e9355be699aec4
NEW_BACKUP_VERIFY_SHA256=8d8c19b3ba205101fd00027abc5fb607e060286f760b751290bcc8e0ee4d167e

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== C1/7 re-verify post-flip state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the uatfix3 pin'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)" = "$NEW_IMAGE" ] || fail 'running image is not the uatfix3 pin'
[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo)" = healthy ] || fail 'container is not healthy'
expected_image_id=$(docker image inspect --format '{{.Id}}' "$NEW_IMAGE")
[ "$(docker inspect --format '{{.Image}}' kaneo)" = "$expected_image_id" ] || fail 'running image id mismatch'
[ "$(sha256sum /srv/kaneo/recovery/backup-kaneo.sh | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'wrapper is not the uatfix3 pin'
[ "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'sync-metadata is not the uatfix3 pin'
[ "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-migration-verify | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'migration-verify is not the uatfix3 pin'
[ "$(sha256sum /usr/local/lib/home-server-recovery/kaneo-backup-verify | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify is not the uatfix3 pin'

printf '%s\n' '== C2/7 rebind recovery metadata to the new wave'
sh /usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata

printf '%s\n' '== C3/7 migration/schema verify (read-only)'
/usr/local/lib/home-server-recovery/kaneo-migration-verify

printf '%s\n' '== C4/7 newest-backup verify (read-only, pre-snapshot receipt)'
/usr/local/lib/home-server-recovery/kaneo-backup-verify

printf '%s\n' '== C5/7 status (informational)'
sh "$STATUS_SCRIPT" || true

printf '%s\n' '== C6/7 fresh encrypted snapshot of the new release'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== C7/7 mirror the fresh pair + wave receipt'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"
printf '%s\n' "KANEO WAVE APPLY PASS: uatfix3"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
