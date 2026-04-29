from __future__ import annotations

import csv
import io

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from models.group_models import (
  ApplyTemplateRequest,
  BatchStatsResponse,
  GroupCreateRequest,
  GroupResponse,
  TemplateCreateRequest,
  TemplateResponse,
)
from services import groups as groups_service

router = APIRouter(prefix="/api/groups", tags=["groups"])


@router.get("", response_model=list[GroupResponse])
async def list_groups() -> list[GroupResponse]:
  """List all sample groups."""
  return groups_service.list_groups()


@router.post("", response_model=GroupResponse, status_code=201)
async def create_group(body: GroupCreateRequest) -> GroupResponse:
  """Create a new sample group from a list of loaded file IDs."""
  try:
    return groups_service.create_group(body.name, body.file_ids)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{group_id}", response_model=GroupResponse)
async def get_group(group_id: str) -> GroupResponse:
  """Get a specific group by ID."""
  try:
    return groups_service.get_group(group_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{group_id}")
async def delete_group(group_id: str) -> dict:
  """Delete a sample group (does not delete files or gates)."""
  try:
    groups_service.delete_group(group_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  return {"deleted": group_id}


@router.post("/{group_id}/template", response_model=TemplateResponse, status_code=201)
async def create_template(group_id: str, body: TemplateCreateRequest) -> TemplateResponse:
  """Extract a gating template from a source file and attach it to this group."""
  try:
    template = groups_service.create_template(group_id, body.source_file_id, body.template_name)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  return TemplateResponse(
    id=template.id,
    name=template.name,
    source_file_id=template.source_file_id,
    gate_count=len(template.gates),
  )


@router.post("/{group_id}/apply-template")
async def apply_template(group_id: str, body: ApplyTemplateRequest) -> dict:
  """Apply the attached gating template to all samples in the group.

  Returns a dict of ``{file_id: {created: N} | {error: ...}}``.
  """
  try:
    grp = groups_service.get_group(group_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  results: dict[str, dict] = {}
  for sample in grp.samples:
    try:
      ids = groups_service.apply_template(body.template_id, sample.file_id)
      results[sample.file_id] = {"created": len(ids)}
    except KeyError as exc:
      results[sample.file_id] = {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001
      results[sample.file_id] = {"error": str(exc)}
  return results


@router.get("/{group_id}/batch-stats", response_model=BatchStatsResponse)
async def batch_stats(
  group_id: str,
  gate_name: str = Query(..., description="Gate name to aggregate across all samples"),
) -> BatchStatsResponse:
  """Return count/% statistics for a named gate across all files in the group."""
  try:
    return groups_service.get_batch_stats(group_id, gate_name)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{group_id}/export.csv")
async def export_csv(
  group_id: str,
  gate_name: str = Query(..., description="Gate name to export"),
) -> StreamingResponse:
  """Download batch statistics as a CSV file."""
  try:
    stats = groups_service.get_batch_stats(group_id, gate_name)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  output = io.StringIO()
  writer = csv.DictWriter(
    output,
    fieldnames=["label", "file_id", "gate_name", "count", "pct_of_parent", "pct_of_total", "parent_count"],
  )
  writer.writeheader()
  for row in stats.rows:
    writer.writerow(row.model_dump())
  output.seek(0)

  safe_name = gate_name.replace("/", "_").replace("\\", "_")
  return StreamingResponse(
    iter([output.getvalue()]),
    media_type="text/csv",
    headers={"Content-Disposition": f'attachment; filename="batch_{safe_name}.csv"'},
  )
