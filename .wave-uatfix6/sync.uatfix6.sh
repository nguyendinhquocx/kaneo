#!/bin/sh
# Update root-only recovery metadata after the reviewed candidate is staged.
# This changes no runtime state and writes no secret; the running image may still be the previous candidate while the pre-apply backup is taken.
set -eu

PROJECT_DIR=/srv/kaneo
COMPOSE_FILE=$PROJECT_DIR/compose.yml
BACKUP_WRAPPER=$PROJECT_DIR/recovery/backup-kaneo.sh
RECOVERY_ROOT=/usr/local/lib/home-server-recovery
METADATA=$RECOVERY_ROOT/kaneo-install-metadata
EXPECTED_SOURCE_REVISION=dca547b03e876106f709ce7c3cd7d484e2043986
EXPECTED_COMPOSE_SHA256=1e637fa348ddc6d4d53f7d4ff0c0f082ffbd06002218848281ac1c6d88a2e717
EXPECTED_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd'
EXPECTED_PREVIOUS_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d'
EXPECTED_BACKUP_WRAPPER_SHA256=e01c070fdfea2f41e39102ee99528bba99771b2aeb45bbadddb2044f659348da

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
