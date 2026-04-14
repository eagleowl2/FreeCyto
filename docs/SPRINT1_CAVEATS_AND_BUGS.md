# Hierarchical gating sprints — Caveats, Dangers, Errors, Bugs

This file logs review findings for **Sprint 1** (BE-1, BE-2, BE-3), **Sprint 2** (BE-4, FE-1), and **Sprint 3** (FE-2, FE-3).

---

# Sprint 1 (Hierarchy BE-1, BE-2, BE-3)

**Reviewed:** 2026-03-04.  
**Scope:** `backend/services/gates.py`, `backend/models/gate_models.py` (Sprint 1 changes only).

---

## Bugs / Errors

### 1. No validation of `parent_gate_id` on create

**Where:** `create_gate()` in `backend/services/gates.py`.

**Issue:** If the client sends `parent_gate_id` that does not exist, or that belongs to a **different file**, the gate is still created and linked into the tree:

- The new gate is appended to `_children[parent_gate_id]` (or that key is created). If `parent_gate_id` is from another file, one file’s tree will contain a gate whose `file_id` is different; `list_gates(file_id)` only walks `_root_children[file_id]`, so the new gate **won’t appear** in the list for its own file.
- Depth is computed only when the parent is found and has the same `file_id`; otherwise depth is 0, so depth checks can be bypassed.

**Recommendation:** Before creating the gate, validate that `parent_gate_id` is either `None` or exists in `_gates_by_id` and `parent.file_id == body.file_id`; otherwise raise `ValueError` or 400.

---

### 2. Delete does not cascade — orphaned children

**Where:** `delete_gate()` in `backend/services/gates.py`.

**Issue:** Deleting a gate only removes that gate from the tree and from `_gates_by_id`. Its **children are not deleted**; they are only removed from `_children[deleted_id]` and their caches are invalidated. Those child records remain in `_gates_by_id` with `parent_gate_id` pointing to the deleted gate, and they are no longer reachable from `_root_children` / `_children`, so they become **orphans** (never returned by `list_gates`, never cleaned up until BE-4).

**Status:** Deferred to Sprint 2 BE-4 (cascade delete). Documented here as a known limitation until BE-4 is implemented.

---

## Dangers / Robustness

### 3. No cycle detection in parent chain

**Where:** `_get_mask(record)` (and any code that walks parent via `parent_gate_id`).

**Issue:** If through a bug or corruption a gate’s `parent_gate_id` points to a descendant (cycle in the parent chain), `_get_mask` will recurse indefinitely and cause a **stack overflow**. There is no `visited` set to detect cycles.

**Recommendation:** In `_get_mask` (or a shared “get parent mask” helper), pass a `visited: set[str]` and skip / error if `record.parent_gate_id in visited`; or validate the tree on load and reject cycles.

---

### 4. Workspace load ignores hierarchy

**Where:** `backend/services/workspace_service.py` — workspace load builds `GateCreateRequest` without `parent_gate_id` or `order`.

**Issue:** On workspace load, all recreated gates get `parent_gate_id=None` and default `order`, so the **entire hierarchy is flattened to root-level**. Saved parent/child structure is lost until INT-1 (Sprint 4).

**Status:** Expected to be addressed in Sprint 4 (INT-1). Logged here as a caveat for anyone testing hierarchy + workspace before Sprint 4.

---

## Caveats (behavior / API)

### 5. Redundant second pop in `_on_file_evicted`

**Where:** `_on_file_evicted(file_id)`.

**Issue:** `_root_children.pop(file_id, [])` already removes the key; the following `_root_children.pop(file_id, None)` is a no-op. Harmless but redundant.

**Recommendation:** Remove the second `pop` for clarity.

---

### 6. Tree order is list order, not `record.order` sort

**Where:** `topological_order(file_id)` walks `_root_children` and `_children` in **list order**.

**Issue:** Order in the API is determined by the order of IDs in `_root_children` and `_children`, not by sorting with `record.order`. We do keep `record.order` in sync when inserting/reordering, but if the lists were ever mutated without updating `record.order`, or vice versa, the two could diverge.

**Recommendation:** Either document that “order is list order” and keep a single source of truth (the lists), or derive order by sorting siblings by `record.order` when building the tree.

---

### 7. GateResponse omits transform parameters

