#!/bin/sh
# Stage the repinned uatfix5 backup-verify adapter, then verify immediately.
# Usage: ssh -t prodesk-home sudo sh /home/quoc/kaneo-wave-uatfix5/stage-verify.sh
set -eu

SRC=/home/quoc/kaneo-wave-uatfix5/backup-verify.uatfix5.sh
DST=/usr/local/lib/home-server-recovery/kaneo-backup-verify
EXPECTED_SRC_SHA256=7c4e6e59265e99143b93a76b9fd8cc0503b75d971d5ae479d610d27f8598ed50

fail() { printf '%s\n' "STAGE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run via sudo'
[ "$(sha256sum "$SRC" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'bundle hash mismatch'
install -o root -g root -m 0555 "$SRC" "$DST"
printf '%s\n' "staged $(sha256sum "$DST" | awk '{print $1}')"
sh "$DST"
