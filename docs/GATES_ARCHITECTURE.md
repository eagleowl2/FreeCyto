# Gates — Architecture and storage

**Summary:** Gates are **temporary, in-memory only**. They are not persisted to disk. They are cleared when the backend process exits or when the file is evicted from the file cache.

---

## Backend storage

- **Where:** `backend/services/gates.py`
- **Structures:**
  - `_gates_by_id`: `dict[gate_id, GateRecord]` — all gate records.
  - `_root_children`: `dict[file_id, list[gate_id]]` — root-level gate IDs per file (order preserved).
  - `_children`: `dict[gate_id, list[gate_id]]` — child gate IDs per gate (order preserved).
- **Lifecycle:**
  - Created via `POST /api/gates`; stored in the above dicts.
  - Returned via `GET /api/files/{file_id}/gates` (tree) or `GET /api/gates/files/{file_id}` (flat).
  - Cleared for a file when that file is evicted from the file cache (`storage`), via `_on_file_evicted`.
  - **No database or file persistence** — process exit loses all gates.

---

## Frontend

- **State:** `gateTree: GateNode[]` (nested tree from API). `gateList` = flattened tree for display.
- **Fetch:** When the selected file changes, `fetchGateTree(file.id)` is called. On success, `gateTree` is updated. On failure, the previous tree is left unchanged (no wipe).
- **Sync after 409:** If the user gets "Name already in use", the frontend refetches the gate tree so existing gates appear in the hierarchy panel and the UI is consistent with the backend.

---

## Name uniqueness

- Uniqueness is **per file**: two gates in the same file cannot share a name. Different files can reuse the same gate name.
- Check is done in `create_gate()` using `_all_gate_ids_for_file(body.file_id)` (same set of gates that appear in the tree).

---

## Optional: clear gates when loading a file

If you want a completely fresh gate set every time a file is selected (e.g. no carry-over from a previous session in the same process), the frontend could call `DELETE /api/files/{file_id}/gates` when the user selects a file. This is **not** done by default, so gates survive switching away and back to the same file.
