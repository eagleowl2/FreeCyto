# FreeCyto — Architecture Review

**Date:** 2026-04-27
**Reviewer:** Claude (high-level pass)
**Scope:** Repo-wide architecture, focus on FlowJo parity and persistence strategy.
**Branch reviewed:** `claude/pedantic-tesla-25ed2d` (worktree of `main` @ `5638ca9`)

---

## 1. Executive summary

FreeCyto today is a clean, scientifically-honest **MVP** of a flow-cytometry analyzer. The backend (FastAPI + NumPy + FlowIO) and the Electron/React frontend are well separated, the FCS pipeline is non-destructive, gating already supports hierarchies with FlowJo parity tests passing (Phase D), and a workspace JSON format with auto-save exists (Phase F). For a single-sample, single-analyst workflow, the architecture is appropriate.

**However,** the architecture as it stands will *not* scale to a FlowJo-class product without two concrete shifts:

1. **A first-class "sample group / gating template" abstraction** in both backend models and frontend state — this is the single biggest gap to FlowJo parity, far more important than any one missing gate type.
2. **A real local datastore (SQLite) for workspace state** once the unit of work grows beyond a handful of samples and tens of gates. JSON-on-disk is the right choice today and will become a liability in 6–12 months.

Everything else (more gate shapes, layout editor, derived parameters, compensation editor) is incremental work that fits inside the current bones.

---

## 2. What's good

| Area | Evidence | Why it matters |
|---|---|---|
| **Clean backend layering** | [routers/](backend/routers/) ⟶ [services/](backend/services/) ⟶ [models/](backend/models/) | Domain logic is testable without HTTP. |
| **Non-destructive compensation** | [services/storage.py](backend/services/storage.py) keeps `raw_events` + `comp_events` memmaps; `np.linalg.solve`-based, condition number exposed | Matches FlowJo semantics (compensation is a view, not a mutation). |
| **Stable, content-hashed file IDs** | [services/fcs_parser.py](backend/services/fcs_parser.py) — SHA-256 of first 64 KB | Makes workspace JSON portable across paths/machines without breaking gate references. |
| **LRU + on-disk memmap cache** | [services/storage.py](backend/services/storage.py:60), `OPENCYTO_CACHE_MB` env cap | Bounds RAM, survives larger-than-RAM corpora, no DB needed for the *event* layer. |
| **Hierarchical gating with FlowJo parity tests** | [services/gates.py](backend/services/gates.py), 18/18 parity tests pass (Phase D) | Hardest part of FlowJo's data model is already in place. |
| **Workspace JSON + auto-save session** | [services/session.py](backend/services/session.py), [services/workspace_service.py](backend/services/workspace_service.py) | Versioned schema (`version: 2`) — schema evolution is anticipated. |

This is a much healthier MVP than most "FlowJo clone" attempts at this stage.

---

## 3. What needs revision to be FlowJo-like

### 3.1 Conceptual gaps (highest leverage)

FlowJo's data model is **Workspace → Groups → Samples → Population tree → Statistics → Layouts**. FreeCyto currently has:

```
Workspace → Files → (per-file) Population tree → Per-gate stats
```

The missing first-class concepts are:

- **Sample groups** — a named bag of files that share a gating template. In FlowJo, you draw the gate hierarchy on one sample and "apply to group" propagates it to all 96 wells of a plate. There is **no equivalent** today; each file owns its own gate tree.
- **Gating templates / inheritance** — a group's gate tree is the source-of-truth; per-sample gates can override but otherwise track the template. Today every gate is independently stored per file ([services/gates.py](backend/services/gates.py:1)).
- **Sample table / layout editor** — FlowJo's marketable artifact is a multi-sample table or figure layout, not a single plot. The current UI is a single-sample plot driven from [App.tsx](frontend/src/App.tsx).
- **Derived / compensated parameter naming** — no `Comp-FL1-A` style virtual channels, no formula-based pseudo-parameters.

