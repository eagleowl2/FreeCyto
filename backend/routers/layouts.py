"""Gate layout endpoints — Phase U (enhanced).

New in Phase U:
  GET  /api/layouts/{id}           → LayoutDetailResponse (full detail with metadata + strategy)
  PUT  /api/layouts/{id}           → update name and/or metadata
  GET  /api/layouts/{id}/strategy  → list GatingStep[]
  PUT  /api/layouts/{id}/strategy  → replace GatingStep[]
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from models.layout_models import (
    GatingStep,
    LayoutDetailResponse,
    LayoutListItem,
    LayoutMetadata,
    LayoutUpdateRequest,
    StrategyUpdateRequest,
)
from services import gates as gates_service
from services import layouts as layouts_service


router = APIRouter(prefix="/api/layouts", tags=["layouts"])


# ─── request/response models used only by this router ────────────────────────

class LayoutCreateRequest(BaseModel):
    """Request to save a layout from the current file."""
    name: str
    source_file_id: str


class LayoutCreateResponse(BaseModel):
    """Minimal response returned after a layout is created."""
    id: str
    name: str
    source_file_id: str
    gate_count: int


# ─── helpers ─────────────────────────────────────────────────────────────────

def _to_list_item(layout) -> LayoutListItem:
    return LayoutListItem(
        id=layout.id,
        name=layout.name,
        source_file_id=layout.source_file_id,
        gate_count=layout.gate_count,
        description=layout.description,
        author=layout.author,
        tags=layout.tags,
        created_date=layout.created_date,
        modified_date=layout.modified_date,
        strategy_step_count=len(layout.strategy),
    )


def _to_detail(layout) -> LayoutDetailResponse:
    return LayoutDetailResponse(
        id=layout.id,
        name=layout.name,
        source_file_id=layout.source_file_id,
        gate_count=layout.gate_count,
        metadata=layout.to_metadata(),
        strategy=layout.strategy,
        created_date=layout.created_date,
        modified_date=layout.modified_date,
    )


# ─── collection endpoints ─────────────────────────────────────────────────────

@router.post("", response_model=LayoutCreateResponse, status_code=201)
async def save_layout(body: LayoutCreateRequest) -> LayoutCreateResponse:
    """Save the current gate tree as a reusable layout."""
    try:
        gate_tree = gates_service.get_gate_tree(body.source_file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        layout = layouts_service.save_layout(body.name, gate_tree, body.source_file_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return LayoutCreateResponse(
        id=layout.id,
        name=layout.name,
        source_file_id=layout.source_file_id,
        gate_count=layout.gate_count,
    )


@router.get("", response_model=list[LayoutListItem])
async def list_layouts() -> list[LayoutListItem]:
    """List all saved layouts (summary, no gate tree)."""
    return [_to_list_item(l) for l in layouts_service.list_layouts()]


# ─── item endpoints ───────────────────────────────────────────────────────────

@router.get("/{layout_id}", response_model=LayoutDetailResponse)
async def get_layout(layout_id: str) -> LayoutDetailResponse:
    """Retrieve full layout detail including metadata and gating strategy."""
    try:
        layout = layouts_service.get_layout(layout_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _to_detail(layout)


@router.put("/{layout_id}", response_model=LayoutDetailResponse)
async def update_layout(layout_id: str, body: LayoutUpdateRequest) -> LayoutDetailResponse:
    """Update layout name and/or metadata (partial update — omit fields to keep)."""
    try:
        layout = layouts_service.update_layout(layout_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_detail(layout)


@router.delete("/{layout_id}", status_code=204)
async def delete_layout(layout_id: str) -> Response:
    """Delete a saved layout."""
    if not layouts_service.delete_layout(layout_id):
        raise HTTPException(status_code=404, detail=f"Layout {layout_id!r} not found")
    return Response(status_code=204)


# ─── strategy sub-resource ───────────────────────────────────────────────────

@router.get("/{layout_id}/strategy", response_model=list[GatingStep])
async def get_strategy(layout_id: str) -> list[GatingStep]:
    """Retrieve the ordered gating strategy steps for a layout."""
    try:
        layout = layouts_service.get_layout(layout_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return layout.strategy


@router.put("/{layout_id}/strategy", response_model=list[GatingStep])
async def update_strategy(layout_id: str, body: StrategyUpdateRequest) -> list[GatingStep]:
    """Replace the ordered gating strategy steps for a layout."""
    try:
        layout = layouts_service.update_strategy(layout_id, body.steps)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return layout.strategy


# ─── apply endpoint ──────────────────────────────────────────────────────────

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
