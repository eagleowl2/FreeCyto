# Backend workflow test report

**Generated:** From last pytest run of `backend/tests/test_backend_workflow.py`  
**Raw output:** `backend/tests/test_backend_workflow_report.txt`

---

## 1. Test run summary

| Result   | Count |
|----------|--------|
| Passed   | 21    |
| Skipped  | 1     |
| Failed   | 0     |
| Warnings | 3     |

**Command used:**  
`pytest backend/tests/test_backend_workflow.py -v --tb=short -W default -rA`

---

## 2. Test results (per test)

### SCIENCE — gate counts and transforms

| Test | Result | Notes |
|------|--------|--------|
| `TestScienceGateCounts::test_rectangle_exact_count` | PASSED | Rectangle count matches manual numpy count. |
| `TestScienceGateCounts::test_rectangle_count_uses_full_events_not_sample` | PASSED | Gate count stable after display downsampling. |
| `TestScienceGateCounts::test_pct_of_total_formula` | PASSED | pct_of_total == count/total*100 (rounded). |
| `TestScienceGateCounts::test_pct_of_parent_child_gate` | PASSED | pct_of_parent == child.count/parent.count*100. |
| `TestScienceGateCounts::test_child_count_never_exceeds_parent` | PASSED | Hierarchical mask applied. |
| `TestScienceTransforms::test_arcsinh_transform_shifts_gate_boundary` | PASSED | Arcsinh gate bounds correct. |
| `TestScienceTransforms::test_linear_and_arcsinh_gate_same_file_different_counts` | PASSED | Transform applied (different counts). |
| `TestSciencePolygonBoundary::test_point_exactly_on_polygon_edge_is_inside` | PASSED | Boundary = inside (GatingML 2.0). Emits RuntimeWarning (see Warnings). |
| `TestSciencePolygonBoundary::test_point_outside_polygon_not_counted` | PASSED | Outside point not counted. Emits RuntimeWarning (see Warnings). |

### LOGIC — tree, delete, validation

| Test | Result | Notes |
|------|--------|--------|
| `TestLogicTree::test_tree_depth_reported_correctly` | PASSED | depth 0/1/2 for root/child/grandchild. |
| `TestLogicTree::test_cascade_delete_removes_all_descendants` | PASSED | Deleting root removes full subtree. |
| `TestLogicTree::test_delete_child_leaves_parent_intact` | PASSED | Parent count unchanged after child delete. |
| `TestLogicTree::test_invalid_parent_gate_id_raises` | PASSED | ValueError for non-existent parent. |
| `TestLogicTree::test_duplicate_gate_name_raises` | PASSED | GateNameExistsError on duplicate name. |
| `TestLogicTree::test_depth_limit_50_enforced` | PASSED | ValueError on 51st level. |
| `TestLogicCacheInvalidation::test_cache_invalidated_after_compensation` | PASSED | Counts change after compensation. |
| `TestLogicCacheInvalidation::test_sibling_order_stable_after_multiple_creates` | PASSED | Children order A, B, C preserved. |

### REPRODUCIBILITY — round-trip and determinism

| Test | Result | Notes |
|------|--------|--------|
| `TestReproducibility::test_same_gate_same_count_on_repeated_calls` | PASSED | Counts identical across get_gate_tree calls. |
| `TestReproducibility::test_count_unchanged_after_list_gates` | PASSED | list_gates does not alter cached counts. |
| `TestReproducibility::test_workspace_round_trip_preserves_counts` | PASSED | Save/load preserves hierarchy and counts. |
| `TestReproducibility::test_delete_gate_then_recreate_same_count` | PASSED | Delete + recreate same params → same count. |
| `TestReproducibility::test_fcs_fixture_count_matches_reference` | PASSED | Counts on `reference.fcs` (currently `WBC_CP8.fcs`) match `reference_counts.json`. |

---

## 3. Warnings (all)

### W1 — Pydantic deprecation (GateResponse)

- **Location:** `backend/models/gate_models.py:63`
- **Message:** `PydanticDeprecatedSince20: Support for class-based config is deprecated, use ConfigDict instead. Deprecated in Pydantic V2.0 to be removed in V3.0.`
- **Context:** `class GateResponse(BaseModel):` uses a nested `class Config:`.
- **Action:** Migrate to `model_config = ConfigDict(...)` (Pydantic v2 style) when touching this model.

### W2 — RuntimeWarning: invalid value encountered in divide (polygon)

- **Location:** `backend/services/gates.py:52`  
  **Triggered by:** `TestSciencePolygonBoundary::test_point_exactly_on_polygon_edge_is_inside`
- **Code:** `cross = np.where(mask, vx[i] + (vx[i + 1] - vx[i]) * (y - vy[i]) / denom, np.nan)`
- **Cause:** `denom` can be zero when an edge is horizontal (`vy[i+1] == vy[i]`); the `mask = denom != 0` guards the division but NumPy still evaluates the expression and emits the warning.
- **Action:** Optional: use `np.errstate(divide='ignore')` around that line, or compute cross only where `mask` is True to suppress the warning. Logic is correct (nan where denom==0).

### W3 — RuntimeWarning: divide by zero (polygon)

- **Location:** Same as W2.  
  **Triggered by:** `TestSciencePolygonBoundary::test_point_outside_polygon_not_counted`
- **Cause:** Same as W2 — horizontal edge gives `denom == 0`.
- **Action:** Same as W2.

---

## 4. Problems and caveats

### P1 — FCS reference test configuration (REPRO-5)

- **Test:** `TestReproducibility::test_fcs_fixture_count_matches_reference`
- **Current fixture:** `tests/fixtures/reference.fcs` (copied from `tests/fixtures/WBC_CP8.fcs`).
- **Reference counts:** `tests/fixtures/reference_counts.json` (expected counts pre-populated by `scripts/update_reference_counts.py` using the live backend).
- **Status:** Test now runs and passes; update the fixture and reference JSON together if you change the reference FCS file or gate definitions.

### P2 — GateCreateRequest default `order=-1`

- **Change:** Default `order` was changed from `0` to `-1` (“append at end”) so that siblings appear in creation order when the client does not send `order`.
- **Impact:** Any client that relied on default `order=0` (insert at front) will now get append behaviour. Frontend currently sends `parent_gate_id` and typically does not send `order`; behaviour should remain correct.

### P3 — Synthetic workspace paths

- **Behaviour:** `load_workspace` treats file entries with path starting with `/synthetic/` and id `synthetic_{n}_{seed}` as in-memory synthetic files and regenerates events from the seed. Real FCS paths are still loaded via `fcs_parser`.
- **Caveat:** Synthetic format is for testing only; production workspaces use real file paths.

---

## 5. How to regenerate this report

From the backend directory:

```bash
pytest tests/test_backend_workflow.py -v --tb=short -W default -rA 2>&1 | Out-File -FilePath tests/test_backend_workflow_report.txt -Encoding utf8
```

Then update this document’s “Generated” note and any counts if the run result changes.
