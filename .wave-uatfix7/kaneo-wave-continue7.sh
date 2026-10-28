#!/bin/sh
# Kaneo wave uatfix7 continuation: repin adapters, verify, snapshot, mirror.
# Run as root on ProDesk after the deploy flip:
#   sudo sh /home/quoc/kaneo-wave-uatfix7/kaneo-wave-continue7.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix7
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
NEW_COMPOSE_SHA256=5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f
NEW_WRAPPER_SHA256=ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820
NEW_SYNC_SHA256=47bab1d8dcfe1ebf7db8fb34ad781eb18dca71d685e13091007f885210d6a083
NEW_MIGRATION_SHA256=bbb7952722d27216efd491239fef98410da6c7a17ff4dde49a49701a27f4f37b
NEW_SNAPSHOT_ADAPTER_SHA256=e8798ba8f07ad19c08000396d06ea0a6fb1ac31efaaf0d2ebedadc908eb15f2a

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/7 verify flipped host state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the uatfix7 pin'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the uatfix7 pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not uatfix7'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail "container health is $health"

printf '%s\n' '== 2/7 verify candidate adapter bundle integrity'
[ "$(sha256sum "$BUNDLE/sync.uatfix7.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.uatfix7.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.uatfix7.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'

printf '%s\n' '== 3/7 stage repinned adapters (atomic)'
install -o root -g root -m 0555 "$BUNDLE/sync.uatfix7.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix7.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix7.sh" "$SNAPSHOT_ADAPTER"

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

printf '%s\n' "KANEO WAVE CONTINUE PASS: uatfix7 backup_id=$backup_id"
