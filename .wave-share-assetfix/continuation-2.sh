#!/bin/sh
# Kaneo wave share-assetfix continuation 2: snapshot (no-args adapter contract),
# R2 mirror, strict backup verify. Steps 1-4 of continuation-1 already PASS
# (verifiers staged, metadata rebound); this script re-verifies that state.
# Run as root on ProDesk:  sudo sh /home/quoc/kaneo-wave-share-assetfix/continuation-2.sh
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

fail() { printf '%s\n' "KANEO CONTINUATION-2 BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/5 re-verify continuation-1 state'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'production compose is not the new wave pin'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not the new wave pin'
health=$(docker inspect --format '{{.State.Health.Status}}' kaneo 2>/dev/null || true)
[ "$health" = healthy ] || fail "container health is $health"
[ "$(sha256sum "$SYNC_TARGET" | awk '{print $1}')" = "$NEW_SYNC_SHA256" ] || fail 'sync target is not the new wave version'
[ "$(sha256sum "$MIGRATION_TARGET" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'migration-verify is not the new wave version'
[ "$(sha256sum "$BACKUP_VERIFY_TARGET" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'backup-verify is not the new wave version'
sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | grep -Fxq '7ef486dedaa45eb724d4c319a3a0ed29e4193f58' || fail 'install-metadata not rebound to the new wave'

printf '%s\n' '== 2/5 migration verify (re-run, new pins)'
sh "$MIGRATION_TARGET"

printf '%s\n' '== 3/5 read-only status'
sh "$STATUS_SCRIPT" || true

printf '%s\n' '== 4/5 fresh encrypted snapshot (no-args adapter contract) + R2 mirror'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 5/5 strict backup verify with the new wave identity'
sh "$BACKUP_VERIFY_TARGET"

printf '%s\n' 'KANEO CONTINUATION-2 PASS: share-assetfix'
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
