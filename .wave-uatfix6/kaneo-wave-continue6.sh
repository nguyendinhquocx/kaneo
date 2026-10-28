#!/bin/sh
# Kaneo wave uatfix6 continuation: repin adapters, verify, snapshot, mirror.
# Run as root on ProDesk after the deploy flip:
#   sudo sh /home/quoc/kaneo-wave-uatfix6/kaneo-wave-continue6.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix6
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd'
NEW_COMPOSE_SHA256=1e637fa348ddc6d4d53f7d4ff0c0f082ffbd06002218848281ac1c6d88a2e717
NEW_WRAPPER_SHA256=e01c070fdfea2f41e39102ee99528bba99771b2aeb45bbadddb2044f659348da
NEW_SYNC_SHA256=5b1ef1d7d2117ea616eb1dc0185484f7f4bf88df69a4448fa769a56529bf11aa
NEW_MIGRATION_SHA256=e3cc654f405aeb5935850737e3d3058300b23740f6f6ec0a0461a0bc2d8d34d1
NEW_SNAPSHOT_ADAPTER_SHA256=19af4e180e081835b71a36c1f712ddca15bce2ca643eb86a6bfdb55a1a3c78f5

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/7 verify flipped host state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the uatfix6 pin'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the uatfix6 pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not uatfix6'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail "container health is $health"

printf '%s\n' '== 2/7 verify candidate adapter bundle integrity'
[ "$(sha256sum "$BUNDLE/sync.uatfix6.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.uatfix6.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.uatfix6.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'

printf '%s\n' '== 3/7 stage repinned adapters (atomic)'
install -o root -g root -m 0555 "$BUNDLE/sync.uatfix6.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix6.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix6.sh" "$SNAPSHOT_ADAPTER"

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

printf '%s\n' "KANEO WAVE CONTINUE PASS: uatfix6 backup_id=$backup_id"
