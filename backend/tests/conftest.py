"""Shared pytest fixtures for backend tests."""

from __future__ import annotations

import os
import sys

import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
  sys.path.insert(0, BACKEND_ROOT)

from services import gates as gates_service
from services import storage


@pytest.fixture(autouse=True)
def clean_store_and_gates():
  """Clear file store and gate store so tests do not leak state (ARCH-1)."""
  for fid in list(storage.list_loaded_file_ids()):
    try:
      storage.delete_file(fid)
    except KeyError:
      pass
  gates_service.reset_gate_store()
  yield
  for fid in list(storage.list_loaded_file_ids()):
    try:
      storage.delete_file(fid)
    except KeyError:
      pass
  gates_service.reset_gate_store()
