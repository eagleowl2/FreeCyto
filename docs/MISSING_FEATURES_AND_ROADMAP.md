# FreeCyto — Missing FlowJo Features & Future Roadmap

**Last updated:** 2026-04-27  
**Status:** MVP with hierarchical gates, compensation, workspace save/load complete. Phase H planned.

---

## Table of contents

1. [Major missing features](#major-missing-features) — what users will immediately notice
2. [Core workflow gaps](#core-workflow-gaps) — what blocks real analysis
3. [Advanced gate types](#advanced-gate-types) — shapes needed for scientific workflows
4. [UX/interaction features](#uxinteraction-features) — moveable gates, undo/redo, layout
5. [Data model extensions](#data-model-extensions) — groups, templates, derived parameters
6. [Recommended roadmap (Phase H onwards)](#recommended-roadmap-phase-h-onwards) — prioritized
7. [Technical prerequisites](#technical-prerequisites) — refactors before adding features

---

## Major missing features

### 1. **Moveable / editable gates** ⭐ (HIGH PRIORITY)

**What it is:** After drawing a gate, user can:
- Click and drag a gate corner/vertex to resize
- Click and drag the entire gate to move it
- Edit gate bounds numerically (e.g. in a sidebar "X min: 5000, X max: 50000")
- Right-click to "Define from events" or "Snap to percentile"

**Why users want it:** In FlowJo, gating is iterative. You draw an approximate gate, look at the count/%, realize you're 2% off, then tweak the bounds by 5 pixels. Without moveable gates, users have to delete and redraw.

**Current state:** Gates are draw-once; no editing. Gate coordinates are stored in transformed space (log/arcsinh/logicle); moving requires live coordinate transforms.

**Implementation sketch:**
- Backend: extend `GateRecord` with `is_locked: bool` flag; add `PATCH /api/gates/{gate_id}` to update vertices/bounds/logicle_params.
- Frontend: on gate-overlay click, enter "edit mode" (overlay turns golden); listen to mouse drag; send PATCH; re-fetch plot and tree.
- Test: draw gate → click corner → drag 50 pixels → confirm count changed by expected delta; gate not renamed.

**Estimated effort:** 2–3 days (coordinate transform on move is the main complexity).

### 2. **Undo / redo** (HIGH PRIORITY)

**What it is:** User draws a gate, realizes it's wrong, presses Ctrl+Z to undo gate creation. Can redo. Typical stack depth: last 20 actions.

**Why users want it:** Standard desktop affordance; flow analysis is iterative (draw 10 gates, delete 3, redraw 2). Undo costs nothing in paper-and-pen flow analysis and everything in software.

**Current state:** No undo; deleting a gate is final (only in-memory, no workspace save required to "commit" the delete).

**Implementation sketch:**
- Backend: add `ActionLog` service storing events like `{ "created_gate": gate_id }`, `{ "deleted_gate": gate_id, "definition": {...} }`, `{ "updated_gate": gate_id, "old": {...}, "new": {...} }`.
- Frontend: maintain a `currentAction` index; on Ctrl+Z, emit `POST /api/workspace/undo` (or internal index-shift + refetch tree).
- Persistence: store undo stack in workspace JSON under `"undo_stack": [...]` (capped at 20–50 items); on load, restore stack.
- Test: create gate A, create gate B, undo → only A; redo → A + B; undo undo undo → empty tree.

**Estimated effort:** 2–3 days (event log + replay is standard; state recovery is the variable).

### 3. **Multiple files / sample group view** (MEDIUM PRIORITY)

**What it is:** User loads a 96-well plate (96 FCS files) and sees a grid showing one parameter per well (e.g. "% CD4+ of lymphocytes"). Can click a well to drill down into that sample's gate tree.

**Why users want it:** Most flow work is plate-based or multi-replicate. Currently, users can load 10 files but can only plot one at a time. FlowJo's "Sample Table" view is its most-used feature.

**Current state:** File browser loads N files, but plot is always 1 file. No grid / multi-file view.

**Implementation sketch:**
- Data model: add `Sample` and `Group` entities (see §5 below).
- Backend: `GET /api/groups/{group_id}/statistics?stat=pct_of_parent&population=CD4+` returns a 96-element array of floats (one per sample).
- Frontend: add a "Grid" / "Sample Table" view as an alternative to the scatter plot. Each cell = one statistic. Click to open that sample in the plot view.
- Test: load 10 samples, apply gates to all, grid shows 10 distinct counts/%.

**Estimated effort:** 4–5 days (requires Group model refactor; see §5).

### 4. **Quad gates** (MEDIUM PRIORITY)

**What it is:** A 4-quadrant gate dividing a 2D plot into (X+/X−) × (Y+/Y−) populations. Very common in immunology (CD4 vs CD8 quadrants).

**Why users want it:** Standard immunology gating. "CD4+ (BL1+BL2+)" is a quad gate on CD4 vs CD3.

**Current state:** Rectangle and polygon gates only. Quad gates can be approximated as 4 rectangle gates but are awkward.

**Implementation sketch:**
- Backend: add `gate_type: "quad"` to `GateRecord`; store thresholds as `quad_x_threshold` and `quad_y_threshold` (floats in raw space). Mask evaluation: `(x > thresh_x) AND (y > thresh_y)` for each quadrant.
- Frontend: in draw mode, if user clicks same starting pixel again (or Shift+click), switch to quad mode. Draw crosshairs at cursor; accept second click to set quadrant thresholds.
- Test: draw quad on CD4 vs CD3, confirm 4 child gates created (one per quadrant) with correct masks.

**Estimated effort:** 1–2 days (straightforward; minimal geometric complexity).

---

## Core workflow gaps

### 5. **Compensation matrix editor** (HIGH PRIORITY)

**What it is:** UI to load spillover matrix from file metadata, visualize as a table (channels × channels), edit cells, preview raw vs compensated events side-by-side.

**Why users want it:** Current UI is a textarea with CSV-like text. Hard to see typos; no preview. FlowJo shows a table and live preview.

**Current state:** Backend exposes `$SPILLOVER` in file metadata. Frontend has textarea + Apply/Reset buttons. No table editor; no side-by-side preview.

**Implementation sketch:**
- Frontend: add a "Compensation" tab (or modal) with:
  - **Table editor:** `channels.length × channels.length` grid of text inputs; load/save from file metadata.
  - **Condition number badge:** fetch from `GET /api/compensation/status/{file_id}`, display as green (cond < 50) / yellow (50–100) / red (>100).
  - **Preview toggle:** two scatter plots side-by-side, raw vs compensated events, same axis/transform; or overlay with color coding.
  - **Apply / Reset buttons:** existing.
- Test: load file with spillover, edit one cell, preview updates, apply.

**Estimated effort:** 1–2 days (table is straightforward; preview requires a second plot refetch).

### 6. **1-D gates / histograms** (MEDIUM PRIORITY)

**What it is:** User selects one channel (e.g. FSC-A) and draws a gate on a 1-D histogram, setting X min/max (Y is implicit: all events).

**Why users want it:** Quick filtering. "FSC-A between 5k and 250k" (singlets gate) is easiest as a 1-D threshold, not a rectangle on two channels.

**Current state:** All gates are 2-D (X × Y channels). No 1-D histogram view.

**Implementation sketch:**
- Frontend: add "Histogram" view mode (toggle alongside Scatter/Density). Select one channel; render a bin'd histogram (e.g. 100 bins); user can click-drag on the X axis to set a range gate.
- Backend: `gate_type: "interval"` with `x_channel`, `x_min`, `x_max`, no `y_channel`. Mask evaluation: `(raw_x >= x_min) AND (raw_x <= x_max)`.
- Test: draw 1-D gate on FSC-A, confirm count is subset of parent; switch to scatter plot, overlay the interval gate as a vertical strip.

**Estimated effort:** 1.5–2 days (histogram rendering is new; interval gate is simple).

### 7. **Per-sample statistics / batch export** (MEDIUM PRIORITY)

**What it is:** User selects multiple samples (group) and a set of populations (gates) and exports a table: rows = samples, columns = populations, cells = count/MFI/CV%. Can export to CSV or Excel with optional formatting.

**Why users want it:** The entire point of plate-based experiments. Users want "% CD4+ of lymphocytes" for all 96 wells in one table.

**Current state:** Per-gate stats are exported one sample at a time. No group/batch view.

**Implementation sketch:**
- Data model: add `Group` (bag of samples + metadata) — see §5.
- Backend: `GET /api/groups/{group_id}/batch-stats?populations=CD4+,CD8+,Tregs&statistic=pct_of_parent` returns a 2-D array (samples × populations).
- Frontend: add a "Batch export" panel. Select samples; select gates; select statistics (count, %, MFI, median, CV%); render table; export to CSV/Excel.
- Test: load 10 samples; apply gates; export batch table; verify 10 rows, N columns match requested populations.

**Estimated effort:** 2–3 days (Group model is a prerequisite; see §5).

---

## Advanced gate types

### 8. **Ellipse / polygon transformation gates** (LOW PRIORITY)

**What it is:** User draws an ellipse (by center + semi-major/semi-minor axes) or an arbitrary polygon, gate behaves as before.

**Why users want it:** Cleanup gates (CD4/CD8 populations after CD3 doublet filtering often are rotated; ellipse is faster than polygon). Less common than quad/rect.

**Current state:** Polygon and rectangle only. Polygon is flexible but slow for 200k+ events.

**Implementation sketch:**
- Backend: add `gate_type: "ellipse"` with center (x_c, y_c) and semi-axes (a, b) and rotation angle θ. Mask = `((x - x_c) * cos θ + (y - y_c) * sin θ)^2 / a^2 + ((x - x_c) * (−sin θ) + (y − y_c) * cos θ)^2 / b^2 ≤ 1`. Use NumPy broadcasting for speed.
- Frontend: in draw mode, shift-click for ellipse mode. First click = center; second click = dragged to semi-major end; third click = rotates semi-minor.
- Test: draw ellipse, confirm count < rectangle enclosing it.

**Estimated effort:** 1.5–2 days (math is simple; frontend interaction is the variable).

### 9. **Boolean gates** (LOW PRIORITY)

**What it is:** User combines existing gates with AND/OR/NOT. E.g., `(CD4+) AND NOT (activated)` = naïve CD4 T cells.

**Why users want it:** Powerful population definition language; avoids 10 nested rectangle gates. Less common in live gating (more in post-hoc analysis).

**Current state:** No boolean gates. Users have to manually create combined rectangles.

**Implementation sketch:**
- Backend: add `gate_type: "boolean"` with `expression: str` (e.g. `"G1 AND NOT G2"`) parsing to an AST of gate IDs and operators. Mask = evaluate AST by fetching submasks from cache.
- Test: `(Singlets AND CD3+)` should be subset of both parent gates.

**Estimated effort:** 1–2 days (parsing and evaluation are standard; main complexity is UX for editing expressions).

### 10. **Time gates / QC filtering** (LOW PRIORITY)

**What it is:** Some instruments emit an event-time parameter. User gates on Time (e.g. "Time between 100–500 sec") to exclude initial warmup and final shutdown.

**Why users want it:** Standard QC for experiments running >30 min. Prevents temperature drift artifacts.

**Current state:** No special handling for time. Could be gated as a normal 1-D interval gate if the instrument emits a Time channel (which not all do).

**Implementation sketch:** Same as 1-D gates. If no Time channel in metadata, this is user error (FCS file missing it). No special code needed.

**Estimated effort:** 0 days (covered by 1-D gates; §6).

---

## UX/interaction features

### 11. **Keyboard shortcuts** (MEDIUM PRIORITY)

**What it is:** Ctrl+Z = undo, Ctrl+Y = redo, Ctrl+S = save workspace, Delete = delete active gate, etc.

**Why users want it:** Power users expect desktop affordances. FlowJo keyboard bindings are deeply ingrained.

**Current state:** No keyboard bindings beyond browser defaults.

**Implementation sketch:**
- Frontend: use `useEffect` + `addEventListener("keydown", ...)` to capture Ctrl+Z, Ctrl+S, Delete, etc.
- Send API calls or update local state based on key.
- Test: press Ctrl+Z, undo happens; press Ctrl+S, no error.

**Estimated effort:** 0.5–1 day (low complexity; mostly gluing to existing API).

### 12. **Population statistics panel improvements** (LOW PRIORITY)

**What it is:** Current panel shows per-channel stats for one gate. Expand to:
- Compare two populations (side-by-side MFI, p-value by t-test?)
- Show statistics for all children of active gate (summary table)
- Frequency-of-parent, frequency-of-root (not just counts)

**Why users want it:** Faster comparison workflows.

**Current state:** Single-gate per-channel stats only.

**Implementation sketch:**
- Backend: extend `GET /api/gates/{gate_id}/stats` to optionally return sibling stats, or add `GET /api/gates/{gate_id}/siblings-stats`.
- Frontend: show active gate stats + mini-table of children's counts/%.
- Test: select parent gate, stats panel shows children statistics.

**Estimated effort:** 1–1.5 days (mostly UI work; backend is straightforward).

### 13. **Threshold dragging on the plot** (MEDIUM PRIORITY)

**What it is:** User draws a 1-D interval gate (see §6) as a threshold line on the scatter plot. Can drag the left/right edge to adjust min/max visually.

**Why users want it:** Faster than editing numeric bounds; visual feedback.

**Current state:** No 1-D gates; can't drag thresholds.

**Implementation sketch:**
- Once 1-D gates are implemented, add an SVG overlay of two vertical lines (or a shaded band) representing the interval.
- Mouse down on edge → drag → calls PATCH to update gate bounds.
- Test: drag interval gate boundary, count updates.

**Estimated effort:** 1 day (requires interval gates first; interaction is straightforward).

---

## Data model extensions

### 14. **Sample Groups & Gating Templates** ⭐ (ARCHITECTURAL, HIGH PRIORITY)

**What it is:** Introduce first-class entities:
- **Sample:** a single FCS file + metadata (e.g. well ID "A01", replicate 1, tissue type)
- **Group:** a named collection of samples that should share a gating template
- **GatingTemplate:** a reusable gate tree definition; when applied to a group, gates are "seeded" on each sample and can be individually overridden

**Why users want it:** Every multi-sample experiment uses this model. "Plate reader" workflows mean 96 samples with the same 20-gate hierarchy. Without this, users have to copy-paste gate definitions across samples (error-prone).

**Current state:** Files are loaded independently; gates are per-file. No group, no template.

**Implementation sketch:**
- Backend models:
  ```python
  Sample(id, path, file_id, group_id, metadata: dict)  # well, rep, tissue, etc.
  Group(id, name, samples: list[Sample], gating_template_id?)
  GatingTemplate(id, name, root_gates: list[Gate])  # gates without file binding
  ```
- Backend API:
  - `POST /api/groups` — create group, list samples
  - `POST /api/groups/{gid}/apply-template` — seed gates on all samples from template
  - `GET /api/groups/{gid}/statistics` — aggregate stats across group
- Frontend: "Load sample group" button → file picker for multiple FCS → create group → apply template → sample table view.

**Estimated effort:** 4–5 days (requires schema + API + frontend redesign; see recommendation in ARCHITECTURE_REVIEW).

**Blocking:** This is **prerequisite for multi-sample workflows**. Build this before adding more gate types or you'll have to refactor later.

### 15. **Derived / virtual parameters** (LOW PRIORITY)

**What it is:** User defines a formula-based parameter (e.g. `"log10(FL1-A / FL2-A)"` = CD4/CD8 ratio) and can gate on it.

**Why users want it:** Common in CyTOF workflows (mass-metal ratios). Immunology sometimes uses ratios.

**Current state:** Not implemented. Parameters are read directly from FCS or derived via compensation.

**Implementation sketch:**
- Backend: add `DerivedParameter(name, expression: str, derivation_strategy: "formula" | "compensation")`. Evaluate `expression` on all events in a population; return as an array.
- Frontend: in channel dropdown, add "Derived parameters..." button → modal to define formula; add to dropdown.
- Test: define ratio parameter, gate on it.

**Estimated effort:** 2–3 days (expression parser is the variable; NumPy evaluation is straightforward).

### 16. **Population naming / alias scheme** (LOW PRIORITY)

**What it is:** Allow users to define naming conventions (e.g. `"CD{count}+"` = gates with >count in name are T cells). Use these to color-code populations, group in summaries, etc.

**Why users want it:** Standard immunology convention. Helps with big gate trees (>50 gates).

**Current state:** Gate names are free text; no semantic meaning.

**Implementation sketch:**
- Backend: add `PopulationAlias(pattern: str, population_type: enum)` where pattern is a regex and type is "T cell", "B cell", etc.
- Frontend: on gate tree, color-code by population type (green = T cell, blue = B cell, etc.).
- Test: define alias; create gates matching pattern; they color-code correctly.

**Estimated effort:** 1.5–2 days (mostly UI; pattern matching is simple).

---

## Recommended roadmap (Phase H onwards)

### Phase H — Moveable gates + undo/redo (1 week)

**Deliverables:**
- Editable gate bounds (drag corners, numeric input)
- Undo/redo stack (Ctrl+Z/Ctrl+Y)
- Persistent undo stack in workspace JSON
- Tests: drag gate, undo/redo all actions

**Blocking:** None. Builds on current architecture.

**When:** Immediately after Phase G (statistics panel).

---

### Phase I — Quad gates + 1-D histogram / interval gates (4–5 days)

**Deliverables:**
- Quad gate drawing + 4-child gate creation
- 1-D histogram view (single channel)
- Interval gate drawing on histogram
- Tests: quad gate counts; interval gate as subset of parent

**Blocking:** None for quad/1-D independently; Phase H recommended first for momentum.

**When:** Weeks 3–4 of development.

---

### Phase J — Compensation UI improvements + time-domain filtering (2–3 days)

**Deliverables:**
- Spillover matrix table editor
- Condition number badge / warning
- Raw vs compensated side-by-side preview
- Time parameter auto-detection (if present in FCS)

**Blocking:** None.

**When:** Week 4; low-risk high-value feature.

---

### Phase K — Sample groups + gating templates (1 week, CRITICAL)

**Deliverables:**
- `Sample`, `Group`, `GatingTemplate` models in backend
- API for group CRUD and template application
- "Load sample group" dialog in frontend
- Sample table view showing aggregate statistics
- Batch statistics export (CSV/Excel)

**Blocking:** Prerequisite for all multi-sample features. Must do before scaling to plate workflows.

**When:** Week 5; plan 1 week of work including refactor.

**Architectural impact:** Requires frontend state refactor (Zustand store — see ARCHITECTURE_REVIEW §3.2).

---

### Phase L — Boolean gates + derived parameters (4–5 days)

**Deliverables:**
- Boolean gate definition (AND/OR/NOT expression editor)
- Formula-based derived parameter editor
- Both gatable like normal populations
- Tests: boolean mask correctness; derived param values

**Blocking:** Sample groups recommended first (changes gate model).

**When:** Weeks 6–7.

---

### Phase M — Ellipse gates + advanced polygons (2–3 days)

**Deliverables:**
- Ellipse gate drawing (center + axes + rotation)
- Polygon improvements (snapping, Bezier curves?, convexity hint)
- Tests: ellipse mask; polygon subset properties

**Blocking:** None; polish feature.

**When:** Week 8 (lower priority; can defer).

---

### Phase N — Keyboard shortcuts + usability polish (1.5–2 days)

**Deliverables:**
- Ctrl+Z, Ctrl+Y, Ctrl+S, Ctrl+N, Delete bindings
- Right-click context menu on gates (delete, duplicate, lock, rename)
- Drag gate outline to move entire gate (not just corners)
- Tests: all shortcuts

**Blocking:** None; UX polish.

**When:** Week 8–9 (in parallel with Phase M).

---

### Phase O — Data export + report generation (3–4 days)

**Deliverables:**
- Export entire workspace to FlowJo .wsp format (stretch goal; may not be 1:1)
- Or: export all gate definitions as JSON schema
- Generate a simple HTML report (gate tree, all statistics, one sample plot per sample)
- Batch export (all samples, all gates, all stats to Excel with formatting)

**Blocking:** None; downstream of Phase K (batch stats).

**When:** Week 9–10.

---

### Phase P — Packaging + distribution (1.5–2 weeks)

**Deliverables:**
- electron-builder configuration for Windows/macOS/Linux
- Python backend bundling (PyInstaller or `python-build-standalone`)
- First installer build (test on clean machine)
- Code signing (for Windows SmartScreen) if targeting external users
- Auto-update framework setup (optional)

**Blocking:** Feature set must be stable before shipping installer.

**When:** Week 10–11 (parallel with Phase O).

---

### Phase Q — Telemetry, crash reporting, docs (1 week)

**Deliverables:**
- Structured error logging to `~/.freecyto/logs/`
- Optional telemetry / crash reporter (Sentry or similar)
- User documentation (PDF or web): gating workflow, shortcuts, batch analysis
- API documentation (for third-party tools / future plugin system)

**Blocking:** After Phase P (packaging).

**When:** Week 11–12.

---

## Technical prerequisites

Before starting Phase H, ensure:

1. **Frontend refactor (1–2 days):** Extract App.tsx state into Zustand store; split into feature components. See ARCHITECTURE_REVIEW §3.2. **Rationale:** App.tsx will exceed 4,000 LOC by Phase J without this; undo/redo state becomes unmaintainable.

2. **SQLite migration (optional but recommended for Phase K):** Migrate workspace JSON to SQLite database. See ARCHITECTURE_REVIEW §4.3. **Rationale:** By Phase K (100+ gates × 96 samples), JSON auto-save becomes O(seconds); SQLite is O(ms). **When:** Start Phase K or earlier if Phase G users report slowness.

3. **Test coverage expansion:** Aim for >80% backend coverage + >50% frontend coverage before Phase H. Current: ~80% backend, <20% frontend.

---

## Feature priority matrix

| Feature | Priority | Effort | Impact | Phase |
|---------|----------|--------|--------|-------|
| Moveable gates | HIGH | 2–3d | Essential | H |
| Undo/redo | HIGH | 2–3d | Essential | H |
| Sample groups | HIGH | 4–5d | Unlocks multi-sample | K |
| Quad gates | MEDIUM | 1–2d | Common workflow | I |
| 1-D gates / histogram | MEDIUM | 1.5–2d | Common workflow | I |
| Comp UI improve | MEDIUM | 1–2d | Usability | J |
| Batch stats / export | MEDIUM | 2–3d | Common need | K |
| Boolean gates | LOW | 1–2d | Power users | L |
| Derived parameters | LOW | 2–3d | Special cases | L |
| Ellipse gates | LOW | 1.5–2d | Polish | M |
| Keyboard shortcuts | LOW | 0.5–1d | Usability | N |
| Threshold dragging | LOW | 1d | UX polish | N |
| Packaging | HIGH | 1.5–2w | Distribution | P |

---

## Known limitations (not planned)

- **Import .wsp files from FlowJo:** Complex parser (100+ gate types, legacy formats). Recommend: export from FlowJo as XML → script to parse. Low ROI.
- **Live plotting during gating:** Would require streaming masks; slow for 100k events. Current downsampling + refetch is acceptable.
- **Spectral unmixing / deconvolution:** Specialist CyTOF feature. Out of scope for general flow analysis.
- **Non-rectangular coordinate systems:** Polar, log-polar gating. Not standard; defer.

---

## Conclusion

FreeCyto has a strong MVP foundation. The next critical step (Phase K — sample groups) unlocks multi-sample workflows and is **prerequisite** for reaching FlowJo feature parity. Phases H–J are lower-risk morale-boosters (moveable gates, undo, better compensation UI); do these first to build confidence, then tackle the architectural work in Phase K.

Estimated timeline to FlowJo feature parity: **10–12 weeks** of full-time development (Phases H–O + refactors). Packaging (Phase P) is parallel and can begin earlier.
