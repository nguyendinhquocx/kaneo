#!/bin/sh
# Stage the repinned uatfix7 backup-verify adapter, then verify immediately.
# Usage: ssh -t prodesk-home sudo sh /home/quoc/kaneo-wave-uatfix7/stage-verify.sh
set -eu

SRC=/home/quoc/kaneo-wave-uatfix7/backup-verify.uatfix7.sh
DST=/usr/local/lib/home-server-recovery/kaneo-backup-verify
EXPECTED_SRC_SHA256=eea07a72b35202a61ddcf0eb2aee09facdc4c88a663d727bfd9645e11664c678

fail() { printf '%s\n' "STAGE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run via sudo'
[ "$(sha256sum "$SRC" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'bundle hash mismatch'
install -o root -g root -m 0555 "$SRC" "$DST"
printf '%s\n' "staged $(sha256sum "$DST" | awk '{print $1}')"
sh "$DST"
