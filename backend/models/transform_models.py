from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ChannelTransform(BaseModel):
  channel: str
  type: Literal["linear", "log", "arcsinh", "logicle"]
  arcsinh_cofactor: float = 150.0
  logicle_T: float = 262144.0
  logicle_W: float = 0.5
  logicle_M: float = 4.5
  logicle_A: float = 0.0

