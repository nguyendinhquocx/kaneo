#!/bin/sh
# Kaneo wave uat-r4fix2 continuation 2: fresh snapshot + R2 mirror + receipt.
# Context: continuation 1 completed migration-verify, post-flip backup guard,
# and metadata rebind, but blocked at the snapshot step because the host
# kaneo-backup-snapshot-current adapter allowlist did not yet contain the
# repinned wave wrapper. This script stages the allowlist entry (host file +
# exactly one new case, history preserved), then completes snapshot + mirror.
# Run as root on ProDesk: sudo sh /home/quoc/kaneo-wave-uat-r4fix2/kaneo-wave-continue2.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uat-r4fix2
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
ADAPTER_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
BACKUP_VERIFY=/usr/local/lib/home-server-recovery/kaneo-backup-verify

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a5125cf5-uat-r4fix2@sha256:a68eb69371ff86be177bb6c08b6400df85fc7e05b0ecfa1134d5c9862cc719a7'
ROLLBACK_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d1884ca4-uat-r4fix@sha256:883db42fec1116361d8e4caad927cba4351e81f72dbb749664d40f7d8325484e'
NEW_COMPOSE_SHA256=1043f99eb01a890f433ad955437da8bb5092c5863a0e942eb1a89320ff5b5fe4
NEW_WRAPPER_SHA256=e0077a54d0faa49caa1ae024e60f846be07035d6285af3305e093e16cad9b0bb
NEW_ADAPTER_SHA256=108037aa335a9fe252a313d13c88053a1e4fac11a4ed755f408a0627e971e5ec

fail() { printf '%s\n' "KANEO WAVE CONTINUE2 BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/5 re-verify deployed state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not the staged candidate'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the repinned wave wrapper'
[ "$(sha256sum "$BUNDLE/kaneo-backup-snapshot-current.next" | awk '{print $1}')" = "$NEW_ADAPTER_SHA256" ] || fail 'bundle adapter hash mismatch'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not the wave candidate'
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo 2>/dev/null || true)
[ "$health" = 'healthy' ] || fail "candidate container health is $health"
meta_rev=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$meta_rev" = 'a5125cf5a2c578be87612113b17a879a1493e570' ] || fail "metadata revision is $meta_rev; expected the rebound a5125cf5 metadata"

printf '%s\n' '== 2/5 stage snapshot adapter with the wave allowlist entry (atomic)'
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-snapshot-current.next" "$ADAPTER_TARGET"

printf '%s\n' '== 3/5 fresh encrypted snapshot of the new release (adapter strict-verifies the new bundle)'
adapter_output=$(sh "$ADAPTER_TARGET")
printf '%s\n' "$adapter_output"
backup_id=$(printf '%s\n' "$adapter_output" | sed -n 's/^Kaneo current backup PASS: \(kaneo-[0-9]\{8\}T[0-9]\{6\}Z\) .*/\1/p')
[ -n "$backup_id" ] || fail 'could not determine the new backup id from adapter output'

printf '%s\n' '== 4/5 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== 5/5 final read-only verification + wave receipt'
sh "$BACKUP_VERIFY"
printf '%s\n' "KANEO WAVE CONTINUE2 PASS: uat-r4fix2"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$ROLLBACK_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
