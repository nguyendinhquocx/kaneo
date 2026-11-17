#!/bin/sh
# Kaneo wave uat-r4fix2 apply script. Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-apply.sh
# Fail-closed: every host-state assumption observed during the read-only
# survey is re-verified before any mutation. No path/host/bucket overrides.
set -eu

BUNDLE=/home/quoc/kaneo-wave-uat-r4fix2
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-uat-r4fix2.sh
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
MIGRATION_VERIFY=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY=/usr/local/lib/home-server-recovery/kaneo-backup-verify
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d1884ca4-uat-r4fix@sha256:883db42fec1116361d8e4caad927cba4351e81f72dbb749664d40f7d8325484e'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a5125cf5-uat-r4fix2@sha256:a68eb69371ff86be177bb6c08b6400df85fc7e05b0ecfa1134d5c9862cc719a7'
CURRENT_COMPOSE_SHA256=385c373756297ce14974c80ec6d15ccf2400dda69ba7df5189ac971aeb7fc45f
NEW_COMPOSE_SHA256=1043f99eb01a890f433ad955437da8bb5092c5863a0e942eb1a89320ff5b5fe4
NEW_WRAPPER_SHA256=e0077a54d0faa49caa1ae024e60f846be07035d6285af3305e093e16cad9b0bb
NEW_SYNC_SHA256=8940ac10d7c9bdc97de4ff896c2b8caa257f33b99d3edfc633278f9be9992bab
OLD_WRAPPER_SHA256=0453a148e45e3e86994a872dc3cb616a6213d9bb1d8503f4ad6b436f7de6cea6
OLD_SYNC_SHA256=cd91e5e19e715edfedccd4705e7cf26047d618079b29b9f242b4ab8802eea8cb

fail() { printf '%s\n' "KANEO WAVE APPLY BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/9 re-verify surveyed host state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production compose hash changed since the survey; re-survey before applying'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$OLD_WRAPPER_SHA256" ] || fail 'backup wrapper changed since the survey'
old_sync=$(sha256sum "$SYNC_TARGET" 2>/dev/null | awk '{print $1}' || true)
[ "$old_sync" = "$OLD_SYNC_SHA256" ] || [ -z "$old_sync" ] || fail 'sync-metadata changed since the survey'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$CURRENT_IMAGE" ] || fail 'running kaneo image is not the surveyed previous candidate'
sha_state=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$sha_state" = 'd1884ca49b3363edf4f9bcac74ab40f29a45428c' ] || fail 'install metadata source revision is not the surveyed previous candidate'

printf '%s\n' '== 2/9 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.next.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-sync-recovery-metadata.next" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync-metadata hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/9 stage repinned recovery files (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.next.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-sync-recovery-metadata.next" "$SYNC_TARGET"

printf '%s\n' '== 4/9 guarded deploy (backup guard, compose flip, pull, health, migration)'
sh "$DEPLOY_SCRIPT"

printf '%s\n' '== 5/9 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 6/9 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$MIGRATION_VERIFY"
sh "$BACKUP_VERIFY"

printf '%s\n' '== 7/9 fresh encrypted snapshot of the new release (adapter picks the repinned wrapper)'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER" --snapshot --yes)
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== 8/9 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 9/9 wave receipt'
printf '%s\n' "KANEO WAVE APPLY PASS: uat-r4fix2"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
