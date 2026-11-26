"""Render the digest-pinned R8 release bundle from the verified R7 bundle."""
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD = ROOT / ".wave-cardagent-r7"
NEW = ROOT / ".wave-cardagent-r8"
REV = "c3df945b8c0b5678c7a4ce3da0358f03e4cf68e0"
TAG = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8"
DIGEST = "dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d"
IMAGE = f"{TAG}@sha256:{DIGEST}"
R7_IMAGE = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-1e800ab2-card-agent-collab-r7@sha256:993a79ffcf87f0a90a9acc6dfcec1b74874063e9ecfe4eeb53f0530fed305188"
R7_COMPOSE = "3f5e0989241b5d73df9e29d7fc2fba30e9f1e0b2afece97b82be78434ce5993c"
R7_REV = "1e800ab2fef42e647aa1a832f693ccde696cfc07"
R7_WRAPPER = "2ffe646e8a7901a4a4c841d0228161201970d37c006ee4d01d3cbea186d4479e"
R5_IMAGE = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-6edc3bce-card-agent-collab-r5@sha256:d1623209cd2bcc57f3fbe304923f0ae0913de40185a96b5ff0ae19fb4ff588a2"
R5_COMPOSE = "c2f0554ab3db93d5ec200fb659a4dc6b9ffe97aec4a52acaee6d649654c0db7e"
R5_WRAPPER = "1a391e1c057cdeb92b44da819707f52ca96c493c1919085a0662dce3b8bc7451"
R7_SYNC = "41aa26397a52b7a602b3842e19427260228480f1047ebdcf45b1546748eb2b7d"
R7_MIGRATION = "edf65ed8c58472a5016646e63c93c1ea4719976ad1f3b16ee7f774b61df6a352"
R7_BACKUP_VERIFY = "cb1bd0c8a6e5313cf6942cd7acac1d0fb853dad86aeb186140e5b1ab5fb92836"
R7_SNAPSHOT = "6d50072a7a32e038a2f4526f2a736715d8e998a460f90137454660f0106e26aa"
R7_DEPLOY = "051611df39d9d3a91f520479e539678b6110e3339610fae56bb8c6098bc2d0ec"
R7_PREVIOUS_IMAGE = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-6edc3bce-card-agent-collab-r5@sha256:d1623209cd2bcc57f3fbe304923f0ae0913de40185a96b5ff0ae19fb4ff588a2"
MIGRATION_HEAD = "a4b63b1aadb626ca8c99e033964add7a06094b0d8cc07fb2bccf9d39cf1dca5f"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(name: str) -> str:
    return (OLD / name).read_text(encoding="utf-8", newline="")


def write(name: str, text: str) -> str:
    path = NEW / name
    path.write_bytes(text.encode("utf-8"))
    return sha(path.read_bytes())


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"R8 render BLOCKED {label}: expected one match, found {count}")
    return text.replace(old, new)


if NEW.exists():
    shutil.rmtree(NEW)
NEW.mkdir(parents=True)
hashes: dict[str, str] = {}

# Candidate Compose changes only the immutable application image pin.
compose = replace_once(read("compose.cardagent.yml"), f"    image: {R7_IMAGE}\n", f"    image: {IMAGE}\n", "compose image")
hashes["compose"] = write("compose.cardagent.yml", compose)
R8_COMPOSE = hashes["compose"]

# Backup wrapper recognizes the currently running R7 pair and the R8 candidate.
wrapper = read("backup-kaneo.cardagent.sh")
wrapper = replace_once(wrapper, f"PREVIOUS_COMPOSE_SHA256={R5_COMPOSE}\n", f"PREVIOUS_COMPOSE_SHA256={R7_COMPOSE}\n", "backup previous compose")
wrapper = replace_once(wrapper, f"PREVIOUS_IMAGE_REF='{R5_IMAGE}'\n", f"PREVIOUS_IMAGE_REF='{R7_IMAGE}'\n", "backup previous image")
wrapper = replace_once(wrapper, f"CANDIDATE_COMPOSE_SHA256={R7_COMPOSE}\n", f"CANDIDATE_COMPOSE_SHA256={R8_COMPOSE}\n", "backup candidate compose")
wrapper = replace_once(wrapper, f"CANDIDATE_IMAGE_REF='{R7_IMAGE}'\n", f"CANDIDATE_IMAGE_REF='{IMAGE}'\n", "backup candidate image")
hashes["wrapper"] = write("backup-kaneo.cardagent.sh", wrapper)
R8_WRAPPER = hashes["wrapper"]

