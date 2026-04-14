# Gating Review — Action Plan

**Source:** `FreeCyto_Gating_Review.pdf` (March 2026)  
**Scope:** Scientific rigour, reproducibility, FlowJo parity.  
**Fix order:** Critical → Science → Frontend → Architecture.

---

## 1. Issue register

| ID | Title | Category | Effort | Fix before |
|----|--------|----------|--------|------------|
| **C-1** | SVG scales responsively; capture div is fixed 480×360 — coordinates wrong when container ≠ 480px | 🔴 Critical | 2–3 h | Any user testing |
| **C-2** | Capture div offset by container padding (8px) — constant coordinate shift | 🔴 Critical | 30 min | Any user testing |
| **C-3** | drawingRect SVG preview uses un-normalised Y — live rectangle renders upside-down during drag | 🔴 Critical | 30 min | ✅ Done |
| **S-1** | Gates evaluated against downsampled events — gate count is wrong (display subset, not full file) | 🔵 Science | 2–4 h | ✅ Done |
| **S-2** | No parent gate; only pct_total — no % of parent, no hierarchical gating | 🔵 Science | 1 day | ✅ Done |
| **S-3** | Transform mismatch: dataRange is transformed space; changing transform silently invalidates gates | 🔵 Science | 2–3 h | ✅ Done |
| **S-4** | Ray-casting has degenerate-edge flaw — boundary events may be miscounted (use winding-number) | 🔵 Science | 2 h | ✅ Done |
| **S-5** | Gate ID is 8 hex chars of UUID — collision risk in large sessions | 🔵 Science | 15 min | ✅ Done |
| **F-1** | Docstrings say "raw units" but coordinates are transformed — misleading docs | 🟡 Frontend | 1 h | ✅ Done |
| **F-2** | list_gates() re-evaluates every gate on every call — O(N×M), slow with many gates | 🟡 Frontend | 3–4 h | ✅ Done |
| **F-3** | No gate name validation — empty/duplicate names allowed (e.g. multiple "Gate", Q1–Q4 twice) | 🟡 Frontend | 1–2 h | ✅ Done |
| **A-1** | Gates not cleared when file is evicted from LRU cache — 500 on list_gates after eviction | 🟠 Arch | 1–2 h | ✅ Done |
| **A-2** | GateCreateRequest uses flat optional fields — no type discrimination; 500 instead of 400 on bad payload | 🟠 Arch | 2–3 h | ✅ Done |

---

## 2. Recommended sprint plan

| Sprint | Issues | Goal | Est. |
|--------|--------|------|------|
| **Sprint 1 — Unblock gating** | C-1, C-2, C-3, S-5 | Coordinates correct; gates land where drawn; no ID collisions | 1 day |
| **Sprint 2 — Scientific correctness** | S-1, S-3, S-4 | Gate counts match FlowJo; boundary events correct; stale gates warned | 2–3 days |
| **Sprint 3 — Architecture** | A-1, A-2, F-1 | Eviction safe; model validated at API boundary; docs accurate | 1 day |
| **Sprint 4 — Parent gating + UX** | S-2, F-2, F-3 | Hierarchical gates; cached evaluation; no duplicate names | 2–3 days |

After Sprint 2, gate statistics can be meaningfully compared to FlowJo on the same FCS and geometry. First external scientific validation should happen then.

---

## 2.1 Sprint 2 — Goals and definition of done

**Scope:** S-1 (full-event gating), S-3 (transform/stale gates), S-4 (polygon boundary).

**Overarching goal:** Gate counts and percentages are scientifically correct and comparable to FlowJo on the same file and gate geometry; no silent misuse of downsampled data or wrong transform space.

| Goal | ID | Description | Definition of done |
|------|----|-------------|--------------------|
| **Full-event gating** | S-1 | Gates are evaluated on the full event array, not the display downsample. | (1) Storage keeps full `raw_events` / `comp_events`; downsampling only in events API. (2) Gate evaluation uses full events; assertion or check that event count matches file metadata. (3) Test: gate count on a file with 100k events is stable regardless of `max_events` used for display. |
| **Stale gates on transform change** | S-3 | Changing transform does not silently change gate counts; users are warned or gates are invalidated. | (1) `dataRange` renamed to `transformedRange` (or equivalent) and documented as “current transform space”. (2) On transform X/Y change for current file: either auto-delete gates (with toast) or mark gates stale and show warning; never re-evaluate in the new transform without user awareness. (3) Test: create gate under logicle → switch to arcsinh → gate either shows stale warning / is removed or counts are not silently different. |
| **Polygon boundary = inside** | S-4 | Points on polygon edges are counted as inside (GatingML 2.0). | (1) Ray-casting replaced with winding-number (or equivalent correct) point-in-polygon; boundary explicitly “inside”. (2) No ad-hoc epsilon that flips boundary events. (3) Test: polygon with horizontal edge through median Y; count matches FlowJo (or reference implementation) within 0 events. |

**Outcome:** After Sprint 2, the app is ready for first external scientific validation: same FCS + same gates in FreeCyto and FlowJo → comparable counts and percentages (FlowJo parity checklist items 1, 2, 3, 4, 6, 7 unblocked where applicable).

**Estimated effort:** 2–3 days.

---

## 3. Action points (concrete fixes)

### Phase 1 — Critical (C-1, C-2, C-3)

