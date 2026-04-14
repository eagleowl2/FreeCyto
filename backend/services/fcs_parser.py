from __future__ import annotations

import hashlib
import os
import re
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import flowio

from models.file_models import ChannelMetadata, FileMetadata
from services import storage
from services import cache as cache_service

_PER_CHANNEL_DTYPE_RE = re.compile(r"^\$P\d+DATATYPE$")

_PARSE_CHUNK_EVENTS = 50_000


def _normalize_fcs_text_key(key: object) -> str:
  """Normalise FlowIO TEXT keys to FCS convention (``$PAR``, ``$P1N``, …).

  FlowIO often omits the leading ``$`` (``par``, ``p1n``). Our lookups use ``$``-prefixed keys.
  Keys that already start with ``$`` are only upper-cased so we never produce ``$$PAR``.
  """
  s = str(key).strip().upper()
  if not s:
    return s
  return s if s.startswith("$") else f"${s}"


@dataclass
class _ChannelAlias:
  """Derived alias data for a single channel. Internal use only."""

  index: int          # 1-based, matching FCS convention
  name: str           # $PiN — raw instrument name, e.g. "FL1-A"
  stain: str | None   # $PiS — reagent/marker, e.g. "CD19 BV421"; None if absent/duplicate
  display_name: str   # "FL1-A :: CD19 BV421" or "FL1-A"


def _first(text: dict[str, str], keys: list[str]) -> str | None:
  """Return the first non-empty value found for any key in the list.

  Assumes ``text`` keys are normalised via :func:`_normalize_fcs_text_key` (``$`` + upper case).
  """
  for key in keys:
    val = text.get(key)
    if val is not None:
      clean = val.strip()
      if clean:
        return clean
  return None


def _decode_stain(raw: str | None) -> str | None:
  """Normalise a stain string from the FCS TEXT segment."""
  if not raw:
    return None
  try:
    decoded = raw.encode("latin-1").decode("utf-8")
  except (UnicodeEncodeError, UnicodeDecodeError):
    decoded = raw
  clean = decoded.strip()
  return clean if clean else None


def _extract_channel_aliases(text: dict[str, str], n_channels: int) -> list[_ChannelAlias]:
  """Build per-channel alias records from a normalised TEXT dict."""
  aliases: list[_ChannelAlias] = []
  for i in range(1, n_channels + 1):
    name_keys = [f"$P{i}N", f"$P{i:02d}N", f"$P{i:03d}N"]
    stain_keys = [f"$P{i}S", f"$P{i:02d}S", f"$P{i:03d}S"]

    name = _first(text, name_keys) or f"CH{i}"
    raw_stain = _first(text, stain_keys)
    stain = _decode_stain(raw_stain)
    if stain and stain.strip().lower() == name.strip().lower():
      stain = None

    display_name = f"{name} :: {stain}" if stain else name
    aliases.append(_ChannelAlias(index=i, name=name, stain=stain, display_name=display_name))
  missing_names = sum(1 for a in aliases if a.name.startswith("CH"))
  if missing_names >= max(2, int(n_channels * 0.1)):
    warnings.warn(
      f"[FCS] {missing_names}/{n_channels} channels have no $PiN; "
      "TEXT segment may have been mis-parsed or channel names are missing.",
    )
  return aliases


def _apply_bitmask(
  events: np.ndarray,
  text: dict[str, str],
  n_channels: int,
  datatype: str,
) -> np.ndarray:
  """Mask integer-valued channels to their declared $PiR range before float conversion."""
  if datatype.upper() not in {"I"}:
    return events.astype(np.float32)

  out = events.copy().astype(np.int64)
  for i in range(1, n_channels + 1):
    range_str = _first(text, [f"$P{i}R", f"$P{i:02d}R"])
    if not range_str:
      continue
    try:
      p_range = int(float(range_str))
    except ValueError:
      continue
    if p_range <= 0:
      continue
    # BUG-4: ceil(log2(p_range+1)) is one bit too wide when p_range is an exact power of two
    # (e.g. 65536 → 17 bits instead of 16 for values 0..65535). Use bit_length of (p_range - 1).
    n_bits = (p_range - 1).bit_length() if p_range > 1 else 1
    mask = (1 << n_bits) - 1
    col = i - 1
    out[:, col] = out[:, col] & mask

  return out.astype(np.float32)


