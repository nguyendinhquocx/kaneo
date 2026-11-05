#!/bin/sh
# Kaneo wave int1 apply script. Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-int1/kaneo-wave-apply.sh
# Fail-closed: every host-state assumption is re-verified before any
# mutation. Repins the backup wrapper + recovery adapters for the
# uatfix7->int1 pair, takes a fresh encrypted pre-migration snapshot
# (mirrored to R2) of the uatfix7 release, then deploys the
# SPEC-2026-10-31 calendar/mindmap integration revision (commit
# d7c142498abadc303e802c4e61338b0b42ed71e3, migration 0052_secret_maelstrom).
set -eu

BUNDLE=/home/quoc/kaneo-wave-int1
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-int1.sh
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d7c14249-calendar-mindmap-int1@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc'
CURRENT_COMPOSE_SHA256=5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f
NEW_WRAPPER_SHA256=8ce2b6b3d21dd59aa3325a59cc9eab038ed12d5e31d7cf13eb26d2e08cb1b2aa
NEW_SYNC_SHA256=e940762af40c8583e3c009ad57815439404cc909f0c192b75b37a076f6493ed4
NEW_MIGRATION_SHA256=916a7627683478fb92979ec6b1d1a85bdfa6ef986e1a60ea18258d6432311513
NEW_BACKUP_VERIFY_SHA256=d41cfdda6d8625ecfdf5d13dde44d682ad8bb60451964b204d949cb4a7a5f86f
NEW_SNAPSHOT_ADAPTER_SHA256=0689423a81639bf47e44065b1efd86ff27a511aee52cceedc54023aec91c3342
OLD_WRAPPER_SHA256=ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820
OLD_SYNC_SHA256=47bab1d8dcfe1ebf7db8fb34ad781eb18dca71d685e13091007f885210d6a083
OLD_MIGRATION_SHA256=bbb7952722d27216efd491239fef98410da6c7a17ff4dde49a49701a27f4f37b
OLD_BACKUP_VERIFY_SHA256=eea07a72b35202a61ddcf0eb2aee09facdc4c88a663d727bfd9645e11664c678
OLD_SNAPSHOT_ADAPTER_SHA256=e8798ba8f07ad19c08000396d06ea0a6fb1ac31efaaf0d2ebedadc908eb15f2a

fail() { printf '%s\n' "KANEO WAVE APPLY BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/11 re-verify surveyed host state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production compose hash changed since the survey; re-survey before applying'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$OLD_WRAPPER_SHA256" ] || fail 'backup wrapper changed since the survey'
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$OLD_SYNC_SHA256" ] || fail 'sync-metadata changed since the survey'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$OLD_MIGRATION_SHA256" ] || fail 'migration-verify changed since the survey'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$OLD_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify changed since the survey'
[ "$(sha256sum "$SNAPSHOT_ADAPTER" | awk '{print $1}')" = "$OLD_SNAPSHOT_ADAPTER_SHA256" ] || fail 'snapshot adapter changed since the survey'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$CURRENT_IMAGE" ] || fail 'running kaneo image is not the surveyed previous candidate'
sha_state=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$sha_state" = 'd56f1bbae914269fdd3b322fae4cbea19528603c' ] || fail 'install metadata source revision is not the surveyed previous candidate'

printf '%s\n' '== 2/11 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.int1.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/sync.int1.sh" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/migration-verify.int1.sh" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/backup-verify.int1.sh" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/snapshot.int1.sh" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/11 stage repinned wrapper + recovery adapters (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.int1.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.int1.sh" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/sync.int1.sh" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/snapshot.int1.sh" "$SNAPSHOT_ADAPTER"
install -o root -g root -m 0555 "$BUNDLE/backup-verify.int1.sh" "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 4/11 fresh encrypted pre-migration snapshot of the CURRENT uatfix7 release'
pre_snapshot_output=$(sh "$WRAPPER_TARGET" --snapshot --yes)
printf '%s\n' "$pre_snapshot_output"
pre_backup_id=$(printf '%s\n' "$pre_snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$pre_backup_id" ] || fail 'could not determine the pre-migration backup id from snapshot output'

printf '%s\n' '== 5/11 mirror the pre-migration pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$pre_backup_id"

printf '%s\n' '== 6/11 guarded deploy (backup guard, compose flip, pull, health, migration 0052)'
sh "$DEPLOY_SCRIPT"

printf '%s\n' '== 7/11 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 8/11 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 9/11 fresh encrypted snapshot of the new release'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== 10/11 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 11/11 wave receipt'
printf '%s\n' "KANEO WAVE APPLY PASS: int1"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
printf '%s\n' "pre_migration_backup_id=$pre_backup_id"
printf '%s\n' "backup_id=$backup_id"
