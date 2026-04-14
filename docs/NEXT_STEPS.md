# MVP next steps

After review-driven hardening (Phase 1–3), these are the defined next steps to keep building the MVP. Order is by dependency and impact.

**Gating bugs & scientific consistency:** The code review in `FreeCyto_Gating_Review.pdf` is summarised in **`docs/GATING_REVIEW_ACTION_PLAN.md`**. That document is the single source of truth for fixing gating coordinate bugs (C-1–C-3), scientific correctness (S-1–S-5), frontend/UX (F-1–F-3), and architecture (A-1–A-2). Implement in four sprints as described there; log each sprint in `PROJECT_LOG.md`.

**Sprint 2 (Scientific correctness):** Goals and definition of done for S-1, S-3, S-4 are in **`docs/GATING_REVIEW_ACTION_PLAN.md` §2.1**. Focus: full-event gating, stale gates on transform change, polygon boundary = inside (FlowJo parity).

**Hierarchical gating (FlowJo-style tree):** The plan in **`FreeCyto_GatingHierarchy_Plan.pdf`** is implemented in five sprints defined in **`docs/GATING_HIERARCHY_SPRINTS.md`**: (1) Backend tree store + mask engine, (2) API + frontend types, (3) Tree panel + active population, (4) Overlays + workspace, (5) FlowJo parity validation. Prerequisites (C-1, C-2, S-1) are already done.

---

## Recent fix (2026‑03‑04) — Gates not displayed

**Issue:** Frontend showed "No gates" while backend had gates and returned 409 on duplicate name.  
**Cause:** `get_gate_tree()` raised `TypeError` when building nested `GateResponse` (duplicate `children` keyword).  
**Fix:** Build dict from `base.model_dump()`, set `d["children"] = child_responses`, then `GateResponse(**d)`. Documented as **S2-1b** in **`docs/SPRINT1_CAVEATS_AND_BUGS.md`**. Gates now appear in the hierarchy panel.

---

## Defined next steps (priority order)

### A. Hierarchical gating (continue sprints)

- **Sprint 4 (FE-4 + INT-1):** Gate overlays filtered by active population (visibleGates); workspace save/load preserves hierarchy (parent_gate_id, order, id_map on load). See **`docs/GATING_HIERARCHY_SPRINTS.md` §6**.
- **Sprint 5 (INT-2):** FlowJo parity validation on ≥2 reference FCS files; checklist pass before shipping hierarchy. See **`docs/GATING_HIERARCHY_SPRINTS.md` §7**.

### B. Optional hardening (from caveats doc)

- **`docs/SPRINT1_CAVEATS_AND_BUGS.md`:** Consider implementing: (1) validate `parent_gate_id` on create, (2) return 404 when DELETE gate not found (S2-2), (3) single DELETE for clearGates (S2-3 if not already done), (4) cycle detection in `_get_mask`, (5) remove redundant pop in eviction.

### B1. Backend bugfix sprint (2026‑03‑09) — from backend review

- **Fix BUG‑3:** Validate `parent_gate_id` in `create_gate` (must exist and belong to the same file) to prevent orphaned gates.
- **Fix BUG‑1 / BUG‑2:** Clean up stats: stop re-calling `_get_mask(parent)` in `_compute_stats`; replace fragile `or 0` cache reads in `_record_to_response` with explicit `is not None` checks.
- **Add ROB‑1:** Cycle detection in `_get_mask` using a `_visited` set/frozenset.
- **Tidy API semantics:** Make `DELETE /api/gates/{gate_id}` return 404 when no gates were deleted (S2‑2).
- **Unblock INT‑1:** Add `arcsinh_cofactor` and `logicle_*` to `GateResponse` and stop hardcoding `arcsinh_cofactor=150.0` in workspace save (ROB‑6 / Sprint 1 item 7).

### C. Compensation UI (high value)

- Expose `$SPILLOVER` in file metadata; "Load from file" / "Use file spillover"; "Reset compensation" button; optional table editor or raw vs compensated comparison. See **NEXT_STEPS.md §1** below.

### D. Workspace & persistence (full session save/load)

- Backend workspace schema and save/load endpoints; frontend Save/Load workspace UI. See **NEXT_STEPS.md §3**.

### E. Tests & packaging

- Backend: at least one non-skipped FCS test; frontend: Vitest smoke tests. Then packaging (electron-builder, embedded backend) for distributable build. See **NEXT_STEPS.md §4–5**.

---

## 0. A-4 remaining (error handling)

**Goal:** Formalise frontend error handling so it doesn’t get forgotten.

**Current state:** Backend returns structured errors; `App.tsx` shows `fcsError` above the plot. No dedicated `useEvents` hook or React error boundary.

**Deliverables**
- Extract events-fetch logic into a `useEvents`-style hook that returns `{ points, error, loading }` and surfaces API errors consistently.
- Add a simple error boundary around the plot (or main content) so a render crash doesn’t blank the whole app.

**Definition of done:** One place responsible for events + error state; one error boundary in place. Can be done as part of item 2 (Gating MVP) when touching the plot/renderer, or as a small standalone task.

---

## 1. Compensation UI (recommended first)

**Goal:** Make compensation usable without hand-pasting matrices.