def _extract_spillover(text: dict[str, str]) -> str | None:
  """Return the raw spillover string, checking both $SPILLOVER and $SPILL."""
  return _first(text, ["$SPILLOVER"]) or _first(text, ["$SPILL"])


def _stable_file_id(path: Path) -> str:
  """SHA-256 of the first 64 KB, truncated to 16 hex chars."""
  with path.open("rb") as f:
    prefix = f.read(65536)
  return hashlib.sha256(prefix).hexdigest()[:16]


def _fcs_text_only(
  path: Path,
  ignore_offset_error: bool = True,
  ignore_offset_discrepancy: bool = True,
) -> dict[str, str]:
  """Load FCS TEXT keywords only (no event data). Keys are ``$``-prefixed and upper-cased."""
  try:
    fcs = flowio.FlowData(
      str(path),
      only_text=True,
      ignore_offset_error=ignore_offset_error,
      ignore_offset_discrepancy=ignore_offset_discrepancy,
    )
  except Exception as exc:
    raise ValueError(f"flowio failed to parse {path.name}: {exc}") from exc
  raw_text: dict[str, str] = fcs.text
  return {_normalize_fcs_text_key(k): str(v) for k, v in raw_text.items()}


def _assert_list_mode_fcs_text(path: Path, text: dict[str, str]) -> tuple[int, str]:
  """Validate supported LIST-mode FCS from TEXT. Returns (n_channels, datatype)."""
  n_channels = int(text.get("$PAR", "0") or "0")
  # FCS 2.0 may omit $DATATYPE; "F" (float) is the standard default (PARSE-2).
  datatype = text.get("$DATATYPE", "F").upper()
  mode = text.get("$MODE", "L").upper()
  next_data = int(text.get("$NEXTDATA", "0") or "0")

  if mode != "L":
    raise NotImplementedError(f"FCS MODE {mode!r} not supported; only list mode 'L' is supported.")
  if datatype == "A":
    raise NotImplementedError("FCS DATATYPE 'A' (ASCII list mode) is not supported.")

  if next_data > 0:
    warnings.warn(
      f"[FCS {path.name}] File contains multiple datasets ($NEXTDATA={next_data}); "
      "only the first dataset is loaded.",
    )

  if n_channels <= 0:
    raise ValueError(f"$PAR missing or zero in {path.name}")

  per_channel_dtypes = [k for k in text.keys() if _PER_CHANNEL_DTYPE_RE.match(k)]
  if per_channel_dtypes:
    raise NotImplementedError(
      f"[FCS {path.name}] Per-channel $PiDATATYPE overrides are not supported; "
      "file may be misread. Please export as a standard float FCS.",
    )

  return n_channels, datatype


def _file_metadata_from_text(
  path: Path,
  file_id: str,
  text: dict[str, str],
  n_events: int,
) -> FileMetadata:
  """Build FileMetadata from normalised TEXT and authoritative event count."""
  n_channels = int(text.get("$PAR", "0") or "0")
  aliases = _extract_channel_aliases(text, n_channels)
  spillover_str = _extract_spillover(text)

  public_channels: list[ChannelMetadata] = []
  for alias in aliases:
    range_str = _first(text, [f"$P{alias.index}R", f"$P{alias.index:02d}R"])
    amp_str = _first(text, [f"$P{alias.index}E", f"$P{alias.index:02d}E"])
    public_channels.append(
      ChannelMetadata(
        name=alias.name,
        index=alias.index,
        stain=alias.stain,
        display_name=alias.display_name,
        range=float(range_str) if range_str else None,
        amplification=amp_str,
      )
    )

  return FileMetadata(
    id=file_id,
    path=str(path),
    sample_name=_first(text, ["$SRC", "$SMNO"]) or path.stem,
    event_count=n_events,
    channels=public_channels,
    instrument=_first(text, ["$CYT"]),
    acquisition_datetime=_first(text, ["$DATE"]),
    comment=_first(text, ["$COM"]),
    spillover_str=spillover_str,
  )


