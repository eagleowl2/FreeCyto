"""FCS 3.1 export service.

Writes compensated (or raw) events as a minimal-but-valid FCS 3.1 binary blob
suitable for download and reimport into third-party cytometry software.

FCS 3.1 layout
--------------
HEADER   58 bytes  – version, TEXT/DATA/ANALYSIS segment offsets
TEXT     variable  – ASCII key/value pairs separated by a delimiter char
DATA     variable  – IEEE-754 float32, row-major (events × channels), little-endian
(ANALYSIS segment omitted)
"""

from __future__ import annotations

import numpy as np

from services import storage


# ---------------------------------------------------------------------------
# FCS 3.1 constants
# ---------------------------------------------------------------------------

_FCS_VERSION = b"FCS3.1    "   # 6-char version + 4 spaces = 10 bytes
_HEADER_LEN = 58               # fixed FCS header length
_TEXT_START = 256              # conventional offset for TEXT segment start
_DATA_ALIGN = 512              # DATA segment aligned to 512-byte boundary
_DELIMITER = "/"               # TEXT key/value delimiter (single printable ASCII char)


# ---------------------------------------------------------------------------
# Core binary writer
# ---------------------------------------------------------------------------


def _build_text_bytes(kv: dict[str, str]) -> bytes:
    """Serialise *kv* as an FCS TEXT segment (bytes)."""
    parts = [_DELIMITER]
    for k, v in kv.items():
        parts.append(f"{k}{_DELIMITER}{v}{_DELIMITER}")
    return "".join(parts).encode("latin-1")