**Where:** `backend/models/gate_models.py` — `GateResponse`.

**Issue:** `GateResponse` does not include `arcsinh_cofactor` or logicle parameters (`logicle_T`, etc.). The frontend cannot reproduce the exact transform for a gate from the response alone (e.g. for overlays or re-plotting). Transform type (`transform_x`, `transform_y`) is present.

**Recommendation:** If the frontend needs full transform parity (e.g. for gate overlays on different axes), consider adding these fields to `GateResponse` in a later sprint.

---

## Summary

| # | Severity   | Item                          | Action |
|---|------------|-------------------------------|--------|
| 1 | Bug        | Validate `parent_gate_id` on create | Add validation; 400 if invalid/missing/wrong file. |
| 2 | Known gap  | Cascade delete                | Implement in BE-4 (Sprint 2). |
| 3 | Danger     | Cycle in parent chain          | Add visited set or tree validation. |
| 4 | Caveat     | Workspace load flattens hierarchy | Fix in INT-1 (Sprint 4). |
| 5 | Minor      | Redundant pop in eviction     | Remove second `pop`. |
| 6 | Caveat     | Order = list order             | Document or derive from `record.order`. |
| 7 | Caveat     | GateResponse missing transform params | Add in later sprint if needed. |

---

# Sprint 2 (Hierarchy BE-4, FE-1) — Caveats, Dangers, Errors, Bugs

**Reviewed:** 2026-03-04.  
**Scope:** BE-4 (cascade delete, get_gate_tree, get_gate_events, delete_all_gates_for_file), FE-1 (types/gates.ts, App gateTree).

---

## Bugs / Errors

### S2-1. GET gate events column order followed file order, not (x, y)

**Where:** `get_gate_events()` in `backend/services/gates.py` (when `x_channel` and/or `y_channel` are provided).

**Issue:** Indices and channel names were built by iterating `metadata.channels`, so columns were returned in **file channel order** instead of requested **[x_channel, y_channel]** order. Plots using the first column as X and second as Y could show axes swapped.

**Status:** Fixed: indices/names are now built in `[x_channel, y_channel]` order when both are provided.

---

### S2-1b. get_gate_tree raised TypeError when building tree (gates not shown on frontend)

**Where:** `get_gate_tree()` in `backend/services/gates.py` — building nested `GateResponse` in `build_node()`.

**Issue:** The code did `return GateResponse(**base.model_dump(), children=child_responses)`. Since `base.model_dump()` already includes the key `children` (from the GateResponse default), Python raised **`TypeError: ... multiple values for keyword argument 'children'`**. So **GET /api/files/{file_id}/gates** returned **500** whenever the tree had at least one gate. The frontend never received a valid tree and showed "No gates" while the backend had created the gate and correctly returned 409 on duplicate name.

**Fix (2026-03-04):** Build a dict from `base.model_dump()`, set `d["children"] = child_responses`, then `return GateResponse(**d)`. No duplicate keyword.

**Status:** Fixed. Verified by `python -m scripts.test_gates_flow` and by UI (gates now appear in hierarchy panel).

---

### S2-2. DELETE gate when not found returns 200 with empty deleted_ids

**Where:** `DELETE /api/gates/{gate_id}` in `backend/routers/gates.py`.

**Issue:** If the gate does not exist, the service returns `[]` and the router returns 200 with `{"status": "deleted", "gate_id": "<id>", "deleted_ids": []}`. Some clients may expect 404 for “resource not found”.

**Recommendation:** Consider returning 404 when `delete_gate` returns empty `deleted_ids` and the requested `gate_id` was not deleted (e.g. distinguish “already gone” from “never existed” if needed).

---

## Dangers / Robustness

### S2-3. clearGatesForTransformChange deletes every gate individually

**Where:** `frontend/src/App.tsx` — `clearGatesForTransformChange`.

**Issue:** The frontend iterates over `gateList` (flattened tree) and sends one DELETE per gate. With cascade delete, deleting a parent already removes its descendants, so later DELETEs for those children may hit 404 or no-op. Behaviour is correct but **inefficient**: many unnecessary requests. Alternatively, the frontend could call **DELETE /api/files/{file_id}/gates** once to clear all gates for the file.

**Recommendation:** For “clear all gates (e.g. on transform change)”, prefer DELETE /api/files/{file_id}/gates instead of one DELETE per gate.