def _parse_events_to_memmap(
  fcs: "flowio.FlowData",
  file_id: str,
  n_events_header: int,
  n_channels: int,
  text: dict[str, str],
  datatype: str,
  *,
  source_display: str,
) -> tuple[Path, int]:
  """Write FlowIO's event sequence to a memory-mapped .npy file in chunks (atomic commit).

  Validates flat length against ``$TOT × $PAR`` (BUG-2 / MISS-5); allows a one-event slack
  (PARSE-3) before raising. Writes to ``*_raw.npy.tmp`` then :func:`os.replace` to ``*_raw.npy`` (GAP-1).
  """
  cache_dir = cache_service.get_cache_dir()
  mmap_path = cache_service.raw_mmap_path(file_id, cache_dir)
  tmp_path = cache_service.raw_mmap_tmp_path(file_id, cache_dir)

  events_seq = fcs.events
  expected_flat = int(n_events_header) * int(n_channels)
  actual_flat = len(events_seq)
  slack = int(n_channels)
  if actual_flat != expected_flat:
    if abs(actual_flat - expected_flat) <= slack:
      warnings.warn(
        f"[FCS] Event flat length differs from $TOT×$PAR by {abs(actual_flat - expected_flat)} "
        f"in {source_display}; using full rows from data length.",
      )
      total = actual_flat - (actual_flat % int(n_channels))
      if total <= 0:
        raise ValueError(
          f"FCS data segment in {source_display}: after tolerance, no full rows "
          f"(flat={actual_flat}, $PAR={n_channels}).",
        )
      n_events_data = total // int(n_channels)
    else:
      raise ValueError(
        f"FCS data segment size mismatch in {source_display}: "
        f"$TOT={n_events_header} × $PAR={n_channels} = {expected_flat} values expected, "
        f"got {actual_flat}. File may be truncated or $TOT is wrong.",
      )
  else:
    total = actual_flat
    n_events_data = n_events_header
  mmap = None
  try:
    mmap = np.lib.format.open_memmap(
      str(tmp_path),
      mode="w+",
      dtype=np.float32,
      shape=(n_events_data, n_channels),
    )

    chunk_size_flat = _PARSE_CHUNK_EVENTS * n_channels
    row = 0
    flat_idx = 0
    while flat_idx < total:
      end = min(flat_idx + chunk_size_flat, total)
      chunk_flat = events_seq[flat_idx:end]
      n_rows = len(chunk_flat) // n_channels
      if n_rows == 0:
        break
      flat_slice = chunk_flat[: n_rows * n_channels]
      if datatype.upper() in {"I"}:
        raw_arr = np.array(flat_slice, dtype=np.int64).reshape(n_rows, n_channels)
        arr = _apply_bitmask(raw_arr, text, n_channels, datatype)
      else:
        arr = np.array(flat_slice, dtype=np.float32).reshape(n_rows, n_channels)
        arr = _apply_bitmask(arr, text, n_channels, datatype)
      mmap[row : row + n_rows, :] = arr
      row += n_rows
      flat_idx = end

    mmap.flush()
  except BaseException:
    try:
      if mmap is not None:
        del mmap
    except Exception:
      pass
    if tmp_path.exists():
      tmp_path.unlink(missing_ok=True)
    raise
  else:
    del mmap

  try:
    os.replace(str(tmp_path), str(mmap_path))
  except BaseException:
    if tmp_path.exists():
      tmp_path.unlink(missing_ok=True)
    raise

  return mmap_path, n_events_data


