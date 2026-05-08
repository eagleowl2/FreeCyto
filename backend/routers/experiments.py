"""Experiments router — Phase T.

Endpoints:
  POST   /api/experiments                                         create experiment
  GET    /api/experiments                                         list experiments
  GET    /api/experiments/{exp_id}                                get full hierarchy
  PUT    /api/experiments/{exp_id}                                update experiment
  DELETE /api/experiments/{exp_id}                                delete experiment

  POST   /api/experiments/{exp_id}/groups                         add group
  GET    /api/experiments/{exp_id}/groups/{group_id}              get group
  PUT    /api/experiments/{exp_id}/groups/{group_id}              update group
  DELETE /api/experiments/{exp_id}/groups/{group_id}              delete group

  POST   /api/experiments/{exp_id}/groups/{group_id}/samples      add sample
  GET    .../samples/{sample_id}                                   get sample
  PUT    .../samples/{sample_id}                                   update sample
  DELETE .../samples/{sample_id}                                   delete sample
  POST   .../samples/{sample_id}/move                              move to another group

  GET    /api/experiments/{exp_id}/batch-stats                     batch gate statistics
"""

from __future__ import annotations

import io
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse

from models.experiment_models import (
    ExperimentCreateRequest,
    ExperimentListItem,
    ExperimentResponse,
    ExperimentUpdateRequest,
    GroupCreateRequest,
    GroupResponse,
    GroupUpdateRequest,
    SampleAddRequest,
    SampleResponse,
    SampleUpdateRequest,
)
from services import experiment_service

logger = logging.getLogger("opencyto")
router = APIRouter(prefix="/api/experiments", tags=["experiments"])

store = experiment_service.get_store()


# ─── Experiment CRUD ─────────────────────────────────────────────────────────

@router.post("", response_model=ExperimentResponse, status_code=201)
async def create_experiment(body: ExperimentCreateRequest) -> ExperimentResponse:
    exp = store.create_experiment(body)
    return experiment_service._exp_to_response(exp)


@router.get("", response_model=List[ExperimentListItem])
async def list_experiments() -> List[ExperimentListItem]:
    return [experiment_service._exp_to_list_item(e) for e in store.list_experiments()]


