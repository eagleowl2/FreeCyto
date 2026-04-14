from __future__ import annotations

from fastapi import APIRouter

from services import session as session_service

router = APIRouter(prefix="/api/session", tags=["session"])


@router.get("/restore")
async def get_session_restore() -> dict:
  """Return last auto-saved workspace JSON for client restore, if any."""
  data = session_service.load_session()
  if data is None:
    return {"available": False}
  return {"available": True, "workspace": data}
