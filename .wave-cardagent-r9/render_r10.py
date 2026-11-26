"""Render the digest-pinned R10 UAT bugfix release from R9 pins."""
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD = ROOT / ".wave-cardagent-r9"
NEW = ROOT / ".wave-cardagent-r10"
REV = "da107aa4b7dbfb526bdbde20bfde9522afdb870a"
TAG = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-da107aa4-card-agent-collab-r10"
DIGEST = "ab61b5e07d903ef88bea0b797a8cdc72e0915192bea7eae7d92dfae311eece8f"
IMAGE = f"{TAG}@sha256:{DIGEST}"
R9_IMAGE = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-071cb51c-card-agent-collab-r9@sha256:dcdf49e614f38b1da211e66cceb52cee302dd4e5ce0c517959d17d919fb7aeb8"
R9_COMPOSE = "676edc655f07812e8b42a7dae6702d352ad7c0eec867a5536ed706f62772653a"
R9_REV = "071cb51c5d1882a7ebb48637e16c4547ab36a340"
R9_WRAPPER = "343c2656d4130d9c69fcdd4852249bae2434603729a36cdd83033005dd87dc9c"
R8_IMAGE = "ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8@sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d"
R8_COMPOSE = "4e88ce7bfded2b034c2cde7e20a8db7bd285289d16d67c5476e357ce5e4befc9"
R8_REV = "c3df945b8c0b5678c7a4ce3da0358f03e4cf68e0"
R8_WRAPPER = "37689be88d73b303f0d6ba71a74bb0ff07e4ec6dd2398b73a6334a58b8742c4e"
R9_SYNC = "24d2c585df4be4ca179a21ba5c31beb4d02ce26d6b5be4532ecb640fbcd329a7"
R9_MIGRATION = "21867c699595065204d600c0124cd182f44ba47e7bc7d701870c68ba88fba034"
R9_BACKUP_VERIFY = "efb94195260200e26e038492198f3111c8bcdd7c6855e414ca1d84afc715367f"
R9_SNAPSHOT = "bfc848ac2c801a06dc479117f8c98aa062a164428fd95149fd42369392ab2c21"
R9_DEPLOY = "c875dc5cf6537ae183e0e654e63e09aa6e023f22202eefc14a46448608048070"
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
        raise SystemExit(f"R10 render BLOCKED {label}: expected one match, found {count}")
    return text.replace(old, new)


if NEW.exists():
    shutil.rmtree(NEW)
NEW.mkdir(parents=True)
hashes: dict[str, str] = {}

compose = replace_once(read("compose.cardagent.yml"), f"    image: {R9_IMAGE}\n", f"    image: {IMAGE}\n", "compose image")
hashes["compose"] = write("compose.cardagent.yml", compose)
R10_COMPOSE = hashes["compose"]

wrapper = read("backup-kaneo.cardagent.sh")
wrapper = replace_once(wrapper, f"PREVIOUS_COMPOSE_SHA256={R8_COMPOSE}\n", f"PREVIOUS_COMPOSE_SHA256={R9_COMPOSE}\n", "backup previous compose")
wrapper = replace_once(wrapper, f"PREVIOUS_IMAGE_REF='{R8_IMAGE}'\n", f"PREVIOUS_IMAGE_REF='{R9_IMAGE}'\n", "backup previous image")
wrapper = replace_once(wrapper, f"CANDIDATE_COMPOSE_SHA256={R9_COMPOSE}\n", f"CANDIDATE_COMPOSE_SHA256={R10_COMPOSE}\n", "backup candidate compose")
wrapper = replace_once(wrapper, f"CANDIDATE_IMAGE_REF='{R9_IMAGE}'\n", f"CANDIDATE_IMAGE_REF='{IMAGE}'\n", "backup candidate image")
hashes["wrapper"] = write("backup-kaneo.cardagent.sh", wrapper)
R10_WRAPPER = hashes["wrapper"]

