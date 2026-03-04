from __future__ import annotations

from typing import List

import numpy as np

from services import storage


def apply_compensation(
  file_id: str,
  spillover: List[List[float]],
) -> None:
  """Apply a spillover/compensation matrix to all channels for a file.

  For MVP we:
  - Assume spillover is square (n_channels x n_channels)
  - Apply to all channels in order
  - Overwrite the stored events matrix in-place
  """
  events = storage.get_file_events(file_id)
  s = np.asarray(spillover, dtype=np.float64)
  if s.ndim != 2 or s.shape[0] != s.shape[1]:
    raise ValueError("spillover matrix must be square")
  if events.shape[1] != s.shape[0]:
    raise ValueError(
      f"spillover dimension {s.shape} does not match event channels {events.shape[1]}"
    )

  try:
    inv_s = np.linalg.inv(s)
  except np.linalg.LinAlgError as exc:
    raise ValueError(f"spillover matrix not invertible: {exc}") from exc

  corrected = events @ inv_s
  storage.set_file_events(file_id, corrected)

