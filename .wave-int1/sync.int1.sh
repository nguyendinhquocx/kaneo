#!/bin/sh
# Update root-only recovery metadata after the reviewed candidate is staged.
# This changes no runtime state and writes no secret; the running image may still be the previous candidate while the pre-apply backup is taken.
set -eu

PROJECT_DIR=/srv/kaneo
COMPOSE_FILE=$PROJECT_DIR/compose.yml
BACKUP_WRAPPER=$PROJECT_DIR/recovery/backup-kaneo.sh
RECOVERY_ROOT=/usr/local/lib/home-server-recovery
METADATA=$RECOVERY_ROOT/kaneo-install-metadata
EXPECTED_SOURCE_REVISION=d7c142498abadc303e802c4e61338b0b42ed71e3
EXPECTED_COMPOSE_SHA256=70459206ff5117c81ddc74c01f0a73cfed75fad10b357af3ff2b1da01c8a3c25
EXPECTED_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d7c14249-calendar-mindmap-int1@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc'
EXPECTED_PREVIOUS_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
EXPECTED_BACKUP_WRAPPER_SHA256=8ce2b6b3d21dd59aa3325a59cc9eab038ed12d5e31d7cf13eb26d2e08cb1b2aa

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
