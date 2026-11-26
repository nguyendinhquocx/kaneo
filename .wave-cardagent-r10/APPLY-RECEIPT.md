# Kaneo card-agent collaboration R10 production wave receipt

Status: APPLIED 2026-11-16 — guarded production wave PASS.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration (UAT bugfix wave A+B)
- Source commit: `da107aa4b7dbfb526bdbde20bfde9522afdb870a` (`kaneo/prodesk-production`)
- Previous image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-071cb51c-card-agent-collab-r9@sha256:dcdf49e614f38b1da211e66cceb52cee302dd4e5ce0c517959d17d919fb7aeb8`
- Candidate image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-da107aa4-card-agent-collab-r10@sha256:ab61b5e07d903ef88bea0b797a8cdc72e0915192bea7eae7d92dfae311eece8f`
- Candidate digest: `sha256:ab61b5e07d903ef88bea0b797a8cdc72e0915192bea7eae7d92dfae311eece8f`
- Candidate Compose SHA256: `f24c4851381ab13900a38d31fa11afa5c11807050c54a4c376a2ecd59d8da536`
- Migration head: unchanged 0056 (id 59/count 59); R10 adds no migrations.
- R10 scope: (A) unparsable client dates on subtask/card updates now return 400 with the field name instead of a raw 500 (`parseTaskDateInput`); (B) comment-bound asset uploads (`ownerType=task_comment` + comment id) resolve through the comment activity row to the owning task, task-level form stays compatible, unknown owners get a clear 404.
- Wave apply PASS: visible-sudo guarded run (~53s), compose flip `676edc65→f24c4851`, digest-pinned pull, container healthy on `da107aa4@sha256:ab61b5e0`.
- Pre-deploy encrypted snapshot created + mirrored to private R2 inside the wave (steps 2-3, fail-fast PASS).
- Post-deploy snapshot `kaneo-20261116T121340Z` verified (ciphertext sha256 `49adbe40…`, receipt sha256 `35961ead…`, source identity accepted, 30-day freshness gate enforced) + private R2 mirror PASS.
- Migration/schema PASS: head `0056_agent_session_delivery_generation` (id 59/count 59/hash `a4b63b1a…`), no migrations.
- Live: HTTPS `/api/health` `{"status":"ok"}`, home 200; container `Up (healthy)`, Caddy active.
- Rollback pin: previous R9 image `071cb51c@sha256:dcdf49e6`.
