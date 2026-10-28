#!/bin/sh
# Kaneo wave uatfix5 apply script. Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-uatfix5/kaneo-wave-apply.sh
# Fail-closed: every host-state assumption is re-verified before any
# mutation. Repins the backup wrapper + recovery adapters for the
# uatfix4->uatfix5 pair, then deploys SPEC-2026-10-27 subtask board focus
# markers + work markers (commit c491af97, migration 0050).
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix5
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-uatfix5.sh
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b0eb792f-uatfix4@sha256:2d421f5c08accfd93fee04e1e2ea100dcccc51855348d3a15dbea0570864631e'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d'
CURRENT_COMPOSE_SHA256=314899585bce6cb69f3a09275b41c1f055e40989589edf8d470b5d286f3c6a33
NEW_WRAPPER_SHA256=8151bfa1d950f8b33d71741358791f6ef2c7a793045b5762536a19d3bf1cde9c
NEW_SYNC_SHA256=990464b6af93420803b2d1c7896d148f4dabd110520c4899d099f8dc7017e330
NEW_MIGRATION_SHA256=cb8f4a6f4749a593d657847c08ac20021beda6cde9ee278fbe38b1ff482cb0e4
NEW_BACKUP_VERIFY_SHA256=7c4e6e59265e99143b93a76b9fd8cc0503b75d971d5ae479d610d27f8598ed50
NEW_SNAPSHOT_ADAPTER_SHA256=ca0bdc31491d87344fcba9a1650dd6f2445ffecefac5a293e980d06771f9365c
OLD_WRAPPER_SHA256=87bf9ab191ea063dba4c3f7db3ab54ee3ddee2bc017fe1078bed9159e6f9ae0c
OLD_SYNC_SHA256=fea2c153581e0716447d6fd810a2b0688dc601fb3ac7ac28ef530b97a514b51b
OLD_MIGRATION_SHA256=6f4c30379a1a75bc389d0c282eb3556a277aac33b6415539efaa80eafc0d6cd5
OLD_BACKUP_VERIFY_SHA256=3db9cd065cfd6b25cf33fb03d98fe8fe06fa2d561064e25e1fd439f5603de642
OLD_SNAPSHOT_ADAPTER_SHA256=ec79dff1964a927e25027bcab14dcd2fad8bbe65704a1c23d56462de15dcb457

fail() { printf '%s\n' "KANEO WAVE APPLY BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/9 re-verify surveyed host state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production compose hash changed since the survey; re-survey before applying'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$OLD_WRAPPER_SHA256" ] || fail 'backup wrapper changed since the survey'
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$OLD_SYNC_SHA256" ] || fail 'sync-metadata changed since the survey'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$OLD_MIGRATION_SHA256" ] || fail 'migration-verify changed since the survey'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$OLD_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify changed since the survey'
[ "$(sha256sum "$SNAPSHOT_ADAPTER" | awk '{print $1}')" = "$OLD_SNAPSHOT_ADAPTER_SHA256" ] || fail 'snapshot adapter changed since the survey'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$CURRENT_IMAGE" ] || fail 'running kaneo image is not the surveyed previous candidate'
sha_state=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$sha_state" = 'b0eb792f72f3055e0429a8fa382e686783e9af61' ] || fail 'install metadata source revision is not the surveyed previous candidate'

printf '%s\n' '== 2/9 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.uatfix5.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/sync.uatfix5.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.uatfix5.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/backup-verify.uatfix5.sh" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.uatfix5.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/9 stage repinned wrapper + recovery adapters (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.uatfix5.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix5.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/sync.uatfix5.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix5.sh" "$SNAPSHOT_ADAPTER"
install -o root -g root -m 0555 "$BUNDLE/backup-verify.uatfix5.sh" "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 4/9 guarded deploy (backup guard, compose flip, pull, health, migration)'
sh "$DEPLOY_SCRIPT"

printf '%s\n' '== 5/9 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 6/9 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 7/9 fresh encrypted snapshot of the new release'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== 8/9 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 9/9 wave receipt'
printf '%s\n' "KANEO WAVE APPLY PASS: uatfix5"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
printf '%s\n' "backup_id=$backup_id"
