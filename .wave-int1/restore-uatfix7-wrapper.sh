#!/bin/sh
# Restore the reviewed uatfix7 backup wrapper that was overwritten on
# 2026-11-04 15:41 UTC by an unknown old-generation copy (0453a148...).
# Fail-closed: the current file must still be the drifted 0453a148 copy,
# the source must hash ea1640d6..., and the installed file is re-verified.
# Then --plan proves the restored pair resolves against the live compose.
set -eu

SRC=/home/quoc/kaneo-wave-uatfix7/backup-kaneo.uatfix7.sh
DST=/srv/kaneo/recovery/backup-kaneo.sh
EXPECTED_SRC_SHA256=ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820
DRIFTED_SHA256=0453a148e45e3e86994a872dc3cb616a6213d9bb1d8503f4ad6b436f7de6cea6

fail() { printf '%s\n' "WRAPPER RESTORE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run via sudo'
[ -f "$SRC" ] && [ ! -L "$SRC" ] || fail 'source wrapper missing or symlinked'
[ "$(sha256sum "$SRC" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'source hash mismatch'
current=$(sha256sum "$DST" | awk '{print $1}')
[ "$current" = "$DRIFTED_SHA256" ] || fail "current wrapper is not the drifted 0453a148 copy (got $current); re-survey before restoring"
install -o root -g root -m 0555 "$SRC" "$DST"
[ "$(sha256sum "$DST" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'installed hash mismatch'
printf '%s\n' 'WRAPPER RESTORE PASS: ea1640d6 installed over the 0453a148 drifted copy'
sh "$DST" --plan
