#!/bin/sh
# Resume of the interrupted child-activity-context-r1 apply: container already
# recreated from the digest-pinned candidate and healthy; this finishes the
# remaining pin checks, migration verifier install, and post-apply snapshot.
set -eu

BUNDLE_DIR=/home/quoc/kaneo/staging/kaneo-child-activity-context-r1
COMPOSE_DIR=/srv/kaneo
COMPOSE_FILE=$COMPOSE_DIR/compose.yml
WRAPPER=$COMPOSE_DIR/recovery/backup-kaneo.sh
RECOVERY=/usr/local/lib/home-server-recovery
OUTBOX_ROOT=/var/lib/home-server-recovery/kaneo-outbox
BACKUP_VERIFIER=$RECOVERY/kaneo-verify-backup.py
EXPECTED_BACKUP_VERIFIER_SHA256=d6c27751cc7964317bbbe7e81ce5a81625e616ac3e638dcdf0566083aad6beaf
CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-4a4996a3-subtask-order-r1@sha256:fd6569575a92f76101c5838034a90ad0f9d70d5240575733501c7729837bc282'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-59d0905b-child-activity-context-r1@sha256:089e604ea365212a6525043ea3e59c5284a2c94698110bf3a7a404e74eca3258'
SOURCE_REVISION='59d0905b14a50f98aaa7558875f8d43003719a00'
NEW_COMPOSE_SHA256='d06808c581ffbe7904873a24325eac7239369a4069ec9dd002201b5c02c8fd58'
NEW_WRAPPER_SHA256='3d06edf6294376e2d5b51e76743805819fade8f814f635e26aec9baaed1f57a6'
NEW_MIGRATION_SHA256='d169659b5251b1c5c0729af00608c98714eabca0e9a0b26d1eeb26916789d2b8'

fail() { printf '%s\n' "KANEO R10 CHILD-ACTIVITY-CONTEXT RESUME BLOCKED: $*" >&2; exit 2; }
sha() { sha256sum "$1" | awk '{print $1}'; }
VERIFY_DIR=''
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
[ "$(sha "$COMPOSE_FILE")" = "$NEW_COMPOSE_SHA256" ] || fail 'production Compose is not the reviewed candidate'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo)" = "$NEW_IMAGE" ] || fail 'running Kaneo is not the candidate'
[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' kaneo)" = healthy ] || fail 'candidate container is not healthy'
[ "$(sha "$WRAPPER")" = "$NEW_WRAPPER_SHA256" ] || fail 'installed backup wrapper hash mismatch'

printf '%s\n' '== 6/8 resume: verify image ID matches the digest pin'
expected_image_id=$(docker image inspect --format '{{.Id}}' "$NEW_IMAGE")
[ "$(docker inspect --format '{{.Image}}' kaneo)" = "$expected_image_id" ] || fail 'running image ID does not match digest pin'

printf '%s\n' '== 7/8 verify unchanged migration/schema state and candidate recovery pair'
[ -f "$BUNDLE_DIR/kaneo-migration-verify.next" ] && [ "$(sha "$BUNDLE_DIR/kaneo-migration-verify.next")" = "$NEW_MIGRATION_SHA256" ] || fail 'candidate migration verifier hash mismatch'
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
printf '%s\n' "KANEO R10 CHILD-ACTIVITY-CONTEXT RESUME PASS: image=$NEW_IMAGE rollback=$CURRENT_IMAGE post_backup=$post_id compose_sha256=$NEW_COMPOSE_SHA256"
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep '^kaneo|'