**Current state**
- Backend: Compensation endpoints and raw vs compensated events are done. The only remaining backend piece for this item is **1a** (expose `$SPILLOVER` and channel order in file metadata).
- Frontend: textarea for matrix (CSV-style) + “Apply compensation” button; no load from file, no reset, no pre/post comparison.

**Deliverables**
- **1a** Backend: expose `$SPILLOVER` (and channel order) in file metadata so the frontend can pre-fill the matrix when present.
- **1b** Frontend: “Load from file” (or “Use file spillover”) that fills the matrix from metadata when available.
- **1c** Frontend: “Reset compensation” button calling `DELETE /api/compensation/{file_id}` and refreshing the plot.
- **1d** Frontend (optional): simple table editor for the matrix (grid of inputs) instead of or in addition to raw text.
- **1e** Frontend (optional): toggle or side-by-side to compare raw vs compensated on the same plot (e.g. two panels or overlay).

**Definition of done:** User can load FCS → see/load spillover from file → edit if needed → apply → reset and re-apply without pasting.

---

## 2. Gating MVP

**Goal:** Define regions (gates) on a 2D plot and see event counts and percentages.

**Current state**
- Backend: no gate models or endpoints.
- Frontend: WebGL scatter plot; no drawing or gate state.

**Design decision required (before implementing 2a):** Gate vertex storage — **display space** (e.g. normalised 0–1 or pixels) vs **raw instrument units** (channel values). Recommendation: **raw instrument units**. Storing in raw units keeps gates independent of current transform/zoom, matches workspace portability and FCS conventions, and avoids recomputing when the view changes. The frontend converts to display space for drawing; the backend stores and evaluates in raw space.

**Deliverables**
- **2a** Backend: gate models (e.g. polygon, rectangle, threshold) and in-memory gate tree per file (or per plot); vertex coordinates in **raw instrument units** (see design decision above).
- **2b** Backend: endpoints e.g. `POST /api/gates` (create), `GET /api/files/{file_id}/gates`, `DELETE /api/gates/{gate_id}`; apply gates to event data and return counts and % of parent/total.
- **2c** Frontend: draw a gate on the scatter plot (start with rectangle or polygon); send vertices to backend and create gate.
- **2d** Frontend: sidebar or panel showing gate list with name, count, and %; update when gates or data change.

**Definition of done:** User can draw at least one gate type (e.g. rectangle), see gate stats, and have them persisted in memory for the session.

**B-1 validation (prerequisite for gating on transformed data):** Before building gates on top of the logicle transform, complete a one-time validation: run the same FCS file through FlowJo and FreeCyto, compare transformed percentiles to 4 decimal places, and document or fix any discrepancy. Track in this item or a short sub-bullet under 2.

---

## 3. Workspace & persistence

**Goal:** Save and reload a session (files, transforms, compensation, gates).

**Current state**
- Backend: no workspace endpoints; stable file IDs and transform scaffolding (B-2) support this.
- Frontend: no save/load UI.

**Deliverables**
- **3a** Backend: schema for workspace JSON (file list with paths/IDs, transforms, compensation matrices, gate definitions).
- **3b** Backend: `POST /api/workspace/save` (return JSON blob) and `POST /api/workspace/load` (accept JSON, reload files, restore comp/gates/transforms as far as possible).
- **3c** Frontend: “Save workspace” / “Load workspace” (e.g. via Electron dialog); serialize current state and call save; on load, send blob to backend and refresh UI.

**Definition of done:** User can save a workspace to a file and load it in a later session and continue analysis.

---

## 4. Tests

**Goal:** Reliable regression (backend + frontend).

**Current state**
- Backend: pytest placeholder and `tests/fixtures/README.md`; no real FCS tests yet. No committed corpus (FCS files from e.g. FlowRepository, reference event counts/percentiles).
- Frontend: no Vitest.

**Deliverables**
- **4a** Backend: add at least one real FCS parse test using a small fixture; optionally transform and compensation unit tests. Real corpus = FCS files (e.g. FlowRepository) + committed reference values (event counts, percentile values) and a non-skipped test (see `tests/fixtures/README.md`).
- **4b** Frontend: Vitest (or Jest) with one or two smoke tests (e.g. App renders, health check).

**Definition of done:** CI or local run of backend tests (including at least one non-skipped FCS test) and frontend tests passing.

---

## 5. Packaging

**Goal:** Distributable desktop app (installer).

**Current state:** No electron-builder config; no Python bundling.

**Deliverables**
- **5a** electron-builder config for the frontend.
- **5b** Document or script Python backend bundling (e.g. PyInstaller/conda-pack) so the desktop app can ship with an embedded API.
- **5c** Produce first installable build (e.g. Windows) for early testers.

**Definition of done:** One platform installer that runs the full app (frontend + embedded backend).

---

## Recommended order

1. **Compensation UI** – backend already there; small, high-value frontend + one metadata extension.
2. **Gating MVP** – core cytometry workflow; unblocks “real” analysis.
3. **Workspace & persistence** – makes sessions reusable; builds on gates and compensation.
4. **Tests** – can be done in parallel or after 1–3 (1–2 day scope).
5. **Packaging** – separate from tests; larger scope (1–2 weeks); depends on stable feature set.

---

## Where to log work

- **Project log:** `docs/PROJECT_LOG.md` (append dated entries for each step).
- **README:** Update “Current implementation stage” and “Next planned steps” as you complete items.
