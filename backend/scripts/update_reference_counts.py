import json
import os

from models.gate_models import GateCreateRequest, RectangleGateCreate
from services import gates as gates_service
from services.fcs_parser import load_and_register_files


def main() -> None:
  json_path = os.path.join("tests", "fixtures", "reference_counts.json")
  with open(json_path, "r", encoding="utf-8") as f:
    data = json.load(f)

  fcs_path = os.environ.get(
    "OPENCYTO_TEST_FCS",
    os.path.join("tests", "fixtures", "WBC_CP8.fcs"),
  )

  loaded = load_and_register_files([fcs_path])
  if not loaded:
    raise SystemExit(f"No files loaded from {fcs_path!r}")
  fid = loaded[0].id

  x_ch = data.get("x_channel", "FSC-A")
  y_ch = data.get("y_channel", "SSC-A")

  try:
    for gate_def in data.get("gates", []):
      body = GateCreateRequest(
        file_id=fid,
        name=gate_def["name"],
        x_channel=x_ch,
        y_channel=y_ch,
        params=RectangleGateCreate(
          type="rectangle",
          x_min=gate_def["x_min"],
          y_min=gate_def["y_min"],
          x_max=gate_def["x_max"],
          y_max=gate_def["y_max"],
        ),
      )
      resp = gates_service.create_gate(body)
      gate_def["expected_count"] = resp.count

    with open(json_path, "w", encoding="utf-8") as f:
      json.dump(data, f, indent=2)
  finally:
    gates_service.delete_all_gates_for_file(fid)


if __name__ == "__main__":
  main()

