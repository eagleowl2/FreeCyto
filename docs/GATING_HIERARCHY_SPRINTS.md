# Hierarchical Gating — Implementation Sprints

**Source:** `FreeCyto_GatingHierarchy_Plan.pdf` (March 2026)  
**Goal:** Full FlowJo-equivalent gate tree, backend mask engine, frontend tree UI, workspace persistence.

---

## Prerequisites (already done)

From the Gating Review, the following must be resolved before starting; they are **done** in the current codebase:

- **C-1, C-2:** SVG/capture-div scaling and padding (coordinates correct).
- **S-1:** Full-event evaluation (no downsampled gating).

---

## 1. FlowJo mental model (target behaviour)

- One **gate tree** per file; implicit root = "All Events".
- Every gate is a **node**; **parent** defines input population (evaluate only on events inside parent).
- **% of Parent** = count / parent.count × 100; **% of Total** = count / root.count × 100; both always reported.
- **Cascade delete:** deleting a parent removes all descendants.
- **Re-evaluate** a gate invalidates all descendant caches.
- **Order** within a parent is stable (defines panel order).
- **Boolean mask** per gate: length = n_total; True = event inside this gate’s population; project from parent subset back to full index space.

---

## 2. Sprint overview

| Sprint | Steps | Deliverable | Est. |
|--------|--------|-------------|------|
| **Sprint 1** | BE-1, BE-2, BE-3 | Tree store + hierarchical mask engine; POST accepts parent; evaluation correct | 1.5 days |
| **Sprint 2** | BE-4, FE-1 | New API endpoints; frontend types; flat UI still works, tree data available | 1.0 day |
| **Sprint 3** | FE-2, FE-3 | Gate tree panel; click node → refetch plot; new gates get parent_gate_id; breadcrumb | 1.5 days |
| **Sprint 4** | FE-4, INT-1 | Overlays filtered to active population; workspace save/load preserves hierarchy | 1.0 day |
| **Sprint 5** | INT-2 | FlowJo parity validation on ≥2 reference FCS files; checklist pass | 0.5 day |

**Total:** ~5.5 days. Do not ship hierarchy until Sprint 5 (INT-2) passes.

---

## 3. Sprint 1 — Backend: data model, tree store, mask engine

**Steps:** BE-1, BE-2, BE-3. **Status:** Completed 2026-03-04 (see `docs/PROJECT_LOG.md`).

### BE-1 — Extend data model

**Files:** `backend/services/gates.py` (GateRecord), `backend/models/gate_models.py` (GateCreateRequest, GateResponse).

- **GateRecord:** Add `parent_gate_id: str | None`, `order: int = 0`; add logicle params `logicle_T`, `logicle_W`, `logicle_M`, `logicle_A`; add cache fields `_mask`, `_mask_valid` (no repr/eq/serialise).
- **GateCreateRequest:** Add `parent_gate_id`, `order`, logicle params.
- **GateResponse:** Add `parent_gate_id`, `depth`, `order`, `pct_of_parent`, `pct_of_total`, `parent_count`, `children: list[GateResponse]`. Keep `pct_total` as alias of `pct_of_total` during FE transition.

### BE-2 — Tree store

**File:** `backend/services/gates.py`.

- **Replace** `_gates_by_file_id: dict[str, list[str]]` with:
  - `_root_children: dict[str, list[str]]` (file_id → root-level gate IDs),
  - `_children: dict[str, list[str]]` (gate_id → child gate IDs).
- **Keep** `_gates_by_id`.
- **Add:** `_get_parent_list(rec)`, `get_descendants(gate_id)`, `topological_order(file_id)`.
- **create_gate:** Insert into parent’s sibling list by `order`; renumber sibling `order` after insert.

### BE-3 — Hierarchical mask engine

**File:** `backend/services/gates.py`.

- **Replace** current `_evaluate_gate` with:
  - **`_get_mask(rec, events)`:** Recursive; resolve parent mask → transform channels → test geometry on parent subset → project back to full index space → cache.
  - **`_compute_stats(rec, events)`:** count, pct_of_parent, pct_of_total, parent_count from masks.
- **Cache invalidation:** `invalidate_subtree(gate_id)`, `invalidate_file(file_id)` (e.g. on compensation change).
- **Safety:** Refuse create if computed depth > 50.

**Definition of done:** POST /api/gates with parent_gate_id works; list_gates (or internal tree walk) returns correct counts and %; tests for hierarchy and cache invalidation pass.

---

## 4. Sprint 2 — Backend API + frontend types

**Steps:** BE-4, FE-1. **Status:** Completed 2026-03-04 (see `docs/PROJECT_LOG.md`).

### BE-4 — API: cascade delete, tree response, population events

**Files:** `backend/services/gates.py`, `backend/routers/gates.py`.

- **delete_gate(gate_id):** Delete gate + all descendants; remove from parent’s child list; return `deleted_ids: list[str]`.
- **get_gate_tree(file_id):** Return nested `list[GateResponse]` (root-level nodes, each with `children` filled); use `_get_mask` + `_compute_stats`; build recursively.
- **GET /api/files/{file_id}/gates:** Return tree from `get_gate_tree` (replace flat list).
- **GET /api/gates/{gate_id}/events:** New endpoint — events inside gate population (mask → subset → downsample/transform like files/events); params: x_channel, y_channel, transform_x, transform_y, max_events.
- **DELETE /api/files/{file_id}/gates:** New — clear all gates for file (e.g. on compensation reset or re-load).

