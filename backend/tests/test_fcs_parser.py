"""
FCS parser unit tests (Step 0.8).

These tests exercise the helper functions in services.fcs_parser using
synthetic TEXT dictionaries (no real FCS files required).
"""

from __future__ import annotations

import os
import sys
from typing import Dict

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from services.fcs_parser import (  # type: ignore[import]
    _apply_bitmask,
    _assert_list_mode_fcs_text,
    _decode_stain,
    _extract_channel_aliases,
    _extract_spillover,
    _first,
    _normalize_fcs_text_key,
    _parse_events_to_memmap,
)


def _make_flowdata_text(pairs: Dict[str, str]) -> dict[str, str]:
    """Build a flowio-style upper-cased text dict directly (skip binary encoding)."""
    return {k.upper().strip(): v.strip() for k, v in pairs.items()}


class TestNormalizeFcsTextKey:
    """FlowIO may return TEXT keys without the FCS ``$`` prefix."""

    def test_adds_dollar_for_plain_keys(self) -> None:
        assert _normalize_fcs_text_key("par") == "$PAR"
        assert _normalize_fcs_text_key("p1n") == "$P1N"
        assert _normalize_fcs_text_key("tot") == "$TOT"

    def test_preserves_single_dollar_prefix(self) -> None:
        assert _normalize_fcs_text_key("$par") == "$PAR"
        assert _normalize_fcs_text_key("$P1N") == "$P1N"

    def test_dict_like_flowio_text(self) -> None:
        raw = {"par": "3", "p1n": "FL1-A", "$MODE": "l"}
        norm = {_normalize_fcs_text_key(k): str(v) for k, v in raw.items()}
        assert norm["$PAR"] == "3"
        assert norm["$P1N"] == "FL1-A"
        assert norm["$MODE"] == "l"


class TestChannelAliases:
    def test_basic_name_and_stain(self) -> None:
        text = _make_flowdata_text({"$PAR": "1", "$P1N": "FL1-A", "$P1S": "CD19 BV421"})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].name == "FL1-A"
        assert aliases[0].stain == "CD19 BV421"
        assert aliases[0].display_name == "FL1-A :: CD19 BV421"

    def test_zero_padded_keys(self) -> None:
        """$P01N resolved same as $P1N."""
        text = _make_flowdata_text({"$PAR": "1", "$P01N": "SSC-A", "$P01S": "SSC"})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].name == "SSC-A"
        assert aliases[0].stain == "SSC"

    def test_missing_stain_gives_none(self) -> None:
        text = _make_flowdata_text({"$PAR": "1", "$P1N": "FSC-A"})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].stain is None
        assert aliases[0].display_name == "FSC-A"

    def test_empty_stain_gives_none(self) -> None:
        text = _make_flowdata_text({"$PAR": "1", "$P1N": "FSC-A", "$P1S": "   "})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].stain is None

    def test_stain_duplicate_of_name_suppressed(self) -> None:
        """Beckman Coulter artifact: $PiS == $PiN → stain suppressed."""
        text = _make_flowdata_text({"$PAR": "1", "$P1N": "FL1-A", "$P1S": "FL1-A"})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].stain is None
        assert aliases[0].display_name == "FL1-A"

    def test_stain_duplicate_case_insensitive(self) -> None:
        text = _make_flowdata_text({"$PAR": "1", "$P1N": "FL1-A", "$P1S": "fl1-a"})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].stain is None

    def test_fallback_name_when_pin_missing(self) -> None:
        text = _make_flowdata_text({"$PAR": "1"})
        aliases = _extract_channel_aliases(text, 1)
        assert aliases[0].name == "CH1"

    def test_multiple_channels_order_preserved(self) -> None:
        text = _make_flowdata_text(
            {
                "$PAR": "3",
                "$P1N": "FSC-A",
                "$P2N": "SSC-A",
                "$P2S": "SSC",
                "$P3N": "FL1-A",
                "$P3S": "CD3 FITC",
            }
        )
        aliases = _extract_channel_aliases(text, 3)
        assert [a.name for a in aliases] == ["FSC-A", "SSC-A", "FL1-A"]
        assert aliases[1].stain == "SSC"
        assert aliases[2].stain == "CD3 FITC"


class TestDecodeStain:
    def test_none_returns_none(self) -> None:
        assert _decode_stain(None) is None

    def test_empty_returns_none(self) -> None:
        assert _decode_stain("") is None
        assert _decode_stain("   ") is None

    def test_clean_ascii_unchanged(self) -> None:
        assert _decode_stain("CD19") == "CD19"

    def test_latin1_mojibake_recovered(self) -> None:
        """é written as latin-1 and read back as latin-1 string → correct UTF-8."""
        latin1_str = "P\xe9ridinin"  # 'é' as latin-1 byte embedded in str
        result = _decode_stain(latin1_str)
        assert result is not None
        assert "ridinin" in result


