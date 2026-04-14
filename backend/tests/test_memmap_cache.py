"""
Memmap cache behaviour (MM-3/MM-4/MM-5): disk cache lifecycle and fast re-register.
"""

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
from services import cache as cache_service
from services import fcs_parser
from services import storage


def _register_synthetic(
  file_id: str,
  n_events: int = 50,
  n_channels: int = 2,
) -> None:
  """Write raw memmap and register a FileRecord. Requires get_cache_dir patched."""
  events = np.ones((n_events, n_channels), dtype=np.float32)
  channels = [
    ChannelMetadata(
      name=f"CH{i + 1}",
      index=i + 1,
      stain=None,
      range=1024.0,
      amplification=None,
      display_name=f"CH{i + 1}",
    )
    for i in range(n_channels)
  ]
  meta = FileMetadata(
    id=file_id,
    path=f"/tmp/{file_id}.fcs",
    sample_name="s",
    event_count=n_events,
    channels=channels,
  )
  storage.register_file(meta, events)


@pytest.fixture
def tmp_cache_dir(tmp_path, monkeypatch):
  monkeypatch.setattr(cache_service, "get_cache_dir", lambda override=None: tmp_path)
  yield tmp_path


class TestDeleteClearsDisk:
  def test_delete_file_removes_raw_mmap(self, tmp_cache_dir):
    fid = "del_test_id"
    _register_synthetic(fid)
    raw_path = cache_service.raw_mmap_path(fid, tmp_cache_dir)
    assert raw_path.is_file()
    storage.delete_file(fid)
    assert not raw_path.exists()


class TestEvictionClearsDisk:
  def test_lru_eviction_removes_oldest_disk_cache(self, tmp_cache_dir, monkeypatch):
    monkeypatch.setattr(storage, "MAX_CACHE_BYTES", 0)
    a, b = "evict_a", "evict_b"
    _register_synthetic(a, n_events=1000, n_channels=4)
    path_a = cache_service.raw_mmap_path(a, tmp_cache_dir)
    assert path_a.is_file()
    _register_synthetic(b, n_events=1000, n_channels=4)
    assert storage.list_loaded_file_ids() == [b]
    assert not path_a.exists(), "LRU eviction should clear on-disk cache for evicted file id"
    assert cache_service.raw_mmap_path(b, tmp_cache_dir).is_file()


def _minimal_fcs_text_dict() -> dict[str, str]:
  """TEXT keywords sufficient for _assert_list_mode_fcs_text + channel names."""
  return {
    "$PAR": "2",
    "$MODE": "L",
    "$DATATYPE": "F",
    "$NEXTDATA": "0",
    "$TOT": "999",
    "$P1N": "CH1",
    "$P2N": "CH2",
  }


class TestMM5FastPath:
  def test_load_fcs_file_uses_text_only_when_raw_exists(
    self, tmp_cache_dir, monkeypatch,
  ):
    file_id = "mm5_stable"
    dummy = tmp_cache_dir / "dummy.fcs"
    dummy.write_bytes(b"x" * 200)
    monkeypatch.setattr(fcs_parser, "_stable_file_id", lambda _path: file_id)

    mmap_path = cache_service.raw_mmap_path(file_id, tmp_cache_dir)
    mm = np.lib.format.open_memmap(
      str(mmap_path), mode="w+", dtype=np.float32, shape=(7, 2),
    )
    mm[:] = 3.0
    del mm

    monkeypatch.setattr(fcs_parser, "_fcs_text_only", lambda *_a, **_k: _minimal_fcs_text_dict())
    monkeypatch.setattr(
      fcs_parser.flowio,
      "FlowData",
      lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("full FlowData must not run")),
    )

    meta, mmap_path = fcs_parser._load_fcs_file(str(dummy))
    assert meta.event_count == 7
    assert mmap_path.is_file()
    mm = np.lib.format.open_memmap(str(mmap_path), mode="r")
    try:
      assert mm.shape == (7, 2)
      assert float(mm[0, 0]) == pytest.approx(3.0)
    finally:
      del mm

    out = fcs_parser.load_and_register_file(dummy)
    assert out.event_count == 7
    ev = storage.get_raw_events(file_id)
    assert ev.shape == (7, 2)
    assert float(ev[0, 0]) == pytest.approx(3.0)


class TestML1MemmapWriteAbort:
  def test_parse_events_removes_partial_npy_on_write_failure(self, tmp_cache_dir, monkeypatch):
    """ML-1: exception during chunked memmap write deletes partial cache file."""
    from types import SimpleNamespace

    file_id = "ml1_abort"
    mmap_path = cache_service.raw_mmap_path(file_id, tmp_cache_dir)
    tmp_path = cache_service.raw_mmap_tmp_path(file_id, tmp_cache_dir)
    for p in (mmap_path, tmp_path):
      if p.exists():
        p.unlink()

    monkeypatch.setattr(fcs_parser, "_PARSE_CHUNK_EVENTS", 5)
    count: list[int] = []
    orig = fcs_parser._apply_bitmask

    def boom(events, text, n_channels, datatype):
      count.append(1)
      if len(count) >= 2:
        raise RuntimeError("simulated write failure")
      return orig(events, text, n_channels, datatype)

    monkeypatch.setattr(fcs_parser, "_apply_bitmask", boom)

    fake_fcs = SimpleNamespace(events=[0.0] * 30)
    text = {"$PAR": "2", "$MODE": "L", "$DATATYPE": "F"}
    with pytest.raises(RuntimeError, match="simulated write failure"):
      fcs_parser._parse_events_to_memmap(
        fake_fcs,
        file_id,
        n_events_header=15,
        n_channels=2,
        text=text,
        datatype="F",
        source_display="test",
      )
    assert not tmp_path.exists(), "partial tmp memmap must be removed"
    assert not mmap_path.exists(), "final .npy must not exist after failed write"


class TestMM5ChannelMismatch:
  def test_raises_when_mmap_channels_differ_from_text(self, tmp_cache_dir, monkeypatch):
    file_id = "mm5_mismatch"
    dummy = tmp_cache_dir / "dummy2.fcs"
    dummy.write_bytes(b"y" * 200)
    monkeypatch.setattr(fcs_parser, "_stable_file_id", lambda _path: file_id)

    mmap_path = cache_service.raw_mmap_path(file_id, tmp_cache_dir)
    mm = np.lib.format.open_memmap(
      str(mmap_path), mode="w+", dtype=np.float32, shape=(3, 3),
    )
    mm[:] = 0
    del mm

    monkeypatch.setattr(
      fcs_parser,
      "_fcs_text_only",
      lambda *_a, **_k: {"$PAR": "1", "$MODE": "L", "$DATATYPE": "F", "$NEXTDATA": "0", "$TOT": "3", "$P1N": "CH1"},
    )
    monkeypatch.setattr(
      cache_service,
      "raw_mmap_is_readable",
      lambda *a, **k: True,
    )
    monkeypatch.setattr(
      fcs_parser.flowio,
      "FlowData",
      lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("full FlowData must not run")),
    )

    with pytest.raises(ValueError, match="Cached memmap"):
      fcs_parser._load_fcs_file(str(dummy))
