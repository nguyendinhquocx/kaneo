#!/bin/sh
# Kaneo wave uatfix6 apply script. Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-uatfix6/kaneo-wave-apply.sh
# Fail-closed: every host-state assumption is re-verified before any
# mutation. Repins the backup wrapper + recovery adapters for the
# uatfix5->uatfix6 pair, then deploys the SPEC-2026-10-27 post-UAT
# revision (commit dca547b0, migration 0051).
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix6
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-uatfix6.sh
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd'
CURRENT_COMPOSE_SHA256=24aebba06211970e6d4c4115c0c5ffc301672d879cae05215cc07af0e2424a8b
NEW_WRAPPER_SHA256=e01c070fdfea2f41e39102ee99528bba99771b2aeb45bbadddb2044f659348da
NEW_SYNC_SHA256=5b1ef1d7d2117ea616eb1dc0185484f7f4bf88df69a4448fa769a56529bf11aa
NEW_MIGRATION_SHA256=e3cc654f405aeb5935850737e3d3058300b23740f6f6ec0a0461a0bc2d8d34d1
NEW_BACKUP_VERIFY_SHA256=caab1488157c9f5e40760267688571b584e16ead86dcb998e4740a81549eb450
NEW_SNAPSHOT_ADAPTER_SHA256=19af4e180e081835b71a36c1f712ddca15bce2ca643eb86a6bfdb55a1a3c78f5
OLD_WRAPPER_SHA256=8151bfa1d950f8b33d71741358791f6ef2c7a793045b5762536a19d3bf1cde9c
OLD_SYNC_SHA256=990464b6af93420803b2d1c7896d148f4dabd110520c4899d099f8dc7017e330
OLD_MIGRATION_SHA256=cb8f4a6f4749a593d657847c08ac20021beda6cde9ee278fbe38b1ff482cb0e4
OLD_BACKUP_VERIFY_SHA256=7c4e6e59265e99143b93a76b9fd8cc0503b75d971d5ae479d610d27f8598ed50
OLD_SNAPSHOT_ADAPTER_SHA256=ca0bdc31491d87344fcba9a1650dd6f2445ffecefac5a293e980d06771f9365c

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
[ "$sha_state" = 'c491af9763e91a8b246de092e44cbe32e9737428' ] || fail 'install metadata source revision is not the surveyed previous candidate'

printf '%s\n' '== 2/9 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.uatfix6.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/sync.uatfix6.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.uatfix6.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/backup-verify.uatfix6.sh" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.uatfix6.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/9 stage repinned wrapper + recovery adapters (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.uatfix6.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix6.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/sync.uatfix6.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix6.sh" "$SNAPSHOT_ADAPTER"
install -o root -g root -m 0555 "$BUNDLE/backup-verify.uatfix6.sh" "$BACKUP_VERIFY_TARGET"

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
printf '%s\n' "KANEO WAVE APPLY PASS: uatfix6"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
printf '%s\n' "backup_id=$backup_id"
