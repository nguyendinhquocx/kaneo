#!/bin/sh
# R10 guarded one-shot rollout for the code-only subtask-order fix.
# Run from the staged bundle with: sudo sh run-all.sh --plan
# Apply only after review: sudo sh run-all.sh --apply --yes
set -eu
MODE=plan
if [ "$#" -eq 1 ] && [ "$1" = "--plan" ]; then
    MODE=plan
elif [ "$#" -eq 2 ] && [ "$1" = "--apply" ] && [ "$2" = "--yes" ]; then
    MODE=apply
else
    printf '%s\n' 'Usage: run-all.sh --plan | --apply --yes' >&2
    exit 2
fi

BUNDLE_DIR=/home/quoc/kaneo/staging/kaneo-subtask-order-r1
COMPOSE_DIR=/srv/kaneo
COMPOSE_FILE=$COMPOSE_DIR/compose.yml
WRAPPER=$COMPOSE_DIR/recovery/backup-kaneo.sh
RECOVERY=/usr/local/lib/home-server-recovery
OUTBOX_ROOT=/var/lib/home-server-recovery/kaneo-outbox
BACKUP_VERIFIER=$RECOVERY/kaneo-verify-backup.py
EXPECTED_BACKUP_VERIFIER_SHA256=d6c27751cc7964317bbbe7e81ce5a81625e616ac3e638dcdf0566083aad6beaf
CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7a8dc20e-glanceable-progress@sha256:8818eb60d14fdd15dedf8af57622b58f3c96fd7584e11cf3e912ff0ae1356b61'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-4a4996a3-subtask-order-r1@sha256:fd6569575a92f76101c5838034a90ad0f9d70d5240575733501c7729837bc282'
NEW_SHA='fd6569575a92f76101c5838034a90ad0f9d70d5240575733501c7729837bc282'
CURRENT_SOURCE_REVISION='7a8dc20ed9e558bc23d0d9f4d02bbc868c4793c9'
SOURCE_REVISION='4a4996a3ed680480fedf3c4b17b7850112840d96'
SOURCE_ARCHIVE_SHA256='ddae118265a09ffc9a80a5b9c1d973e85a4ce9e766b62539b0a74e7e71b7bffb'
CURRENT_COMPOSE_SHA256='0835ee222befc5a5f1a30a4020096ca20dcf382dc93abb1d4dab09aeb1c4f99f'
NEW_COMPOSE_SHA256='85fe2ccc5f8a31d5a9c83b268ec22992987a4910663e819d95917da1d3e37ecf'
CURRENT_WRAPPER_SHA256='3e553181ab2ae4e5a9c8a42fb56a0b7b0a9d890a3b4caf9714298b530b0e23dd'
NEW_WRAPPER_SHA256='7b0b9247bdfb8de744b6feda9ca7fb8d78fe6761bca91c3f14ae0e1e77f27134'
NEW_SYNC_SHA256='9bbf75baf5faef23761b4605ee049b4efd63fe94df5bb9ca83b2d8a8bfc4239e'
NEW_MIGRATION_SHA256='599acbb1791ad168afc5327640271a45e93e24b00d113314b99fe4b251a0e968'

fail() { printf '%s\n' "KANEO R10 SUBTASK-ORDER BLOCKED: $*" >&2; exit 2; }
sha() { sha256sum "$1" | awk '{print $1}'; }
VERIFY_DIR=''
cleanup_verify() {
    if [ -n "$VERIFY_DIR" ] && [ -d "$VERIFY_DIR" ]; then rm -rf "$VERIFY_DIR"; fi
}
trap cleanup_verify EXIT HUP INT TERM

verify_snapshot() {
    backup_id=$1
    expected_compose=$2
    expected_image=$3
    expected_source=$4
    printf '%s\n' "$backup_id" | grep -Eq '^kaneo-[0-9]{8}T[0-9]{6}Z$' || fail 'backup ID format invalid'
    [ -f "$BACKUP_VERIFIER" ] && [ ! -L "$BACKUP_VERIFIER" ] || fail 'strict backup verifier missing or symlinked'
    [ "$(sha "$BACKUP_VERIFIER")" = "$EXPECTED_BACKUP_VERIFIER_SHA256" ] || fail 'strict backup verifier hash mismatch'
    VERIFY_DIR=$(mktemp -d "$OUTBOX_ROOT/.verify.XXXXXX")
    ln "$OUTBOX_ROOT/$backup_id.age" "$VERIFY_DIR/$backup_id.age"
    ln "$OUTBOX_ROOT/$backup_id.receipt.json" "$VERIFY_DIR/$backup_id.receipt.json"
    python3 "$BACKUP_VERIFIER" "$VERIFY_DIR" --json
    python3 - "$VERIFY_DIR/$backup_id.receipt.json" "$expected_compose" "$expected_image" "$expected_source" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, compose_sha, image_ref, source_revision = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    receipt = json.load(handle)
if receipt.get("compose_sha256") != compose_sha:
    raise SystemExit("backup receipt Compose identity mismatch")
if receipt.get("image_ref") != image_ref:
    raise SystemExit("backup receipt image identity mismatch")
if receipt.get("source_revision") != source_revision:
    raise SystemExit("backup receipt source revision mismatch")
if receipt.get("inner_manifest_decrypt_verified") is not False or receipt.get("plaintext_egress") is not False:
    raise SystemExit("backup receipt plaintext/decrypt policy mismatch")
if receipt.get("egress") != "local-outbox" or receipt.get("retention") != "keep-all":
    raise SystemExit("backup receipt egress/retention policy mismatch")
created_at = receipt.get("created_at")
try:
    created = datetime.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
except (TypeError, ValueError):
    raise SystemExit("backup receipt timestamp invalid")
age_seconds = (datetime.now(timezone.utc) - created).total_seconds()
if age_seconds > 30 * 24 * 3600 or age_seconds < -300:
    raise SystemExit("backup receipt outside the reviewed 30-day freshness window")
print("Kaneo backup receipt identity/freshness PASS:", receipt["backup_id"])
PY
    rm -rf "$VERIFY_DIR"
    VERIFY_DIR=''
}

