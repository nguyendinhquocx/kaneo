#!/bin/sh
# Fixed-path, hash-pinned Kaneo card-agent production rollout; run via visible sudo on ProDesk.
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
BUNDLE=/home/quoc/kaneo/release/.staging/card-agent-collaboration
PROJECT=/srv/kaneo
COMPOSE=$PROJECT/compose.yml
WRAPPER=$PROJECT/recovery/backup-kaneo.sh
RECOVERY=/usr/local/lib/home-server-recovery
MIRROR=$PROJECT/recovery/mirror-kaneo-backup-r2.sh
STATUS=$RECOVERY/kaneo-status
CURRENT_IMAGE=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d7c14249-calendar-mindmap-int1@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc
NEW_IMAGE=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-48705de2-card-agent-collab@sha256:51a58e3a3ed1da1c8f8b91eccdab773d5aa4a0e670e3a2410c99d6c245c216bf
CURRENT_COMPOSE_SHA256=70459206ff5117c81ddc74c01f0a73cfed75fad10b357af3ff2b1da01c8a3c25
NEW_COMPOSE_SHA256=727dec02a209e3441840eea4f628b663bf4cf00f2a68df4ff090e36a04fe6da8
CURRENT_SOURCE_REVISION=d7c142498abadc303e802c4e61338b0b42ed71e3
NEW_SOURCE_REVISION=48705de286d1928b38253e22a3559991a2c5a779
CURRENT_WRAPPER_SHA256=8ce2b6b3d21dd59aa3325a59cc9eab038ed12d5e31d7cf13eb26d2e08cb1b2aa
NEW_WRAPPER_SHA256=aec36be2045f77963555d8dcdc69283c58685385d9d11b0cc52cb7c38bfcf318
NEW_SYNC_SHA256=759d6e292290db636456e76e29e9290b1bc712a0421456e87fc5badf47f6343e
NEW_MIGRATION_SHA256=5b8e33fe1057a8847e6b294225e4fc0a3ac3e28fe43b622c7f361e974d97f1a8
NEW_BACKUP_VERIFY_SHA256=943305bc2057dca1c61f6879990fb6e0fd505e0dc67b70a0a636193072292f8e
NEW_SNAPSHOT_ADAPTER_SHA256=b1c39a086d63670ab08f972ce06625268827271ddc402f3b391562a18d3adcc7
NEW_DEPLOY_SHA256=f81caa7d60fa8612240834cb01d064a848f4bf1dc05c3abe711feb40554d5a22
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