---

## Caveats (behavior / API)

### S2-4. get_gate_tree recomputes stats for every node

**Where:** `get_gate_tree(file_id)` in `backend/services/gates.py`.

**Issue:** Each node is built by calling `_compute_stats(record)`, which uses `_get_mask` and can refill cache. For large trees this does full evaluation for every gate on every tree request. Cache helps when the same tree is requested again with no invalidation, but the first request (or after invalidation) is O(n) evaluations.

**Recommendation:** Document or accept as-is; consider lazy stats in a later sprint if needed.

---

### S2-5. GET /api/gates/files/{file_id} still returns flat list

**Where:** `backend/routers/gates.py` — `list_gates(file_id)`.

**Issue:** **GET /api/files/{file_id}/gates** now returns the **tree** (nested). **GET /api/gates/files/{file_id}** still returns a **flat** list via `list_gates()`. Two different shapes for “gates for a file” depending on endpoint; clients that use the gates router get a flat list.

**Recommendation:** Document; consider deprecating GET /api/gates/files/{file_id} or aligning semantics in a later sprint.

---

### S2-6. Frontend does not use findNode or breadcrumb yet

**Where:** `frontend/src/types/gates.ts` — `findNode`, `breadcrumb` exported but unused in App.

**Issue:** Utilities were added for FE-2/FE-3 (tree panel, active population, breadcrumb). They are not yet used; dead code until Sprint 3.

**Recommendation:** None; keep for Sprint 3 or remove if not needed.

---

### S2-7. GateNode.children type allows undefined at runtime

**Where:** `frontend/src/types/gates.ts` — `GateNode.children`.

**Issue:** Type is `children: GateNode[]`. If the backend ever omits `children` or sends `null`, runtime access (e.g. `flattenTree` with `n.children?.length`) is safe, but TypeScript assumes array. Backend always sends `children` (list).

**Recommendation:** Optional chaining already used in flattenTree/findNode/breadcrumb; no change unless backend contract changes.

---

## Summary (Sprint 2)

| #    | Severity | Item                                      | Action |
|------|----------|-------------------------------------------|--------|
| S2-1  | Bug      | Gate events column order                  | Fixed (x, y order). |
| S2-1b | Bug      | get_gate_tree TypeError (gates not shown) | Fixed (dict then children). |
| S2-2  | Caveat   | DELETE gate 200 when missing              | Consider 404. |
| S2-3 | Danger   | clearGatesForTransformChange N DELETEs    | Prefer DELETE file gates. |
| S2-4 | Caveat   | get_gate_tree O(n) stats                  | Document or optimize later. |
| S2-5 | Caveat   | Two shapes for “file gates”               | Document. |
| S2-6  | Caveat   | findNode/breadcrumb unused                | Use in Sprint 3. |
| S2-7  | Caveat   | GateNode.children runtime                 | Already safe with ?. |

---

# Sprint 3 (Hierarchy FE-2, FE-3)

**Reviewed:** 2026-03-04.  
**Scope:** `frontend/src/components/GateTreePanel.tsx`, `frontend/src/App.tsx` (activeGateId, events routing, create with parent_gate_id, breadcrumb, GateTreePanel, visibleGates), `frontend/src/types/gates.ts` (breadcrumbPath, findNode).

---

## Bugs / Errors

### S3-1. “0 events in this gate population” can flash during loading

**Where:** `frontend/src/App.tsx` — the condition `activeGateId && points.length === 0` used to show the empty-gate message.

**Issue:** At the start of the events effect we set `setPoints([])` (implicitly via not updating until fetch completes) and set `setFcsStatus("loading")`. The plot renders with `points.length === 0` while the gate-events request is in flight, so the text “0 events in this gate population” can appear briefly before the real data (or real zero) arrives.

**Recommendation:** Only show the message when `activeGateId && points.length === 0 && fcsStatus === "loaded"` (or equivalent: not loading). Alternatively, keep a separate “gate population empty” flag set only after a successful response with zero events.

---

### S3-2. GateTreeNode assumes `node.children` is always an array

**Where:** `frontend/src/components/GateTreePanel.tsx` — `node.children.map((child) => ...)` inside the recursive render.