[ "$(id -u)" -eq 0 ] || fail 'run as root via visible sudo ceremony'
[ -d "$BUNDLE_DIR" ] && [ ! -L "$BUNDLE_DIR" ] || fail 'staging bundle missing or symlinked'
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail 'production Compose missing or symlinked'
[ -f "$BUNDLE_DIR/source.tar" ] && [ "$(sha "$BUNDLE_DIR/source.tar")" = "$SOURCE_ARCHIVE_SHA256" ] || fail 'committed source archive hash mismatch'
[ -f "$BUNDLE_DIR/compose.subtask-order-r1.yml" ] && [ "$(sha "$BUNDLE_DIR/compose.subtask-order-r1.yml")" = "$NEW_COMPOSE_SHA256" ] || fail 'candidate Compose hash mismatch'
[ -f "$BUNDLE_DIR/backup-kaneo.next" ] && [ "$(sha "$BUNDLE_DIR/backup-kaneo.next")" = "$NEW_WRAPPER_SHA256" ] || fail 'candidate backup wrapper hash mismatch'
[ -f "$BUNDLE_DIR/kaneo-sync-recovery-metadata.next" ] && [ "$(sha "$BUNDLE_DIR/kaneo-sync-recovery-metadata.next")" = "$NEW_SYNC_SHA256" ] || fail 'candidate recovery metadata adapter hash mismatch'
[ -f "$BUNDLE_DIR/kaneo-migration-verify.next" ] && [ "$(sha "$BUNDLE_DIR/kaneo-migration-verify.next")" = "$NEW_MIGRATION_SHA256" ] || fail 'candidate migration verifier hash mismatch'
[ "$(sha "$COMPOSE_FILE")" = "$CURRENT_COMPOSE_SHA256" ] || fail 'production Compose changed since survey'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo)" = "$CURRENT_IMAGE" ] || fail 'running Kaneo image changed since survey'
[ "$(docker inspect --format '{{.State.Health.Status}}' kaneo)" = healthy ] || fail 'current Kaneo is not healthy'
[ "$(sha "$WRAPPER")" = "$CURRENT_WRAPPER_SHA256" ] || fail 'current backup wrapper changed since survey'
[ -f "$BACKUP_VERIFIER" ] && [ "$(sha "$BACKUP_VERIFIER")" = "$EXPECTED_BACKUP_VERIFIER_SHA256" ] || fail 'strict backup verifier hash mismatch'
[ -d "$OUTBOX_ROOT" ] && [ ! -L "$OUTBOX_ROOT" ] || fail 'encrypted backup outbox missing or symlinked'
[ "$(stat -c '%U:%G %a' "$OUTBOX_ROOT")" = 'root:root 700' ] || fail 'encrypted backup outbox ownership/mode mismatch'
source_now=$(sed -n 's/^source_revision=//p' "$RECOVERY/kaneo-install-metadata" | tr -d '[:space:]')
[ "$source_now" = '7a8dc20ed9e558bc23d0d9f4d02bbc868c4793c9' ] || fail 'current install metadata changed since survey'
[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$NEW_IMAGE")" = "$SOURCE_REVISION" ] || fail 'candidate image source-revision label mismatch'
grep -Fqx "    image: $NEW_IMAGE" "$BUNDLE_DIR/compose.subtask-order-r1.yml" || fail 'candidate Compose image pin mismatch'

if [ "$MODE" = apply ]; then
    [ ! -e "$BUNDLE_DIR/deploy-run.log" ] || fail 'deployment log already exists; refusing to overwrite a prior attempt'
    exec > "$BUNDLE_DIR/deploy-run.log" 2>&1
fi