@router.get("/{exp_id}", response_model=ExperimentResponse)
async def get_experiment(exp_id: str) -> ExperimentResponse:
    try:
        exp = store.get_experiment(exp_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._exp_to_response(exp)


@router.put("/{exp_id}", response_model=ExperimentResponse)
async def update_experiment(exp_id: str, body: ExperimentUpdateRequest) -> ExperimentResponse:
    try:
        exp = store.update_experiment(exp_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._exp_to_response(exp)


@router.delete("/{exp_id}", status_code=204)
async def delete_experiment(exp_id: str) -> Response:
    try:
        store.delete_experiment(exp_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=204)


# ─── Group CRUD ──────────────────────────────────────────────────────────────

@router.post("/{exp_id}/groups", response_model=GroupResponse, status_code=201)
async def add_group(exp_id: str, body: GroupCreateRequest) -> GroupResponse:
    try:
        grp = store.add_group(exp_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._group_to_response(grp)


@router.get("/{exp_id}/groups/{group_id}", response_model=GroupResponse)
async def get_group(exp_id: str, group_id: str) -> GroupResponse:
    try:
        grp = store.get_group(exp_id, group_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._group_to_response(grp)


@router.put("/{exp_id}/groups/{group_id}", response_model=GroupResponse)
async def update_group(exp_id: str, group_id: str, body: GroupUpdateRequest) -> GroupResponse:
    try:
        grp = store.update_group(exp_id, group_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._group_to_response(grp)


@router.delete("/{exp_id}/groups/{group_id}", status_code=204)
async def delete_group(exp_id: str, group_id: str) -> Response:
    try:
        store.delete_group(exp_id, group_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=204)


# ─── Sample CRUD ─────────────────────────────────────────────────────────────

@router.post("/{exp_id}/groups/{group_id}/samples", response_model=SampleResponse, status_code=201)
async def add_sample(exp_id: str, group_id: str, body: SampleAddRequest) -> SampleResponse:
    try:
        s = store.add_sample(exp_id, group_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._sample_to_response(s)


@router.get("/{exp_id}/groups/{group_id}/samples/{sample_id}", response_model=SampleResponse)
async def get_sample(exp_id: str, group_id: str, sample_id: str) -> SampleResponse:
    try:
        s = store.get_sample(exp_id, group_id, sample_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._sample_to_response(s)


@router.put("/{exp_id}/groups/{group_id}/samples/{sample_id}", response_model=SampleResponse)
async def update_sample(
    exp_id: str, group_id: str, sample_id: str, body: SampleUpdateRequest
) -> SampleResponse:
    try:
        s = store.update_sample(exp_id, group_id, sample_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._sample_to_response(s)


@router.delete("/{exp_id}/groups/{group_id}/samples/{sample_id}", status_code=204)
async def delete_sample(exp_id: str, group_id: str, sample_id: str) -> Response:
    try:
        store.delete_sample(exp_id, group_id, sample_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=204)


class MoveSampleRequest:
    pass


from pydantic import BaseModel

class _MoveBody(BaseModel):
    destination_group_id: str


@router.post("/{exp_id}/groups/{group_id}/samples/{sample_id}/move", response_model=SampleResponse)
async def move_sample(
    exp_id: str, group_id: str, sample_id: str, body: _MoveBody
) -> SampleResponse:
    """Move a sample from one group to another within the same experiment."""
    try:
        s = store.move_sample(exp_id, group_id, sample_id, body.destination_group_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return experiment_service._sample_to_response(s)


# ─── Batch statistics ────────────────────────────────────────────────────────

@router.get("/{exp_id}/batch-stats")
async def get_batch_stats(
    exp_id: str,
    gate_name: str = Query(..., description="Gate name to aggregate across all samples"),
) -> dict:
    """Return gate count/pct for every loaded sample in the experiment.

    Response shape:
    {
      "experiment_id": "...",
      "gate_name": "Lymphocytes",
      "gate_names": ["Lymphocytes"],       # all columns
      "rows": [
        {
          "sample_id": ..., "sample_name": ..., "file_id": ...,
          "group_id": ..., "group_name": ..., "total_events": ...,
          "gate_stats": [{"gate_name": ..., "count": ..., "pct_of_parent": ..., "pct_of_total": ...}]
        }, ...
      ]
    }
    """
    try:
        exp = store.get_experiment(exp_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    from services import gates as gates_service
    from services.storage import get_file_metadata

    rows = []
    for grp_id, grp in exp.groups.items():
        for sample in grp.samples.values():
            if not sample.file_id:
                rows.append({
                    "sample_id": sample.id, "sample_name": sample.name,
                    "file_id": None, "group_id": grp_id, "group_name": grp.name,
                    "load_status": sample.load_status, "total_events": 0,
                    "gate_stats": [{"gate_name": gate_name, "count": 0,
                                    "pct_of_parent": 0.0, "pct_of_total": 0.0}],
                })
                continue
            # get all gates for this file and find the named gate
            try:
                gate_tree = gates_service.get_gate_tree(sample.file_id)
                meta = get_file_metadata(sample.file_id)
                total = meta.event_count if meta else 0
            except Exception:
                gate_tree = []
                total = 0

            gate_stat = {"gate_name": gate_name, "count": 0,
                         "pct_of_parent": 0.0, "pct_of_total": 0.0}
            found = _find_gate_by_name(gate_tree, gate_name)
            if found:
                gate_stat = {
                    "gate_name": gate_name,
                    "count": found.count,
                    "pct_of_parent": found.pct_of_parent,
                    "pct_of_total": found.pct_of_total,
                }

            rows.append({
                "sample_id": sample.id, "sample_name": sample.name,
                "file_id": sample.file_id, "group_id": grp_id, "group_name": grp.name,
                "load_status": sample.load_status, "total_events": total,
                "gate_stats": [gate_stat],
            })

    return {
        "experiment_id": exp_id,
        "gate_name": gate_name,
        "gate_names": [gate_name],
        "rows": rows,
    }


@router.get("/{exp_id}/batch-stats/export")
async def export_batch_stats(
    exp_id: str,
    gate_name: str = Query(..., description="Gate name to export"),
) -> StreamingResponse:
    """Export batch statistics as CSV."""
    result = await get_batch_stats(exp_id, gate_name)
    rows = result["rows"]

    buf = io.StringIO()
    buf.write(f"Sample,Group,File ID,Load Status,Total Events,{gate_name} Count,{gate_name} % Parent,{gate_name} % Total\n")
    for row in rows:
        gs = row["gate_stats"][0] if row["gate_stats"] else {}
        buf.write(
            f"{row['sample_name']},{row['group_name']},{row['file_id'] or ''},"
            f"{row['load_status']},{row['total_events']},"
            f"{gs.get('count', 0)},{gs.get('pct_of_parent', 0):.2f},{gs.get('pct_of_total', 0):.2f}\n"
        )
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="batch_stats_{exp_id}.csv"'},
    )


# ─── helpers ─────────────────────────────────────────────────────────────────

def _find_gate_by_name(gates, name: str):
    """Depth-first search for a gate by name (case-insensitive)."""
    for g in gates:
        if g.name.lower() == name.lower():
            return g
        found = _find_gate_by_name(g.children, name)
        if found:
            return found
    return None
