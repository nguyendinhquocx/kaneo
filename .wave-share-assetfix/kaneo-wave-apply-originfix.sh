#!/bin/sh
# Kaneo wave share-originfix apply (wave 2, all-in-one). Run as root on ProDesk:
#   sudo sh /home/quoc/kaneo-wave-share-assetfix/kaneo-wave-apply-originfix.sh
# Fail-closed; every host-state assumption is re-verified before mutation.
# Contracts learned in wave share-assetfix: snapshot adapter is no-args and
# needs the new wrapper hash in its allowlist BEFORE the snapshot runs.
set -eu

BUNDLE=/home/quoc/kaneo-wave-share-assetfix
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status
DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-share-originfix.sh

CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7ef486de-share-assetfix@sha256:63b794c187578000cf17d873208551ef4b01b1902b02c657deb9127f601cc139'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a'
CURRENT_COMPOSE_SHA256=e5fc3c412554402994163822139fcc2c6689c1327845ae7b752005a6580cc5dc
NEW_COMPOSE_SHA256=79cd209d157af98f86f89515eb30788f9844859e2e21063ab67cafd28d8425d4
NEW_WRAPPER_SHA256=5c836ab8bdceb42274b6c67bec219727c45f518425d340f713867deb0aff61b5
NEW_SYNC_SHA256=66eb27788cc928fa71c2fe0058c4cad6c806e237eb2478771433e0411104d094
NEW_MIGRATION_SHA256=1d01cae82e4889f3f4d17edc9681d22997ada5c361837faafebed1537baedb4b
NEW_BACKUP_VERIFY_SHA256=e2e3833adb0b6427c1eaa4c27f3c26c2b2ec9b43c8aa2f605b45af7ac1f8c168
NEW_ADAPTER_SHA256=9928a4269b9b88e5e1f2cea4c5d153f8926185e7983d4ead24b7d3b622e6c937
OLD_WRAPPER_SHA256=3cca338129c247306b8458f1ed3c849b9ab3d6bdc99916dc446a7f4526fabdb8
OLD_SYNC_SHA256=4bc6263a9cb8b57505f27e18a955b56671adea3a02441400fa813a885ffe65e9
OLD_MIGRATION_SHA256=f0a0621c78fa9655bcc70e4a033f5e2db63b728fe96f1296c8a33d41d39cd1d6
OLD_BACKUP_VERIFY_SHA256=b4c46a97369891d1022e7079e2e17e98b01199abe2f243b721c47099595b2983
OLD_ADAPTER_SHA256=3be9adeebbda68a7bebcd2524daabc604ffb75180936f0552463abfc2f1ea888

fail() { printf '%s\n' "KANEO WAVE APPLY BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/8 re-verify surveyed host state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production compose hash changed since the survey'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$OLD_WRAPPER_SHA256" ] || fail 'backup wrapper changed since the survey'
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$OLD_SYNC_SHA256" ] || fail 'sync metadata changed since the survey'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$OLD_MIGRATION_SHA256" ] || fail 'migration-verify changed since the survey'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$OLD_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify changed since the survey'
[ "$(sha256sum "$SNAPSHOT_ADAPTER" | awk '{print $1}')" = "$OLD_ADAPTER_SHA256" ] || fail 'snapshot adapter changed since the survey'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$CURRENT_IMAGE" ] || fail 'running kaneo image is not the surveyed previous candidate'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail 'running kaneo container is not healthy'
for f in backup-kaneo.next2.sh kaneo-sync-recovery-metadata.next2 kaneo-migration-verify.next2 kaneo-backup-verify.next2 adapter.next2; do
    [ -f "$BUNDLE/$f" ] || fail "bundle file missing: $f"
done

printf '%s\n' '== 2/8 verify candidate bundle integrity'
[ "$(sha256sum "$BUNDLE/backup-kaneo.next2.sh" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'bundle wrapper hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-sync-recovery-metadata.next2" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'bundle sync hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-migration-verify.next2" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-backup-verify.next2" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
[ "$(sha256sum "$BUNDLE/adapter.next2" | awk '{print $1}')" = "$NEW_ADAPTER_SHA256" ] || fail 'bundle adapter hash mismatch'
grep -Fqx "CURRENT_IMAGE='$CURRENT_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script CURRENT pin mismatch'
grep -Fqx "NEW_IMAGE='$NEW_IMAGE'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW pin mismatch'
NEW_SHA=${NEW_IMAGE##*@sha256:}
grep -Fqx "NEW_SHA='$NEW_SHA'" "$DEPLOY_SCRIPT" || fail 'deploy script NEW_SHA pin mismatch'

printf '%s\n' '== 3/8 stage all repinned ops files (atomic, runtime unchanged)'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.next2.sh" "$WRAPPER_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-sync-recovery-metadata.next2" "$SYNC_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-migration-verify.next2" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-verify.next2" "$BACKUP_VERIFY_TARGET"
install -o root -g root -m 0555 "$BUNDLE/adapter.next2" "$SNAPSHOT_ADAPTER"

printf '%s\n' '== 4/8 guarded deploy (backup guard, compose flip, pull, health)'
sh "$DEPLOY_SCRIPT"

printf '%s\n' '== 5/8 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 6/8 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$MIGRATION_TARGET"

printf '%s\n' '== 7/8 fresh encrypted snapshot + R2 mirror'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 8/8 strict backup verify + receipt'
sh "$BACKUP_VERIFY_TARGET"
printf '%s\n' 'KANEO WAVE APPLY PASS: share-originfix'
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$CURRENT_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