**Recommendation:** Before adding more gate shapes (quad / ellipse / boolean / threshold / time), introduce `Group` and `GatingTemplate` entities. Without those, every additional feature compounds the per-file duplication problem.

### 3.2 Frontend architecture risk

[App.tsx](frontend/src/App.tsx) is **2,925 lines**. It is the single state holder for files, channels, transforms, gate drawing, gate tree, statistics panel, compensation UI, and workspace I/O. There is no Redux/Zustand/Jotai — only `useState` and `useRef`.

This is the right choice at MVP scope. It will become the wrong choice the moment you add:

- multi-sample sample table,
- side-by-side raw/compensated overlay (already on the NEXT_STEPS list),
- layout editor with multiple plots,
- undo/redo (FlowJo users expect this).

**Recommendation:** Before Phase H, split `App.tsx` into:

- A state store (Zustand is the lowest-friction fit for this codebase — no Provider, easy selectors, small bundle).
- Feature components per panel ([GateTreePanel.tsx](frontend/src/components/) already exists — extend the pattern).
- A single `useEvents` hook (already noted as item 0 in [NEXT_STEPS.md](docs/NEXT_STEPS.md:54)).

This is one to two days of refactor and unblocks every multi-panel feature.

### 3.3 Gate model gaps

Current gates: rectangle, polygon. Missing for FlowJo parity:

- **Quad gates** (4-quadrant, common in immunology).
- **1-D thresholds / interval gates** (histograms).
- **Ellipse gates** (CD4/CD8 cleanup).
- **Boolean gates** (`A AND NOT B`) — FlowJo's most-used "combine populations" tool.
- **Time gates** for QC — gate on event time vs. a parameter.

The existing tree + mask engine in [services/gates.py](backend/services/gates.py) is the right place to add these. Each is incremental once the data model supports a `gate_type` discriminated union — which it already does.

### 3.4 Statistics & export gaps

Phase G shipped a per-gate stats panel with CSV export. FlowJo's value-add is:

- **Sample × population × statistic table** (not gate-by-gate).
- **Custom statistics** (frequency-of-parent, frequency-of-grandparent, percentile, geometric mean).
- **Batch CSV / Excel export** of the whole table.

This is downstream of the *Group* concept (3.1). Don't build sample-comparison stats until a sample group exists.

---

## 4. Should the backend use a database?

**Short answer:** Not yet. **But yes, soon — and SQLite, not Postgres.**

### 4.1 What persistence looks like today

Three layers, all file-based:

| Layer | Storage | Format |
|---|---|---|
| Event arrays | `~/.freecyto/cache/{file_id}_raw.npy`, `_comp.npy` | NumPy memmap |
| Auto-saved session | `~/.freecyto/session.json` | JSON, daemon thread, atomic rename ([services/session.py](backend/services/session.py:14)) |
| User-saved workspace | User-chosen path | JSON, schema `version: 2` ([services/workspace_service.py](backend/services/workspace_service.py)) |

This is a **good** stack at the current scale. Memmaps for numerical event data are exactly right — no database fits that workload.

### 4.2 Where JSON breaks down

JSON workspace files will hit a wall around the points below. None of these are theoretical — they're the routine FlowJo workload:

- **Hundreds of samples × hundreds of gates per sample.** A 96-well plate with a 30-gate panel is ~3,000 gate records. JSON load/save becomes O(seconds) and the entire blob has to be rewritten on every edit. The auto-save daemon ([services/session.py](backend/services/session.py:18)) writes the whole document every time.
- **Cross-sample queries.** "Show me all `CD4+` gates" or "compute frequency-of-parent for population X across the group" requires a scan of every file's tree on every request.
- **Undo/redo.** Users expect FlowJo to undo arbitrarily deep. Diffing JSON blobs is slow and memory-hungry; an event log against a relational store is cheap.
- **Concurrent edits.** Today the daemon thread + global file lock is fine for one user. The moment a Phase brings collaboration features (even just "merge another analyst's gates"), this collapses.
- **Schema evolution beyond v2.** A `version` field is necessary but not sufficient — you'll want migrations.