class TestBitmask:
    def test_noop_for_float_datatype(self) -> None:
        events = np.array([[100.0, 200.0]], dtype=np.float32)
        text = {"$P1R": "262144", "$P2R": "262144"}
        result = _apply_bitmask(events, text, 2, "F")
        np.testing.assert_array_equal(result, events)

    def test_integer_bitmask_applied(self) -> None:
        """$PiR=1023 ($PiB=16) → values > 1023 are masked to 10 bits."""
        events = np.array([[65535, 500]], dtype=np.float32)
        text = {"$P1R": "1023", "$P1B": "16", "$P2R": "262144", "$P2B": "16"}
        result = _apply_bitmask(events, text, 2, "I")
        assert result[0, 0] == 1023
        assert result[0, 1] == 500

    def test_full_range_integer_not_masked(self) -> None:
        """$PiR=65535 ($PiB=16) → 16-bit full range; no change."""
        events = np.array([[65535]], dtype=np.float32)
        text = {"$P1R": "65535", "$P1B": "16"}
        result = _apply_bitmask(events, text, 1, "I")
        assert result[0, 0] == 65535

    def test_p_range_exact_power_of_two_is_16_bit_not_17(self) -> None:
        """BUG-4: $PiR=65536 implies 0..65535 (16 bits); value 65536 must mask with 0xFFFF."""
        events = np.array([[65536]], dtype=np.int64)
        text = {"$P1R": "65536"}
        result = _apply_bitmask(events, text, 1, "I")
        assert int(result[0, 0]) == 0

    def test_integer_int64_input_bitmask_matches_uint24_boundary(self) -> None:
        """BUG-1: bitmask on int64 must not go through float32 first (loses >2²⁴ integers)."""
        val = (1 << 24) + 1  # 16777217 — not representable exactly in float32
        events_i64 = np.array([[val]], dtype=np.int64)
        text = {"$P1R": "1023"}
        out = _apply_bitmask(events_i64, text, 1, "I")
        assert int(out[0, 0]) == (val & 1023)
        events_f32_bad = np.array([[float(val)]], dtype=np.float32)
        out_bad = _apply_bitmask(events_f32_bad, text, 1, "I")
        assert int(out_bad[0, 0]) != (val & 1023)


class TestSpillover:
    def test_spillover_keyword_found(self) -> None:
        text = _make_flowdata_text({"$SPILLOVER": "2,FL1-A,FL2-A,1.0,0.05,0.0,1.0"})
        assert _extract_spillover(text) == "2,FL1-A,FL2-A,1.0,0.05,0.0,1.0"

    def test_spill_fallback(self) -> None:
        """$SPILL (BD FACSDiva) used when $SPILLOVER absent."""
        text = _make_flowdata_text({"$SPILL": "2,FL1-A,FL2-A,1.0,0.0,0.0,1.0"})
        assert _extract_spillover(text) is not None

    def test_spillover_wins_over_spill(self) -> None:
        text = _make_flowdata_text(
            {
                "$SPILLOVER": "canonical",
                "$SPILL": "legacy",
            }
        )
        assert _extract_spillover(text) == "canonical"

    def test_absent_returns_none(self) -> None:
        assert _extract_spillover({}) is None


class TestAssertListModeText:
    def test_global_datatype_not_treated_as_per_channel(self) -> None:
        """BUG-3: $DATATYPE must not match per-channel $PiDATATYPE pattern."""
        from pathlib import Path

        text = _make_flowdata_text({"$PAR": "1", "$MODE": "L", "$DATATYPE": "F"})
        p = Path("dummy.fcs")
        n, dt = _assert_list_mode_fcs_text(p, text)
        assert n == 1 and dt == "F"

    def test_p1_datatype_override_rejected(self) -> None:
        text = _make_flowdata_text(
            {
                "$PAR": "1",
                "$MODE": "L",
                "$DATATYPE": "F",
                "$P1DATATYPE": "I",
            }
        )
        from pathlib import Path

        with pytest.raises(NotImplementedError, match="DATATYPE"):
            _assert_list_mode_fcs_text(Path("x.fcs"), text)


class TestParseEventsTotPar:
    def test_size_mismatch_raises(self, tmp_path, monkeypatch) -> None:
        """BUG-2 / MISS-5: large flat length errors still raise (beyond PARSE-3 slack)."""
        from pathlib import Path
        from services import cache as cache_service

        monkeypatch.setattr(cache_service, "get_cache_dir", lambda override=None: tmp_path)
        fake = type("F", (), {"events": [0.0] * 25})()  # 25 vs 15*2=30, |diff| > $PAR slack
        text = {"$PAR": "2", "$MODE": "L", "$DATATYPE": "F"}
        with pytest.raises(ValueError, match="size mismatch"):
            _parse_events_to_memmap(
                fake,
                "totpar_x",
                n_events_header=15,
                n_channels=2,
                text=text,
                datatype="F",
                source_display="unit",
            )

    def test_small_tot_slack_warns_and_truncates(self, tmp_path, monkeypatch) -> None:
        """PARSE-3: within one-event flat slack, warn and use full rows from data."""
        from pathlib import Path
        from services import cache as cache_service

        monkeypatch.setattr(cache_service, "get_cache_dir", lambda override=None: tmp_path)
        # 29 floats vs $TOT×$PAR=30: one value short; two channels → one partial row dropped
        flat = [float(i) for i in range(29)]
        fake = type("F", (), {"events": flat})()
        text = {"$PAR": "2", "$MODE": "L", "$DATATYPE": "F"}
        with pytest.warns(UserWarning, match="flat length"):
            path, n_ev = _parse_events_to_memmap(
                fake,
                "totpar_slack",
                n_events_header=15,
                n_channels=2,
                text=text,
                datatype="F",
                source_display="unit",
            )
        assert n_ev == 14
        assert path.is_file()
        mm = np.lib.format.open_memmap(str(path), mode="r")
        try:
            assert mm.shape == (14, 2)
        finally:
            del mm


class TestFirstHelper:
    def test_first_returns_none_when_missing(self) -> None:
        text = _make_flowdata_text({"$P1N": "FL1-A"})
        assert _first(text, ["$P2N"]) is None