deploy = read("deploy-kaneo-cardagent.sh")
deploy = replace_once(
    deploy,
    "# Canonical Kaneo release deploy template — card-agent collaboration R9 wave pins\n"
    f"# (SPEC-2026-11-10-kaneo-card-agent-collaboration R9 @ {R9_REV}).\n",
    "# Canonical Kaneo release deploy template — card-agent collaboration R10 wave pins\n"
    f"# (SPEC-2026-11-10-kaneo-card-agent-collaboration R10 @ {REV}).\n",
    "deploy header",
)
deploy = replace_once(deploy, f"CURRENT_IMAGE='{R8_IMAGE}'\n", f"CURRENT_IMAGE='{R9_IMAGE}'\n", "deploy current image")
deploy = replace_once(deploy, f"NEW_IMAGE='{R9_IMAGE}'\n", f"NEW_IMAGE='{IMAGE}'\n", "deploy candidate image")
deploy = replace_once(deploy, f"NEW_SHA='{R9_IMAGE.split('@sha256:')[1]}'\n", f"NEW_SHA='{DIGEST}'\n", "deploy digest")
hashes["deploy"] = write("deploy-kaneo-cardagent.sh", deploy)
R10_DEPLOY = hashes["deploy"]

sync = read("sync.cardagent.sh")
sync = replace_once(sync, f"EXPECTED_SOURCE_REVISION={R9_REV}\n", f"EXPECTED_SOURCE_REVISION={REV}\n", "sync revision")
sync = replace_once(sync, f"EXPECTED_COMPOSE_SHA256={R9_COMPOSE}\n", f"EXPECTED_COMPOSE_SHA256={R10_COMPOSE}\n", "sync compose")
sync = replace_once(sync, f"EXPECTED_IMAGE='{R9_IMAGE}'\n", f"EXPECTED_IMAGE='{IMAGE}'\n", "sync image")
sync = replace_once(sync, f"EXPECTED_PREVIOUS_IMAGE='{R8_IMAGE}'\n", f"EXPECTED_PREVIOUS_IMAGE='{R9_IMAGE}'\n", "sync previous image")
sync = replace_once(sync, f"EXPECTED_BACKUP_WRAPPER_SHA256={R9_WRAPPER}\n", f"EXPECTED_BACKUP_WRAPPER_SHA256={R10_WRAPPER}\n", "sync wrapper")
hashes["sync"] = write("sync.cardagent.sh", sync)
R10_SYNC = hashes["sync"]

migration = read("migration-verify.cardagent.sh")
migration = replace_once(migration, f"EXPECTED_COMPOSE_SHA256={R9_COMPOSE}\n", f"EXPECTED_COMPOSE_SHA256={R10_COMPOSE}\n", "migration compose")
migration = replace_once(migration, f"EXPECTED_IMAGE='{R9_IMAGE}'\n", f"EXPECTED_IMAGE='{IMAGE}'\n", "migration image")
hashes["migration"] = write("migration-verify.cardagent.sh", migration)
R10_MIGRATION = hashes["migration"]

backup_verify = read("backup-verify.cardagent.sh")
backup_verify = replace_once(
    backup_verify,
    f"CARD_AGENT_R9_CANDIDATE_IMAGE='{R9_IMAGE}'\n",
    f"CARD_AGENT_R9_CANDIDATE_IMAGE='{R9_IMAGE}'\n"
    f"CARD_AGENT_R10_CANDIDATE_COMPOSE_SHA256={R10_COMPOSE}\n"
    f"CARD_AGENT_R10_CANDIDATE_IMAGE='{IMAGE}'\n",
    "backup verifier R10 constants",
)
backup_verify = replace_once(
    backup_verify,
    f'"$CARD_AGENT_R9_CANDIDATE_COMPOSE_SHA256" "$CARD_AGENT_R9_CANDIDATE_IMAGE" <<\'PY\'',
    f'"$CARD_AGENT_R9_CANDIDATE_COMPOSE_SHA256" "$CARD_AGENT_R9_CANDIDATE_IMAGE" '
    f'"$CARD_AGENT_R10_CANDIDATE_COMPOSE_SHA256" "$CARD_AGENT_R10_CANDIDATE_IMAGE" <<\'PY\'',
    "backup verifier R10 args",
)
backup_verify = replace_once(
    backup_verify,
    "card_agent_r9_compose, card_agent_r9_image = sys.argv[1:]",
    "card_agent_r9_compose, card_agent_r9_image, card_agent_r10_compose, card_agent_r10_image = sys.argv[1:]",
    "backup verifier R10 unpack",
)
backup_verify = replace_once(
    backup_verify,
    "(card_agent_r9_compose, card_agent_r9_image)}:",
    "(card_agent_r9_compose, card_agent_r9_image), (card_agent_r10_compose, card_agent_r10_image)}:",
    "backup verifier R10 identity allowlist",
)
hashes["backup_verify"] = write("backup-verify.cardagent.sh", backup_verify)
R10_BACKUP_VERIFY = hashes["backup_verify"]

