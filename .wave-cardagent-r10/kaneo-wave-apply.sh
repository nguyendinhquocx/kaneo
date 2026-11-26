#!/bin/sh
# Fixed-path, hash-pinned Kaneo card-agent R10 production rollout; run via visible sudo on ProDesk.
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
BUNDLE=/home/quoc/kaneo/staging/card-agent-collab-r10
PROJECT=/srv/kaneo
COMPOSE=$PROJECT/compose.yml
WRAPPER=$PROJECT/recovery/backup-kaneo.sh
RECOVERY=/usr/local/lib/home-server-recovery
MIRROR=$PROJECT/recovery/mirror-kaneo-backup-r2.sh
STATUS=$RECOVERY/kaneo-status
CURRENT_IMAGE=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-071cb51c-card-agent-collab-r9@sha256:dcdf49e614f38b1da211e66cceb52cee302dd4e5ce0c517959d17d919fb7aeb8
NEW_IMAGE=ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-da107aa4-card-agent-collab-r10@sha256:ab61b5e07d903ef88bea0b797a8cdc72e0915192bea7eae7d92dfae311eece8f
CURRENT_COMPOSE_SHA256=676edc655f07812e8b42a7dae6702d352ad7c0eec867a5536ed706f62772653a
NEW_COMPOSE_SHA256=f24c4851381ab13900a38d31fa11afa5c11807050c54a4c376a2ecd59d8da536
CURRENT_SOURCE_REVISION=071cb51c5d1882a7ebb48637e16c4547ab36a340
NEW_SOURCE_REVISION=da107aa4b7dbfb526bdbde20bfde9522afdb870a
CURRENT_WRAPPER_SHA256=343c2656d4130d9c69fcdd4852249bae2434603729a36cdd83033005dd87dc9c
NEW_WRAPPER_SHA256=60f9989f700db003e8b81cc14e35b3cdfa0054e7be94f19e894780cf495dd647
NEW_SYNC_SHA256=6366d3c1132462fc9075eac445d4e80f6d80be60f468513b8d91462b79d165a8
NEW_MIGRATION_SHA256=cd061f8a4208ef18adec28e9057fbb5f99e718d607eed8931364fa5ba6795926
NEW_BACKUP_VERIFY_SHA256=7a218ced2db4ec896f67fe80139783423e778e1a971477c242aa3cff9a2fe071
NEW_SNAPSHOT_ADAPTER_SHA256=62ff48822d91f32a2ce0917208886131164bc5c6cf9e275df3429aff6615e6df
NEW_DEPLOY_SHA256=6e5f026536ce0271250c0d5035e76fb748da3c4161a98809c8b05224cde25f79
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