# Digest-pinned deploy script: current R7 -> candidate R8.
deploy = read("deploy-kaneo-cardagent.sh")
deploy = replace_once(
    deploy,
    "# Canonical Kaneo release deploy template — card-agent collaboration R7 wave pins\n"
    f"# (SPEC-2026-11-10-kaneo-card-agent-collaboration R7 @ {R7_REV}).\n",
    "# Canonical Kaneo release deploy template — card-agent collaboration R8 wave pins\n"
    f"# (SPEC-2026-11-10-kaneo-card-agent-collaboration R8 @ {REV}).\n",
    "deploy header",
)
deploy = replace_once(deploy, f"CURRENT_IMAGE='{R5_IMAGE}'\n", f"CURRENT_IMAGE='{R7_IMAGE}'\n", "deploy current image")
deploy = replace_once(deploy, f"NEW_IMAGE='{R7_IMAGE}'\n", f"NEW_IMAGE='{IMAGE}'\n", "deploy candidate image")
deploy = replace_once(deploy, f"NEW_SHA='{R7_IMAGE.split('@sha256:')[1]}'\n", f"NEW_SHA='{DIGEST}'\n", "deploy digest")
hashes["deploy"] = write("deploy-kaneo-cardagent.sh", deploy)
R8_DEPLOY = hashes["deploy"]

# Recovery metadata adapter is valid only for R8 after staging and after apply.
sync = read("sync.cardagent.sh")
sync = replace_once(sync, f"EXPECTED_SOURCE_REVISION={R7_REV}\n", f"EXPECTED_SOURCE_REVISION={REV}\n", "sync revision")
sync = replace_once(sync, f"EXPECTED_COMPOSE_SHA256={R7_COMPOSE}\n", f"EXPECTED_COMPOSE_SHA256={R8_COMPOSE}\n", "sync compose")
sync = replace_once(sync, f"EXPECTED_IMAGE='{R7_IMAGE}'\n", f"EXPECTED_IMAGE='{IMAGE}'\n", "sync image")
sync = replace_once(sync, f"EXPECTED_PREVIOUS_IMAGE='{R7_PREVIOUS_IMAGE}'\n", f"EXPECTED_PREVIOUS_IMAGE='{R7_IMAGE}'\n", "sync previous image")
sync = replace_once(sync, f"EXPECTED_BACKUP_WRAPPER_SHA256={R7_WRAPPER}\n", f"EXPECTED_BACKUP_WRAPPER_SHA256={R8_WRAPPER}\n", "sync wrapper")
hashes["sync"] = write("sync.cardagent.sh", sync)
R8_SYNC = hashes["sync"]

migration = read("migration-verify.cardagent.sh")
migration = replace_once(migration, f"EXPECTED_COMPOSE_SHA256={R7_COMPOSE}\n", f"EXPECTED_COMPOSE_SHA256={R8_COMPOSE}\n", "migration compose")
migration = replace_once(migration, f"EXPECTED_IMAGE='{R7_IMAGE}'\n", f"EXPECTED_IMAGE='{IMAGE}'\n", "migration image")
hashes["migration"] = write("migration-verify.cardagent.sh", migration)
R8_MIGRATION = hashes["migration"]

# Extend the allowlist used by the current encrypted-backup verifier.
backup_verify = read("backup-verify.cardagent.sh")
backup_verify = replace_once(
    backup_verify,
    f"CARD_AGENT_R7_CANDIDATE_IMAGE='{R7_IMAGE}'\n",
    f"CARD_AGENT_R7_CANDIDATE_IMAGE='{R7_IMAGE}'\n"
    f"CARD_AGENT_R8_CANDIDATE_COMPOSE_SHA256={R8_COMPOSE}\n"
    f"CARD_AGENT_R8_CANDIDATE_IMAGE='{IMAGE}'\n",
    "backup verifier R8 constants",
)
backup_verify = replace_once(
    backup_verify,
    f'"$CARD_AGENT_R7_CANDIDATE_COMPOSE_SHA256" "$CARD_AGENT_R7_CANDIDATE_IMAGE" <<\'PY\'',
    f'"$CARD_AGENT_R7_CANDIDATE_COMPOSE_SHA256" "$CARD_AGENT_R7_CANDIDATE_IMAGE" '
    f'"$CARD_AGENT_R8_CANDIDATE_COMPOSE_SHA256" "$CARD_AGENT_R8_CANDIDATE_IMAGE" <<\'PY\'',
    "backup verifier R8 args",
)
backup_verify = replace_once(
    backup_verify,
    "card_agent_r5_compose, card_agent_r5_image, card_agent_r7_compose, card_agent_r7_image = sys.argv[1:]",
    "card_agent_r5_compose, card_agent_r5_image, card_agent_r7_compose, card_agent_r7_image, card_agent_r8_compose, card_agent_r8_image = sys.argv[1:]",
    "backup verifier R8 unpack",
)
backup_verify = replace_once(
    backup_verify,
    "(card_agent_r5_compose, card_agent_r5_image), (card_agent_r7_compose, card_agent_r7_image)}:",
    "(card_agent_r5_compose, card_agent_r5_image), (card_agent_r7_compose, card_agent_r7_image), (card_agent_r8_compose, card_agent_r8_image)}:",
    "backup verifier R8 identity allowlist",
)
hashes["backup_verify"] = write("backup-verify.cardagent.sh", backup_verify)
R8_BACKUP_VERIFY = hashes["backup_verify"]

