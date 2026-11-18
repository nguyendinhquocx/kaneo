#!/bin/sh
# One-shot sudo bundle (v3, order fixed per R10 apply flow):
# repin wrapper -> pre-flip guard -> compose flip -> sync metadata ->
# pre snapshot -> pull/up/health/migration -> post guard -> post snapshot.
# Run: sudo sh run-all.sh
set -eu
exec > /tmp/kaneo-deploy-glanceable/run.log 2>&1

BUNDLE_DIR=/tmp/kaneo-deploy-glanceable
COMPOSE_DIR=/srv/kaneo
COMPOSE_FILE=$COMPOSE_DIR/compose.yml
WRAPPER=/srv/kaneo/recovery/backup-kaneo.sh
CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-da107aa4-card-agent-collab-r10@sha256:ab61b5e07d903ef88bea0b797a8cdc72e0915192bea7eae7d92dfae311eece8f'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7a8dc20e-glanceable-progress@sha256:8818eb60d14fdd15dedf8af57622b58f3c96fd7584e11cf3e912ff0ae1356b61'
NEW_SHA='8818eb60d14fdd15dedf8af57622b58f3c96fd7584e11cf3e912ff0ae1356b61'

fail() { printf '%s\n' "KANEO RUN BLOCKED: $*" >&2; exit 2; }

printf '%s\n' '== 1/8 repin backup wrapper pairs (previous=r10, candidate=glanceable)'
sed -i 's|^PREVIOUS_COMPOSE_SHA256=.*|PREVIOUS_COMPOSE_SHA256=f24c4851381ab13900a38d31fa11afa5c11807050c54a4c376a2ecd59d8da536|' "$WRAPPER"
sed -i "s|^PREVIOUS_IMAGE_REF=.*|PREVIOUS_IMAGE_REF='$CURRENT_IMAGE'|" "$WRAPPER"
sed -i 's|^CANDIDATE_COMPOSE_SHA256=.*|CANDIDATE_COMPOSE_SHA256=0835ee222befc5a5f1a30a4020096ca20dcf382dc93abb1d4dab09aeb1c4f99f|' "$WRAPPER"
sed -i "s|^CANDIDATE_IMAGE_REF=.*|CANDIDATE_IMAGE_REF='$NEW_IMAGE'|" "$WRAPPER"
chmod 555 "$WRAPPER"

printf '%s\n' '== 2/8 pre-flip backup guard (current release pair)'
"$WRAPPER" --plan

printf '%s\n' '== 3/8 compose flip (atomic stage + validate + wrapper pair check)'
if grep -Fqx "    image: $CURRENT_IMAGE" "$COMPOSE_FILE"; then
    NEXT="$COMPOSE_FILE.next-wave"
    sed "s|$CURRENT_IMAGE|$NEW_IMAGE|" "$COMPOSE_FILE" > "$NEXT"
    grep -Fqx "    image: $NEW_IMAGE" "$NEXT" || fail 'staged compose missing new pin'
    (cd "$COMPOSE_DIR" && docker compose --file "$NEXT" config --quiet) || fail 'staged compose validation failed'
    [ "${NEW_IMAGE##*@sha256:}" = "$NEW_SHA" ] || fail 'NEW_SHA does not match digest suffix'
    staged_compose_hash=$(sha256sum "$NEXT" | awk '{print $1}')
    cand_c=$(sed -n 's/^CANDIDATE_COMPOSE_SHA256=//p' "$WRAPPER")
    cand_i=$(sed -n "s/^CANDIDATE_IMAGE_REF=//p" "$WRAPPER" | tr -d "'")
    [ "$staged_compose_hash" = "$cand_c" ] && [ "$cand_i" = "$NEW_IMAGE" ] \
        || fail "wrapper pair does not review staged compose $staged_compose_hash + $NEW_IMAGE"
    mv -f "$NEXT" "$COMPOSE_FILE"
elif grep -Fqx "    image: $NEW_IMAGE" "$COMPOSE_FILE"; then
    printf '%s\n' '   compose already on the new pin'
else
    fail 'compose pin matches neither baseline nor target'
fi

printf '%s\n' '== 4/8 install + run reviewed metadata sync (compose now = candidate)'
install -o root -g root -m 0555 "$BUNDLE_DIR/kaneo-sync-recovery-metadata.next" /usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata
/usr/local/lib/home-server-recovery/kaneo-sync-recovery-metadata

printf '%s\n' '== 5/8 pre-apply encrypted snapshot (candidate pair now valid)'
"$WRAPPER" --snapshot --yes

printf '%s\n' '== 6/8 pull + rolling restart + health + digest check'
(cd "$COMPOSE_DIR" && docker compose pull kaneo)
(cd "$COMPOSE_DIR" && docker compose up -d kaneo)
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
if [ -x /usr/local/lib/home-server-recovery/kaneo-migration-verify ]; then
    /usr/local/lib/home-server-recovery/kaneo-migration-verify
fi
"$WRAPPER" --plan || fail 'backup wrapper --plan failed against the NEW release; run kaneo-sync-recovery-metadata + fresh snapshot, or roll back'

printf '%s\n' '== 7/8 post-apply encrypted snapshot'
"$WRAPPER" --snapshot --yes

printf '%s\n' '== 8/8 final state'
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep '^kaneo|'
grep -n "image: ghcr.io" "$COMPOSE_FILE"
printf '%s\n' "KANEO DEPLOY PASS: $NEW_IMAGE"
printf '%s\n' "ROLLBACK PIN: $CURRENT_IMAGE"
