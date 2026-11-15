#!/bin/sh
# One-extension, fixed-path ProDesk parity release for the approved Kaneo Pi MCP.
# This is intentionally narrower than a whole curated 82-skill artifact refresh:
# the current manifest inventory fails closed on unrelated stale/unlisted sources.
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

BUNDLE=/home/quoc/kaneo/release/.staging/card-agent-collaboration/pi-extension
ARTIFACT_ID=kaneo-mcp-linux-d81cd37-18aa5f8a
ARCHIVE=$BUNDLE/$ARTIFACT_ID.tar.gz
RELEASE_MANIFEST=$BUNDLE/$ARTIFACT_ID.release.json
EXPECTED_ARCHIVE_SHA=6db3b953ff173c7c087abbbe92ef6e153c329221f49ff5b80675abc2de8d3d6c
EXPECTED_RELEASE_MANIFEST_SHA=bd2cdebdcb440ffd348bc4dece82f6fe0532de22e732628baa4848589e32b32c
EXPECTED_SOURCE_COMMIT=d81cd37cd18d2ff771bf39db6fc5b4f2a0895392
EXPECTED_PARITY_MANIFEST_SHA=fe3a3670d8094708e55db48b47ab04905222df20db78ffc837d033a4643c6175
RUNTIME=/home/quoc/.pi/agent/extensions/kaneo-mcp
BACKUP_BASE=/home/quoc/pi-agent-work/extensions/kaneo-mcp-runtime-backups
PI_AGENT=/home/quoc/.pi/agent

fail() { printf '%s\n' "Kaneo MCP runtime deploy BLOCKED: $*" >&2; exit 2; }
sha() { sha256sum "$1" | awk '{print $1}'; }

[ -d "$BUNDLE" ] && [ ! -L "$BUNDLE" ] || fail 'fixed extension artifact staging path missing or symlinked'
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || fail 'candidate archive missing or symlinked'
[ -f "$RELEASE_MANIFEST" ] && [ ! -L "$RELEASE_MANIFEST" ] || fail 'release manifest missing or symlinked'
[ "$(sha "$ARCHIVE")" = "$EXPECTED_ARCHIVE_SHA" ] || fail 'candidate archive sha256 mismatch'
[ "$(sha "$RELEASE_MANIFEST")" = "$EXPECTED_RELEASE_MANIFEST_SHA" ] || fail 'release manifest sha256 mismatch'
[ -d "$RUNTIME" ] && [ ! -L "$RUNTIME" ] || fail 'runtime extension is missing or not a real directory'
[ "$(systemctl --user is-active telepi.service 2>/dev/null || true)" = active ] || fail 'TelePi must be active before activation so we can preserve/restart its prior state'