- **C-1**  
  - Add a single plot container ref and `plotW` / `plotH` state driven by `ResizeObserver` on that container.  
  - Use a fixed aspect ratio (e.g. `plotH = round(plotW * 360/480)`).  
  - Use `plotW` × `plotH` for: (1) SVG `viewBox` and dimensions, (2) overlay/capture div size and position, (3) all coordinate math.  
  - Remove hardcoded `width={480}` / `height={360}` from the capture layer.

- **C-2**  
  - Move `padding: 0.5rem` to an **outer** wrapper only.  
  - Inner container (with `ref` for ResizeObserver) has no padding; all three layers (dots, SVG, capture div) share the same origin and size.

- **C-3**  
  - When rendering the live `drawingRect` in SVG, convert plot-space Y (0=bottom, 1=top) to SVG Y (0=top):  
    `y_svg = margin + (height - 2*margin) * (1 - y_plot)`.  
  - Use consistent min/max so the rect has positive width/height.

### Phase 2 — Science (S-1, S-2, S-3, S-4, S-5)

- **S-1**  
  - Ensure `FileRecord.raw_events` (and `comp_events`) always hold the **full** event array; never store a downsampled array.  
  - Downsample only in `GET /api/files/{id}/events` for display.  
  - In `_evaluate_gate`, add an assertion: `events.shape[0] == get_file_metadata(file_id).event_count`.

- **S-2**  
  - Add `parent_gate_id: str | None` to `GateRecord` and to create API.  
  - Implement parent mask resolution (recursive or iterative); evaluate gate only on events inside parent.  
  - Add `pct_of_parent` and `pct_of_total` to `GateResponse` and to the frontend gate list.

- **S-3**  
  - Rename `dataRange` → `transformedRange` and document that it is in the **current** transform space.  
  - When `transform_x` or `transform_y` changes for the current file: either auto-delete gates for that file (with toast) or mark gates stale and show a warning; do not silently re-evaluate in a different transform space.

- **S-4**  
  - Replace ray-casting with a **winding-number** point-in-polygon implementation; treat boundary as inside (GatingML 2.0).  
  - Avoid ad-hoc epsilons in divisions; use a single small epsilon only where needed for degenerate horizontal edges, and document boundary inclusion.

- **S-5**  
  - Use full UUID for gate ID: `gate_id = str(uuid.uuid4())` (no `[:8]`).  
  - If a short display label is needed, derive it from the full ID for UI only; never use the short form as the storage key.

### Phase 3 — Frontend (F-1, F-2, F-3)

- **F-1**  
  - Update `gate_models.py` and `gates.py` docstrings/comments to state that gate coordinates are in **transformed** space (same as plot axes).  
  - Optionally add `coordinate_space: Literal["transformed","raw"]` to request/record for future raw-space support.

- **F-2**  
  - Add cached `(count, pct)` (and optionally `pct_of_parent` / `pct_of_total`) on `GateRecord`.  
  - Invalidate cache when: gate created, compensation changed for file, parent gate invalidated.  
  - `list_gates()` returns cached values when valid; only run `_evaluate_gate` when cache is invalid.

- **F-3**  
  - Backend: in `create_gate()`, check gate name uniqueness per file; return 409 if duplicate.  
  - Frontend: show 409 as inline validation; for quadrant gates, auto-suffix names (e.g. Q1 (2)) or timestamp to avoid duplicates.

### Phase 4 — Architecture (A-1, A-2)

- **A-1**  
  - Add an eviction callback from `FileStore` (e.g. `register_evict_callback`).  
  - In `gates.py`, register a callback that removes all gates for the evicted `file_id` from `_gates_by_file_id` and `_gates_by_id`.  
  - After eviction, `GET /api/files/{id}/gates` should return 404 or empty list, not 500.

- **A-2**  
  - Refactor `GateCreateRequest` to use a Pydantic **discriminated union** for params (e.g. `RectangleGateCreate | PolygonGateCreate` with `discriminator='type'`).  
  - Keep common fields (file_id, name, x_channel, y_channel, transform_*) at top level; move type-specific fields into the union so validation returns 422 with a clear message for bad payloads.

---

## 4. FlowJo parity checklist (post–Sprint 2)

Use as acceptance criteria; each should become a passing pytest test where applicable.

| # | Check | Tolerance | Status |
|---|--------|------------|--------|
| 1 | Rectangle gate count on reference FCS = FlowJo count | 0 events | Blocked by S-1 |
| 2 | Polygon gate count on reference FCS = FlowJo count | 0 events | Blocked by S-1, S-4 |
| 3 | Gate count uses full event array (not display subsample) | 0 events | Open (S-1) |
| 4 | % of total matches FlowJo "% Total" column | &lt; 0.01% | Blocked by S-1 |
| 5 | % of parent matches FlowJo "% Parent" for child gates | &lt; 0.01% | Blocked by S-2 |
| 6 | Changing display transform does not silently change gate counts | Exact | Open (S-3) |
| 7 | Points on polygon boundary counted as inside | Exact | Open (S-4) |
| 8 | Logicle transform values match FlowJo to 4 decimal places | &lt; 0.0001 | B-1 validation pending |
| 9 | Compensation + gating pipeline matches FlowJo on same matrix | &lt; 0.01% | Depends on 1, 8 |
| 10 | Workspace save → load → re-evaluate gates = same counts | 0 events | Blocked by S-3 |

---

## 5. Logging

- All fixes and findings from this plan should be logged in **`docs/PROJECT_LOG.md`** under dated entries (e.g. "2026‑03‑XX – Gating review Sprint 1 (C-1, C-2, C-3, S-5)").
- After each sprint, update the issue register table above (e.g. mark issues "Done") and note any deviations or new issues discovered.