# Extend the post-deploy snapshot adapter with the R8 recovery identity.
snapshot = read("snapshot.cardagent.sh")
snapshot = replace_once(
    snapshot,
    f"CARD_AGENT_R7_CANDIDATE_IMAGE='{R7_IMAGE}'\n",
    f"CARD_AGENT_R7_CANDIDATE_IMAGE='{R7_IMAGE}'\n"
    f"CARD_AGENT_R8_CANDIDATE_BACKUP_SHA256={R8_WRAPPER}\n"
    f"CARD_AGENT_R8_CANDIDATE_COMPOSE_SHA256={R8_COMPOSE}\n"
    f"CARD_AGENT_R8_CANDIDATE_IMAGE='{IMAGE}'\n",
    "snapshot R8 constants",
)
snapshot = replace_once(
    snapshot,
    f'    "$CARD_AGENT_R7_CANDIDATE_BACKUP_SHA256") expected_compose=$CARD_AGENT_R7_CANDIDATE_COMPOSE_SHA256; expected_image=$CARD_AGENT_R7_CANDIDATE_IMAGE ;;\n',
    f'    "$CARD_AGENT_R7_CANDIDATE_BACKUP_SHA256") expected_compose=$CARD_AGENT_R7_CANDIDATE_COMPOSE_SHA256; expected_image=$CARD_AGENT_R7_CANDIDATE_IMAGE ;;\n'
    f'    "$CARD_AGENT_R8_CANDIDATE_BACKUP_SHA256") expected_compose=$CARD_AGENT_R8_CANDIDATE_COMPOSE_SHA256; expected_image=$CARD_AGENT_R8_CANDIDATE_IMAGE ;;\n',
    "snapshot R8 case",
)
hashes["snapshot"] = write("snapshot.cardagent.sh", snapshot)
R8_SNAPSHOT = hashes["snapshot"]

# Hash-pinned wave orchestrator: production R7 -> candidate R8.
wave = read("kaneo-wave-apply.sh")
wave = replace_once(wave, "# Fixed-path, hash-pinned Kaneo card-agent R7 production rollout; run via visible sudo on ProDesk.\n", "# Fixed-path, hash-pinned Kaneo card-agent R8 production rollout; run via visible sudo on ProDesk.\n", "wave header")
wave = replace_once(wave, "BUNDLE=/home/quoc/kaneo/staging/card-agent-collab-r7\n", "BUNDLE=/home/quoc/kaneo/staging/card-agent-collab-r8\n", "wave bundle")
wave = replace_once(wave, f"CURRENT_IMAGE={R5_IMAGE}\n", f"CURRENT_IMAGE={R7_IMAGE}\n", "wave current image")
wave = replace_once(wave, f"NEW_IMAGE={R7_IMAGE}\n", f"NEW_IMAGE={IMAGE}\n", "wave new image")
wave = replace_once(wave, f"CURRENT_COMPOSE_SHA256={R5_COMPOSE}\n", f"CURRENT_COMPOSE_SHA256={R7_COMPOSE}\n", "wave current compose")
wave = replace_once(wave, f"NEW_COMPOSE_SHA256={R7_COMPOSE}\n", f"NEW_COMPOSE_SHA256={R8_COMPOSE}\n", "wave new compose")
wave = replace_once(wave, f"CURRENT_SOURCE_REVISION=6edc3bce47e70b14c2db34e5df77755e8bf1bbe7\n", f"CURRENT_SOURCE_REVISION={R7_REV}\n", "wave current revision")
wave = replace_once(wave, f"NEW_SOURCE_REVISION={R7_REV}\n", f"NEW_SOURCE_REVISION={REV}\n", "wave new revision")
wave = replace_once(wave, f"CURRENT_WRAPPER_SHA256={R5_WRAPPER}\n", f"CURRENT_WRAPPER_SHA256={R7_WRAPPER}\n", "wave current wrapper")
wave = replace_once(wave, f"NEW_WRAPPER_SHA256={R7_WRAPPER}\n", f"NEW_WRAPPER_SHA256={R8_WRAPPER}\n", "wave new wrapper")
wave = replace_once(wave, f"NEW_SYNC_SHA256={R7_SYNC}\n", f"NEW_SYNC_SHA256={R8_SYNC}\n", "wave sync")
wave = replace_once(wave, f"NEW_MIGRATION_SHA256={R7_MIGRATION}\n", f"NEW_MIGRATION_SHA256={R8_MIGRATION}\n", "wave migration")
wave = replace_once(wave, f"NEW_BACKUP_VERIFY_SHA256={R7_BACKUP_VERIFY}\n", f"NEW_BACKUP_VERIFY_SHA256={R8_BACKUP_VERIFY}\n", "wave backup verifier")
wave = replace_once(wave, f"NEW_SNAPSHOT_ADAPTER_SHA256={R7_SNAPSHOT}\n", f"NEW_SNAPSHOT_ADAPTER_SHA256={R8_SNAPSHOT}\n", "wave snapshot adapter")
wave = replace_once(wave, f"NEW_DEPLOY_SHA256={R7_DEPLOY}\n", f"NEW_DEPLOY_SHA256={R8_DEPLOY}\n", "wave deploy script")
hashes["wave"] = write("kaneo-wave-apply.sh", wave)