# Hash/entry-set verification is performed before extracting any source file.
verify_archive() {
  python3 - "$ARCHIVE" "$RELEASE_MANIFEST" "$EXPECTED_SOURCE_COMMIT" "$EXPECTED_PARITY_MANIFEST_SHA" <<'PY'
import hashlib, json, pathlib, sys, tarfile
archive_path, manifest_path, expected_commit, expected_manifest_sha = sys.argv[1:]
raw = pathlib.Path(manifest_path).read_bytes()
manifest = json.loads(raw)
if hashlib.sha256(raw).hexdigest() != "bd2cdebdcb440ffd348bc4dece82f6fe0532de22e732628baa4848589e32b32c":
    raise SystemExit("release manifest digest mismatch")
if manifest.get("artifact_id") != "kaneo-mcp-linux-d81cd37-18aa5f8a":
    raise SystemExit("artifact id mismatch")
if manifest.get("source_commit") != expected_commit:
    raise SystemExit("source commit mismatch")
if manifest.get("manifest_sha256") != expected_manifest_sha:
    raise SystemExit("parity manifest digest mismatch")
if manifest.get("target") != "linux-headless" or manifest.get("source_path") != "app_presets/pi/extensions/kaneo-mcp":
    raise SystemExit("artifact target/source path mismatch")
entry = manifest.get("manifest_entry", {})
if entry.get("status") != "approved" or entry.get("target_status", {}).get("linux-headless") != "approved":
    raise SystemExit("extension is not approved for linux-headless")
if manifest.get("file_count") != 17 or manifest.get("file_count") != len(manifest.get("files", [])):
    raise SystemExit("target/file count mismatch")
expected = {"kaneo-mcp/" + item["path"]: item for item in manifest["files"]}
if len(expected) != manifest["file_count"]:
    raise SystemExit("duplicate source paths")
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    actual = {}
    for member in members:
        name = member.name
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or not name.startswith("kaneo-mcp/"):
            raise SystemExit("archive path is outside the extension root")
        if not member.isfile() or member.issym() or member.islnk():
            raise SystemExit("archive contains a non-regular file")
        if name in actual:
            raise SystemExit("duplicate archive member")
        actual[name] = member
    if set(actual) != set(expected):
        raise SystemExit("archive file set differs from release manifest")
    for name, item in expected.items():
        member = actual[name]
        stream = archive.extractfile(member)
        if stream is None:
            raise SystemExit("archive member is unreadable")
        data = stream.read()
        if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise SystemExit("file content hash mismatch: " + name)
print("Kaneo MCP artifact verified: files=%d source=%s payload=%s" % (
    manifest["file_count"], manifest["source_commit"], manifest["payload_manifest_sha256"]
))
PY
}
verify_archive

protected_snapshot() {
  python3 - <<'PY'
import hashlib, pathlib, stat
root = pathlib.Path('/home/quoc/.pi/agent')
rows=[]
for name in ('auth.json','models.json','settings.json'):
    p=root/name
    if p.exists():
        st=p.stat()
        rows.append((name,st.st_uid,st.st_gid,oct(stat.S_IMODE(st.st_mode)),hashlib.sha256(p.read_bytes()).hexdigest()))
    else:
        rows.append((name,'missing','missing'))
print(hashlib.sha256(repr(rows).encode()).hexdigest())
PY
}

if [ "$MODE" = plan ]; then
  printf '%s\n' "Kaneo MCP deploy plan PASS: artifact=$ARTIFACT_ID files=$(find "$RUNTIME" -maxdepth 1 -type f | wc -l) TelePi=active; no mutation."
  exit 0
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=$BACKUP_BASE/$ARTIFACT_ID-$STAMP
STAGE=$BUNDLE/.unpack-$STAMP
PREPARED=$RUNTIME.next-$STAMP
BEFORE_PROTECTED=$(protected_snapshot)
WAS_ACTIVE=1
MOVED_OLD=0
MOVED_NEW=0
cleanup_on_failure() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    systemctl --user stop telepi.service >/dev/null 2>&1 || true
    if [ "$MOVED_NEW" -eq 1 ] && [ -d "$RUNTIME" ] && [ ! -L "$RUNTIME" ]; then
      mv "$RUNTIME" "$BACKUP_BASE/$ARTIFACT_ID-failed-$STAMP" 2>/dev/null || true
    fi
    if [ "$MOVED_OLD" -eq 1 ] && [ -d "$BACKUP/live-runtime" ] && [ ! -e "$RUNTIME" ]; then
      mv "$BACKUP/live-runtime" "$RUNTIME" 2>/dev/null || true
    fi
    rm -rf "$STAGE" "$PREPARED"
    if [ "$WAS_ACTIVE" -eq 1 ]; then systemctl --user start telepi.service >/dev/null 2>&1 || true; fi
  fi
  exit "$rc"
}
trap cleanup_on_failure EXIT HUP INT TERM