def export_events_as_fcs(
    events: np.ndarray,
    channel_names: list[str],
    channel_ranges: list[float],
    sample_name: str = "",
) -> bytes:
    """Return a well-formed FCS 3.1 byte string for the given event matrix.

    Parameters
    ----------
    events:
        Shape (N, P) numeric array (will be cast to float32).
    channel_names:
        List of P channel name strings ($PnN keyword).
    channel_ranges:
        List of P range values ($PnR keyword, e.g. 262144.0).
    sample_name:
        Optional string written as $SMNO (sample number/name).
    """
    if events.ndim != 2:
        raise ValueError(f"events must be 2-D, got shape {events.shape}")
    n_events, n_channels = events.shape
    if len(channel_names) != n_channels:
        raise ValueError(
            f"channel_names length {len(channel_names)} != events columns {n_channels}"
        )
    if len(channel_ranges) != n_channels:
        raise ValueError(
            f"channel_ranges length {len(channel_ranges)} != events columns {n_channels}"
        )

    data_len = n_events * n_channels * 4  # float32 = 4 bytes

    # ------------------------------------------------------------------
    # Build TEXT keywords (two-pass to get the final DATA offset).
    # ------------------------------------------------------------------
    def _make_kv(data_start: int, data_end: int) -> dict[str, str]:
        kv: dict[str, str] = {
            "$BEGINANALYSIS": "0",
            "$ENDANALYSIS": "0",
            "$BEGINTEXT": str(_TEXT_START),
            "$BYTEORD": "1,2,3,4",  # little-endian
            "$DATATYPE": "F",        # 32-bit IEEE float
            "$MODE": "L",            # list mode
            "$NEXTDATA": "0",
            "$PAR": str(n_channels),
            "$TOT": str(n_events),
            "$BEGINDATA": str(data_start),
            "$ENDDATA": str(data_end),
        }
        if sample_name:
            kv["$SMNO"] = sample_name[:64]
        for i, (name, rng) in enumerate(zip(channel_names, channel_ranges), 1):
            kv[f"$P{i}B"] = "32"
            kv[f"$P{i}E"] = "0,0"
            kv[f"$P{i}N"] = name
            kv[f"$P{i}R"] = str(max(1, int(rng)))
        return kv

    # Pass 1 — approximate; data offsets use 10-digit placeholders to
    # guarantee digit count won't increase in pass 2.
    PLACEHOLDER = 9_999_999_999
    kv1 = _make_kv(PLACEHOLDER, PLACEHOLDER)
    text1 = _build_text_bytes(kv1)
    text_end1 = _TEXT_START + len(text1) - 1

    # $ENDTEXT is set to the last byte of the TEXT segment itself.
    # We need to include it in the KV *before* computing length.
    # Use another pass: add $ENDTEXT with a placeholder then patch.
    kv1["$ENDTEXT"] = str(text_end1)
    text1 = _build_text_bytes(kv1)
    text_end1 = _TEXT_START + len(text1) - 1
    # One more patch after $ENDTEXT value is final (digit count stable):
    kv1["$ENDTEXT"] = str(text_end1)
    text1 = _build_text_bytes(kv1)
    text_end1 = _TEXT_START + len(text1) - 1

    # DATA starts at the next _DATA_ALIGN boundary after TEXT_END.
    data_start1 = ((text_end1 // _DATA_ALIGN) + 1) * _DATA_ALIGN
    data_end1 = data_start1 + data_len - 1

    # Pass 2 — final values (digit count can only stay same or decrease).
    kv2 = _make_kv(data_start1, data_end1)
    text_end_est = _TEXT_START + len(_build_text_bytes(kv2)) - 1
    kv2["$ENDTEXT"] = str(text_end_est)
    text2 = _build_text_bytes(kv2)
    text_end2 = _TEXT_START + len(text2) - 1
    kv2["$ENDTEXT"] = str(text_end2)
    text2 = _build_text_bytes(kv2)
    text_end2 = _TEXT_START + len(text2) - 1

    # Verify DATA start did not shift (should never happen given 10-digit placeholders).
    data_start2 = ((text_end2 // _DATA_ALIGN) + 1) * _DATA_ALIGN
    if data_start2 != data_start1:
        # Re-derive with the new data start (safety net).
        data_end2 = data_start2 + data_len - 1
        kv2["$BEGINDATA"] = str(data_start2)
        kv2["$ENDDATA"] = str(data_end2)
        text2 = _build_text_bytes(kv2)
        text_end2 = _TEXT_START + len(text2) - 1
        kv2["$ENDTEXT"] = str(text_end2)
        text2 = _build_text_bytes(kv2)
        text_end2 = _TEXT_START + len(text2) - 1
        data_start1, data_end1 = data_start2, data_end2

    data_end_final = data_start1 + data_len - 1

    # ------------------------------------------------------------------
    # HEADER (58 bytes)
    # ------------------------------------------------------------------
    header = (
        _FCS_VERSION                                       # bytes 0-9
        + f"{_TEXT_START:8d}".encode("ascii")             # bytes 10-17
        + f"{text_end2:8d}".encode("ascii")               # bytes 18-25
        + f"{data_start1:8d}".encode("ascii")             # bytes 26-33
        + f"{data_end_final:8d}".encode("ascii")          # bytes 34-41
        + b"       0"                                      # bytes 42-49 (no ANALYSIS)
        + b"       0"                                      # bytes 50-57 (no ANALYSIS)
    )
    assert len(header) == _HEADER_LEN, f"BUG: header is {len(header)} bytes, expected 58"

    # ------------------------------------------------------------------
    # Assemble: HEADER padded to TEXT_START, TEXT padded to DATA_START, DATA.
    # ------------------------------------------------------------------
    header_padded = header + b" " * (_TEXT_START - _HEADER_LEN)
    text_padded = text2 + b" " * (data_start1 - _TEXT_START - len(text2))
    data_bytes = events.astype("<f4").tobytes()  # little-endian float32

    return header_padded + text_padded + data_bytes


# ---------------------------------------------------------------------------
# High-level helpers
# ---------------------------------------------------------------------------


def export_gate_fcs(gate_id: str) -> tuple[bytes, str]:
    """Export gated events as FCS bytes.

    Returns ``(fcs_bytes, suggested_filename)``.
    """
    from services import gates as gates_service  # lazy — avoids circular import

    record = gates_service._store.gates_by_id.get(gate_id)
    if record is None:
        raise KeyError(f"Gate {gate_id!r} not found")
    file_id = record.file_id

    meta = storage.get_file_metadata(file_id)
    events = storage.get_file_events(file_id)
    mask = gates_service._get_mask(record)
    gated = events[mask]

    channel_names = [ch.name for ch in meta.channels]
    channel_ranges = [float(ch.range or 262144) for ch in meta.channels]
    sample_name = f"{meta.sample_name or file_id}_{record.name}"

    fcs_bytes = export_events_as_fcs(gated, channel_names, channel_ranges, sample_name=sample_name)
    safe_name = record.name.replace("/", "_").replace("\\", "_")
    filename = f"{safe_name}_gated.fcs"
    return fcs_bytes, filename


def export_file_fcs(file_id: str) -> tuple[bytes, str]:
    """Export all (compensated) events for a file as FCS bytes."""
    meta = storage.get_file_metadata(file_id)
    events = storage.get_file_events(file_id)

    channel_names = [ch.name for ch in meta.channels]
    channel_ranges = [float(ch.range or 262144) for ch in meta.channels]
    sample_name = meta.sample_name or file_id

    fcs_bytes = export_events_as_fcs(events, channel_names, channel_ranges, sample_name=sample_name)
    safe = (meta.sample_name or file_id).replace("/", "_").replace("\\", "_")
    filename = f"{safe}_export.fcs"
    return fcs_bytes, filename
