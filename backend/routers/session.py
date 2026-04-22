from __future__ import annotations

from fastapi import APIRouter, Request

from services import session as session_service

router = APIRouter(prefix="/api/session", tags=["session"])


@router.get("/restore")
async def get_session_restore() -> dict:
  """Return last auto-saved workspace JSON for client restore, if any."""
  data = session_service.load_session()
  if data is None:
    return {"available": False}
  return {"available": True, "workspace": data}


@router.post("/save")
async def post_session_save(request: Request) -> dict:
  """Persist a workspace JSON blob to the session file (~/.freecyto/session.json).

  Accepts any JSON body (the frontend sends the full merged WorkspaceSave including
  default_axes). Non-blocking: the write happens in a daemon thread so the response
  returns immediately. Returns {"ok": true} on success.
  """
  try:
    data = await request.json()
  except Exception:
    return {"ok": False, "error": "invalid JSON body"}
  session_service.save_session(data)
  return {"ok": True}
