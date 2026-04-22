"""Phase D — FlowJo Parity Validation
======================================
Validates that the FreeCyto gate engine reproduces event counts for a real WBC
panel to within ±0.1 % (or ±1 event absolute floor) of a deterministic numpy
reference evaluation and to 0 events when comparing the engine against itself.

Gate hierarchy (standard WBC panel):

    Singlets      — FSC-A × SSC-A rectangle, linear
    └─ Lymphocytes  — FSC-A × SSC-A rectangle, linear
          └─ CD3+   — BV605-A (CD3) × SSC-A rectangle, arcsinh(cofactor=150)
                └─ CD4+  — BB515-A (CD4) × BV605-A (CD3) rectangle, arcsinh(cofactor=150)

All D-* tests operate on a real FCS fixture (tests/fixtures/WBC_CP8.fcs). The
whole module is skipped automatically when that file is absent.

Run:
    cd backend
    pytest tests/test_flowjo_parity.py -v
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Path bootstrap — needed when invoked directly via pytest from backend/
# ---------------------------------------------------------------------------
HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.gate_models import GateCreateRequest, RectangleGateCreate, PolygonGateCreate
from services import gates as gates_service
from services import storage
from services.transforms import apply_transform

# ---------------------------------------------------------------------------
# Fixture paths
# ---------------------------------------------------------------------------
WBC_FCS_FIXTURE = os.environ.get(
    "OPENCYTO_TEST_WBC_FCS",
    os.path.join(HERE, "fixtures", "WBC_CP8.fcs"),
)

REF_COUNTS_PATH = os.path.join(HERE, "fixtures", "reference_counts.json")


def _wbc_fixture_parseable() -> bool:
    if not os.path.exists(WBC_FCS_FIXTURE):
        return False
    try:
        from services.fcs_parser import parse_metadata_only

        parse_metadata_only(WBC_FCS_FIXTURE)
        return True
    except Exception:
        return False


NEEDS_WBC = pytest.mark.skipif(
    not _wbc_fixture_parseable(),
    reason=f"WBC FCS fixture not found or unreadable at {WBC_FCS_FIXTURE!r}",
)

# ---------------------------------------------------------------------------
# Gate-coordinate constants (all in the transform space used by each gate)
# ---------------------------------------------------------------------------
# Singlets — linear FSC-A × SSC-A (same bounds used in reference_counts.json)
SINGLETS_X_MIN, SINGLETS_X_MAX = 50_000.0, 250_000.0
SINGLETS_Y_MIN, SINGLETS_Y_MAX = 20_000.0, 200_000.0

# Lymphocytes — linear FSC-A × SSC-A (same bounds used in reference_counts.json)
LYMPH_X_MIN, LYMPH_X_MAX = 60_000.0, 150_000.0
LYMPH_Y_MIN, LYMPH_Y_MAX = 30_000.0, 120_000.0

# CD3+ — arcsinh(BV605-A / 150) × arcsinh(SSC-A / 150)
# Lower bound separates CD3-negative from CD3-positive population.
CD3_X_MIN = float(np.arcsinh(200.0 / 150.0))   # ≈ 1.30
CD3_X_MAX = float(np.arcsinh(262_144.0 / 150.0))  # ≈ 8.16 (instrument max)
CD3_Y_MIN = -2.0                                  # include full SSC range
CD3_Y_MAX = float(np.arcsinh(262_144.0 / 150.0))  # ≈ 8.16

# CD4+ — arcsinh(BB515-A / 150) × arcsinh(BV605-A / 150), child of CD3+
CD4_X_MIN = float(np.arcsinh(100.0 / 150.0))    # ≈ 0.65
CD4_X_MAX = float(np.arcsinh(262_144.0 / 150.0))
CD4_Y_MIN = float(np.arcsinh(200.0 / 150.0))    # same CD3-positive floor
CD4_Y_MAX = float(np.arcsinh(262_144.0 / 150.0))

# CD3+CD4- polygon (example of polygon gate on the same population)
# Triangle in arcsinh(BV605-A) × arcsinh(BB515-A) space representing CD3+CD4- cells
CD3_POS_CD4_NEG_VERTICES = [
    [CD3_X_MIN, -2.0],
    [CD3_X_MAX, -2.0],
    [CD3_X_MAX, CD4_X_MIN - 0.01],
    [CD3_X_MIN, CD4_X_MIN - 0.01],
]

# ±0.1 % or ±1 event, whichever is larger — intended FlowJo parity tolerance
TOLERANCE_FRAC = 0.001


def _within_tolerance(actual: int, expected: int) -> bool:
    """Return True if |actual - expected| <= max(1, expected * TOLERANCE_FRAC)."""
    floor = max(1, int(round(expected * TOLERANCE_FRAC)))
    return abs(actual - expected) <= floor


# ---------------------------------------------------------------------------
# Request builders (mirrors helpers in test_backend_workflow.py)
# ---------------------------------------------------------------------------

def _rect(
    file_id: str,
    name: str,
    x_ch: str,
    y_ch: str,
    x_min: float,
    y_min: float,
    x_max: float,
    y_max: float,
    parent: str | None = None,
    tx: str = "linear",
    ty: str = "linear",
    cofactor: float = 150.0,
) -> GateCreateRequest:
    return GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel=x_ch,
        y_channel=y_ch,
        transform_x=tx,
        transform_y=ty,
        arcsinh_cofactor=cofactor,
        parent_gate_id=parent,
        params=RectangleGateCreate(
            type="rectangle",
            x_min=x_min, y_min=y_min,
            x_max=x_max, y_max=y_max,
        ),
    )


def _poly(
    file_id: str,
    name: str,
    x_ch: str,
    y_ch: str,
    vertices: list[list[float]],
    parent: str | None = None,
    tx: str = "arcsinh",
    ty: str = "arcsinh",
    cofactor: float = 150.0,
) -> GateCreateRequest:
    return GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel=x_ch,
        y_channel=y_ch,
        transform_x=tx,
        transform_y=ty,
        arcsinh_cofactor=cofactor,
        parent_gate_id=parent,
        params=PolygonGateCreate(type="polygon", vertices=vertices),
    )


# ---------------------------------------------------------------------------
# Shared fixture — load WBC_CP8.fcs once per test module (session-scoped, but
# the autouse conftest fixture tears down after each test function; we load
# fresh per test to stay consistent with the conftest autouse cleanup).
# ---------------------------------------------------------------------------

def _load_wbc() -> tuple[str, np.ndarray, dict[int, str]]:
    """Load WBC_CP8.fcs; return (file_id, events_f64, {0-based-index: channel_name})."""
    from services.fcs_parser import load_and_register_files

    loaded = load_and_register_files([WBC_FCS_FIXTURE])
    fid = loaded[0].id
    # events stored as float32; gate engine casts to float64 during evaluation
    events = storage.get_file_events(fid).astype(np.float64)
    metadata = storage.get_file_metadata(fid)
    ch_map = {ch.index - 1: ch.name for ch in metadata.channels}
    return fid, events, ch_map


def _np_count_rect(
    events: np.ndarray,
    mask: np.ndarray,
    col_x: int,
    col_y: int,
    x_min: float,
    y_min: float,
    x_max: float,
    y_max: float,
    tx: str = "linear",
    ty: str = "linear",
    cofactor: float = 150.0,
) -> tuple[int, np.ndarray]:
    """Numpy reference count for a rectangle gate with optional parent mask."""
    x = apply_transform(events[:, col_x], tx, arcsinh_cofactor=cofactor)
    y = apply_transform(events[:, col_y], ty, arcsinh_cofactor=cofactor)
    gate_mask = (
        (x >= x_min) & (x <= x_max) &
        (y >= y_min) & (y <= y_max)
    ) & mask
    return int(np.sum(gate_mask)), gate_mask


def _np_count_poly(
    events: np.ndarray,
    mask: np.ndarray,
    col_x: int,
    col_y: int,
    vertices: list[list[float]],
    tx: str = "arcsinh",
    ty: str = "arcsinh",
    cofactor: float = 150.0,
) -> int:
    """Numpy reference count for a convex-polygon gate (axis-aligned rect hull used as proxy)."""
    # For rectangles-disguised-as-polygons: min/max of vertices is the exact rect.
    vx = [v[0] for v in vertices]
    vy = [v[1] for v in vertices]
    x = apply_transform(events[:, col_x], tx, arcsinh_cofactor=cofactor)
    y = apply_transform(events[:, col_y], ty, arcsinh_cofactor=cofactor)
    gate_mask = (
        (x >= min(vx)) & (x <= max(vx)) &
        (y >= min(vy)) & (y <= max(vy))
    ) & mask
    return int(np.sum(gate_mask))


# ===========================================================================
# D-1: Singlets — root rectangle gate, linear transform
# ===========================================================================

@NEEDS_WBC
class TestSingletsGate:
    """D-1: Singlets root gate on FSC-A × SSC-A matches numpy reference exactly."""

    def test_singlets_count_exact(self):
        """
        D-1-A: Gate engine count == numpy reference for Singlets rectangle.

        Pass definition:
            resp.count == np.sum(mask_numpy), tolerance = 0.

        Inputs:
            WBC_CP8.fcs; FSC-A × SSC-A linear; bounds from reference_counts.json.

        Common errors:
            - Channel index off by one (1-based vs 0-based).
            - Gate evaluates on downsampled events.
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        all_mask = np.ones(events.shape[0], dtype=bool)

        expected, _ = _np_count_rect(
            events, all_mask, 0, 3,
            SINGLETS_X_MIN, SINGLETS_Y_MIN,
            SINGLETS_X_MAX, SINGLETS_Y_MAX,
        )

        resp = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )

        assert resp.count == expected, (
            f"D-1-A: Singlets count {resp.count} != numpy {expected}. "
            "Check full-event evaluation and channel index mapping."
        )

    def test_singlets_pct_of_total_formula(self):
        """
        D-1-B: pct_of_total == round(count / n_total * 100, 2).

        Pass definition:
            |resp.pct_of_total - expected_pct| <= 0.01.
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        n_total = events.shape[0]

        resp = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )

        expected_pct = round(resp.count / n_total * 100, 2)
        assert abs(resp.pct_of_total - expected_pct) <= 0.01, (
            f"D-1-B: pct_of_total {resp.pct_of_total} != expected {expected_pct}"
        )

    def test_singlets_matches_reference_counts_json(self):
        """
        D-1-C [optional]: Singlets count is within ±0.1 % of the value stored in
        reference_counts.json (derived from an independent run on the equivalent
        file).  Skipped if the JSON is absent.

        Pass definition:
            _within_tolerance(resp.count, reference_count).
        """
        if not os.path.exists(REF_COUNTS_PATH):
            pytest.skip(f"reference_counts.json not found at {REF_COUNTS_PATH!r}")

        with open(REF_COUNTS_PATH) as f:
            ref = json.load(f)

        gate_defs = {g["name"]: g for g in ref.get("gates", [])}
        if "Singlets" not in gate_defs:
            pytest.skip("Singlets not in reference_counts.json")

        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]

        resp = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )

        ref_count = gate_defs["Singlets"]["expected_count"]
        assert _within_tolerance(resp.count, ref_count), (
            f"D-1-C: Singlets count {resp.count} differs from reference {ref_count} "
            f"by more than {TOLERANCE_FRAC * 100:.1f}%"
        )


# ===========================================================================
# D-2: Lymphocytes — child of Singlets, rectangle, linear
# ===========================================================================

@NEEDS_WBC
class TestLymphocytesGate:
    """D-2: Lymphocytes child gate; count must equal hierarchical numpy reference."""

    def test_lymphocytes_count_exact(self):
        """
        D-2-A: Lymphocytes count == numpy count with Singlets parent mask applied.

        Pass definition:
            resp.count == np.sum(singlets_mask & lymph_rect_mask), tolerance = 0.

        Common errors:
            - Parent mask not applied in child evaluation (SCIENCE-5 regression).
            - _cached_mask not propagated before child's _compute_stats (A-1 bug).
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        all_mask = np.ones(events.shape[0], dtype=bool)

        _, sing_mask = _np_count_rect(
            events, all_mask, 0, 3,
            SINGLETS_X_MIN, SINGLETS_Y_MIN,
            SINGLETS_X_MAX, SINGLETS_Y_MAX,
        )
        expected, _ = _np_count_rect(
            events, sing_mask, 0, 3,
            LYMPH_X_MIN, LYMPH_Y_MIN,
            LYMPH_X_MAX, LYMPH_Y_MAX,
        )

        sing_resp = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph_resp = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing_resp.id)
        )

        assert lymph_resp.count == expected, (
            f"D-2-A: Lymphocytes count {lymph_resp.count} != numpy {expected}. "
            "Parent mask likely not applied in child evaluation."
        )

    def test_lymphocytes_count_le_singlets(self):
        """D-2-B: Lymphocytes count <= Singlets count (hierarchical subset)."""
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )

        assert lymph.count <= sing.count, (
            f"D-2-B: Lymphocytes ({lymph.count}) > Singlets ({sing.count}): "
            "hierarchical mask not applied"
        )

    def test_lymphocytes_pct_of_parent(self):
        """
        D-2-C: pct_of_parent == round(lymph.count / singlets.count * 100, 2).

        Pass definition:
            |resp.pct_of_parent - expected_pct| <= 0.01.
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )

        if sing.count == 0:
            pytest.skip("Singlets gate empty — adjust bounds")

        expected_pct = round(lymph.count / sing.count * 100, 2)
        assert abs(lymph.pct_of_parent - expected_pct) <= 0.01, (
            f"D-2-C: pct_of_parent {lymph.pct_of_parent} != {expected_pct} "
            f"(lymph={lymph.count}, singlets={sing.count})"
        )

    def test_lymphocytes_matches_reference_counts_json(self):
        """
        D-2-D [optional]: Lymphocytes count is within ±0.1 % of reference_counts.json.

        Skipped if JSON absent or gate not listed.
        """
        if not os.path.exists(REF_COUNTS_PATH):
            pytest.skip("reference_counts.json not found")

        with open(REF_COUNTS_PATH) as f:
            ref = json.load(f)

        gate_defs = {g["name"]: g for g in ref.get("gates", [])}
        if "Lymphocytes" not in gate_defs:
            pytest.skip("Lymphocytes not in reference_counts.json")

        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )

        ref_count = gate_defs["Lymphocytes"]["expected_count"]
        assert _within_tolerance(lymph.count, ref_count), (
            f"D-2-D: Lymphocytes count {lymph.count} differs from reference {ref_count} "
            f"by more than {TOLERANCE_FRAC * 100:.1f}%"
        )


# ===========================================================================
# D-3: CD3+ — arcsinh rectangle gate on fluorescence channel, child of Lymphocytes
# ===========================================================================

@NEEDS_WBC
class TestCD3Gate:
    """D-3: CD3+ arcsinh gate; count must match hierarchical numpy reference exactly."""

    def test_cd3_count_exact(self):
        """
        D-3-A: CD3+ count == numpy count with Lymphocytes parent mask + arcsinh transform.

        Pass definition:
            resp.count == np.sum(lymph_mask & cd3_arcsinh_rect_mask), tolerance = 0.

        Inputs:
            BV605-A channel (0-based index 8); arcsinh cofactor = 150.

        Common errors:
            - Arcsinh not applied before gate test.
            - Wrong cofactor used.
            - Channel at index 8 is not BV605-A in this FCS (header mismatch).
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]   # BV605-A (CD3)
        all_mask = np.ones(events.shape[0], dtype=bool)

        _, sing_mask = _np_count_rect(
            events, all_mask, 0, 3,
            SINGLETS_X_MIN, SINGLETS_Y_MIN,
            SINGLETS_X_MAX, SINGLETS_Y_MAX,
        )
        _, lymph_mask = _np_count_rect(
            events, sing_mask, 0, 3,
            LYMPH_X_MIN, LYMPH_Y_MIN,
            LYMPH_X_MAX, LYMPH_Y_MAX,
        )

        expected, _ = _np_count_rect(
            events, lymph_mask, 8, 3,
            CD3_X_MIN, CD3_Y_MIN,
            CD3_X_MAX, CD3_Y_MAX,
            tx="arcsinh", ty="arcsinh",
        )

        sing_resp = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph_resp = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing_resp.id)
        )
        cd3_resp = gates_service.create_gate(
            _rect(fid, "CD3+", cd3_ch, ssc_a,
                  CD3_X_MIN, CD3_Y_MIN,
                  CD3_X_MAX, CD3_Y_MAX,
                  parent=lymph_resp.id,
                  tx="arcsinh", ty="arcsinh")
        )

        assert cd3_resp.count == expected, (
            f"D-3-A: CD3+ count {cd3_resp.count} != numpy {expected}. "
            f"Channel used: {cd3_ch!r} (index 8). "
            "Check arcsinh transform application in _get_mask."
        )

    def test_cd3_count_le_lymphocytes(self):
        """D-3-B: CD3+ count <= Lymphocytes count (subset property)."""
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )
        cd3 = gates_service.create_gate(
            _rect(fid, "CD3+", cd3_ch, ssc_a,
                  CD3_X_MIN, CD3_Y_MIN,
                  CD3_X_MAX, CD3_Y_MAX,
                  parent=lymph.id,
                  tx="arcsinh", ty="arcsinh")
        )

        assert cd3.count <= lymph.count, (
            f"D-3-B: CD3+ ({cd3.count}) > Lymphocytes ({lymph.count}): "
            "parent mask not applied"
        )

    def test_cd3_positive_population_nonzero(self):
        """
        D-3-C: CD3+ gate captures a non-trivial T-cell population (> 5 % of lymphocytes).

        Pass definition:
            cd3.count > 0.05 * lymph.count.

        This guards against a gate that silently captures 0 events because the
        channel name, index, or transform is wrong.
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )
        cd3 = gates_service.create_gate(
            _rect(fid, "CD3+", cd3_ch, ssc_a,
                  CD3_X_MIN, CD3_Y_MIN,
                  CD3_X_MAX, CD3_Y_MAX,
                  parent=lymph.id,
                  tx="arcsinh", ty="arcsinh")
        )

        if lymph.count == 0:
            pytest.skip("Lymphocytes gate empty — adjust bounds")

        frac = cd3.count / lymph.count
        assert frac >= 0.05, (
            f"D-3-C: CD3+ captured only {cd3.count} events ({frac:.1%} of lymphocytes). "
            f"Expected ≥5 %. Channel {cd3_ch!r} at index 8 may be wrong, "
            "or the arcsinh transform is not applied."
        )


# ===========================================================================
# D-4: CD4+ — arcsinh rectangle gate, child of CD3+
# ===========================================================================

@NEEDS_WBC
class TestCD4Gate:
    """D-4: CD4+ arcsinh gate nested inside CD3+; count matches numpy reference exactly."""

    def test_cd4_count_exact(self):
        """
        D-4-A: CD4+ count == numpy count with full ancestor mask cascade.

        Pass definition:
            resp.count == np.sum(cd3_mask & cd4_arcsinh_rect_mask), tolerance = 0.

        Inputs:
            BB515-A channel (0-based index 12); arcsinh cofactor = 150.
            Gate axes: BB515-A (x) × BV605-A (y).
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]    # BV605-A (CD3)
        cd4_ch = ch_map[12]   # BB515-A (CD4)
        all_mask = np.ones(events.shape[0], dtype=bool)

        _, sing_mask = _np_count_rect(
            events, all_mask, 0, 3,
            SINGLETS_X_MIN, SINGLETS_Y_MIN,
            SINGLETS_X_MAX, SINGLETS_Y_MAX,
        )
        _, lymph_mask = _np_count_rect(
            events, sing_mask, 0, 3,
            LYMPH_X_MIN, LYMPH_Y_MIN,
            LYMPH_X_MAX, LYMPH_Y_MAX,
        )
        _, cd3_mask = _np_count_rect(
            events, lymph_mask, 8, 3,
            CD3_X_MIN, CD3_Y_MIN,
            CD3_X_MAX, CD3_Y_MAX,
            tx="arcsinh", ty="arcsinh",
        )
        expected, _ = _np_count_rect(
            events, cd3_mask, 12, 8,
            CD4_X_MIN, CD4_Y_MIN,
            CD4_X_MAX, CD4_Y_MAX,
            tx="arcsinh", ty="arcsinh",
        )

        sing_r = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph_r = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing_r.id)
        )
        cd3_r = gates_service.create_gate(
            _rect(fid, "CD3+", cd3_ch, ssc_a,
                  CD3_X_MIN, CD3_Y_MIN,
                  CD3_X_MAX, CD3_Y_MAX,
                  parent=lymph_r.id,
                  tx="arcsinh", ty="arcsinh")
        )
        cd4_r = gates_service.create_gate(
            _rect(fid, "CD4+", cd4_ch, cd3_ch,
                  CD4_X_MIN, CD4_Y_MIN,
                  CD4_X_MAX, CD4_Y_MAX,
                  parent=cd3_r.id,
                  tx="arcsinh", ty="arcsinh")
        )

        assert cd4_r.count == expected, (
            f"D-4-A: CD4+ count {cd4_r.count} != numpy {expected}. "
            f"CD4 channel: {cd4_ch!r} (index 12), CD3 y-axis channel: {cd3_ch!r} (index 8)."
        )

    def test_cd4_count_le_cd3(self):
        """D-4-B: CD4+ count <= CD3+ count (subset property, 4-level hierarchy)."""
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]
        cd4_ch = ch_map[12]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )
        cd3 = gates_service.create_gate(
            _rect(fid, "CD3+", cd3_ch, ssc_a,
                  CD3_X_MIN, CD3_Y_MIN,
                  CD3_X_MAX, CD3_Y_MAX,
                  parent=lymph.id,
                  tx="arcsinh", ty="arcsinh")
        )
        cd4 = gates_service.create_gate(
            _rect(fid, "CD4+", cd4_ch, cd3_ch,
                  CD4_X_MIN, CD4_Y_MIN,
                  CD4_X_MAX, CD4_Y_MAX,
                  parent=cd3.id,
                  tx="arcsinh", ty="arcsinh")
        )

        assert cd4.count <= cd3.count, (
            f"D-4-B: CD4+ ({cd4.count}) > CD3+ ({cd3.count}): "
            "4-level parent mask cascade broken"
        )


