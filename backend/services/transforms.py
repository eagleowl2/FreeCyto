"""Per-channel transforms for flow cytometry: logicle, arcsinh, log, linear."""

from __future__ import annotations

import warnings

import numpy as np
from flowutils.transforms import logicle


def transform_linear(x: np.ndarray) -> np.ndarray:
  return np.asarray(x, dtype=np.float64)


def transform_log(x: np.ndarray) -> np.ndarray:
  """Log10 transform with clamp.

  Values <= 0 are clamped to 1.0 before log10 to avoid -inf. This matches the
  common FlowJo-style behaviour of mapping non-positive values to the lowest
  displayable bin rather than erroring.
  """
  x = np.asarray(x, dtype=np.float64)
  return np.log10(np.maximum(x, 1.0))


def transform_arcsinh(
  x: np.ndarray,
  cofactor: float = 150.0,
) -> np.ndarray:
  """Arcsinh(x / cofactor). cofactor 150 typical for fluorescence, 5 for CyTOF."""
  x = np.asarray(x, dtype=np.float64)
  return np.arcsinh(x / cofactor)


def transform_logicle(
  x: np.ndarray,
  t: float = 262144.0,
  w: float = 0.5,
  m: float = 4.5,
  a: float = 0.0,
) -> np.ndarray:
  """Exact logicle transform via flowutils."""
  x = np.asarray(x, dtype=np.float64)
  # flowutils.logicle applies the transform to selected channels; here we treat the
  # 1D column as a single-channel array.
  data = x.reshape(-1, 1)
  out = logicle(data, channel_indices=[0], t=t, m=m, w=w, a=a)
  return out[:, 0]


def estimate_logicle_params(
  channel_data: np.ndarray,
  m: float = 4.5,
  instrument_range: float | None = None,
) -> dict:
  """Estimate logicle T and W.

  If instrument_range is provided (e.g. from $PnR / channel.range), it is used
  as T. Otherwise the maximum observed value in the data is used as a fallback.
  """
  data = np.asarray(channel_data, dtype=np.float64)
  if data.size == 0:
    return {"T": 262144.0, "W": 0.5, "M": m, "A": 0.0}
  if instrument_range is not None:
    t = float(instrument_range)
  else:
    t = float(np.max(data))
  neg = data[data < 0]
  if neg.size == 0:
    w = 0.5
  else:
    r = float(np.percentile(neg, 5))
    w = max(0.0, (m - np.log10(t / abs(r))) / 2)
  return {"T": t, "W": float(w), "M": m, "A": 0.0}


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
    warnings.warn(f"Unknown transform {name!r}; falling back to linear.", stacklevel=2)
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
