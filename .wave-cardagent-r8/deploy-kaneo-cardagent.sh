#!/bin/sh
# Canonical Kaneo release deploy template — card-agent collaboration R8 wave pins
# (SPEC-2026-11-10-kaneo-card-agent-collaboration R8 @ c3df945b8c0b5678c7a4ce3da0358f03e4cf68e0).
#
# GUARD (T15 finding): step 1 proves the CURRENT release has a repinned
# backup wrapper; step 7 proves the NEW release does. Skipping the backup
# repin silently broke the backup chain for 33 days — this guard makes any
# future wave fail loud instead.
#
# Usage (root on ProDesk): sudo sh deploy-kaneo-cardagent.sh
set -eu

COMPOSE_DIR=/srv/kaneo
COMPOSE_FILE=$COMPOSE_DIR/compose.yml
BACKUP_WRAPPER=/srv/kaneo/recovery/backup-kaneo.sh

# ---- FILL THESE PINS PER WAVE -------------------------------------------
CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-1e800ab2-card-agent-collab-r7@sha256:993a79ffcf87f0a90a9acc6dfcec1b74874063e9ecfe4eeb53f0530fed305188'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8@sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d'
NEW_SHA='dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d'
# --------------------------------------------------------------------------

fail() { printf '%s\n' "KANEO DEPLOY BLOCKED: $*" >&2; exit 2; }
[ -n "$CURRENT_IMAGE" ] && [ -n "$NEW_IMAGE" ] && [ -n "$NEW_SHA" ] \
    || fail 'fill CURRENT_IMAGE / NEW_IMAGE / NEW_SHA pins first'
[ "$(id -u)" -eq 0 ] || fail 'must run as root (sudo)'
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail 'compose file missing or symlinked'
[ -x "$BACKUP_WRAPPER" ] || fail 'backup wrapper missing'

printf '%s\n' '== 1/8 backup guard (pre-flight): current release must have a repinned wrapper'
"$BACKUP_WRAPPER" --plan || fail 'backup wrapper is not repinned for the CURRENT release; fix the backup chain before deploying anything new'

printf '%s\n' '== 2/8 stage new pin atomically + pre-flip backup guard'
if grep -Fqx "    image: $CURRENT_IMAGE" "$COMPOSE_FILE"; then
    NEXT="$COMPOSE_FILE.next-wave"
    sed "s|$CURRENT_IMAGE|$NEW_IMAGE|" "$COMPOSE_FILE" > "$NEXT"
    grep -Fqx "    image: $NEW_IMAGE" "$NEXT" || fail 'staged compose missing new pin'
    (cd "$COMPOSE_DIR" && docker compose --file "$NEXT" config --quiet) || fail 'staged compose validation failed'
    # Pre-flip backup guard: the wrapper must review a pair matching the
    # staged compose hash + the NEW image identity. Without this a stale
    # wrapper only fails AFTER the new container is live.
    [ "${NEW_IMAGE%@*}" != "$NEW_IMAGE" ] || fail 'NEW_IMAGE must carry an @sha256: digest suffix'
    [ "${NEW_IMAGE##*@sha256:}" = "$NEW_SHA" ] || fail 'NEW_SHA does not match the digest suffix of NEW_IMAGE'
    staged_compose_hash=$(sha256sum "$NEXT" | awk '{print $1}')
    prev_c=$(sed -n 's/^PREVIOUS_COMPOSE_SHA256=//p' "$BACKUP_WRAPPER")
    prev_i=$(sed -n "s/^PREVIOUS_IMAGE_REF=//p" "$BACKUP_WRAPPER" | tr -d "'")
    cand_c=$(sed -n 's/^CANDIDATE_COMPOSE_SHA256=//p' "$BACKUP_WRAPPER")
    cand_i=$(sed -n "s/^CANDIDATE_IMAGE_REF=//p" "$BACKUP_WRAPPER" | tr -d "'")
    if [ "$staged_compose_hash" = "$cand_c" ] && [ "$cand_i" = "$NEW_IMAGE" ]; then
        : # wrapper reviews exactly this candidate
    elif [ "$staged_compose_hash" = "$prev_c" ] && [ "$prev_i" = "$CURRENT_IMAGE" ]; then
        fail 'backup wrapper only reviews the CURRENT release; repin it for the NEW release before deploying'
    else
        fail "backup wrapper reviews no pair matching staged compose $staged_compose_hash + $NEW_IMAGE"
    fi
    mv -f "$NEXT" "$COMPOSE_FILE"
elif grep -Fqx "    image: $NEW_IMAGE" "$COMPOSE_FILE"; then
    printf '%s\n' '   compose already on the new pin; continuing verification'
else
    fail 'current compose pin matches neither baseline nor target; refusing blind replace'
fi

printf '%s\n' '== 3/8 pull pinned image'
(cd "$COMPOSE_DIR" && docker compose pull kaneo)

printf '%s\n' '== 4/8 rolling restart kaneo container'
(cd "$COMPOSE_DIR" && docker compose up -d kaneo)

printf '%s\n' '== 5/8 wait for container health'
status=unknown
i=0
while [ "$i" -lt 30 ]; do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo 2>/dev/null || true)
    [ "$status" = healthy ] && break
    i=$((i + 1))
    sleep 5
done
[ "$status" = healthy ] || fail "container health is $status after timeout"
expected_image_id=$(docker image inspect --format '{{.Id}}' "$NEW_IMAGE")
[ "$(docker inspect --format '{{.Image}}' kaneo)" = "$expected_image_id" ] \
    || fail 'running image id does not match the pinned digest'

printf '%s\n' '== 6/8 migration verify'
if [ -x /usr/local/lib/home-server-recovery/kaneo-migration-verify ]; then
    /usr/local/lib/home-server-recovery/kaneo-migration-verify
fi

printf '%s\n' '== 7/8 backup guard (post-flip): new release must have a repinned wrapper'
"$BACKUP_WRAPPER" --plan || fail "backup wrapper --plan failed against the NEW release ($NEW_SHA); run kaneo-sync-recovery-metadata and mirror a fresh snapshot, or roll back"

printf '%s\n' '== 8/8 final status'
printf '%s\n' "KANEO DEPLOY PASS: $NEW_IMAGE"
printf '%s\n' "ROLLBACK PIN: $CURRENT_IMAGE"
