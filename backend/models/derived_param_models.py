from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class DerivedParamCreate(BaseModel):
  file_id: str
  name: str = Field(..., min_length=1, description="Display name for the virtual channel")
  expression: str = Field(
    ...,
    min_length=1,
    description=(
      "Math expression over channel names. "
      "Supported: +, -, *, /, ** (power), log, log10, log2, exp, sqrt, abs, arcsinh, clip, where. "
      "Channel names with hyphens are written as-is (e.g. FSC-A). "
      "Example: 'log10(BL1-A / BL2-A)'"
    ),
  )


class DerivedParamResponse(BaseModel):
  id: str
  file_id: str
  name: str
  expression: str