snapshot = read("snapshot.cardagent.sh")
snapshot = replace_once(
    snapshot,
    f"CARD_AGENT_R9_CANDIDATE_IMAGE='{R9_IMAGE}'\n",
    f"CARD_AGENT_R9_CANDIDATE_IMAGE='{R9_IMAGE}'\n"
    f"CARD_AGENT_R10_CANDIDATE_BACKUP_SHA256={R10_WRAPPER}\n"
    f"CARD_AGENT_R10_CANDIDATE_COMPOSE_SHA256={R10_COMPOSE}\n"
    f"CARD_AGENT_R10_CANDIDATE_IMAGE='{IMAGE}'\n",
    "snapshot R10 constants",
)
snapshot = replace_once(
    snapshot,
    f'    "$CARD_AGENT_R9_CANDIDATE_BACKUP_SHA256") expected_compose=$CARD_AGENT_R9_CANDIDATE_COMPOSE_SHA256; expected_image=$CARD_AGENT_R9_CANDIDATE_IMAGE ;;\n',
    f'    "$CARD_AGENT_R9_CANDIDATE_BACKUP_SHA256") expected_compose=$CARD_AGENT_R9_CANDIDATE_COMPOSE_SHA256; expected_image=$CARD_AGENT_R9_CANDIDATE_IMAGE ;;\n'
    f'    "$CARD_AGENT_R10_CANDIDATE_BACKUP_SHA256") expected_compose=$CARD_AGENT_R10_CANDIDATE_COMPOSE_SHA256; expected_image=$CARD_AGENT_R10_CANDIDATE_IMAGE ;;\n',
    "snapshot R10 case",
)
hashes["snapshot"] = write("snapshot.cardagent.sh", snapshot)
R10_SNAPSHOT = hashes["snapshot"]

wave = read("kaneo-wave-apply.sh")
wave = replace_once(wave, "# Fixed-path, hash-pinned Kaneo card-agent R9 production rollout; run via visible sudo on ProDesk.\n", "# Fixed-path, hash-pinned Kaneo card-agent R10 production rollout; run via visible sudo on ProDesk.\n", "wave header")
wave = replace_once(wave, "BUNDLE=/home/quoc/kaneo/staging/card-agent-collab-r9\n", "BUNDLE=/home/quoc/kaneo/staging/card-agent-collab-r10\n", "wave bundle")
# CURRENT_IMAGE re-pin: the R9 wave still carried R8 as CURRENT (render_r9 only
# advanced NEW). Current must equal the live R9 image before apply.
wave = replace_once(wave, f"CURRENT_IMAGE={R8_IMAGE}\n", f"CURRENT_IMAGE={R9_IMAGE}\n", "wave current image")
wave = replace_once(wave, f"NEW_IMAGE={R9_IMAGE}\n", f"NEW_IMAGE={IMAGE}\n", "wave new image")
wave = replace_once(wave, f"CURRENT_COMPOSE_SHA256={R8_COMPOSE}\n", f"CURRENT_COMPOSE_SHA256={R9_COMPOSE}\n", "wave current compose")
wave = replace_once(wave, f"NEW_COMPOSE_SHA256={R9_COMPOSE}\n", f"NEW_COMPOSE_SHA256={R10_COMPOSE}\n", "wave new compose")
wave = replace_once(wave, f"CURRENT_SOURCE_REVISION={R8_REV}\n", f"CURRENT_SOURCE_REVISION={R9_REV}\n", "wave current revision")
wave = replace_once(wave, f"NEW_SOURCE_REVISION={R9_REV}\n", f"NEW_SOURCE_REVISION={REV}\n", "wave new revision")
wave = replace_once(wave, f"CURRENT_WRAPPER_SHA256={R8_WRAPPER}\n", f"CURRENT_WRAPPER_SHA256={R9_WRAPPER}\n", "wave current wrapper")
wave = replace_once(wave, f"NEW_WRAPPER_SHA256={R9_WRAPPER}\n", f"NEW_WRAPPER_SHA256={R10_WRAPPER}\n", "wave new wrapper")
wave = replace_once(wave, f"NEW_SYNC_SHA256={R9_SYNC}\n", f"NEW_SYNC_SHA256={R10_SYNC}\n", "wave sync")
wave = replace_once(wave, f"NEW_MIGRATION_SHA256={R9_MIGRATION}\n", f"NEW_MIGRATION_SHA256={R10_MIGRATION}\n", "wave migration")
wave = replace_once(wave, f"NEW_BACKUP_VERIFY_SHA256={R9_BACKUP_VERIFY}\n", f"NEW_BACKUP_VERIFY_SHA256={R10_BACKUP_VERIFY}\n", "wave backup verifier")
wave = replace_once(wave, f"NEW_SNAPSHOT_ADAPTER_SHA256={R9_SNAPSHOT}\n", f"NEW_SNAPSHOT_ADAPTER_SHA256={R10_SNAPSHOT}\n", "wave snapshot adapter")
wave = replace_once(wave, f"NEW_DEPLOY_SHA256={R9_DEPLOY}\n", f"NEW_DEPLOY_SHA256={R10_DEPLOY}\n", "wave deploy script")
hashes["wave"] = write("kaneo-wave-apply.sh", wave)