### 4.3 The right database — SQLite, embedded

**Use SQLite. Do not introduce a server (Postgres/MySQL).** This is a desktop app; a server adds installation pain and buys nothing.

What SQLite gives you that JSON doesn't:

- **Indexed lookups** on `(file_id, parent_gate_id, channel)` — essential for tree operations and cross-sample queries.
- **Atomic transactions** — gate-tree edits become safe even on crash mid-edit (replaces the daemon thread/atomic-rename dance).
- **Migrations** — Alembic or hand-rolled schema versioning is well-trodden.
- **Compact storage** — typical FlowJo-sized workspaces compress 5-10× vs. JSON.
- **Zero infra** — single file, ships with Python stdlib, perfect for an Electron app.

**What stays out of SQLite:** event arrays. NumPy memmaps stay in `~/.freecyto/cache/`. The DB stores metadata, transforms, gate definitions, compensation matrices, statistics cache — i.e. things you query, not things you stream.

### 4.4 Optional: DuckDB for stats

Once sample-table statistics arrive (§3.4), **DuckDB** is worth considering for read-only analytical queries over event arrays. It can query Parquet/Arrow directly, integrates with NumPy, and turns "frequency of parent across 96 samples" into a single SQL query. It coexists with SQLite — different jobs.

### 4.5 Trigger for the migration

Don't migrate to SQLite preemptively. Migrate when **either** of these is true:

- A typical user workspace exceeds ~10 samples or ~500 gates (auto-save latency becomes user-visible).
- You start work on the **Group / template** abstraction (§3.1) — that's the natural moment to introduce the schema, because the data model is changing anyway.

---

## 5. Other architecture observations

- **CORS is correctly hardened** to Electron + Vite dev origins ([backend/main.py](backend/main.py:12)) — good.
- **Backend transport is HTTP-only.** For a desktop app this is fine, but a long-lived WebSocket would simplify "events streaming during a long-running gate computation" and "live stats updates while drawing." Optional, not urgent.
- **No structured logging.** Errors go through a generic exception handler. When you start shipping installers (Phase 5 / packaging), users will report bugs without a way for you to triage. Add structured logs to `~/.freecyto/logs/` early.
- **Packaging is unscoped.** [packaging/](packaging/) is reserved but empty. Embedding the Python backend (PyInstaller / `python-build-standalone` / conda-pack) is the riskiest unbuilt piece — start prototyping it before feature work blocks on it.
- **No telemetry / crash reporting.** Acceptable for an open-source desktop tool, but at least an opt-in error reporter would shorten the bug-fix loop after release.
- **Tests are backend-heavy.** 70 backend tests (incl. FlowJo parity) is excellent for an MVP. Frontend has a Vitest skeleton with little coverage — given that App.tsx is the highest-risk file, this is the gap to close.

---

## 6. Recommended next-three-things

In strict priority order, ignoring the existing roadmap:

1. **Refactor `App.tsx` into a Zustand store + feature components.** One to two days. Unblocks every UI feature after Phase H.
2. **Introduce the `Group` + `GatingTemplate` data model.** Backend models, API, and a minimal frontend "apply this gate tree to these N samples" flow. This is the single biggest step toward FlowJo parity.
3. **Migrate workspace persistence to SQLite** at the same time as (2), because the schema is changing anyway. Keep memmap event cache as-is.

Quad gates, boolean gates, ellipses, layout editor, derived parameters — all important, all easier *after* (1)–(3).

---

## 7. Bottom line

FreeCyto is on a credible path to a FlowJo-class tool. The science is right, the persistence layer is honest, and the gating engine is already further along than its line count would suggest. The two strategic decisions to make now are:

- **Stop modeling per-file gate trees in isolation.** Add Groups + Templates before adding more gate types.
- **Plan the SQLite migration** as a deliberate Phase, not a panic when JSON auto-save starts costing seconds. Pair it with the Group work.

Everything else is execution.
