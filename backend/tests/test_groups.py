"""Phase K — Sample groups, gating templates, and batch statistics tests."""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import GateCreateRequest, RectangleGateCreate
from services import gates as gates_service
from services import groups as groups_service
from services import storage


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_file(n_events: int = 500, seed: int = 1, file_id: str | None = None) -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 2)).astype(np.float32)
    fid = file_id or f"test_{seed}"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return fid


def _add_rect_gate(file_id: str, name: str, x_min: float = 100, y_min: float = 100,
                   x_max: float = 900, y_max: float = 900, parent: str | None = None) -> str:
    req = GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel="FSC-A",
        y_channel="SSC-A",
        parent_gate_id=parent,
        params=RectangleGateCreate(type="rectangle", x_min=x_min, y_min=y_min, x_max=x_max, y_max=y_max),
    )
    resp = gates_service.create_gate(req)
    return resp.id


# ---------------------------------------------------------------------------
# Group CRUD
# ---------------------------------------------------------------------------


class TestGroupCRUD:
    def test_create_group(self):
        """Create a group with two files and verify response fields."""
        fid1 = _make_file(seed=1)
        fid2 = _make_file(seed=2, file_id="test_2")
        grp = groups_service.create_group("MyGroup", [fid1, fid2])
        assert grp.name == "MyGroup"
        assert len(grp.samples) == 2
        assert {s.file_id for s in grp.samples} == {fid1, fid2}
        assert grp.id
        assert grp.template_id is None

    def test_get_group(self):
        """get_group returns same data as create_group."""
        fid = _make_file()
        created = groups_service.create_group("G", [fid])
        retrieved = groups_service.get_group(created.id)
        assert retrieved.id == created.id
        assert retrieved.name == created.name
        assert retrieved.samples[0].file_id == fid

    def test_get_group_not_found(self):
        """get_group raises KeyError for unknown ID."""
        with pytest.raises(KeyError):
            groups_service.get_group("nonexistent-id")

    def test_list_groups(self):
        """list_groups returns all created groups."""
        fid = _make_file()
        groups_service.create_group("A", [fid])
        groups_service.create_group("B", [fid])
        lst = groups_service.list_groups()
        assert len(lst) == 2
        names = {g.name for g in lst}
        assert names == {"A", "B"}

    def test_delete_group(self):
        """delete_group removes the group from the store."""
        fid = _make_file()
        grp = groups_service.create_group("ToDelete", [fid])
        groups_service.delete_group(grp.id)
        with pytest.raises(KeyError):
            groups_service.get_group(grp.id)

    def test_delete_group_not_found(self):
        """delete_group raises KeyError for unknown ID."""
        with pytest.raises(KeyError):
            groups_service.delete_group("nonexistent-id")

    def test_sample_labels_use_filename(self):
        """Sample labels are derived from file path basename."""
        fid = _make_file(file_id="test_label")
        grp = groups_service.create_group("G", [fid])
        # Path is /test/test_label.fcs, basename = "test_label.fcs"
        assert grp.samples[0].label == "test_label.fcs"


# ---------------------------------------------------------------------------
# Gating templates
# ---------------------------------------------------------------------------


class TestGatingTemplate:
    def test_create_template_from_file_with_gates(self):
        """create_template extracts gate definitions from a source file."""
        fid = _make_file()
        lid = _add_rect_gate(fid, "Lymphocytes")
        _add_rect_gate(fid, "CD4+", parent=lid)

        grp = groups_service.create_group("G", [fid])
        tpl = groups_service.create_template(grp.id, fid, "MyTemplate")

        assert tpl.id
        assert tpl.name == "MyTemplate"
        assert tpl.source_file_id == fid
        assert len(tpl.gates) == 2

        gate_names = {g.name for g in tpl.gates}
        assert gate_names == {"Lymphocytes", "CD4+"}

    def test_template_parent_name_preserved(self):
        """Template gates record their parent gate name (not ID)."""
        fid = _make_file()
        lid = _add_rect_gate(fid, "Lymph")
        _add_rect_gate(fid, "Child", parent=lid)
        grp = groups_service.create_group("G", [fid])
        tpl = groups_service.create_template(grp.id, fid, "T")

        child = next(g for g in tpl.gates if g.name == "Child")
        assert child.parent_name == "Lymph"

        root = next(g for g in tpl.gates if g.name == "Lymph")
        assert root.parent_name is None

    def test_create_template_group_not_found(self):
        """create_template raises KeyError for unknown group."""
        fid = _make_file()
        with pytest.raises(KeyError):
            groups_service.create_template("nonexistent", fid, "T")

    def test_group_template_id_set_after_create(self):
        """group.template_id is set after create_template."""
        fid = _make_file()
        grp = groups_service.create_group("G", [fid])
        assert grp.template_id is None
        tpl = groups_service.create_template(grp.id, fid, "T")
        grp2 = groups_service.get_group(grp.id)
        assert grp2.template_id == tpl.id


