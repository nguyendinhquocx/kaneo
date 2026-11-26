#!/bin/sh
# Update root-only recovery metadata after the reviewed candidate is staged.
# This changes no runtime state and writes no secret; the running image may still be the previous candidate while the pre-apply backup is taken.
set -eu

PROJECT_DIR=/srv/kaneo
COMPOSE_FILE=$PROJECT_DIR/compose.yml
BACKUP_WRAPPER=$PROJECT_DIR/recovery/backup-kaneo.sh
RECOVERY_ROOT=/usr/local/lib/home-server-recovery
METADATA=$RECOVERY_ROOT/kaneo-install-metadata
EXPECTED_SOURCE_REVISION=071cb51c5d1882a7ebb48637e16c4547ab36a340
EXPECTED_COMPOSE_SHA256=676edc655f07812e8b42a7dae6702d352ad7c0eec867a5536ed706f62772653a
EXPECTED_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-071cb51c-card-agent-collab-r9@sha256:dcdf49e614f38b1da211e66cceb52cee302dd4e5ce0c517959d17d919fb7aeb8'
EXPECTED_PREVIOUS_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8@sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d'
EXPECTED_BACKUP_WRAPPER_SHA256=343c2656d4130d9c69fcdd4852249bae2434603729a36cdd83033005dd87dc9c

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
