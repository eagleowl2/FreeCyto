"""Gate layout endpoints."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services import gates as gates_service
from services import layouts as layouts_service


router = APIRouter(prefix="/api/layouts", tags=["layouts"])


class LayoutRequest(BaseModel):
  """Request to save a layout from the current file."""

  name: str
  source_file_id: str


class LayoutResponse(BaseModel):
  """A saved layout."""

  id: str
  name: str
  source_file_id: str
  gate_count: int


@router.post("", response_model=LayoutResponse)
async def save_layout(body: LayoutRequest) -> LayoutResponse:
  """Save the current gate tree as a reusable layout."""
  try:
    gate_tree = gates_service.get_gate_tree(body.source_file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  try:
    layout = layouts_service.save_layout(body.name, gate_tree, body.source_file_id)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc

  return LayoutResponse(
    id=layout.id,
    name=layout.name,
    source_file_id=layout.source_file_id,
    gate_count=layout.gate_count,
  )


@router.get("", response_model=list[LayoutResponse])
async def list_layouts() -> list[LayoutResponse]:
  """List all saved layouts."""
  layouts = layouts_service.list_layouts()
  return [
    LayoutResponse(
      id=layout.id,
      name=layout.name,
      source_file_id=layout.source_file_id,
      gate_count=layout.gate_count,
    )
    for layout in layouts
  ]


@router.post("/{layout_id}/apply")
async def apply_layout(
  layout_id: str,
  target_file_id: str = Query(..., description="File to apply the layout to"),
) -> dict:
  """Apply a saved layout to a target file.

  Clones all gates from the STORED layout snapshot (not the current live source file).
  This ensures the applied gates exactly match what was saved, even if the source
  file's gate tree has since changed.
  """
  try:
    layout = layouts_service.get_layout(layout_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  try:
    gates_applied = gates_service.apply_gate_tree_to_file(layout.gate_tree, target_file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc

  return {
    "status": "applied",
    "layout_id": layout_id,
    "layout_name": layout.name,
    "target_file_id": target_file_id,
    "gates_applied": gates_applied,
  }


@router.delete("/{layout_id}")
async def delete_layout(layout_id: str) -> dict:
  """Delete a saved layout."""
  if not layouts_service.delete_layout(layout_id):
    raise HTTPException(status_code=404, detail=f"Layout {layout_id!r} not found")
  return {"status": "deleted", "layout_id": layout_id}
