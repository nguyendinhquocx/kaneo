#!/bin/sh
# Kaneo wave fullshare apply script. Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-fullshare/kaneo-wave-apply.sh
# Fail-closed: every host-state assumption observed during the read-only
# survey is re-verified before any mutation. No path/host/bucket overrides.
set -eu

BUNDLE=/home/quoc/kaneo-wave-fullshare
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-fullshare.sh
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e'
CURRENT_COMPOSE_SHA256=79cd209d157af98f86f89515eb30788f9844859e2e21063ab67cafd28d8425d4
NEW_COMPOSE_SHA256=12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195
NEW_WRAPPER_SHA256=bd4f3e4fe6ac987be85112d7c057e20dd103905c89b749f3c93aea4bef2a788e
NEW_SYNC_SHA256=d5549b556ec06dad66c42d908dc38430bbcd895738f71be07eea167cbbf5762c
NEW_MIGRATION_SHA256=36bc0b41c94d12950c05ed2c5b56df0a430c51d6ff6020eff7109fbc96cd89f3
NEW_BACKUP_VERIFY_SHA256=6f06920e566ec6b0bb224ad6609805d5ba20c8b4db3ac2a8f898e43a332fc5ec
OLD_WRAPPER_SHA256=5c836ab8bdceb42274b6c67bec219727c45f518425d340f713867deb0aff61b5
OLD_SYNC_SHA256=66eb27788cc928fa71c2fe0058c4cad6c806e237eb2478771433e0411104d094
OLD_MIGRATION_SHA256=1d01cae82e4889f3f4d17edc9681d22997ada5c361837faafebed1537baedb4b
OLD_BACKUP_VERIFY_SHA256=e2e3833adb0b6427c1eaa4c27f3c26c2b2ec9b43c8aa2f605b45af7ac1f8c168

fail() { printf '%s\n' "KANEO WAVE APPLY BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/9 re-verify surveyed host state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production compose hash changed since the survey; re-survey before applying'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$OLD_WRAPPER_SHA256" ] || fail 'backup wrapper changed since the survey'
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$OLD_SYNC_SHA256" ] || fail 'sync-metadata changed since the survey'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$OLD_MIGRATION_SHA256" ] || fail 'migration-verify changed since the survey'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$OLD_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify changed since the survey'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$CURRENT_IMAGE" ] || fail 'running kaneo image is not the surveyed previous candidate'
sha_state=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$sha_state" = 'a8cb40f316208ba350c1a8f43571078b131847e4' ] || fail 'install metadata source revision is not the surveyed previous candidate'

printf '%s\n' '== 2/9 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.next.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-sync-recovery-metadata.next" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-migration-verify.next" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-backup-verify.next" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/9 stage repinned adapters (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.next.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-sync-recovery-metadata.next" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-migration-verify.next" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-verify.next" "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 4/9 guarded deploy (backup guard, compose flip, pull, health, migration)'
sh "$DEPLOY_SCRIPT"

printf '%s\n' '== 5/9 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 6/9 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 7/9 fresh encrypted snapshot of the new release (adapter picks the repinned wrapper)'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER" --snapshot --yes)
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== 8/9 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 9/9 wave receipt'
printf '%s\n' "KANEO WAVE APPLY PASS: fullshare"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