**Issue:** We guard with `hasChildren = (node.children?.length ?? 0) > 0` and only render children when `expanded && hasChildren`, but then call `node.children.map(...)` without optional chaining. If the backend ever omits `children` or sends `null`, this throws. TypeScript type says `children: GateNode[]` (required). Backend currently always sends `children`.

**Recommendation:** Use `node.children?.map(...) ?? []` for defensive rendering, or document that backend must always send `children` and treat as low-risk.

---

## Dangers / Robustness

### S3-3. Events requests do not pass transform parameters from UI

**Where:** `frontend/src/App.tsx` — `fetchEventsAndPlot` and the gate-events branch (GET /api/gates/{id}/events).

**Issue:** File events and gate events are requested with `transform_x`, `transform_y` (and `x_channel`, `y_channel`, `max_events`) but **not** `arcsinh_cofactor` (or logicle params). The backend defaults to `arcsinh_cofactor=150`. Gate creation hardcodes `arcsinh_cofactor: 150`. If the UI later adds a cofactor (or logicle) control, events would still use the default unless the request is updated.

**Recommendation:** Document; when adding transform-parameter UI (cofactor, logicle), pass the same values to both file-events and gate-events requests.

---

### S3-4. onCreateChild from node: theoretical state race

**Where:** `frontend/src/App.tsx` — GateTreePanel `onCreateChild={(parentId) => { onSelectGate(parentId); onCreateChild(); }}`.

**Issue:** We set `activeGateId` to `parentId` then open draw mode. React batches state updates, so when the user draws and submits, `activeGateId` will almost always be `parentId`. If the user could submit in the same synchronous tick (e.g. automated test), the create might see the previous `activeGateId`. Unlikely in normal use.

**Recommendation:** Document or accept; if needed, pass `parentId` into the draw flow so the create payload uses it explicitly instead of relying on `activeGateId`.

---

## Caveats (behavior / API)

### S3-5. breadcrumb() (string names) is unused

**Where:** `frontend/src/types/gates.ts` — `breadcrumb(nodes, id)` returns `string[]`; App uses only `breadcrumbPath(nodes, id)` (GateNode[]).

**Issue:** Dead export; could be removed or kept for future use (e.g. tooltips, aria-labels).

**Recommendation:** No change, or remove if tree UI will only use `breadcrumbPath`.

---

### S3-6. Delete confirmation stays until tree refetches

**Where:** `frontend/src/components/GateTreePanel.tsx` — “Delete subtree? ✓ ✕” inline confirmation.

**Issue:** After the user clicks ✓ we call `onDeleteGate(node.id)`; we do not call `setConfirmDelete(false)`. The confirmation disappears when the tree refetches and the node is removed. If the request is slow or fails, the user sees the confirm state until refetch completes or they navigate away.

**Recommendation:** Optional: call `setConfirmDelete(false)` after `onDeleteGate` (e.g. in a `.then()` or after `await`) to close the confirm immediately; refetch will still remove the row.

---

### S3-7. totalEvents in panel is file.event_count

**Where:** `frontend/src/App.tsx` — GateTreePanel receives `totalEvents={file.event_count}`.

**Issue:** If file metadata is updated (e.g. after compensation or re-load) without refreshing the file object, the “All Events” count in the tree could be stale. Same value is used in the breadcrumb “All Events (N)”.

**Recommendation:** Document; ensure file refetch or metadata update refreshes `event_count` when it changes.

---

### S3-8. No keyboard accessibility in tree

**Where:** `frontend/src/components/GateTreePanel.tsx` — rows and buttons are click-only.

**Issue:** No focus management, no Enter/Space to select or activate, no arrow-key navigation. Screen-reader and keyboard-only users cannot operate the tree efficiently.

**Recommendation:** Defer to a dedicated a11y pass; consider `role="tree"`, `role="treeitem"`, `aria-expanded`, `tabIndex`, and arrow keys.

---

### S3-9. Stale activeGateId if breadcrumb path is empty

**Where:** `frontend/src/App.tsx` — breadcrumb renders “All Events” plus `breadcrumbPath(gateTree, activeGateId)`.

**Issue:** If `activeGateId` points to a gate that no longer exists in the tree (e.g. deleted by another tab, or race), `breadcrumbPath` returns `[]`, so we show only “All Events (N)” with no path. The events request still goes to GET /api/gates/{activeGateId}/events and may 404. We do clear `activeGateId` when the deleted node’s subtree contains the active gate; we do not validate `activeGateId` against the current tree on load or after refetch.

