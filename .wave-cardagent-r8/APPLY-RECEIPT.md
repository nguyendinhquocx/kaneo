# Kaneo card-agent collaboration R8 production wave receipt

Status: APPLIED 2026-11-16 — production wave verified.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration (UAT Revision 8)
- Source commit: `c3df945b8c0b5678c7a4ce3da0358f03e4cf68e0` (`kaneo/prodesk-production`)
- Previous image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-1e800ab2-card-agent-collab-r7@sha256:993a79ffcf87f0a90a9acc6dfcec1b74874063e9ecfe4eeb53f0530fed305188`
- Candidate image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8@sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d`
- Candidate digest: `sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d`
- Candidate Compose SHA256: `4e88ce7bfded2b034c2cde7e20a8db7bd285289d16d67c5476e357ce5e4befc9`
- Migration head: unchanged 0056 (id 59/count 59); R8 adds no migrations.
- R8 scope: bound-card mutations emit live events; bound images return native Pi vision content; delivered Kaneo messages require a card-comment reply; delivery status is a 3-second transient notice plus minimal dot; completion maps to configured isFinal status; marker writes fetch the authoritative contentRevision.
- Wave apply PASS: guarded compose flip `3f5e0989→4e88ce7b`, digest-pinned pull, container healthy on `c3df945b@sha256:dbb32fe5`.
- Post-deploy snapshot `kaneo-20261116T103317Z` verified (ciphertext sha256 `9f71eb42…`, receipt sha256 `fdd8a081…`, source identity accepted, 30-day freshness enforced); private R2 mirror PASS; recovery wrapper repinned `37689be8`, metadata synced to `c3df945b`.
- Migration/schema PASS: head `0056_agent_session_delivery_generation` (id 59/count 59/hash `a4b63b1a…`), no migrations.
- Live: HTTPS `/api/health` `{"status":"ok"}`, home 200; production container healthy, Caddy active.
- Rollback pin: previous R7 image `1e800ab2@sha256:993a79ff`.
- Pi extension source commit `00678df3` is pushed to `python/main`; 19 source files were copied to the local Kaneo MCP runtime with matching SHA256. Existing runtime backup retained as `kaneo-mcp-r8-pre-20261116T174606`. An already-running Li session still needs `/reload` or a restart before it loads R8.
