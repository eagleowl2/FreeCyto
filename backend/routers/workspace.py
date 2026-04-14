from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from models.workspace_models import WorkspaceLoadResult, WorkspaceSave
from services import workspace as workspace_service


router = APIRouter(prefix="/api/workspace", tags=["workspace"])


@router.post("/save", response_model=WorkspaceSave)
async def save_workspace(
  file_ids: list[str] | None = Query(None, description="If provided, only include these file ids; else all loaded files"),
) -> WorkspaceSave:
  """Return current workspace as JSON (files, compensation, gates)."""
  try:
    return workspace_service.build_workspace_save(file_ids=file_ids)
  except Exception as exc:
    raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/load", response_model=WorkspaceLoadResult)
async def load_workspace(body: WorkspaceSave) -> WorkspaceLoadResult:
  """Load workspace: load files by path, apply compensation, create gates. Returns file metadata and gates for frontend refresh."""
  try:
    return workspace_service.load_workspace(body)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=str(exc)) from exc