class TestApplyTemplate:
    def test_apply_template_creates_gates_on_target(self):
        """Applying a template to a new file creates corresponding gates."""
        src = _make_file(seed=10, file_id="src")
        tgt = _make_file(seed=20, file_id="tgt")
        _add_rect_gate(src, "Lymphocytes")

        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        ids = groups_service.apply_template(tpl.id, tgt)

        assert len(ids) == 1
        tgt_gates = gates_service.list_gates(tgt)
        assert any(g.name == "Lymphocytes" for g in tgt_gates)

    def test_apply_template_hierarchy(self):
        """Multi-level hierarchy is correctly reproduced on the target file."""
        src = _make_file(seed=10, file_id="src_h")
        tgt = _make_file(seed=20, file_id="tgt_h")
        lid = _add_rect_gate(src, "Lymph")
        _add_rect_gate(src, "T cells", parent=lid)

        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        ids = groups_service.apply_template(tpl.id, tgt)

        assert len(ids) == 2
        tgt_gates = {g.name: g for g in gates_service.list_gates(tgt)}
        assert "Lymph" in tgt_gates
        assert "T cells" in tgt_gates
        # T cells should be child of Lymph
        assert tgt_gates["T cells"].parent_gate_id == tgt_gates["Lymph"].id

    def test_apply_template_idempotent(self):
        """Applying the same template twice skips duplicate names, no error."""
        src = _make_file(seed=10, file_id="src_idem")
        tgt = _make_file(seed=20, file_id="tgt_idem")
        _add_rect_gate(src, "G1")
        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        ids1 = groups_service.apply_template(tpl.id, tgt)
        ids2 = groups_service.apply_template(tpl.id, tgt)
        # Second apply creates 0 new gates (all duplicate)
        assert len(ids1) == 1
        assert len(ids2) == 0

    def test_apply_template_not_found(self):
        """apply_template raises KeyError for unknown template_id."""
        tgt = _make_file()
        with pytest.raises(KeyError):
            groups_service.apply_template("nonexistent-tpl", tgt)


# ---------------------------------------------------------------------------
# Batch statistics
# ---------------------------------------------------------------------------


class TestBatchStats:
    def test_batch_stats_returns_row_per_file(self):
        """get_batch_stats returns one row per sample in the group."""
        fid1 = _make_file(seed=1, file_id="bs1")
        fid2 = _make_file(seed=2, file_id="bs2")
        _add_rect_gate(fid1, "Gate1")
        _add_rect_gate(fid2, "Gate1")

        grp = groups_service.create_group("G", [fid1, fid2])
        stats = groups_service.get_batch_stats(grp.id, "Gate1")

        assert stats.gate_name == "Gate1"
        assert len(stats.rows) == 2
        assert {r.file_id for r in stats.rows} == {fid1, fid2}

    def test_batch_stats_counts_are_positive(self):
        """Gate counts in batch stats match individual gate counts."""
        fid = _make_file(n_events=1000, seed=5, file_id="bs_cnt")
        _add_rect_gate(fid, "Lymph", x_min=200, y_min=200, x_max=800, y_max=800)
        grp = groups_service.create_group("G", [fid])
        stats = groups_service.get_batch_stats(grp.id, "Lymph")

        row = stats.rows[0]
        individual = next(g for g in gates_service.list_gates(fid) if g.name == "Lymph")
        assert row.count == individual.count
        assert row.pct_of_parent == individual.pct_of_parent

    def test_batch_stats_missing_gate_returns_zeros(self):
        """Files without the named gate return count=0 row (not error)."""
        fid = _make_file(seed=3, file_id="bs_miss")
        # Gate "NoGate" does not exist on fid
        grp = groups_service.create_group("G", [fid])
        stats = groups_service.get_batch_stats(grp.id, "NoGate")

        assert len(stats.rows) == 1
        assert stats.rows[0].count == 0

    def test_batch_stats_group_not_found(self):
        """get_batch_stats raises KeyError for unknown group."""
        with pytest.raises(KeyError):
            groups_service.get_batch_stats("nonexistent", "G1")

    def test_reset_group_store(self):
        """reset_group_store clears all groups and templates."""
        fid = _make_file()
        groups_service.create_group("G", [fid])
        groups_service.reset_group_store()
        assert groups_service.list_groups() == []