printf '%s\n' '== 1/8 read-only baseline and candidate config checks'
(cd "$COMPOSE_DIR" && docker compose config --quiet) || fail 'current Compose invalid'
docker compose --project-directory "$COMPOSE_DIR" --file "$BUNDLE_DIR/compose.subtask-order-r1.yml" config --quiet || fail 'candidate Compose invalid'
"$RECOVERY/kaneo-migration-verify"
"$WRAPPER" --plan
latest_receipt=$(find "$OUTBOX_ROOT" -maxdepth 1 -type f -name 'kaneo-*.receipt.json' -printf '%f\n' | sort | tail -n 1)
[ -n "$latest_receipt" ] || fail 'no existing encrypted backup receipt is available'
latest_backup_id=${latest_receipt%.receipt.json}
verify_snapshot "$latest_backup_id" "$CURRENT_COMPOSE_SHA256" "$CURRENT_IMAGE" "$CURRENT_SOURCE_REVISION"
if [ "$MODE" = plan ]; then
    printf '%s\n' "KANEO R10 PLAN PASS: current=$CURRENT_IMAGE candidate=$NEW_IMAGE candidate_compose=$NEW_COMPOSE_SHA256 source=$SOURCE_REVISION; no production mutation."
    exit 0
fi

printf '%s\n' '== 2/8 install reviewed backup wrapper and verify both current and candidate pins'
install -o root -g root -m 0555 "$BUNDLE_DIR/backup-kaneo.next" "$WRAPPER"
[ "$(sha "$WRAPPER")" = "$NEW_WRAPPER_SHA256" ] || fail 'installed backup wrapper hash mismatch'
"$WRAPPER" --plan || fail 'backup wrapper does not accept current production Compose'

printf '%s\n' '== 3/8 atomically flip Compose to the digest-pinned candidate'
install -o root -g root -m 0444 "$BUNDLE_DIR/compose.subtask-order-r1.yml" "$COMPOSE_FILE.next-wave"
[ "$(sha "$COMPOSE_FILE.next-wave")" = "$NEW_COMPOSE_SHA256" ] || fail 'staged Compose hash mismatch'
mv -f "$COMPOSE_FILE.next-wave" "$COMPOSE_FILE"
[ "$(sha "$COMPOSE_FILE")" = "$NEW_COMPOSE_SHA256" ] || fail 'production Compose flip did not persist'

printf '%s\n' '== 4/8 sync candidate recovery metadata before the pre-apply snapshot'
install -o root -g root -m 0555 "$BUNDLE_DIR/kaneo-sync-recovery-metadata.next" "$RECOVERY/kaneo-sync-recovery-metadata"
"$RECOVERY/kaneo-sync-recovery-metadata"

printf '%s\n' '== 5/8 create the pre-apply encrypted snapshot (R2 mirror remains a separate gate)'
pre_output=$("$WRAPPER" --snapshot --yes)
printf '%s\n' "$pre_output"
pre_id=$(printf '%s\n' "$pre_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$pre_id" ] || fail 'pre-apply snapshot produced no backup ID'
verify_snapshot "$pre_id" "$NEW_COMPOSE_SHA256" "$NEW_IMAGE" "$SOURCE_REVISION"

printf '%s\n' '== 6/8 pull exact candidate, restart Kaneo, and verify image health/digest'
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
[ "$status" = healthy ] || fail "candidate container health is $status after timeout"
expected_image_id=$(docker image inspect --format '{{.Id}}' "$NEW_IMAGE")
[ "$(docker inspect --format '{{.Image}}' kaneo)" = "$expected_image_id" ] || fail 'running image ID does not match digest pin'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo)" = "$NEW_IMAGE" ] || fail 'running container config does not match candidate pin'

printf '%s\n' '== 7/8 verify unchanged migration/schema state and candidate recovery pair'
install -o root -g root -m 0555 "$BUNDLE_DIR/kaneo-migration-verify.next" "$RECOVERY/kaneo-migration-verify"
"$RECOVERY/kaneo-migration-verify"
"$WRAPPER" --plan || fail 'candidate backup plan failed after activation'

printf '%s\n' '== 8/8 create post-apply encrypted snapshot and report receipt IDs'
post_output=$("$WRAPPER" --snapshot --yes)
printf '%s\n' "$post_output"
post_id=$(printf '%s\n' "$post_output" | grep -oE 'kaneo-[0-9]{8}T[0-9]{6}Z' | tail -n 1)
[ -n "$post_id" ] || fail 'post-apply snapshot produced no backup ID'
verify_snapshot "$post_id" "$NEW_COMPOSE_SHA256" "$NEW_IMAGE" "$SOURCE_REVISION"
"$WRAPPER" --plan
curl --fail --silent --show-error --max-time 15 https://kaneo.quoc.app/api/health
printf '%s\n' "KANEO R10 SUBTASK-ORDER PASS: image=$NEW_IMAGE rollback=$CURRENT_IMAGE pre_backup=$pre_id post_backup=$post_id compose_sha256=$NEW_COMPOSE_SHA256"
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep '^kaneo|'