### FE-1 — Frontend type system

**New file:** `frontend/src/types/gates.ts`.

- **GateNode:** id, file_id, name, type, parent_gate_id, depth, order, x_channel, y_channel, transforms, bounds/vertices, count, pct_of_parent, pct_of_total, parent_count, **children: GateNode[]**.
- **Utilities:** `flattenTree(nodes)`, `findNode(nodes, id)`, `breadcrumb(nodes, id)`.

**App.tsx:** Remove inline Gate type; use `gateTree: GateNode[]`, set from GET /api/files/{id}/gates (nested). Keep current flat UI rendering for now (e.g. flatten tree for list) so app still works.

**Definition of done:** New endpoints deployed; frontend uses GateNode and tree response; existing flat gate list still displays (e.g. from flattened tree).

---

## 5. Sprint 3 — Gate tree panel + active population

**Steps:** FE-2, FE-3.

### FE-2 — Gate tree panel component

**New file:** `frontend/src/components/GateTreePanel.tsx`.

- **Props:** tree, totalEvents, activeGateId, onSelectGate, onDeleteGate, onCreateChild.
- **Root row:** "All Events" + total count; selectable; "+ gate" creates child of root; non-deletable.
- **GateTreeNode (recursive):** Indent by depth; chevron collapse/expand; icon by type; name; count (pct_of_parent); "+" (create child), "✕" (delete). Delete with children → inline confirmation popover.
- **Replace** current flat gate list in App with `<GateTreePanel ... />`.

### FE-3 — Active gate state and plot

**File:** `frontend/src/App.tsx`.

- **State:** `activeGateId: string | null` (null = All Events).
- **Events fetch:** When file, activeGateId, x/y channel, transforms change:
  - If `activeGateId === null` → GET /api/files/{file_id}/events (existing).
  - Else → GET /api/gates/{activeGateId}/events?...
- **Create gate:** Every POST /api/gates includes `parent_gate_id: activeGateId`.
- **Breadcrumb:** Show above plot: "All Events (N)" or "All Events > Singlets > Lymphocytes (M)".
- **On file change:** Reset activeGateId to null; refetch gate tree.

**Definition of done:** Tree panel visible; clicking a node refetches plot for that population; new gates created under selected node; breadcrumb shows current population.

---

## 6. Sprint 4 — Overlays + workspace

**Steps:** FE-4, INT-1.

### FE-4 — Gate overlays filtered by active population

**File:** `frontend/src/App.tsx`.

- **visibleGates:** `flattenTree(gateTree).filter(g => g.parent_gate_id === activeGateId && g.x_channel === xChannel && g.y_channel === yChannel)`.
- **SVG overlays:** Use `visibleGates` instead of all gates; same coordinate conversion as now.

### INT-1 — Workspace persistence for hierarchy

**Files:** `backend/models/workspace_models.py`, `backend/services/workspace_service.py`.

- **WorkspaceGateDef:** Add parent_gate_id, order, logicle_T/W/M/A.
- **Save:** Include parent_gate_id and order in saved gates.
- **Load:** Topological sort by depth (parent before child); create gates in order; maintain **id_map** (old_id → new_id); set parent_gate_id from id_map. Gate IDs are not stable across reload.

**Definition of done:** Overlays only show gates that are direct children of active node on current axes; workspace save/load preserves full hierarchy and counts after reload.

---

## 7. Sprint 5 — FlowJo parity validation

**Step:** INT-2.

- Use ≥2 reference FCS files (e.g. FlowRepository) with known FlowJo .wsp.
- Recreate same gate geometry in FreeCyto; compare event count (0 tolerance) and % of parent (<0.01%).
- Save workspace → reload → recompare (identical counts).
- Cascade delete: delete mid-level gate → all descendants gone from tree and API.
- Click each node → plot updates within ~300 ms.

**Definition of done:** All checklist items pass; do not ship hierarchy until this sprint is complete.

---

## 8. Dependency order

- BE-1 → BE-2 → BE-3 → BE-4 (sequential).
- FE-1 can run in parallel with BE-1..BE-4.
- FE-2, FE-3 require FE-1 and BE-4.
- FE-4 requires FE-3.
- INT-1 requires BE-4 (and FE types); can overlap with FE-2/FE-3/FE-4.
- INT-2 after all above.

---

## 9. Files changed (summary)

| File | Change | Sprint |
|------|--------|--------|
| backend/services/gates.py | Tree store, mask engine, cascade delete, get_gate_tree | 1–2 |
| backend/models/gate_models.py | parent_gate_id, order, depth, children, pct_*, logicle | 1 |
| backend/routers/gates.py | Tree response, GET gate events, DELETE file gates | 2 |
| backend/models/workspace_models.py | parent_gate_id, order, logicle on WorkspaceGateDef | 4 |
| backend/services/workspace_service.py | Topological load, id_map remap | 4 |
| frontend/src/types/gates.ts | **New** — GateNode, flattenTree, findNode, breadcrumb | 2 |
| frontend/src/components/GateTreePanel.tsx | **New** — collapsible tree panel | 3 |
| frontend/src/App.tsx | activeGateId, events URL, create payload, overlay filter, breadcrumb | 3–4 |
| tests (e.g. test_gates.py) | Hierarchy, cascade delete, workspace round-trip | 1–5 |

---

## 10. Logging

Log each sprint in **`docs/PROJECT_LOG.md`** (e.g. "Sprint 1 — Hierarchical gating: BE-1, BE-2, BE-3") and update this document when steps are completed or deferred.
