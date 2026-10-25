#!/bin/sh
# Kaneo wave uatfix3 apply script. Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-uatfix3/kaneo-wave-apply.sh
# Fail-closed: every host-state assumption is re-verified before any
# mutation. No path/host/bucket overrides. Snapshot adapter is staged in
# the same atomic step (its new allowlist entry accepts the uatfix3
# wrapper), so the fresh snapshot runs without a separate continuation.
set -eu

BUNDLE=/home/quoc/kaneo-wave-uatfix3
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-uatfix3.sh
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-708d1712-uatfix3@sha256:4e952ebe74c32bdea01c6d306643b811162454ab6f74f8dde63f214b19a7eb88'
CURRENT_COMPOSE_SHA256=12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195
NEW_COMPOSE_SHA256=c57926be993152afb037c69fc594a52584b384b2d140d1c34a1d9bad93843ddb
NEW_WRAPPER_SHA256=689298548be81b6f54a4037d29b9633fab81926e71b20fb22e3e1c956dee15ea
NEW_SYNC_SHA256=7ced12361d235d8db9b370ae47ea6df549c526fe65ed2b848e98b2598c4783fa
NEW_MIGRATION_SHA256=f3508c19fc549c52fb80d0fc0745293966a18be9aa142366a7e9355be699aec4
NEW_BACKUP_VERIFY_SHA256=8d8c19b3ba205101fd00027abc5fb607e060286f760b751290bcc8e0ee4d167e
NEW_SNAPSHOT_ADAPTER_SHA256=2746ad9f1d308adef5c5f8fff3e76764fa8c86bfe109eb4fd75f402c74beb0f2
OLD_WRAPPER_SHA256=bd4f3e4fe6ac987be85112d7c057e20dd103905c89b749f3c93aea4bef2a788e
OLD_SYNC_SHA256=d5549b556ec06dad66c42d908dc38430bbcd895738f71be07eea167cbbf5762c
OLD_MIGRATION_SHA256=36bc0b41c94d12950c05ed2c5b56df0a430c51d6ff6020eff7109fbc96cd89f3
OLD_BACKUP_VERIFY_SHA256=6f06920e566ec6b0bb224ad6609805d5ba20c8b4db3ac2a8f898e43a332fc5ec
OLD_SNAPSHOT_ADAPTER_SHA256=865efebc4d5726f82be4bdadf23e4e9387b1ab6dd0a434854b827e2a74a9d6dd

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
[ "$sha_state" = '09a9fe89298f0a1faad3389b5a733b046b49319e' ] || fail 'install metadata source revision is not the surveyed previous candidate'

printf '%s\n' '== 2/9 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.next.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-sync-recovery-metadata.next" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-migration-verify.next" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-backup-verify.next" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-backup-snapshot-current.next" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/9 stage repinned adapters (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.next.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-sync-recovery-metadata.next" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-migration-verify.next" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-verify.next" "$BACKUP_VERIFY_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-snapshot-current.next" "$SNAPSHOT_ADAPTER"

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
printf '%s\n' "KANEO WAVE APPLY PASS: uatfix3"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
