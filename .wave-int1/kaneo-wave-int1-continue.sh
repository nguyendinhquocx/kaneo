#!/bin/sh
# Kaneo wave int1 continuation after the failed pre-snapshot ordering:
# the int1 wrapper+adapters are already staged, but the pre-migration
# snapshot must run with the wrapper recorded in install metadata.
# Sequence: verify current state -> restore uatfix7 wrapper -> fresh
# encrypted pre-migration snapshot + R2 mirror -> restage int1 wrapper ->
# guarded deploy (compose flip, pull, health, migration 0052) -> metadata
# rebind -> post checks -> fresh post-deploy snapshot + R2 mirror.
# Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-int1/kaneo-wave-int1-continue.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-int1
U7_WRAPPER_SRC=/home/quoc/kaneo-wave-uatfix7/backup-kaneo.uatfix7.sh
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-int1.sh
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

OLD_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d7c14249-calendar-mindmap-int1@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc'
CURRENT_COMPOSE_SHA256=5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f
U7_WRAPPER_SHA256=ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820
INT1_WRAPPER_SHA256=8ce2b6b3d21dd59aa3325a59cc9eab038ed12d5e31d7cf13eb26d2e08cb1b2aa
INT1_MIGRATION_SHA256=916a7627683478fb92979ec6b1d1a85bdfa6ef986e1a60ea18258d6432311513
INT1_BACKUP_VERIFY_SHA256=d41cfdda6d8625ecfdf5d13dde44d682ad8bb60451964b204d949cb4a7a5f86f
INT1_SNAPSHOT_ADAPTER_SHA256=0689423a81639bf47e44065b1efd86ff27a511aee52cceedc54023aec91c3342
INT1_SYNC_SHA256=e940762af40c8583e3c009ad57815439404cc909f0c192b75b37a076f6493ed4

fail() { printf '%s\n' "KANEO INT1 CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/9 verify exact post-failed-apply host state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$CURRENT_COMPOSE_SHA256" ] || fail 'compose is not on the uatfix7 pin'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$INT1_WRAPPER_SHA256" ] || fail 'backup wrapper is not the staged int1 pin'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$INT1_MIGRATION_SHA256" ] || fail 'migration-verify is not the staged int1 pin'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$INT1_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify is not the staged int1 pin'
[ "$(sha256sum "$SNAPSHOT_ADAPTER" | awk '{print $1}')" = "$INT1_SNAPSHOT_ADAPTER_SHA256" ] || fail 'snapshot adapter is not the staged int1 pin'
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$INT1_SYNC_SHA256" ] || fail 'sync-metadata is not the staged int1 pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$OLD_IMAGE" ] || fail 'running kaneo image is not uatfix7'
sha_state=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$sha_state" = 'd56f1bbae914269fdd3b322fae4cbea19528603c' ] || fail 'install metadata source revision is not uatfix7'

printf '%s\n' '== 2/9 restore the uatfix7 wrapper recorded in install metadata'
[ -f "$U7_WRAPPER_SRC" ] && [ ! -L "$U7_WRAPPER_SRC" ] || fail 'uatfix7 wrapper source missing or symlinked'
[ "$(sha256sum "$U7_WRAPPER_SRC" | awk '{print $1}')" = "$U7_WRAPPER_SHA256" ] || fail 'uatfix7 wrapper source hash mismatch'
install -o root -g root -m 0555 "$U7_WRAPPER_SRC" "$WRAPPER_TARGET"
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$U7_WRAPPER_SHA256" ] || fail 'restored wrapper hash mismatch'

printf '%s\n' '== 3/9 fresh encrypted pre-migration snapshot of the CURRENT uatfix7 release'
pre_snapshot_output=$(sh "$WRAPPER_TARGET" --snapshot --yes)
printf '%s\n' "$pre_snapshot_output"
pre_backup_id=$(printf '%s\n' "$pre_snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$pre_backup_id" ] || fail 'could not determine the pre-migration backup id from snapshot output'

printf '%s\n' '== 4/9 mirror the pre-migration pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$pre_backup_id"

printf '%s\n' '== 5/9 restage the int1 wrapper for the deploy pair'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.int1.sh" "$WRAPPER_TARGET"
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$INT1_WRAPPER_SHA256" ] || fail 'restaged int1 wrapper hash mismatch'

printf '%s\n' '== 6/9 guarded deploy (backup guard, compose flip, pull, health, migration 0052)'
sh "$DEPLOY_SCRIPT"

printf '%s\n' '== 7/9 rebind recovery metadata to the int1 wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 8/9 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 9/9 fresh encrypted post-deploy snapshot of the int1 release + R2 mirror'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' "KANEO INT1 WAVE CONTINUE PASS"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$OLD_IMAGE"
printf '%s\n' "new_compose_sha256=$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')"
printf '%s\n' "pre_migration_backup_id=$pre_backup_id"
printf '%s\n' "backup_id=$backup_id"
