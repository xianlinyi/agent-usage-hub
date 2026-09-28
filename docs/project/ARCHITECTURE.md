# Architecture

```text
18 local source readers ─┐
custom plugin events ────┼─> collector normalization ── HTTPS POST ──> server validation ──> SQLite
JSON/JSONL import ───────┘                                                   │
                                                                            └─> authenticated stats API ─> web UI
```

- `bin/agent-usage.js`: one role-selecting command entry.
- `src/config.js`: install-time config and private token-file handling.
- `src/collector/sources.js`: source registry, default paths, and file discovery.
- `src/collector/adapters/`: native JSON/JSONL, SQLite, and protobuf usage readers.
- `src/collector/index.js`: scans, plugin loading, batches, and resumable file fingerprints.
- `src/records.js`: fixed event schema and extension validation.
- `src/server/http.js`: authenticated ingestion/query HTTP routes and static UI.
- `src/server/db.js`: idempotent event upsert, file-scoped reconciliation, field registry, safe SQL filters, grouped metrics.
- `src/web/`: browser dashboard, authenticated API calls, custom field controls.

Trust boundaries: push and admin tokens are separate private files; raw Agent transcripts stay on collector machines; server receives usage numbers and selected metadata only. File paths are hashed before transfer. `eventId` is stable within a collector. File syncs update and prune records; UTC dates are used in the dashboard.

- Last Updated: 2026-09-28
- Last Verified Commit: TBD (repository has no commit yet)