mkdir -p "$BACKUP_BASE"
chmod 0700 "$BACKUP_BASE"
mkdir -m 0700 "$BACKUP"
mkdir -m 0700 "$STAGE"
python3 - "$ARCHIVE" "$RELEASE_MANIFEST" "$STAGE" <<'PY'
import hashlib, json, pathlib, sys, tarfile
archive_path, manifest_path, stage_path = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
expected={"kaneo-mcp/"+item["path"]:item for item in manifest["files"]}
with tarfile.open(archive_path,"r:gz") as archive:
    members={m.name:m for m in archive.getmembers()}
    for name,item in expected.items():
        data=archive.extractfile(members[name]).read()
        target=stage_path/item["path"]
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o644)
        if hashlib.sha256(target.read_bytes()).hexdigest()!=item["sha256"]:
            raise SystemExit("staged file checksum mismatch: "+name)
print("candidate extension staged and checksummed")
PY
[ "$(find "$STAGE" -type f | wc -l)" -eq 17 ] || fail 'staged file count differs from signed manifest'
# Smoke tests must resolve the sibling import exactly like the live runtime does;
# the runtime sibling is read-only for tests and never copied into the artifact.
TEST_SIBLING="$BUNDLE/kaneo-agent-control"
ln -sfn /home/quoc/.pi/agent/extensions/kaneo-agent-control "$TEST_SIBLING"
node --experimental-strip-types --experimental-transform-types --test "$STAGE"/*.test.ts; test_rc=$?
rm -f "$TEST_SIBLING"
[ "$test_rc" -eq 0 ] || fail "candidate extension node smoke tests failed (rc=$test_rc)"
systemctl --user stop telepi.service
mkdir -m 0700 "$PREPARED"
cp -a "$STAGE/." "$PREPARED/"
python3 - "$PREPARED" "$RELEASE_MANIFEST" <<'PYVERIFY'
import hashlib, json, pathlib, sys
root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))
expected={item['path']:item for item in manifest['files']}
actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
if actual != set(expected): raise SystemExit('prepared runtime file set differs from release manifest')
for rel,item in expected.items():
    data=(root/rel).read_bytes()
    if len(data)!=item['size'] or hashlib.sha256(data).hexdigest()!=item['sha256']:
        raise SystemExit('prepared runtime content hash mismatch: '+rel)
print('prepared runtime file set and hashes verified')
PYVERIFY
mv "$RUNTIME" "$BACKUP/live-runtime"
MOVED_OLD=1
python3 - "$BACKUP/live-runtime" "$BACKUP/runtime-backup-manifest.json" <<'PYBACKUP'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); rows=[]
for p in sorted(x for x in root.rglob('*') if x.is_file()):
    data=p.read_bytes(); rows.append({'path':p.relative_to(root).as_posix(),'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
pathlib.Path(sys.argv[2]).write_text(json.dumps({'file_count':len(rows),'files':rows},indent=2)+chr(10),encoding='utf-8')
PYBACKUP
mv "$PREPARED" "$RUNTIME"
MOVED_NEW=1
rm -rf "$STAGE"
node --version >/dev/null
systemctl --user start telepi.service
attempt=0
while [ "$attempt" -lt 30 ]; do
  [ "$(systemctl --user is-active telepi.service 2>/dev/null || true)" = active ] && break
  attempt=$((attempt+1)); sleep 1
done
[ "$(systemctl --user is-active telepi.service 2>/dev/null || true)" = active ] || fail 'TelePi did not return active after extension activation'
AFTER_PROTECTED=$(protected_snapshot)
[ "$BEFORE_PROTECTED" = "$AFTER_PROTECTED" ] || fail 'protected auth/models/settings state changed'
/home/quoc/toolkit/.venv/bin/python /home/quoc/pi-agent-parity/scripts/prodesk_healthcheck.py --json >/dev/null || fail 'ProDesk healthcheck failed after extension activation'
MOVED_OLD=0
MOVED_NEW=0
trap - EXIT HUP INT TERM
printf '%s\n' "Kaneo MCP runtime activation PASS: artifact=$ARTIFACT_ID; old runtime backup=$BACKUP; TelePi=active; protected state unchanged."