def _load_fcs_file(
  path_str: str,
  ignore_offset_error: bool = True,
  ignore_offset_discrepancy: bool = True,
) -> tuple[FileMetadata, Path]:
  """Parse an FCS file and return metadata plus the path to the raw events memmap.

  The caller (typically :func:`load_and_register_file`) should pass the path to
  :func:`storage.register_file`, which opens the memmap when needed — this avoids
  returning a short-lived ``np.memmap`` whose handle lifetime is unclear.
  """
  path = Path(path_str)
  if not path.exists():
    raise FileNotFoundError(f"FCS file not found: {path}")

  file_id = _stable_file_id(path)
  cache_dir = cache_service.get_cache_dir()

  # Raw memmap already on disk: TEXT-only IO; validate shape without retaining a memmap.
  text = _fcs_text_only(path, ignore_offset_error, ignore_offset_discrepancy)
  n_channels, datatype = _assert_list_mode_fcs_text(path, text)
  if cache_service.raw_mmap_is_readable(
    file_id, cache_dir, expected_n_channels=n_channels,
  ):
    mmap_path = cache_service.raw_mmap_path(file_id, cache_dir)
    mm = np.lib.format.open_memmap(str(mmap_path), mode="r")
    try:
      if mm.shape[1] != n_channels:
        raise ValueError(
          f"Cached memmap has {mm.shape[1]} channels but $PAR={n_channels} in {path.name}; "
          "refusing to load.",
        )
      n_events = int(mm.shape[0])
    finally:
      del mm
    metadata = _file_metadata_from_text(path, file_id, text, n_events)
    return metadata, mmap_path

  try:
    fcs = flowio.FlowData(
      str(path),
      ignore_offset_error=ignore_offset_error,
      ignore_offset_discrepancy=ignore_offset_discrepancy,
    )
  except Exception as exc:
    raise ValueError(f"flowio failed to parse {path.name}: {exc}") from exc

  # Reuse TEXT from _fcs_text_only (PARSE-1): avoid a second parse and FlowIO/only_text drift.
  n_events_header = int(getattr(fcs, "event_count", 0))

  mmap_path, n_events = _parse_events_to_memmap(
    fcs=fcs,
    file_id=file_id,
    n_events_header=n_events_header,
    n_channels=n_channels,
    text=text,
    datatype=datatype,
    source_display=path.name,
  )
  metadata = _file_metadata_from_text(path, file_id, text, n_events)
  return metadata, mmap_path


def load_and_register_file(
  path: str | Path,
  ignore_offset_error: bool = True,
  ignore_offset_discrepancy: bool = True,
) -> FileMetadata:
  """Parse an FCS file using FlowIO and register it in the storage layer.

  This is the supported entry point for loading FCS into the store. It calls the
  private parser :func:`_load_fcs_file` then :func:`storage.register_file`.

  Note (PARSE-4): the older public name ``load_fcs_file`` is not exported; use
  :func:`load_and_register_file` or :func:`load_and_register_files` instead.
  """
  meta, mmap_path = _load_fcs_file(
    str(path),
    ignore_offset_error=ignore_offset_error,
    ignore_offset_discrepancy=ignore_offset_discrepancy,
  )
  storage.register_file(meta, mmap_path)
  return meta


def parse_metadata_only(
  path: str | Path,
  ignore_offset_error: bool = True,
  ignore_offset_discrepancy: bool = True,
) -> FileMetadata:
  """Parse only the TEXT segment (no event data loaded into memory)."""
  path = Path(path)
  if not path.exists():
    raise FileNotFoundError(f"FCS file not found: {path}")

  text = _fcs_text_only(path, ignore_offset_error, ignore_offset_discrepancy)
  n_channels = int(text.get("$PAR", "0") or "0")
  if n_channels <= 0:
    raise ValueError(f"$PAR missing or zero in {path.name}")

  file_id = _stable_file_id(path)
  n_tot = int(text.get("$TOT", "0") or "0")
  return _file_metadata_from_text(path, file_id, text, n_tot)


def load_and_register_files(paths: list[str]) -> list[FileMetadata]:
  """Parse FCS files and register them in the in-memory storage."""
  metas: list[FileMetadata] = []
  for p in paths:
    metas.append(
      load_and_register_file(
        p,
        ignore_offset_error=True,
        ignore_offset_discrepancy=True,
      )
    )
  return metas