provenance = {
    "schema_version": 3,
    "spec": "SPEC-2026-11-10-kaneo-card-agent-collaboration",
    "wave": "card-agent-collab-r10",
    "source_sha": REV,
    "base_source_sha": R9_REV,
    "candidate_image": IMAGE,
    "candidate_manifest_digest": f"sha256:{DIGEST}",
    "candidate_compose_sha256": R10_COMPOSE,
    "platform": "linux/amd64",
    "dockerfile": "Dockerfile.kaneo",
    "dirty_state": "R10 candidate built from committed source; .wave-cardagent-r10 excluded by Dockerfile explicit COPY rules.",
    "verify": [
        "API: focused integration 9 files / 59 tests PASS incl. 10 new UAT regression tests (subtask date validation + comment-bound asset upload)",
        "API unit 264/264 PASS; tsc --noEmit PASS; biome PASS on touched files",
        "Web/extension source unchanged from R9 gates (web 54 files / 175 tests, extension 89/89)",
    ],
    "migration_head_before": {"id": 59, "count": 59, "tag": "0056_agent_session_delivery_generation", "hash": MIGRATION_HEAD},
    "migration_head_after": {"id": 59, "count": 59, "tag": "0056_agent_session_delivery_generation", "hash": MIGRATION_HEAD},
    "deployment_lane": "fixed .wave-cardagent-r10 bundle; pre/post encrypted snapshot + private R2 mirror; hash-pinned adapters; guarded digest compose flip; read-only migration verifier.",
    "rollback": f"previous R9 image {R9_IMAGE}; no migrations in R10; restore only via verified fresh-target workflow.",
}
write("CANDIDATE-PROVENANCE.json", json.dumps(provenance, indent=2) + "\n")
receipt = f"""# Kaneo card-agent collaboration R10 production wave receipt

Status: candidate prepared; apply receipt pending.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration (UAT bugfix wave)
- Source commit: `{REV}` (`kaneo/prodesk-production`)
- Previous image: `{R9_IMAGE}`
- Candidate image: `{IMAGE}`
- Candidate digest: `sha256:{DIGEST}`
- Candidate Compose SHA256: `{R10_COMPOSE}`
- Migration head: unchanged 0056 (id 59/count 59); R10 adds no migrations.
- R10 scope: subtask/card date validation (unparsable client dates now return 400 with the field name instead of a raw 500) and comment-bound asset uploads (ownerType=task_comment with a comment id resolves through the activity row; task-level form stays compatible).
- Pre/post encrypted snapshot IDs, private R2 mirror receipts, exact container image ID, and live health checks: fill after apply.
"""
write("APPLY-RECEIPT.md", receipt)

print("card-agent-collab-r10 rendered")
for key, value in hashes.items():
    print(f"{key:16s} {value}")
print(f"R10_COMPOSE={R10_COMPOSE}\nR10_WRAPPER={R10_WRAPPER}\nR10_SYNC={R10_SYNC}\nR10_MIGRATION={R10_MIGRATION}\nR10_BACKUP_VERIFY={R10_BACKUP_VERIFY}\nR10_SNAPSHOT={R10_SNAPSHOT}\nR10_DEPLOY={R10_DEPLOY}")
