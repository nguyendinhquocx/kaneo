#!/bin/sh
# Fixed-path, hash-pinned Kaneo card-agent R8 production rollout; run via visible sudo on ProDesk.
set -eu
MODE=plan
if [ "$#" -eq 1 ] && [ "$1" = "--plan" ]; then
  MODE=plan
elif [ "$#" -eq 2 ] && [ "$1" = "--apply" ] && [ "$2" = "--yes" ]; then
  MODE=apply
else
  echo "Usage: $0 --plan | --apply --yes" >&2
  exit 2
fi
BUNDLE=/home/quoc/kaneo/staging/card-agent-collab-r8
PROJECT=/srv/kaneo
COMPOSE=$PROJECT/compose.yml
WRAPPER=$PROJECT/recovery/backup-kaneo.sh
RECOVERY=/usr/local/lib/home-server-recovery
MIRROR=$PROJECT/recovery/mirror-kaneo-backup-r2.sh
STATUS=$RECOVERY/kaneo-status
CURRENT_IMAGE=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-1e800ab2-card-agent-collab-r7@sha256:993a79ffcf87f0a90a9acc6dfcec1b74874063e9ecfe4eeb53f0530fed305188
NEW_IMAGE=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8@sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d
CURRENT_COMPOSE_SHA256=3f5e0989241b5d73df9e29d7fc2fba30e9f1e0b2afece97b82be78434ce5993c
NEW_COMPOSE_SHA256=4e88ce7bfded2b034c2cde7e20a8db7bd285289d16d67c5476e357ce5e4befc9
CURRENT_SOURCE_REVISION=1e800ab2fef42e647aa1a832f693ccde696cfc07
NEW_SOURCE_REVISION=c3df945b8c0b5678c7a4ce3da0358f03e4cf68e0
CURRENT_WRAPPER_SHA256=2ffe646e8a7901a4a4c841d0228161201970d37c006ee4d01d3cbea186d4479e
NEW_WRAPPER_SHA256=37689be88d73b303f0d6ba71a74bb0ff07e4ec6dd2398b73a6334a58b8742c4e
NEW_SYNC_SHA256=1c837198c914f84799bd7ee8d8c8be2274d35c0e70677997e668540519cd666c
NEW_MIGRATION_SHA256=5b460c26058c7a5d7a88edf901d8f82918b37cd7ac5eb17a6c2ccc81495727e0
NEW_BACKUP_VERIFY_SHA256=85fac0cde43252fe19ad169d4d98b6119dc10a3ada555674bb9aab8888975b50
NEW_SNAPSHOT_ADAPTER_SHA256=862e642dac2b2567f9b8461c3d0c94082e383bcb2cfef754f381b91e1184c248
NEW_DEPLOY_SHA256=6d67c51dfeaaa2eb40e195e6000142710604997364deb29a7c31a0ce1cd3110b
fail() { printf '%s\n' "Kaneo card-agent wave BLOCKED: $*" >&2; exit 2; }
sha() { sha256sum "$1" | awk '{print $1}'; }
[ "$(id -u)" -eq 0 ] || fail 'run as root via visible sudo ceremony'
[ -d "$BUNDLE" ] && [ ! -L "$BUNDLE" ] || fail 'bundle missing or symlinked'
[ -f "$COMPOSE" ] && [ ! -L "$COMPOSE" ] || fail 'production compose missing or symlinked'
[ "$(sha "$COMPOSE")" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production compose changed since survey'
[ "$(sha "$WRAPPER")" = "$CURRENT_WRAPPER_SHA256" ] || fail 'current backup wrapper changed since survey'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo)" = "$CURRENT_IMAGE" ] || fail 'running image changed since survey'
[ "$(docker inspect --format '{{.State.Health.Status}}' kaneo)" = healthy ] || fail 'current Kaneo is not healthy'
source_now=$(sed -n 's/^source_revision=//p' "$RECOVERY/kaneo-install-metadata" | tr -d '[:space:]')
[ "$source_now" = "$CURRENT_SOURCE_REVISION" ] || fail 'install metadata changed since survey'
[ "$(sha "$BUNDLE/compose.cardagent.yml")" = "$NEW_COMPOSE_SHA256" ] || fail 'candidate compose hash mismatch'
[ "$(sha "$BUNDLE/backup-kaneo.cardagent.sh")" = "$NEW_WRAPPER_SHA256" ] || fail 'candidate backup wrapper hash mismatch'
[ "$(sha "$BUNDLE/sync.cardagent.sh")" = "$NEW_SYNC_SHA256" ] || fail 'candidate metadata sync hash mismatch'
[ "$(sha "$BUNDLE/migration-verify.cardagent.sh")" = "$NEW_MIGRATION_SHA256" ] || fail 'candidate migration verifier hash mismatch'
[ "$(sha "$BUNDLE/backup-verify.cardagent.sh")" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'candidate backup verifier hash mismatch'
[ "$(sha "$BUNDLE/snapshot.cardagent.sh")" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail 'candidate snapshot adapter hash mismatch'
[ "$(sha "$BUNDLE/deploy-kaneo-cardagent.sh")" = "$NEW_DEPLOY_SHA256" ] || fail 'candidate deploy script hash mismatch'
[ "$(grep -Fxc "    image: $NEW_IMAGE" "$BUNDLE/compose.cardagent.yml")" = 1 ] || fail 'candidate compose image pin mismatch'
(cd "$PROJECT" && docker compose config --quiet) || fail 'current compose invalid'
(cd "$PROJECT" && docker compose ps --status running --services | grep -Fxq postgres) || fail 'postgres not running'
docker compose --project-directory "$PROJECT" --file "$BUNDLE/compose.cardagent.yml" config --quiet || fail 'candidate compose invalid'

printf '%s\n' '== 1/9 read-only preflight on current int1'
"$WRAPPER" --plan
"$RECOVERY/kaneo-migration-verify"
"$RECOVERY/kaneo-backup-verify"
"$STATUS" || true
if [ "$MODE" = plan ]; then
  printf '%s\n' "Kaneo card-agent pre-deploy plan PASS: current=$CURRENT_IMAGE candidate=$NEW_IMAGE compose=$NEW_COMPOSE_SHA256; no mutation."
  exit 0
fi

printf '%s\n' '== 2/9 fresh encrypted pre-migration snapshot of int1'
pre_output=$("$RECOVERY/kaneo-backup-snapshot-current")
printf '%s\n' "$pre_output"
pre_id=$(printf '%s\n' "$pre_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$pre_id" ] || fail 'pre-migration snapshot produced no receipt'
printf '%s\n' '== 3/9 mirror verified pre-migration ciphertext/receipt to private R2'
sh "$MIRROR" --mirror --yes --backup-id "$pre_id"

printf '%s\n' '== 4/9 stage exact reviewed adapters; runtime image remains int1'
install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.cardagent.sh" "$WRAPPER"
install -o root -g root -m 0555 "$BUNDLE/sync.cardagent.sh" "$RECOVERY/kaneo-sync-recovery-metadata"
install -o root -g root -m 0555 "$BUNDLE/migration-verify.cardagent.sh" "$RECOVERY/kaneo-migration-verify"
install -o root -g root -m 0555 "$BUNDLE/backup-verify.cardagent.sh" "$RECOVERY/kaneo-backup-verify"
install -o root -g root -m 0555 "$BUNDLE/snapshot.cardagent.sh" "$RECOVERY/kaneo-backup-snapshot-current"
[ "$(sha "$WRAPPER")" = "$NEW_WRAPPER_SHA256" ] || fail 'staged wrapper hash mismatch'
"$WRAPPER" --plan

printf '%s\n' '== 5/9 guarded compose flip, pinned pull, health, image identity, migration verification'
sh "$BUNDLE/deploy-kaneo-cardagent.sh"

printf '%s\n' '== 6/9 rebind root-only recovery metadata to candidate and verify receipt chain'
sh "$RECOVERY/kaneo-sync-recovery-metadata"
"$RECOVERY/kaneo-migration-verify"
"$RECOVERY/kaneo-backup-verify"
"$STATUS" || true

printf '%s\n' '== 7/9 fresh encrypted post-deploy snapshot; strict verify; R2 mirror'
post_output=$("$RECOVERY/kaneo-backup-snapshot-current")
printf '%s\n' "$post_output"
post_id=$(printf '%s\n' "$post_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$post_id" ] || fail 'post-deploy snapshot produced no receipt'
sh "$MIRROR" --mirror --yes --backup-id "$post_id"

printf '%s\n' '== 8/9 final origin health from ProDesk loopback'
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:5173/api/health
printf '%s\n' '== 9/9 wave receipt'
printf '%s\n' "Kaneo CARD-AGENT WAVE PASS: image=$NEW_IMAGE rollback=$CURRENT_IMAGE pre_backup=$pre_id post_backup=$post_id compose_sha256=$(sha "$COMPOSE")"
