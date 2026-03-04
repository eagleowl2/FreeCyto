"""Per-channel transforms for flow cytometry: logicle, arcsinh, log, linear."""

from __future__ import annotations

import numpy as np


def transform_linear(x: np.ndarray) -> np.ndarray:
  return np.asarray(x, dtype=np.float64)


def transform_log(x: np.ndarray) -> np.ndarray:
  """Log10; clamp to 1 for non-positive to avoid -inf."""
  x = np.asarray(x, dtype=np.float64)
  return np.log10(np.maximum(x, 1.0))


def transform_arcsinh(
  x: np.ndarray,
  cofactor: float = 150.0,
) -> np.ndarray:
  """Arcsinh(x / cofactor). cofactor 150 typical for fluorescence, 5 for CyTOF."""
  x = np.asarray(x, dtype=np.float64)
  return np.arcsinh(x / cofactor) * cofactor


def transform_logicle(
  x: np.ndarray,
  t: float = 262144.0,
  w: float = 0.5,
  m: float = 4.5,
  a: float = 0.0,
) -> np.ndarray:
  """Logicle (biexponential) transform. Uses arcsinh-based approximation for stability."""
  x = np.asarray(x, dtype=np.float64)
  # Logicle-like: for MVP we use a scaled arcsinh that approximates logicle shape
  # (linear near 0, log-like for large values). Cofactor from T/W gives similar range.
  cofactor = t / (10 ** (m * w)) if w > 0 else 150.0
  return np.arcsinh(np.maximum(x + a, 0) / cofactor) * cofactor


TRANSFORMS = {
  "linear": transform_linear,
  "log": transform_log,
  "arcsinh": transform_arcsinh,
  "logicle": transform_logicle,
}


def apply_transform(
  column: np.ndarray,
  name: str,
  **kwargs: float,
) -> np.ndarray:
  """Apply a named transform to a 1D channel column."""
  if name not in TRANSFORMS:
    return transform_linear(column)
  fn = TRANSFORMS[name]
  if name == "arcsinh":
    return fn(column, cofactor=kwargs.get("arcsinh_cofactor", 150.0))
  if name == "logicle":
    return fn(
      column,
      t=kwargs.get("logicle_t", 262144.0),
      w=kwargs.get("logicle_w", 0.5),
      m=kwargs.get("logicle_m", 4.5),
      a=kwargs.get("logicle_a", 0.0),
    )
  return fn(column)