**Recommendation:** After `fetchGateTree` completes, if `activeGateId !== null` and `findNode(gateTree, activeGateId) === null`, set `activeGateId` to `null` to avoid stale selection and 404s.

---

## Summary (Sprint 3)

| #    | Severity | Item                                      | Action |
|------|----------|-------------------------------------------|--------|
| S3-1 | Bug      | “0 events” message during loading        | Show only when not loading. |
| S3-2 | Bug      | node.children assumed array               | Optional chaining or document. |
| S3-3 | Danger   | Events requests omit cofactor/logicle    | Document; pass when UI added. |
| S3-4 | Danger   | onCreateChild state race (theoretical)    | Document or pass parentId. |
| S3-5 | Caveat   | breadcrumb() unused                      | No change or remove. |
| S3-6 | Caveat   | Delete confirm until refetch              | Optionally close after delete. |
| S3-7 | Caveat   | totalEvents = file.event_count            | Document. |
| S3-8 | Caveat   | No keyboard a11y in tree                  | Defer to a11y pass. |
| S3-9 | Caveat   | Stale activeGateId after refetch          | Clear if not in tree. |

---

# Proposed solutions (for review — do not implement until approved)

Below are concrete, implementable solutions for each issue. Review and approve before implementation.

---

## Sprint 1

### 1. No validation of `parent_gate_id` on create

**Proposed solution:** In `create_gate()` (e.g. right after the name-uniqueness check and before the depth check), add:

- If `body.parent_gate_id` is not `None`:
  - `parent = _gates_by_id.get(body.parent_gate_id)`
  - If `parent is None`, raise `ValueError("Parent gate not found")`
  - If `parent.file_id != body.file_id`, raise `ValueError("Parent gate belongs to a different file")`
- Router already maps `ValueError` to 400; no router change needed.

---

### 2. Delete does not cascade — orphaned children

**Proposed solution:** **Already implemented in Sprint 2 BE-4.** `delete_gate()` now cascades and returns `deleted_ids`. No further change; update this issue in the doc to “Resolved in Sprint 2”.

---

### 3. No cycle detection in parent chain

**Proposed solution:** In `_get_mask(record)`, add an optional internal parameter `_visited: set[str] | None = None`. At the start of the function (after cache hit check):

- Initialize `visited = _visited if _visited is not None else set()`
- When resolving parent: if `record.parent_gate_id is not None` and `record.parent_gate_id in visited`, raise `ValueError("Gate hierarchy cycle detected")` (or return empty mask and log, depending on desired semantics)
- Before recursing to get parent mask, do `visited.add(record.parent_gate_id)` (add parent before recursing)
- Pass `visited` into the recursive `_get_mask(parent)` call

Alternatively, validate no cycle when creating a gate (walk parent chain and reject if gate_id is seen). Prefer cycle check in `_get_mask` so any corrupted state is caught at evaluation time.

---

### 4. Workspace load ignores hierarchy

**Proposed solution:** Defer to Sprint 4 INT-1 per plan. No change in this sprint; only document that INT-1 will add `parent_gate_id` and `order` to `WorkspaceGateDef`, topological sort on load, and id_map for remapping parent IDs. No code change proposed here.

---

### 5. Redundant second pop in `_on_file_evicted`

**Proposed solution:** In `_on_file_evicted(file_id)`, remove the second line so the body is:

```python
for gid in _root_children.pop(file_id, []):
  _evict_gate_subtree(gid)
```

Delete the line `_root_children.pop(file_id, None)`.

---

### 6. Tree order is list order, not `record.order` sort

**Proposed solution:** **Option A (recommended):** Add a one-line docstring to `topological_order()` and a short comment above `_root_children` / `_children`: “Order of siblings is defined by list order; `record.order` is kept in sync on create/reorder.” No behavioral change.  
**Option B:** When building the tree (e.g. in `get_gate_tree` and `topological_order`), sort each sibling list by `record.order` before walking. That makes `record.order` the source of truth and requires that all code that mutates lists also updates `record.order` (already done on create).  
Recommend Option A to avoid changing behavior and to avoid sorting on every tree walk.

---

### 7. GateResponse omits transform parameters