provenance = {
    "schema_version": 3,
    "spec": "SPEC-2026-11-10-kaneo-card-agent-collaboration",
    "wave": "card-agent-collab-r8",
    "source_sha": REV,
    "base_source_sha": R7_REV,
    "candidate_image": IMAGE,
    "candidate_manifest_digest": f"sha256:{DIGEST}",
    "candidate_compose_sha256": R8_COMPOSE,
    "platform": "linux/amd64",
    "dockerfile": "Dockerfile.kaneo",
    "dirty_state": "R8 candidate built from committed source after tests; .wave-cardagent-r8 excluded by Dockerfile explicit COPY rules.",
    "verify": [
        "web typecheck + full suite 53 files / 173 tests PASS; Vite production build PASS",
        "focused UI state tests 25/25 PASS; marker fresh-CAS regression and delivery dot states included",
        "API typecheck + 264 unit PASS; focused binding/asset integration 11/11 PASS using disposable local Postgres; i18n:check PASS",
        "kaneo-mcp Node suite 89/89 PASS; tsconfig.check TypeScript PASS",
    ],
    "migration_head_before": {"id": 59, "count": 59, "tag": "0056_agent_session_delivery_generation", "hash": MIGRATION_HEAD},
    "migration_head_after": {"id": 59, "count": 59, "tag": "0056_agent_session_delivery_generation", "hash": MIGRATION_HEAD},
    "deployment_lane": "fixed .wave-cardagent-r8 bundle; pre/post encrypted snapshot + private R2 mirror; hash-pinned adapters; guarded digest compose flip; read-only migration verifier.",
    "rollback": f"previous R7 image {R7_IMAGE}; no migrations in R8; restore only via verified fresh-target workflow.",
}
write("CANDIDATE-PROVENANCE.json", json.dumps(provenance, indent=2) + "\n")
receipt = f"""# Kaneo card-agent collaboration R8 production wave receipt

Status: candidate prepared; apply receipt pending.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration (UAT Revision 8)
- Source commit: `{REV}` (`kaneo/prodesk-production`)
- Previous image: `{R7_IMAGE}`
- Candidate image: `{IMAGE}`
- Candidate digest: `sha256:{DIGEST}`
- Candidate Compose SHA256: `{R8_COMPOSE}`
- Migration head: unchanged 0056 (id 59/count 59); R8 adds no migrations.
- R8 scope: bound-card mutations emit live events; bound images return native Pi vision content; delivered Kaneo messages require a card-comment reply; delivery status is a 3-second transient notice plus minimal dot; completion maps to configured isFinal status; marker writes fetch the authoritative contentRevision.
- Pre/post encrypted snapshot IDs, private R2 mirror receipts, exact container image ID, and live health checks: fill after apply.
"""
write("APPLY-RECEIPT.md", receipt)

print("card-agent-collab-r8 rendered")
for key, value in hashes.items():
    print(f"{key:16s} {value}")
print(f"R8_COMPOSE={R8_COMPOSE}\nR8_WRAPPER={R8_WRAPPER}\nR8_SYNC={R8_SYNC}\nR8_MIGRATION={R8_MIGRATION}\nR8_BACKUP_VERIFY={R8_BACKUP_VERIFY}\nR8_SNAPSHOT={R8_SNAPSHOT}\nR8_DEPLOY={R8_DEPLOY}")
