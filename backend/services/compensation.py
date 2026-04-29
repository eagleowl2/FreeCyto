from __future__ import annotations

import numpy as np

from services import gates as gates_service, storage
from models.file_models import FileMetadata


def parse_spillover_string(raw: str) -> tuple[list[str], np.ndarray] | None:
  """Parse a raw $SPILLOVER / $SPILL FCS string into (channel_names, matrix).

  FCS 3.1 format: "N,name1,...,nameN,s11,s12,...,sNN"

  Returns:
      (channel_names, (N, N) float64 matrix), or None if the string is invalid.
  """
  if not raw or not raw.strip():
    return None
  parts = [p.strip() for p in raw.split(",")]
  try:
    n = int(parts[0])
  except (ValueError, IndexError):
    return None
  if n <= 0 or len(parts) < 1 + n + n * n:
    return None
  channel_names = parts[1 : 1 + n]
  try:
    values = [float(v) for v in parts[1 + n : 1 + n + n * n]]
  except ValueError:
    return None
  matrix = np.array(values, dtype=np.float64).reshape((n, n))
  return channel_names, matrix


def apply_compensation(
  file_id: str,
  spillover: list[list[float]],
  channel_names: list[str] | None = None,
) -> float:
  """Apply a spillover/compensation matrix to events for a file.

  When ``channel_names`` is provided (the FCS-standard partial-apply path),
  the N×N matrix is applied only to those channels; other channels (FSC, SSC,
  Time, …) are left unchanged.  The condition number is that of the N×N sub-
  matrix, not the full event matrix.

  When ``channel_names`` is None (legacy path), the matrix must be square with
  dimension == total channel count and is applied to all channels.

  Returns the condition number of the spillover matrix.
  """
  meta = storage.get_file_metadata(file_id)
  ensure_linear_amplification(meta)
  events = storage.get_raw_events(file_id)
  s = np.asarray(spillover, dtype=np.float64)
  if s.ndim != 2 or s.shape[0] != s.shape[1]:
    raise ValueError("spillover matrix must be square")

  cond = float(np.linalg.cond(s))

  if channel_names is not None:
    # Partial-channel compensation: resolve names → column indices.
    ch_map = {ch.name: ch.index - 1 for ch in meta.channels}
    # Also try matching by display_name and stain for flexibility.
    for ch in meta.channels:
      if ch.display_name:
        ch_map.setdefault(ch.display_name, ch.index - 1)
      if ch.stain:
        ch_map.setdefault(ch.stain, ch.index - 1)

    indices: list[int] = []
    missing: list[str] = []
    for name in channel_names:
      idx = ch_map.get(name)
      if idx is None:
        missing.append(name)
      else:
        indices.append(idx)
    if missing:
      raise ValueError(
        f"Spillover channel(s) not found in file: {missing!r}. "
        f"Available names: {list(ch_map.keys())[:10]}"
      )
    if len(indices) != s.shape[0]:
      raise ValueError(
        f"channel_names length ({len(indices)}) does not match spillover "
        f"dimension ({s.shape[0]})"
      )

    # Apply S only to the N fluorescence columns; copy all other columns unchanged.
    corrected = events.copy().astype(np.float64)
    sub = events[:, indices].astype(np.float64)
    try:
      corrected[:, indices] = np.linalg.solve(s.T, sub.T).T
    except np.linalg.LinAlgError as exc:
      raise ValueError(f"spillover matrix not invertible: {exc}") from exc
  else:
    # Legacy full-matrix path: dimensions must match all channels.
    if events.shape[1] != s.shape[0]:
      raise ValueError(
        f"spillover dimension {s.shape} does not match event channels "
        f"{events.shape[1]}. Provide channel_names for partial compensation."
      )
    try:
      corrected = np.linalg.solve(s.T, events.T).T
    except np.linalg.LinAlgError as exc:
      raise ValueError(f"spillover matrix not invertible: {exc}") from exc

  storage.set_compensation(file_id, corrected, s, cond)
  gates_service.invalidate_file_caches(file_id)
  from services import derived_params as dp_service
  dp_service.invalidate_file_caches(file_id)
  return cond


def parse_spillover_from_metadata(meta: FileMetadata) -> np.ndarray | None:
  """Parse the $SPILLOVER / $SPILL string into a square numpy matrix.

  Returns (N, N) float64 matrix, or None if no valid spillover is present.
  Use ``parse_spillover_string`` to also get channel names.
  """
  raw = meta.spillover_str
  result = parse_spillover_string(raw or "")
  if result is None:
    return None
  _, matrix = result
  return matrix


def _has_log_amplification(meta: FileMetadata) -> bool:
  """Return True if any channel has non-zero $PiE f1 (log amplification)."""
  for ch in meta.channels:
    if not ch.amplification:
      continue
    parts = [p.strip() for p in ch.amplification.split(",")]
    if not parts:
      continue
    try:
      f1 = float(parts[0])
    except ValueError:
      continue
    if f1 != 0.0:
      return True
  return False


def ensure_linear_amplification(meta: FileMetadata) -> None:
  """Raise if any channel uses log amplification ($PiE f1 != 0)."""
  if _has_log_amplification(meta):
    raise NotImplementedError(
      "Compensation on log-amplified files ($PiE f1 != 0) is not supported. "
      "Please export data in linear scale before applying spillover.",
    )


