"""Shared pytest fixtures for backend tests."""

from __future__ import annotations

import os
import sys
import tempfile

# Isolate on-disk persistence (layouts, experiments, groups) to a throwaway dir for
# the whole test session, so running the suite never overwrites a real user's
# ~/.freecyto/*.json. Set BEFORE importing services — their singletons load on import.
# Tests that need their own data dir still override this via monkeypatch.setenv.
if "OPENCYTO_DATA_DIR" not in os.environ:
  os.environ["OPENCYTO_DATA_DIR"] = tempfile.mkdtemp(prefix="freecyto_test_data_")

import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
  sys.path.insert(0, BACKEND_ROOT)

from services import derived_params as dp_service
from services import gates as gates_service
from services import groups as groups_service
from services import storage


@pytest.fixture(autouse=True)
def clean_store_and_gates():
  """Clear file store, gate store, group store, and derived param store so tests do not leak state (ARCH-1)."""
  for fid in list(storage.list_loaded_file_ids()):
    try:
      storage.delete_file(fid)
    except KeyError:
      pass
  gates_service.reset_gate_store()
  groups_service.reset_group_store()
  dp_service.reset_derived_param_store()
  yield
  for fid in list(storage.list_loaded_file_ids()):
    try:
      storage.delete_file(fid)
    except KeyError:
      pass
  gates_service.reset_gate_store()
  groups_service.reset_group_store()
  dp_service.reset_derived_param_store()
