from __future__ import annotations

from typing import List

import numpy as np

from services import storage


def apply_compensation(
  file_id: str,
  spillover: List[List[float]],
) -> float:
  """Apply a spillover/compensation matrix to all channels for a file.

  Uses a numerically stable solve instead of explicit matrix inversion and
  records both the compensated events and the condition number of the matrix.
  Returns the condition number.
  """
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
  return float(cond)


