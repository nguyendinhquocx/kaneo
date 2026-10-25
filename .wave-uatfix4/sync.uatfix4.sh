#!/bin/sh
# Update root-only recovery metadata after the reviewed candidate is staged.
# This changes no runtime state and writes no secret; the running image may still be the previous candidate while the pre-apply backup is taken.
set -eu

PROJECT_DIR=/srv/kaneo
COMPOSE_FILE=$PROJECT_DIR/compose.yml
BACKUP_WRAPPER=$PROJECT_DIR/recovery/backup-kaneo.sh
RECOVERY_ROOT=/usr/local/lib/home-server-recovery
METADATA=$RECOVERY_ROOT/kaneo-install-metadata
EXPECTED_SOURCE_REVISION=b0eb792f72f3055e0429a8fa382e686783e9af61
EXPECTED_COMPOSE_SHA256=314899585bce6cb69f3a09275b41c1f055e40989589edf8d470b5d286f3c6a33
EXPECTED_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b0eb792f-uatfix4@sha256:2d421f5c08accfd93fee04e1e2ea100dcccc51855348d3a15dbea0570864631e'
EXPECTED_PREVIOUS_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-708d1712-uatfix3@sha256:4e952ebe74c32bdea01c6d306643b811162454ab6f74f8dde63f214b19a7eb88'
EXPECTED_BACKUP_WRAPPER_SHA256=87bf9ab191ea063dba4c3f7db3ab54ee3ddee2bc017fe1078bed9159e6f9ae0c

fail() { printf '%s\n' "Kaneo recovery metadata BLOCKED: $*" >&2; exit 2; }
[ "$#" -eq 0 ] || fail 'no arguments are accepted'
[ "$(id -u)" -eq 0 ] || fail 'root execution required'
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail 'candidate Compose missing or symlinked'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$EXPECTED_COMPOSE_SHA256" ] || fail 'candidate Compose hash mismatch'
grep -Fqx "    image: $EXPECTED_IMAGE" "$COMPOSE_FILE" || fail 'candidate image pin missing'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$EXPECTED_IMAGE" ] || [ "$running_image" = "$EXPECTED_PREVIOUS_IMAGE" ] || fail 'running Kaneo image is neither the reviewed candidate nor the previous candidate'
[ -f "$BACKUP_WRAPPER" ] && [ ! -L "$BACKUP_WRAPPER" ] || fail 'candidate backup wrapper missing or symlinked'
[ "$(sha256sum "$BACKUP_WRAPPER" | awk '{print $1}')" = "$EXPECTED_BACKUP_WRAPPER_SHA256" ] || fail 'candidate backup wrapper hash mismatch'
install -d -o root -g root -m 0755 "$RECOVERY_ROOT"
temp=$(mktemp "$RECOVERY_ROOT/.kaneo-install-metadata.XXXXXX")
cleanup() { rm -f "$temp"; }
trap cleanup EXIT HUP INT TERM
printf 'source_revision=%s\nsnapshot_sha256=%s\n' "$EXPECTED_SOURCE_REVISION" "$EXPECTED_BACKUP_WRAPPER_SHA256" > "$temp"
chown root:root "$temp"
chmod 0644 "$temp"
mv -f "$temp" "$METADATA"
trap - EXIT HUP INT TERM
printf '%s\n' "Kaneo recovery metadata PASS: source_revision=$EXPECTED_SOURCE_REVISION snapshot_sha256=$EXPECTED_BACKUP_WRAPPER_SHA256"
