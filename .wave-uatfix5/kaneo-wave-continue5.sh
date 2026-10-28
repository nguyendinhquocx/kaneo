#!/bin/sh
# Kaneo wave uatfix5 continuation: repin adapters, verify, snapshot, mirror.
# Run as root on ProDesk after the deploy flip:
#   sudo sh /home/quoc/kaneo-wave-uatfix5/kaneo-wave-continue5.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix5
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d'
NEW_COMPOSE_SHA256=24aebba06211970e6d4c4115c0c5ffc301672d879cae05215cc07af0e2424a8b
NEW_WRAPPER_SHA256=8151bfa1d950f8b33d71741358791f6ef2c7a793045b5762536a19d3bf1cde9c
NEW_SYNC_SHA256=990464b6af93420803b2d1c7896d148f4dabd110520c4899d099f8dc7017e330
NEW_MIGRATION_SHA256=cb8f4a6f4749a593d657847c08ac20021beda6cde9ee278fbe38b1ff482cb0e4
NEW_SNAPSHOT_ADAPTER_SHA256=ca0bdc31491d87344fcba9a1650dd6f2445ffecefac5a293e980d06771f9365c

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/7 verify flipped host state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the uatfix5 pin'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the uatfix5 pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not uatfix5'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail "container health is $health"

printf '%s\n' '== 2/7 verify candidate adapter bundle integrity'
[ "$(sha256sum "$BUNDLE/sync.uatfix5.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.uatfix5.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.uatfix5.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'

printf '%s\n' '== 3/7 stage repinned adapters (atomic)'
install -o root -g root -m 0555 "$BUNDLE/sync.uatfix5.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix5.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix5.sh" "$SNAPSHOT_ADAPTER"

printf '%s\n' '== 4/7 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 5/7 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$MIGRATION_TARGET"
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 6/7 fresh encrypted snapshot of the new release'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== 7/7 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' "KANEO WAVE CONTINUE PASS: uatfix5 backup_id=$backup_id"
