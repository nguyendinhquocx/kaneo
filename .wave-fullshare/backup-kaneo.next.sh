#!/bin/sh
# Fixed-path Kaneo PostgreSQL snapshot. R2 mirroring is a separate reviewed gate.
set -eu

PROJECT_DIR=/srv/kaneo
COMPOSE_FILE=$PROJECT_DIR/compose.yml
RECOVERY_ROOT=/usr/local/lib/home-server-recovery
RECIPIENTS_FILE=$RECOVERY_ROOT/recipients.txt
AGE_BIN=$RECOVERY_ROOT/bin/age
AGE_SHA256=2e305637f2a0555305e21c17fb74446acbb39b53135d43d4b744e50c287133a5
INSTALL_METADATA=$RECOVERY_ROOT/kaneo-install-metadata
OUTBOX_ROOT=/var/lib/home-server-recovery/kaneo-outbox
STAGING_ROOT=/srv/.home-server-recovery-kaneo-staging
LOCK_FILE=/var/lock/home-server-recovery-kaneo.lock
# Accepted release pairs: the wrapper must stay valid across a deploy wave
# (pre-flip sees the previous compose, post-flip sees the candidate).
PREVIOUS_COMPOSE_SHA256=79cd209d157af98f86f89515eb30788f9844859e2e21063ab67cafd28d8425d4
PREVIOUS_IMAGE_REF='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a'
CANDIDATE_COMPOSE_SHA256=12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195
CANDIDATE_IMAGE_REF='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e'
RECIPIENT_FINGERPRINT='age1vy947l9h8w8t8rykv67a8d030cm0m9h05j8d6pgvj3n67j03q4nqu8t8js'
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail() { printf '%s\n' "$*" >&2; exit 2; }

usage() {
    printf '%s\n' "Usage: $0 --plan | --snapshot --yes" >&2
    exit 2
}

# Resolve which reviewed release the live compose actually is, and pin
# EXPECTED_COMPOSE_SHA256 / EXPECTED_IMAGE_REF to that pair.
resolve_release_pair() {
    compose_sha256=$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')
    case "$compose_sha256" in
        "$PREVIOUS_COMPOSE_SHA256")
            EXPECTED_COMPOSE_SHA256=$PREVIOUS_COMPOSE_SHA256
            EXPECTED_IMAGE_REF=$PREVIOUS_IMAGE_REF
            ;;
        "$CANDIDATE_COMPOSE_SHA256")
            EXPECTED_COMPOSE_SHA256=$CANDIDATE_COMPOSE_SHA256
            EXPECTED_IMAGE_REF=$CANDIDATE_IMAGE_REF
            ;;
        *)
            fail 'Source compose hash is not the reviewed Kaneo release'
            ;;
    esac
}

[ "$#" -eq 1 ] && [ "$1" = --plan ] && {
    source_compose="$SOURCE_DIR/../compose.yml"
    [ -r "$source_compose" ] || fail "Missing source compose.yml"
    COMPOSE_FILE="$source_compose"
    resolve_release_pair
    printf '%s\n' "Kaneo backup plan PASS: compose=$EXPECTED_COMPOSE_SHA256 image=$EXPECTED_IMAGE_REF (no mutation; R2 mirror and restore remain gated)."
    exit 0
}
[ "$#" -eq 2 ] && [ "$1" = --snapshot ] && [ "$2" = --yes ] || usage
[ "$(id -u)" -eq 0 ] || fail 'Run the Kaneo snapshot locally as root.'

