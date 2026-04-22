import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { App } from "../../App";

const gatePayloads: unknown[] = [];

beforeEach(() => (gatePayloads.length = 0));

// Override gate POST to capture payloads
function useGateCapture(response = { id: "g1", name: "Gate", count: 1000, pct_total: 25.0 }) {
  server.use(
    http.post("http://127.0.0.1:8765/api/gates", async ({ request }) => {
      gatePayloads.push(await request.json());
      return HttpResponse.json(response);
    }),
  );
}

describe("Rectangle gate creation — click sequence", () => {
  it("sends correct gate payload after draw", async () => {
    useGateCapture();
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByText(/Connected/i));

    (window as any).opencyto = {
      openFcsFiles: vi.fn().mockResolvedValue(["/fake/WBC_CP8.fcs"]),
    };
    await user.click(screen.getByText(/Browse FCS/i));
    await waitFor(() => expect(screen.getByTestId("file-event-count")).toBeInTheDocument());

    // Activate rectangle tool (default is already Rect, so toggle via Poly first)
    await user.click(screen.getByText(/Poly/i));
    await user.click(screen.getByText(/Rect/i));

    // Simulate draw on SVG overlay (mouse events on draw div)
    await waitFor(() => expect(screen.getByTestId("gate-draw-overlay")).toBeInTheDocument());
    const drawArea = screen.getByTestId("gate-draw-overlay") as HTMLElement;
    expect(drawArea).not.toBeNull();

    // Simulate drag from 20%,20% to 60%,60% of plot
    const rect = { left: 68, top: 12, width: 400, height: 400, right: 468, bottom: 412 };
    vi.spyOn(drawArea, "getBoundingClientRect").mockReturnValue(rect as DOMRect);

    await user.pointer([
      { target: drawArea, coords: { clientX: 68 + 80, clientY: 12 + 80 }, keys: "[MouseLeft>]" },
      { target: drawArea, coords: { clientX: 68 + 240, clientY: 12 + 240 } },
      { target: drawArea, coords: { clientX: 68 + 240, clientY: 12 + 240 }, keys: "[/MouseLeft]" },
    ]);

    // Gate name input should appear
    await waitFor(() => screen.getByPlaceholderText(/Gate name/i));
    await user.type(screen.getByPlaceholderText(/Gate name/i), "Lymphocytes");
    await user.click(screen.getByText(/Create gate/i));

    await waitFor(() => expect(gatePayloads.length).toBe(1));
    const payload = gatePayloads[0] as any;
    expect(payload.name).toBe("Lymphocytes");
    expect(payload.x_channel).toBe("FSC-A");
    expect(payload.y_channel).toBe("SSC-A");
    expect(payload.params.type).toBe("rectangle");
    expect(payload.params.x_min).toBeTypeOf("number");
    expect(payload.params.x_max).toBeGreaterThan(payload.params.x_min);
    expect(payload.transform_x).toBe("linear");
  });

  it("sends parent_gate_id when a gate is active", async () => {
    // C-3 fix: was a false-green — the old test had an `if (gatePayloads.length > 0)`
    // guard inside waitFor, so it passed vacuously when no gate was ever submitted.
    // Now performs the full draw sequence and asserts unconditionally.
    useGateCapture({ id: "child-g", name: "Child", count: 200, pct_total: 5.0 });

    // Override gate tree to return one parent gate
    server.use(
      http.get("http://127.0.0.1:8765/api/files/:fileId/gates", () =>
        HttpResponse.json([
          {
            id: "parent-g",
            file_id: "test-file-id",
            name: "Lymphocytes",
            type: "rectangle",
            parent_gate_id: null,
            count: 150000,
            pct_total: 35.5,
            pct_of_parent: 35.5,
            pct_of_total: 35.5,
            parent_count: 422888,
            depth: 0,
            order: 0,
            x_channel: "FSC-A",
            y_channel: "SSC-A",
            transform_x: "linear",
            transform_y: "linear",
            arcsinh_cofactor: 150,
            x_min: -0.5,
            x_max: 0.7,
            y_min: -0.3,
            y_max: 0.8,
            children: [],
          },
        ]),
      ),
    );

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByText(/Connected/i));
    (window as any).opencyto = {
      openFcsFiles: vi.fn().mockResolvedValue(["/fake/WBC_CP8.fcs"]),
    };
    await user.click(screen.getByText(/Browse FCS/i));
    await waitFor(() => screen.getByText(/Lymphocytes/));

    // Select parent gate — makes it the active gate; new gates drawn will be children.
    await user.click(screen.getByText(/Lymphocytes/));

    // Ensure the draw overlay is mounted (draw mode activates after gate selection in tree)
    await waitFor(() => expect(screen.getByTestId("gate-draw-overlay")).toBeInTheDocument());
    const drawArea = screen.getByTestId("gate-draw-overlay") as HTMLElement;
    const rect = { left: 68, top: 12, width: 400, height: 400, right: 468, bottom: 412 };
    vi.spyOn(drawArea, "getBoundingClientRect").mockReturnValue(rect as DOMRect);

    // Full draw sequence: mousedown → move → mouseup to produce a pending gate
    await user.pointer([
      { target: drawArea, coords: { clientX: 68 + 80,  clientY: 12 + 80  }, keys: "[MouseLeft>]" },
      { target: drawArea, coords: { clientX: 68 + 240, clientY: 12 + 240 } },
      { target: drawArea, coords: { clientX: 68 + 240, clientY: 12 + 240 }, keys: "[/MouseLeft]" },
    ]);

    // Name the gate and submit
    await waitFor(() => screen.getByPlaceholderText(/Gate name/i));
    await user.type(screen.getByPlaceholderText(/Gate name/i), "CD3+");
    await user.click(screen.getByText(/Create gate/i));

    // Unconditional assertion — gatePayloads must have exactly one entry
    await waitFor(() => expect(gatePayloads.length).toBe(1));
    const payload = gatePayloads[0] as any;
    expect(payload.parent_gate_id).toBe("parent-g");
    expect(payload.name).toBe("CD3+");
    expect(payload.params.type).toBe("rectangle");
  });
});