**Proposed solution:** In `backend/models/gate_models.py`, add to `GateResponse`: `arcsinh_cofactor: float = 150.0`, `logicle_T: float = 262144.0`, `logicle_W: float = 0.5`, `logicle_M: float = 4.5`, `logicle_A: float = 0.0`. In `_record_to_response()` in `gates.py`, pass these from `record` into the `GateResponse` constructor. Frontend can then use them for overlays/re-plotting when needed. Optional; can be done in a later sprint if not needed for current UI.

---

## Sprint 2

### S2-1. GET gate events column order

**Proposed solution:** Already fixed. No further action.

---

### S2-1b. get_gate_tree TypeError (gates not shown on frontend)

**Proposed solution:** Already fixed: build dict from `base.model_dump()`, set `d["children"] = child_responses`, then `GateResponse(**d)`. No further action.

---

### S2-2. DELETE gate when not found returns 200 with empty deleted_ids

**Proposed solution:** In `backend/routers/gates.py`, in `delete_gate` endpoint: call `deleted_ids = gates_service.delete_gate(gate_id)`. If `len(deleted_ids) == 0`, raise `HTTPException(status_code=404, detail="Gate not found")` instead of returning 200. So: “gate not found” → 404; “gate found and deleted” → 200 with `deleted_ids`.

---

### S2-3. clearGatesForTransformChange deletes every gate individually

**Proposed solution:** In `frontend/src/App.tsx`, replace the loop in `clearGatesForTransformChange` with a single call:

- `await fetch(`${API_BASE}/api/files/${encodeURIComponent(file.id)}/gates`, { method: "DELETE" })`
- Then `setGateTree([])` and set the same gate message. Remove the `for (const g of gateList)` loop. Optionally handle 404 (e.g. file already unloaded) by still clearing local state.

---

### S2-4. get_gate_tree recomputes stats for every node

**Proposed solution:** **Option A:** Add a short docstring to `get_gate_tree()`: “Computes stats (and fills mask cache) for every gate in the tree; O(n) evaluations. Cache is reused for subsequent requests until invalidation.” No code change.  
**Option B (later):** Lazy stats: build tree with placeholder counts and only compute on demand (e.g. when a node is expanded or a dedicated “refresh stats” is used). More invasive; recommend Option A for now.

---

### S2-5. GET /api/gates/files/{file_id} still returns flat list

**Proposed solution:** **Option A:** In `backend/routers/gates.py`, change `list_gates` to call `gates_service.get_gate_tree(file_id)` and return that (so both GET /api/files/{file_id}/gates and GET /api/gates/files/{file_id} return the same tree). Any client that expects a flat list would need to flatten client-side (or use a query param later, e.g. `?flat=1`).  
**Option B:** Document only: in OpenAPI description for GET /api/gates/files/{file_id}, state “Returns flat list of gates for the file. For nested tree, use GET /api/files/{file_id}/gates.”  
Recommend Option A for consistency unless a client explicitly needs the flat endpoint.

---

### S2-6. Frontend findNode / breadcrumb unused

**Proposed solution:** No change. Keep `findNode` and `breadcrumb` in `types/gates.ts` for Sprint 3 (tree panel, breadcrumb UI). Mark as “for Sprint 3” in comments if desired. Do not remove.

---

### S2-7. GateNode.children type allows undefined at runtime

**Proposed solution:** No code change. Optional chaining (`n.children?.length`) already makes runtime safe. If desired, type could be `children?: GateNode[]` and default to `[]` where consumed, but backend always sends `children`; current type is acceptable. Defer unless backend contract changes.

---

## Sprint 3

### S3-1. “0 events in this gate population” during loading

**Proposed solution:** In `App.tsx`, change the condition to show the message only when not loading, e.g. `activeGateId && points.length === 0 && fcsStatus === "loaded"`. Alternatively, set a flag when the gate-events response returns zero events and show the message based on that.

---

### S3-2. GateTreeNode node.children

**Proposed solution:** In `GateTreePanel.tsx`, use `(node.children ?? []).map(...)` when rendering children so that missing `children` does not throw. Keeps type as-is; backend contract unchanged.

---

### S3-3. Events requests omit transform params

**Proposed solution:** Document only. When adding arcsinh_cofactor (or logicle) to the UI, add the same query params to both file-events and gate-events request builders. No code change now.