[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail 'Compose file missing or symlinked.'
resolve_release_pair
[ -x "$AGE_BIN" ] && [ ! -L "$AGE_BIN" ] || fail 'Pinned recovery age binary missing.'
[ "$(stat -c '%U:%G %a' "$AGE_BIN")" = 'root:root 755' ] || fail 'Recovery age binary ownership/mode mismatch.'
[ "$(sha256sum "$AGE_BIN" | awk '{print $1}')" = "$AGE_SHA256" ] || fail 'Recovery age binary hash mismatch.'
[ -f "$RECIPIENTS_FILE" ] && [ ! -L "$RECIPIENTS_FILE" ] || fail 'Recovery recipients file missing or symlinked.'
[ "$(stat -c '%U:%G %a' "$RECIPIENTS_FILE")" = 'root:root 644' ] || fail 'Recovery recipients ownership/mode mismatch.'
recipient=$(grep -vE '^[[:space:]]*(#|$)' "$RECIPIENTS_FILE" | sed -n '1p' | tr -d '[:space:]')
[ "$(grep -cvE '^[[:space:]]*(#|$)' "$RECIPIENTS_FILE")" -eq 1 ] || fail 'Recovery recipients must contain exactly one active recipient.'
[ "$recipient" = "$RECIPIENT_FINGERPRINT" ] || fail 'Recovery recipient is not the reviewed Kaneo recipient.'
[ -f "$INSTALL_METADATA" ] && [ ! -L "$INSTALL_METADATA" ] || fail 'Kaneo recovery metadata missing.'
[ "$(stat -c '%U:%G %a' "$INSTALL_METADATA")" = 'root:root 644' ] || fail 'Kaneo recovery metadata ownership/mode mismatch.'
source_revision=$(sed -n 's/^source_revision=//p' "$INSTALL_METADATA" | tr -d '[:space:]')
snapshot_hash=$(sed -n 's/^snapshot_sha256=//p' "$INSTALL_METADATA" | tr -d '[:space:]')
printf '%s' "$source_revision" | grep -Eq '^[0-9a-f]{7,64}$' || fail 'Kaneo source revision metadata is invalid.'
printf '%s' "$snapshot_hash" | grep -Eq '^[0-9a-f]{64}$' || fail 'Kaneo snapshot hash metadata is invalid.'
[ "$(sha256sum "$0" | awk '{print $1}')" = "$snapshot_hash" ] || fail 'Kaneo snapshot script hash does not match install metadata.'
[ -d "$OUTBOX_ROOT" ] && [ ! -L "$OUTBOX_ROOT" ] || fail 'Kaneo backup outbox missing or symlinked.'
[ "$(stat -c '%U:%G %a' "$OUTBOX_ROOT")" = 'root:root 700' ] || fail 'Kaneo backup outbox ownership/mode mismatch.'
if [ -e "$STAGING_ROOT" ]; then
    [ ! -L "$STAGING_ROOT" ] || fail 'Kaneo staging is symlinked.'
    [ -d "$STAGING_ROOT" ] || fail 'Kaneo staging is not a directory.'
    [ "$(stat -c '%U:%G %a' "$STAGING_ROOT")" = 'root:root 700' ] || fail 'Kaneo staging ownership/mode mismatch.'
else
    install -d -o root -g root -m 700 "$STAGING_ROOT"
fi

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'Another Kaneo backup is already running.'

backup_id="kaneo-$(date -u +%Y%m%dT%H%M%SZ)"
staging="$STAGING_ROOT/$backup_id"
mkdir "$staging"
chmod 700 "$staging"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT HUP INT TERM
[ ! -e "$OUTBOX_ROOT/$backup_id.age" ] && [ ! -e "$OUTBOX_ROOT/$backup_id.receipt.json" ] || fail 'Backup id already exists.'

created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose -f "$COMPOSE_FILE" ps --status running --services | grep -Fxq postgres || fail 'kaneo-postgres is not running.'
docker compose -f "$COMPOSE_FILE" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$staging/postgres.sql" || fail 'pg_dump failed.'
[ -s "$staging/postgres.sql" ] || fail 'pg_dump produced an empty archive.'
db_sha256=$(sha256sum "$staging/postgres.sql" | awk '{print $1}')
previous_receipt_sha256=null
latest_receipt=$(find "$OUTBOX_ROOT" -maxdepth 1 -type f -name 'kaneo-*.receipt.json' -print | sort | tail -n 1 || true)
if [ -n "$latest_receipt" ]; then
    previous_receipt_sha256=$(sha256sum "$latest_receipt" | awk '{print "\"" $1 "\""}')
fi
cat > "$staging/inner-manifest.json" <<EOF
{"schema_version":1,"project":"kaneo","backup_id":"$backup_id","source_revision":"$source_revision","compose_sha256":"$EXPECTED_COMPOSE_SHA256","image_ref":"$EXPECTED_IMAGE_REF","postgres_dump_sha256":"$db_sha256","asset_storage":"r2-versioned-separate-data-class","created_at":"$created_at","previous_receipt_sha256":$previous_receipt_sha256}
EOF
inner_sha256=$(sha256sum "$staging/inner-manifest.json" | awk '{print $1}')
tar -C "$staging" -cf "$staging/payload.tar" inner-manifest.json postgres.sql
"$AGE_BIN" -e -R "$RECIPIENTS_FILE" -o "$staging/$backup_id.age" "$staging/payload.tar" || fail 'age encryption failed.'
[ -s "$staging/$backup_id.age" ] || fail 'Ciphertext is empty.'
cipher_sha256=$(sha256sum "$staging/$backup_id.age" | awk '{print $1}')
cipher_size=$(wc -c < "$staging/$backup_id.age" | tr -d '[:space:]')
cat > "$staging/$backup_id.receipt.json" <<EOF
{"schema_version":1,"project":"kaneo","backup_id":"$backup_id","ciphertext_filename":"$backup_id.age","ciphertext_sha256":"$cipher_sha256","ciphertext_size":$cipher_size,"source_revision":"$source_revision","compose_sha256":"$EXPECTED_COMPOSE_SHA256","image_ref":"$EXPECTED_IMAGE_REF","recipient_fingerprint":"$RECIPIENT_FINGERPRINT","created_at":"$created_at","previous_receipt_sha256":$previous_receipt_sha256,"inner_manifest_sha256":"$inner_sha256","inner_manifest_decrypt_verified":false,"egress":"local-outbox","retention":"keep-all","plaintext_egress":false}
EOF
sha256sum "$staging/$backup_id.age" "$staging/$backup_id.receipt.json" >&2
install -o root -g root -m 0600 "$staging/$backup_id.age" "$OUTBOX_ROOT/$backup_id.age"
install -o root -g root -m 0644 "$staging/$backup_id.receipt.json" "$OUTBOX_ROOT/$backup_id.receipt.json"
printf '%s\n' "Kaneo encrypted backup created: $backup_id (local outbox only; R2 mirror still requires separate gate)."
