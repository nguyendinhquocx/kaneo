#!/bin/sh
# Kaneo wave uat-r4fix2 continuation: finish the interrupted apply sequence.
# Context: the main apply script blocked at deploy step 6/8 because the host
# kaneo-migration-verify still pinned the d188 wave. At that point compose was
# already flipped, the candidate container was already healthy, and the
# repinned backup wrapper was already staged. This script re-verifies that
# exact state (fail-closed), stages the repinned migration-verify, then
# completes the remaining steps in order.
# Run as root on ProDesk: sudo sh /home/quoc/kaneo-wave-uat-r4fix2/kaneo-wave-continue.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uat-r4fix2
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
MIGRATION_TARGET=/usr/local/lib/home-server-recovery/kaneo-migration-verify
SYNC_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
BACKUP_VERIFY=/usr/local/lib/home-server-recovery/kaneo-backup-verify
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a5125cf5-uat-r4fix2@sha256:a68eb69371ff86be177bb6c08b6400df85fc7e05b0ecfa1134d5c9862cc719a7'
ROLLBACK_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d1884ca4-uat-r4fix@sha256:883db42fec1116361d8e4caad927cba4351e81f72dbb749664d40f7d8325484e'
NEW_COMPOSE_SHA256=1043f99eb01a890f433ad955437da8bb5092c5863a0e942eb1a89320ff5b5fe4
NEW_WRAPPER_SHA256=e0077a54d0faa49caa1ae024e60f846be07035d6285af3305e093e16cad9b0bb
NEW_MIGRATION_SHA256=396c8d8fe85ce915eea0f5716f824646792026909f9b8e28f2bfcdc6b56dd0b6

fail() { printf '%s\n' "KANEO WAVE CONTINUE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/8 re-verify post-flip host state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not the staged candidate; refusing blind continue'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the repinned wave wrapper'
[ "$(sha256sum "$BUNDLE/kaneo-migration-verify.next" | awk '{print $1}')" = "$NEW_MIGRATION_SHA256" ] || fail 'bundle migration-verify hash mismatch'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not the wave candidate'
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo 2>/dev/null || true)
[ "$health" = 'healthy' ] || fail "candidate container health is $health"
meta_rev=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$meta_rev" = 'd1884ca49b3363edf4f9bcac74ab40f29a45428c' ] || fail "metadata revision is $meta_rev; expected the not-yet-rebound d188 metadata"

printf '%s\n' '== 2/8 stage repinned migration-verify (atomic)'
install -o root -g root -m 0555 "$BUNDLE/kaneo-migration-verify.next" "$MIGRATION_TARGET"

printf '%s\n' '== 3/8 migration/schema verify on the running candidate'
sh "$MIGRATION_TARGET"

printf '%s\n' '== 4/8 backup guard post-flip (wrapper must review the candidate pair)'
sh "$WRAPPER_TARGET" --plan

printf '%s\n' '== 5/8 rebind recovery metadata to the new wave'
sh "$SYNC_SCRIPT"

printf '%s\n' '== 6/8 read-only post-deploy checks'
sh "$STATUS_SCRIPT" || true
sh "$BACKUP_VERIFY"

printf '%s\n' '== 7/8 fresh encrypted snapshot of the new release (adapter picks the repinned wrapper)'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER" --snapshot --yes)
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== 8/8 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' "KANEO WAVE CONTINUE PASS: uat-r4fix2"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$ROLLBACK_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