---

### S3-4. onCreateChild state race

**Proposed solution:** Document only. If tests or future flows expose the race, pass `parentId` into the draw/create flow and use it in the create payload instead of reading `activeGateId`. No change required for current UX.

---

### S3-5. breadcrumb() unused

**Proposed solution:** No change, or remove `breadcrumb` export from `types/gates.ts` if not needed. Keep `breadcrumbPath` for UI.

---

### S3-6. Delete confirmation until refetch

**Proposed solution:** In `GateTreePanel.tsx`, after calling `onDeleteGate(node.id)`, chain `.then(() => setConfirmDelete(false))` (or use async/await and then `setConfirmDelete(false)`) so the confirm UI closes immediately. Refetch will still update the tree.

---

### S3-7. totalEvents = file.event_count

**Proposed solution:** Document only. Ensure any flow that updates effective event count (e.g. compensation) also refreshes the file object so `event_count` is current.

---

### S3-8. No keyboard a11y in tree

**Proposed solution:** Defer to a dedicated accessibility pass. Consider `role="tree"` / `role="treeitem"`, `aria-expanded`, `tabIndex`, and arrow-key navigation. No change in this sprint.

---

### S3-9. Stale activeGateId after refetch

**Proposed solution:** In `App.tsx`, inside the `fetchGateTree` callback after `setGateTree(...)`, if `activeGateId !== null` and `findNode(Array.isArray(tree) ? tree : [], activeGateId) === null`, call `setActiveGateId(null)` so the selection is cleared when the active gate is no longer in the tree.

---

## Summary table (proposed actions)

| Id   | Action |
|------|--------|
| 1    | Add parent_gate_id validation in create_gate; raise ValueError if invalid. |
| 2    | Mark as resolved (Sprint 2 BE-4). |
| 3    | Add cycle detection in _get_mask (visited set; raise or return empty on cycle). |
| 4    | Defer to INT-1; document only. |
| 5    | Remove redundant _root_children.pop(file_id, None) in _on_file_evicted. |
| 6    | Document “order = list order” (Option A); or sort by record.order (Option B). |
| 7    | Optionally add arcsinh_cofactor and logicle_* to GateResponse (later sprint ok). |
| S2-1  | Done. |
| S2-1b | Done (get_gate_tree children fix). |
| S2-2  | Return 404 when delete_gate returns empty deleted_ids. |
| S2-3 | Replace clearGatesForTransformChange loop with single DELETE /api/files/{id}/gates. |
| S2-4 | Document O(n) in get_gate_tree (Option A). |
| S2-5 | Either make list_gates return tree (Option A) or document flat (Option B). |
| S2-6 | No change; keep for Sprint 3. |
| S2-7 | No change. |
| S3-1 | Show “0 events” only when fcsStatus === "loaded" (or equivalent). |
| S3-2 | Use (node.children ?? []).map in GateTreePanel. |
| S3-3 | Document; pass cofactor/logicle when UI added. |
| S3-4 | Document; optional parentId in create flow. |
| S3-5 | No change or remove breadcrumb. |
| S3-6 | Close confirm after onDeleteGate (setConfirmDelete(false)). |
| S3-7 | Document. |
| S3-8 | Defer to a11y pass. |
| S3-9 | After fetchGateTree, clear activeGateId if not in tree. |

---

# Backend review 2026‑03‑09 — gates, workspace, transforms

**Source:** `FreeCyto_Backend_Review_2026-03-09.md`.  
**Scope:** `backend/services/gates.py`, `backend/services/workspace_service.py`, `backend/services/transforms.py`.  
**Goal:** Capture additional bugs and robustness issues found after Sprints 1–3 and tie them into the sprint plan.

---

## Additional bugs (backend review)

- **BUG-1 — `_compute_stats` re-calls `_get_mask(parent)` unnecessarily:**  
  `_compute_stats` calls `_get_mask(record)` (which recursively fills the parent’s cache) and then calls `_get_mask(parent)` again just to compute `parent_count`. This is redundant and makes the logic harder to reason about. Recommended: read `parent._cached_count` after `_get_mask(record)` instead of re-calling `_get_mask(parent)`.

