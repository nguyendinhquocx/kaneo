#!/bin/sh
# Kaneo wave uat-r4fix2 continuation 3: stage the repinned read-only
# backup-verify (adds the wave identity to its reviewed-identity allowlist),
# then run the final verification + wave receipt.
# Run as root on ProDesk: sudo sh /home/quoc/kaneo-wave-uat-r4fix2/kaneo-wave-continue3.sh
set -eu

BUNDLE=/home/quoc/kaneo-wave-uat-r4fix2
COMPOSE_FILE=/srv/kaneo/compose.yml
WRAPPER_TARGET=/srv/kaneo/recovery/backup-kaneo.sh
BACKUP_VERIFY_TARGET=/usr/local/lib/home-server-recovery/kaneo-backup-verify

NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a5125cf5-uat-r4fix2@sha256:a68eb69371ff86be177bb6c08b6400df85fc7e05b0ecfa1134d5c9862cc719a7'
ROLLBACK_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d1884ca4-uat-r4fix@sha256:883db42fec1116361d8e4caad927cba4351e81f72dbb749664d40f7d8325484e'
NEW_COMPOSE_SHA256=1043f99eb01a890f433ad955437da8bb5092c5863a0e942eb1a89320ff5b5fe4
NEW_WRAPPER_SHA256=e0077a54d0faa49caa1ae024e60f846be07035d6285af3305e093e16cad9b0bb
NEW_BACKUP_VERIFY_SHA256=7d91ccd9188cd1efe4672647934334b7e73275f78cf0a5fd3310111d8004748b
NEW_BACKUP_ID=kaneo-20261021T104411Z
NEW_CIPHER_SHA256=664357baf1e37a89bde7393918b4307a2a8984abac04ddb7f811067d5c030d33
NEW_RECEIPT_SHA256=2d4496504b58a908e2a3be15e15317a1125c4080d2ce6d922bddf4f6cd9b1021

fail() { printf '%s\n' "KANEO WAVE CONTINUE3 BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo)'

printf '%s\n' '== 1/3 re-verify deployed state (no mutation yet)'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$NEW_COMPOSE_SHA256" ] || fail 'compose is not the staged candidate'
[ "$(sha256sum "$WRAPPER_TARGET" | awk '{print $1}')" = "$NEW_WRAPPER_SHA256" ] || fail 'backup wrapper is not the repinned wave wrapper'
[ "$(sha256sum "$BUNDLE/kaneo-backup-verify.next" | awk '{print $1}')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail 'bundle backup-verify hash mismatch'
running_image=$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)
[ "$running_image" = "$NEW_IMAGE" ] || fail 'running kaneo image is not the wave candidate'

printf '%s\n' '== 2/3 stage repinned read-only backup-verify (atomic)'
install -o root -g root -m 0555 "$BUNDLE/kaneo-backup-verify.next" "$BACKUP_VERIFY_TARGET"

printf '%s\n' '== 3/3 final read-only verification + wave receipt'
sh "$BACKUP_VERIFY_TARGET"
printf '%s\n' "KANEO WAVE CONTINUE3 PASS: uat-r4fix2 fully applied"
printf '%s\n' "deployed=$NEW_IMAGE"
printf '%s\n' "rollback_pin=$ROLLBACK_IMAGE"
printf '%s\n' "new_compose_sha256=$NEW_COMPOSE_SHA256"
printf '%s\n' "backup_id=$NEW_BACKUP_ID"
printf '%s\n' "backup_ciphertext_sha256=$NEW_CIPHER_SHA256"
printf '%s\n' "backup_receipt_sha256=$NEW_RECEIPT_SHA256"
