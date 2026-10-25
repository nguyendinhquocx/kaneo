#!/bin/sh
# Kaneo wave uatfix4 continuation: repin adapters, verify, snapshot, mirror.
# Run as root on ProDesk after the deploy flip:
#   sudo sh /home/quoc/kaneo-wave-uatfix4/kaneo-wave-continue4.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix4
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b0eb792f-uatfix4@sha256:2d421f5c08accfd93fee04e1e2ea100dcccc51855348d3a15dbea0570864631e'
NEW_COMPOSE_SHA256=314899585bce6cb69f3a09275b41c1f055e40989589edf8d470b5d286f3c6a33
NEW_WRAPPER_SHA256=87bf9ab191ea063dba4c3f7db3ab54ee3ddee2bc017fe1078bed9159e6f9ae0c
NEW_SYNC_SHA256=fea2c153581e0716447d6fd810a2b0688dc601fb3ac7ac28ef530b97a514b51b
NEW_MIGRATION_SHA256=6f4c30379a1a75bc389d0c282eb3556a277aac33b6415539efaa80eafc0d6cd5
NEW_SNAPSHOT_ADAPTER_SHA256=ec79dff1964a927e25027bcab14dcd2fad8bbe65704a1c23d56462de15dcb457

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/7 verify flipped host state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the uatfix4 pin'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the uatfix4 pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not uatfix4'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail "container health is $health"

printf '%s\n' '== 2/7 verify candidate adapter bundle integrity'
[ "$(sha256sum "$BUNDLE/sync.uatfix4.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.uatfix4.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.uatfix4.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'

printf '%s\n' '== 3/7 stage repinned adapters (atomic)'
install -o root -g root -m 0555 "$BUNDLE/sync.uatfix4.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix4.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix4.sh" "$SNAPSHOT_ADAPTER"

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

printf '%s\n' "KANEO WAVE CONTINUE PASS: uatfix4 backup_id=$backup_id"
