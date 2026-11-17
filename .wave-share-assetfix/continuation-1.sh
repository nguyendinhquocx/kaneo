#!/bin/sh
# Kaneo wave share-assetfix continuation: repin migration-verify + backup-verify,
# rebind recovery metadata, run read-only post-deploy checks, snapshot + mirror.
# Run as root on ProDesk:  sudo sh /home/quoc/kaneo-wave-share-assetfix/continuation-1.sh
# Fail-closed; host-state assumptions re-verified before any mutation.
set -eu

BUNDLE=/home/quoc/kaneo-wave-share-assetfix
COMPOSE_FILE=/srv/kaneo/compose.yml
SYNC_TARGET=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7ef486de-share-assetfix@sha256:63b794c187578000cf17d873208551ef4b01b1902b02c657deb9127f601cc139'
NEW_COMPOSE_SHA256=e5fc3c412554402994163822139fcc2c6689c1327845ae7b752005a6580cc5dc
NEW_SYNC_SHA256=4bc6263a9cb8b57505f27e18a955b56671adea3a02441400fa813a885ffe65e9
NEW_MIGRATION_SHA256=f0a0621c78fa9655bcc70e4a033f5e2db63b728fe96f1296c8a33d41d39cd1d6
NEW_BACKUP_VERIFY_SHA256=b4c46a97369891d1022e7079e2e17e98b01199abe2f243b721c47099595b2983
STAGED_MIGRATION_SHA256=396c8d8fe85ce915eea0f5716f824646792026909f9b8e28f2bfcdc6b56dd0b6
STAGED_BACKUP_VERIFY_SHA256=7d91ccd9188cd1efe4672647934334b7e73275f78cf0a5fd3310111d8004748b

fail() { printf '%s\n' "KANEO CONTINUATION BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/7 re-verify post-flip state'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'production compose is not the new wave pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not the new wave pin'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail "container health is $health"
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'sync target is not the staged new wave version'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$STAGED_MIGRATION_SHA256" ] || fail 'migration-verify changed since the survey'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$STAGED_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify changed since the survey'
[ "$(sha256sum "$BUNDLE/kaneo-migration-verify.next" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify.next hash mismatch'
[ "$(sha256sum "$BUNDLE/kaneo-backup-verify.next" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify.next hash mismatch'

printf '%s\n' '== 2/7 stage repinned read-only verifiers (atomic)'
install -o root -g root -m 0555 "$BUNDLE/kaneo-migration-verify.next" "$MIGRATION_TARGET"
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-verify.next" "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 3/7 migration verify (new wave pins)'
sh "$MIGRATION_TARGET"

printf '%s\n' '== 4/7 rebind recovery metadata to the new wave'
sh "$SYNC_TARGET"

printf '%s\n' '== 5/7 read-only status'
sh "$STATUS_SCRIPT" || true

printf '%s\n' '== 6/7 fresh encrypted snapshot of the new release + R2 mirror'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER" --snapshot --yes)
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 7/7 strict backup verify with the new wave identity'
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' 'KANEO CONTINUATION PASS: share-assetfix'
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