# ===========================================================================
# D-5: Polygon gate on fluorescence channels (CD3+CD4-)
# ===========================================================================

@NEEDS_WBC
class TestPolygonFluorescence:
    """D-5: Polygon gate in arcsinh fluorescence space, child of Lymphocytes."""

    def test_cd3pos_cd4neg_polygon_count_le_lymphocytes(self):
        """
        D-5-A: CD3+CD4- polygon count <= Lymphocytes count (subset).

        Pass definition:
            poly.count <= lymph.count.

        This tests that polygons work correctly in a real hierarchical context
        with arcsinh-transformed fluorescence channels (not just synthetic data).
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]
        cd4_ch = ch_map[12]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )
        poly = gates_service.create_gate(
            _poly(fid, "CD3+CD4-", cd3_ch, cd4_ch,
                  vertices=CD3_POS_CD4_NEG_VERTICES,
                  parent=lymph.id)
        )

        assert poly.count <= lymph.count, (
            f"D-5-A: polygon ({poly.count}) > parent ({lymph.count}): "
            "hierarchical mask not applied in polygon evaluation"
        )

    def test_cd3pos_cd4neg_polygon_count_exact(self):
        """
        D-5-B: Polygon count matches axis-aligned bounding-rect numpy reference exactly.

        Since CD3_POS_CD4_NEG_VERTICES is a rectangle (4 corners), the polygon
        winding-number test is equivalent to the bounding-box test. Count must match.

        Pass definition:
            poly.count == _np_count_poly(events, lymph_mask, ...), tolerance = 0.
        """
        fid, events, ch_map = _load_wbc()
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]
        cd4_ch = ch_map[12]
        all_mask = np.ones(events.shape[0], dtype=bool)

        _, sing_mask = _np_count_rect(
            events, all_mask, 0, 3,
            SINGLETS_X_MIN, SINGLETS_Y_MIN,
            SINGLETS_X_MAX, SINGLETS_Y_MAX,
        )
        _, lymph_mask = _np_count_rect(
            events, sing_mask, 0, 3,
            LYMPH_X_MIN, LYMPH_Y_MIN,
            LYMPH_X_MAX, LYMPH_Y_MAX,
        )
        expected = _np_count_poly(
            events, lymph_mask, 8, 12,
            vertices=CD3_POS_CD4_NEG_VERTICES,
            tx="arcsinh", ty="arcsinh",
        )

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )
        poly = gates_service.create_gate(
            _poly(fid, "CD3+CD4-", cd3_ch, cd4_ch,
                  vertices=CD3_POS_CD4_NEG_VERTICES,
                  parent=lymph.id)
        )

        assert poly.count == expected, (
            f"D-5-B: polygon count {poly.count} != numpy bbox reference {expected}. "
            "Winding-number evaluator or parent-mask cascade broken."
        )


# ===========================================================================
# D-6: Full hierarchy — tree structure + count determinism
# ===========================================================================

@NEEDS_WBC
class TestFullHierarchy:
    """D-6: Complete 4-level WBC hierarchy; structural and statistical assertions."""

    def _build_hierarchy(self, fid: str, ch_map: dict) -> tuple:
        """Create the full Singlets → Lymphocytes → CD3+ → CD4+ hierarchy."""
        fsc_a = ch_map[0]
        ssc_a = ch_map[3]
        cd3_ch = ch_map[8]
        cd4_ch = ch_map[12]

        sing = gates_service.create_gate(
            _rect(fid, "Singlets", fsc_a, ssc_a,
                  SINGLETS_X_MIN, SINGLETS_Y_MIN,
                  SINGLETS_X_MAX, SINGLETS_Y_MAX)
        )
        lymph = gates_service.create_gate(
            _rect(fid, "Lymphocytes", fsc_a, ssc_a,
                  LYMPH_X_MIN, LYMPH_Y_MIN,
                  LYMPH_X_MAX, LYMPH_Y_MAX,
                  parent=sing.id)
        )
        cd3 = gates_service.create_gate(
            _rect(fid, "CD3+", cd3_ch, ssc_a,
                  CD3_X_MIN, CD3_Y_MIN,
                  CD3_X_MAX, CD3_Y_MAX,
                  parent=lymph.id,
                  tx="arcsinh", ty="arcsinh")
        )
        cd4 = gates_service.create_gate(
            _rect(fid, "CD4+", cd4_ch, cd3_ch,
                  CD4_X_MIN, CD4_Y_MIN,
                  CD4_X_MAX, CD4_Y_MAX,
                  parent=cd3.id,
                  tx="arcsinh", ty="arcsinh")
        )
        return sing, lymph, cd3, cd4

    def test_tree_depth_and_structure(self):
        """
        D-6-A: Tree depths are 0/1/2/3 and parent-child links are correct.

        Pass definition:
            tree[0].depth == 0
            tree[0].children[0].depth == 1
            tree[0].children[0].children[0].depth == 2
            tree[0].children[0].children[0].children[0].depth == 3
        """
        fid, events, ch_map = _load_wbc()
        self._build_hierarchy(fid, ch_map)

        tree = gates_service.get_gate_tree(fid)
        assert len(tree) == 1
        sing_node = tree[0]
        assert sing_node.depth == 0
        assert sing_node.name == "Singlets"
        assert len(sing_node.children) == 1

        lymph_node = sing_node.children[0]
        assert lymph_node.depth == 1
        assert lymph_node.name == "Lymphocytes"
        assert len(lymph_node.children) == 1

        cd3_node = lymph_node.children[0]
        assert cd3_node.depth == 2
        assert cd3_node.name == "CD3+"
        assert len(cd3_node.children) == 1

        cd4_node = cd3_node.children[0]
        assert cd4_node.depth == 3
        assert cd4_node.name == "CD4+"

    def test_counts_stable_across_tree_calls(self):
        """
        D-6-B: Counts are identical across 5 consecutive get_gate_tree calls.

        Pass definition:
            All 4 gate counts are identical on every iteration.

        Common errors:
            - np.random.choice in gate evaluation path (should only be in display).
            - Cache spuriously invalidated between calls.
        """
        fid, events, ch_map = _load_wbc()
        sing, lymph, cd3, cd4 = self._build_hierarchy(fid, ch_map)
        original_counts = {
            "Singlets": sing.count,
            "Lymphocytes": lymph.count,
            "CD3+": cd3.count,
            "CD4+": cd4.count,
        }

        for iteration in range(5):
            tree = gates_service.get_gate_tree(fid)
            sing_node = tree[0]
            lymph_node = sing_node.children[0]
            cd3_node = lymph_node.children[0]
            cd4_node = cd3_node.children[0]

            observed = {
                "Singlets": sing_node.count,
                "Lymphocytes": lymph_node.count,
                "CD3+": cd3_node.count,
                "CD4+": cd4_node.count,
            }
            for name, count in observed.items():
                assert count == original_counts[name], (
                    f"D-6-B: {name} count changed on iteration {iteration + 1}: "
                    f"got {count}, expected {original_counts[name]}"
                )

    def test_pct_of_parent_cascade(self):
        """
        D-6-C: pct_of_parent is correct at every level of the 4-level hierarchy.

        Pass definition:
            For each gate: |pct_of_parent - round(count / parent.count * 100, 2)| <= 0.01
        """
        fid, events, ch_map = _load_wbc()
        n_total = events.shape[0]
        sing, lymph, cd3, cd4 = self._build_hierarchy(fid, ch_map)

        pairs = [
            ("Singlets",    sing.count,  n_total,      sing.pct_of_parent),
            ("Lymphocytes", lymph.count, sing.count,   lymph.pct_of_parent),
            ("CD3+",        cd3.count,   lymph.count,  cd3.pct_of_parent),
            ("CD4+",        cd4.count,   cd3.count,    cd4.pct_of_parent),
        ]

        for name, count, parent_count, actual_pct in pairs:
            if parent_count == 0:
                pytest.skip(f"{name}: parent count is 0 — adjust gate bounds")
            expected_pct = round(count / parent_count * 100, 2)
            assert abs(actual_pct - expected_pct) <= 0.01, (
                f"D-6-C: {name} pct_of_parent {actual_pct} != {expected_pct} "
                f"(count={count}, parent={parent_count})"
            )

    def test_all_counts_nonzero(self):
        """
        D-6-D: All 4 gates capture at least 1 event.

        Pass definition:
            sing.count > 0, lymph.count > 0, cd3.count > 0, cd4.count > 0.

        A zero count for any gate indicates a wrong channel index, wrong bounds,
        or missing transform.
        """
        fid, events, ch_map = _load_wbc()
        sing, lymph, cd3, cd4 = self._build_hierarchy(fid, ch_map)

        assert sing.count > 0,  f"D-6-D: Singlets captured 0 events"
        assert lymph.count > 0, f"D-6-D: Lymphocytes captured 0 events"
        assert cd3.count > 0,   f"D-6-D: CD3+ captured 0 events (check channel index 8)"
        assert cd4.count > 0,   f"D-6-D: CD4+ captured 0 events (check channel index 12)"
