# Kaneo card-agent collaboration production wave receipt

Status: candidate prepared; apply receipt pending.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration
- Source commit: `48705de286d1928b38253e22a3559991a2c5a779` (`kaneo/prodesk-production`)
- Previous production image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d7c14249-calendar-mindmap-int1@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc`
- Candidate image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-48705de2-card-agent-collab@sha256:51a58e3a3ed1da1c8f8b91eccdab773d5aa4a0e670e3a2410c99d6c245c216bf`
- Candidate manifest digest: `sha256:51a58e3a3ed1da1c8f8b91eccdab773d5aa4a0e670e3a2410c99d6c245c216bf`
- Candidate Compose SHA256: `727dec02a209e3441840eea4f628b663bf4cf00f2a68df4ff090e36a04fe6da8`
- Expected post-migration head: `0056_agent_session_delivery_generation`, id 59/count 59, hash `a4b63b1aadb626ca8c99e033964add7a06094b0d8cc07fb2bccf9d39cf1dca5f`.
- Live schema verifier: 62 required columns, 7 named constraints, 5 agent-session indexes plus existing data-integrity checks.
- Pre/post encrypted snapshot IDs, private R2 mirror receipts, exact container image ID, live health/HTTPS checks: fill from apply output.
- Pre-deploy laptop gates: target profile private-port contract PASS; Home Server fixed H7 drift `ready`, private-host preflight `ready`, Kaneo `server_ops` preflight `release_gate=ready`, backup verifier PASS on `kaneo-20261105T114508Z`; production HTTPS API health and home page QA PASS.
- Candidate artifact: Linux/amd64 image built locally from source commit `48705de2`, pushed digest-pinned to GHCR; source tar build context excludes `.wave-cardagent` and rendered screenshots via Dockerfile explicit COPY allowlist.
- Pi runtime artifact: broad curated artifact-builder correctly failed closed due pre-existing stale/unlisted manifest inventory outside Kaneo. No broad manifest/source edits were made; the already-approved `kaneo-mcp` linux-headless entry is transported as a selected-file T25 artifact with exact source/file/archive hashes and runtime backup/restart script.
- Owner UAT: pending after deploy by owner instruction.
- Pi extension runtime: separate parity lane; not covered by Kaneo API/web image.

## Pi extension selected-file release

- Candidate: `kaneo-mcp-linux-da9ba471-b74d529a5412` (17 tracked files, Linux target approved in parity manifest).
- Source tree commit: `da9ba4715aac60e3a1e70628fe0920376ce0315b`; archive sha256 `e593dddd3ab234dab83f717c1a40bc602517f85b658abefa3b88d369f8fb2517`; release-manifest sha256 `6d2160dda00045caacbb4c5cde99b2c7cd250059cf81c27f9100cba68537bb83`; parity manifest sha256 `fe3a3670d8094708e55db48b47ab04905222df20db78ffc837d033a4643c6175`.
- The broad curated builder fails closed on pre-existing unrelated manifest inventory/typecheck issues; no manifest widening or unreviewed extensions are included. This uses the documented selected-file SSH parity lane: runtime backup, exact archive/file hashes, protected-state guard, TelePi restart, healthcheck.
- Runtime backup location, TelePi restart/health and protected-state hash verification: fill from apply output.
