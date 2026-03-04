from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from flowio import FlowData

from services import storage
from models.file_models import ChannelMetadata, FileMetadata


@dataclass
class ParsedFile:
  metadata: FileMetadata
  events: np.ndarray  # full event matrix (events x channels)


_lock = threading.Lock()


def _extract_metadata(path: Path, flow: FlowData) -> Tuple[FileMetadata, np.ndarray]:
  text = flow.text
  raw_events = flow.events

  # FlowIO exposes channel information via the TEXT segment ($PnN, $PnS, etc.).
  # `flow.channels` may be a mapping keyed by index, so we explicitly iterate
  # over numeric indices and pull names from TEXT.
  try:
    n_channels = len(flow.channels)
  except Exception:
    # Fallback to $PAR if flow.channels is not sized
    n_channels = int(text.get("$PAR", 0))

  # FlowIO can return array.array or other types; ensure we store a 2D numpy array
  events = np.asarray(raw_events, dtype=np.float64)
  if events.ndim == 1:
    n_events = int(flow.event_count)
    events = events.reshape(n_events, n_channels)

  channels: List[ChannelMetadata] = []
  for i in range(1, n_channels + 1):
    name = text.get(f"$P{i}N") or str(i)
    stain = text.get(f"$P{i}S")
    rng_raw = text.get(f"$P{i}R")
    amplification = text.get(f"$P{i}E")
    try:
      rng = float(rng_raw) if rng_raw is not None else None
    except ValueError:
      rng = None

    channels.append(
      ChannelMetadata(
        index=i,
        name=name,
        stain=stain,
        range=rng,
        amplification=amplification,
      )
    )

  sample_name = text.get("$SM") or text.get("$SRC")
  instrument = text.get("$CYT")
  operator = text.get("$OP")
  acquisition_datetime = text.get("$DATE")

  file_id = str(uuid.uuid4())

  metadata = FileMetadata(
    id=file_id,
    path=str(path),
    sample_name=sample_name,
    instrument=instrument,
    operator=operator,
    acquisition_datetime=acquisition_datetime,
    event_count=int(flow.event_count),
    channels=channels,
  )

  return metadata, events


def load_fcs_file(path_str: str) -> ParsedFile:
  """Parse a single FCS file into metadata and event matrix."""
  path = Path(path_str).expanduser().resolve()
  if not path.exists():
    raise FileNotFoundError(path)

  flow = FlowData(str(path))
  metadata, events = _extract_metadata(path, flow)
  return ParsedFile(metadata=metadata, events=events)


def load_and_register_files(paths: List[str]) -> List[FileMetadata]:
  """Load FCS files and register them in the in-memory store."""
  parsed: List[ParsedFile] = []
  for p in paths:
    parsed.append(load_fcs_file(p))

  with _lock:
    for pf in parsed:
      storage.register_file(pf.metadata, pf.events)

  return [pf.metadata for pf in parsed]

