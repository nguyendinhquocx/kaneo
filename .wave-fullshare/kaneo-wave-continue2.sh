#!/bin/sh
# Kaneo wave fullshare CONTINUATION 2: the only remaining blocker was the
# no-args snapshot adapter wrapper-allowlist. Run 1 + continuation 1 already
# flipped compose, verified migration/schema + backup chain, and rebound the
# install metadata. This script stages the repinned snapshot adapter, takes
# the fresh snapshot, mirrors the pair to R2, and prints the wave receipt.
# Fail-closed: any mismatch blocks instead of repairing.
set -eu

BUNDLE=/home/quoc/kaneo-wave-fullshare
SNAPSHOT_ADAPTER=/usr/local/lib/home-server-recovery/kaneo-backup-snapshot-current
MIRROR_SCRIPT=/srv/kaneo/recovery/mirror-kaneo-backup-r2.sh
STATUS_SCRIPT=/usr/local/lib/home-server-recovery/kaneo-status

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e'
NEW_COMPOSE_SHA256=12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195
NEW_SNAPSHOT_ADAPTER_SHA256=865efebc4d5726f82be4bdadf23e4e9387b1ab6dd0a434854b827e2a74a9d6dd
OLD_SNAPSHOT_ADAPTER_SHA256=9928a4269b9b88e5e1f2cea4c5d153f8926185e7983d4ead24b7d3b622e6c937

fail() { printf '%s\n' "KANEO WAVE CONTINUE2 BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== D1/6 re-verify post-flip wave state'
[ "$(sha256sum /srv/kaneo/compose.yml | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not on the fullshare pin'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)" = "$NEW_IMAGE" ] || fail 'running image is not the fullshare pin'
[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo)" = healthy ] || fail 'container is not healthy'
[ "$(sha256sum "$SNAPSHOT_ADAPTER" | awk '{print $1}')" = "$OLD_SNAPSHOT_ADAPTER_SHA256" ] || fail 'snapshot adapter changed since the survey'
meta_rev=$(sed -n 's/^source_revision=//p' /usr/local/lib/home-server-recovery/kaneo-install-metadata | tr -d '[:space:]')
[ "$meta_rev" = '09a9fe89298f0a1faad3389b5a733b046b49319e' ] || fail 'install metadata source revision is not the fullshare pin'

printf '%s\n' '== D2/6 verify bundle snapshot-adapter hash'
[ "$(sha256sum "$BUNDLE/kaneo-backup-snapshot-current.next" | awk '{print $1}')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'bundle snapshot adapter hash mismatch'
sh -n "$BUNDLE/kaneo-backup-snapshot-current.next" || fail 'bundle snapshot adapter syntax error'

printf '%s\n' '== D3/6 stage repinned snapshot adapter (atomic, no runtime effect)'
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-snapshot-current.next" "$SNAPSHOT_ADAPTER"

printf '%s\n' '== D4/6 fresh encrypted snapshot of the new release (adapter resolves the fullshare wrapper)'
snapshot_output=$(sh "$SNAPSHOT_ADAPTER")
printf '%s\n' "$snapshot_output"
backup_id=$(printf '%s\n' "$snapshot_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$backup_id" ] || fail 'could not determine the new backup id from snapshot output'

printf '%s\n' '== D5/6 mirror the fresh pair to the private R2 backup bucket'
sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$backup_id"

printf '%s\n' '== D6/6 wave receipt'
printf '%s\n' "KANEO WAVE APPLY PASS: fullshare"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$backup_id"