- **BUG-2 — `_record_to_response` uses `or 0` pattern for cached stats:**  
  `count = record._cached_count or 0` etc. relies on truthiness instead of `is None`, which is fragile if any cached field could be `0`/`0.0` or `False`. Recommended: explicit `is not None` checks for all cached fields.

- **BUG-3 — `create_gate` still missing `parent_gate_id` validation:**  
  Matches Sprint 1 item 1: `create_gate` does not enforce that `parent_gate_id` exists and belongs to the same file before inserting. This can still create orphaned gates in `_children` that never appear in the tree. Recommended: validate `parent_gate_id` and raise `ValueError` on missing / wrong-file parents (see Sprint 1 section 1 for exact code).

These three are the **first-priority backend fixes** before workspace hierarchy (INT-1).

---

## Additional robustness / hygiene

- **ROB-1 — No cycle detection in `_get_mask` (reiterated):**  
  Already logged as Sprint 1 item 3. Backend review confirms this is still missing and should be implemented via a `_visited` set/frozenset parameter to `_get_mask` before large-scale parity tests.

- **ROB-2 — `_get_ancestor_list` O(depth²) usage:**  
  Depth is recomputed via `_get_ancestor_list` on every `_record_to_response` call. This is acceptable for small trees but worth documenting; caching `depth` on `GateRecord` at create time is a possible optimisation.

- **ROB-3 — `get_gate_events` always uses gate’s stored logicle params:**  
  When callers override `transform_x` / `transform_y` to `logicle` via query params, `kwargs` still read `record.logicle_T/W/M/A`. This is fine for counts (evaluation uses the stored transform) but can give slightly different display scaling than the UI expects. Low priority; can be addressed by adding optional logicle query params later.

- **ROB-4 — `_on_file_evicted` redundant pop already fixed:**  
  Confirms that Sprint 1 caveat item 5 has been resolved; current code uses a single `pop`.

- **ROB-5 — Sibling order dual source of truth:**  
  Confirms Sprint 1 caveat item 6: list order vs `record.order`. Recommendation is to treat list order as source of truth and document this clearly above `_root_children` / `_children`.

- **ROB-6 — `GateResponse` omits transform parameters; workspace save hardcodes cofactor:**  
  Matches Sprint 1 caveat item 7 and expands it: `WorkspaceGateDef` and `build_workspace_save` currently hardcode `arcsinh_cofactor=150.0` and omit logicle params, so non-default cofactors/logicle settings are lost on save/load. Must be fixed as part of INT-1.

- **ROB-7 — `get_gate_events` random downsampling is non-deterministic:**  
  Uses `np.random.choice` with global RNG. Acceptable for display; note that repeat views of the same gate will show different samples. Low priority; document only unless deterministic sampling is required.

---

## Workspace and transforms (INT‑1 prerequisites)

Backend review highlights that **workspace save/load does not yet preserve hierarchy or per-gate transforms**:

- `WorkspaceGateDef` is missing `parent_gate_id`, `order`, `original_id`, and logicle params.
- `build_workspace_save` cannot read `arcsinh_cofactor` / logicle values from `GateResponse` and therefore hardcodes `arcsinh_cofactor=150.0`.
- `load_workspace` recreates all gates at root (no topological sort, no `id_map` remapping of parent IDs).

These are already planned in `GATING_HIERARCHY_SPRINTS.md` Sprint 4 (INT‑1); the review confirms they are **critical blockers** for FlowJo parity in Sprint 5.

---

## Backend review mapping to sprint actions

The backend review’s prioritised list (BUG‑1/2/3, ROB‑1, INT‑1, ROB‑6, S2‑2, S2‑5, ROB‑2/3/5, S2‑4, H‑1/2/3, TRF‑1/2) maps to this file as:

- **Sprint 1 / 2 items already logged:** parent validation (1), cycle detection (3), workspace hierarchy (4), transform params (7), S2‑2, S2‑4, S2‑5.
- **New explicit IDs:** BUG‑1, BUG‑2, ROB‑2, ROB‑3, ROB‑5, ROB‑7, TRF‑1, TRF‑2, H‑1, H‑2, H‑3 — all tracked in `FreeCyto_Backend_Review_2026-03-09.md` with code pointers and suggested patches.

Use that review doc as the **implementation guide** for the next backend sprint, starting with BUG‑3 → BUG‑1 → BUG‑2 → ROB‑1, then INT‑1 / ROB‑6.
