from __future__ import annotations

import numpy as np

from services import gates as gates_service, storage
from models.file_models import FileMetadata


def apply_compensation(
  file_id: str,
  spillover: list[list[float]],
) -> float:
  """Apply a spillover/compensation matrix to all channels for a file.

  Uses a numerically stable solve instead of explicit matrix inversion and
  records both the compensated events and the condition number of the matrix.
  Returns the condition number.
  """
  ensure_linear_amplification(storage.get_file_metadata(file_id))
  events = storage.get_raw_events(file_id)
  s = np.asarray(spillover, dtype=np.float64)
  if s.ndim != 2 or s.shape[0] != s.shape[1]:
    raise ValueError("spillover matrix must be square")
  if events.shape[1] != s.shape[0]:
    raise ValueError(
      f"spillover dimension {s.shape} does not match event channels {events.shape[1]}"
    )

  cond = np.linalg.cond(s)

  try:
    # Solve S^T x^T = events^T for x instead of computing S^{-1}.
    corrected = np.linalg.solve(s.T, events.T).T
  except np.linalg.LinAlgError as exc:
    raise ValueError(f"spillover matrix not invertible: {exc}") from exc

  storage.set_compensation(file_id, corrected, s, cond)
  gates_service.invalidate_file_caches(file_id)
  return float(cond)


def parse_spillover_from_metadata(meta: FileMetadata) -> np.ndarray | None:
  """Parse the $SPILLOVER / $SPILL string into a square numpy matrix.

  Spillover string format (FCS 3.1):
      "N,name1,name2,...,nameN,s11,s12,...,sNN"

  Returns:
      (N, N) float64 matrix, or None if no valid spillover is present.
  """
  raw = meta.spillover_str
  if not raw or not raw.strip():
    return None

  parts = [p.strip() for p in raw.split(",")]
  try:
    n = int(parts[0])
  except (ValueError, IndexError):
    return None

  if len(parts) < 1 + n + n * n:
    return None

  try:
    values = [float(v) for v in parts[1 + n : 1 + n + n * n]]
  except ValueError:
    return None

  matrix = np.array(values, dtype=np.float64).reshape((n, n))
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


