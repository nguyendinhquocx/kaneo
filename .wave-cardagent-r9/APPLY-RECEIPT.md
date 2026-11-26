# Kaneo card-agent collaboration R9 production wave receipt

Status: APPLIED 2026-11-16 — guarded production wave PASS.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration (UAT Revision 9 follow-up)
- Source commit: `071cb51c5d1882a7ebb48637e16c4547ab36a340` (`kaneo/prodesk-production`)
- Previous image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c3df945b-card-agent-collab-r8@sha256:dbb32fe58e938f56e07e9f73a3b5c531e5dd8bb7fbfb5bc580256ca28e4ec88d`
- Candidate image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-071cb51c-card-agent-collab-r9@sha256:dcdf49e614f38b1da211e66cceb52cee302dd4e5ce0c517959d17d919fb7aeb8`
- Candidate digest: `sha256:dcdf49e614f38b1da211e66cceb52cee302dd4e5ce0c517959d17d919fb7aeb8`
- Candidate Compose SHA256: `676edc655f07812e8b42a7dae6702d352ad7c0eec867a5536ed706f62772653a`
- Migration head: unchanged 0056 (id 59/count 59); R9 adds no migrations.
- R9 scope: parse the structured `message` from a work-marker CAS error so UI shows actionable text, not a raw JSON envelope. R8's fresh-revision read remains unchanged.
- Wave apply PASS: guarded Compose flip `4e88ce7b→676edc65`, digest-pinned pull, container healthy on `071cb51c@sha256:dcdf49e6`.
- Post-deploy snapshot `kaneo-20261116T110608Z` verified (ciphertext sha256 `db7669f1…`, receipt sha256 `4dae7601…`, source identity accepted, 30-day freshness enforced); private R2 mirror PASS; wrapper repinned `343c2656`, metadata synced to `071cb51c`.
- Migration/schema PASS: head `0056_agent_session_delivery_generation` (id 59/count 59/hash `a4b63b1a…`), no migrations.
- Live: HTTPS `/api/health` `{"status":"ok"}`, home 200; production container healthy, Caddy active.
- Rollback pin: previous R8 image `c3df945b@sha256:dbb32fe5`.
