import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { App } from "../../App";

// The compensation UI was rewritten from a single paste-textarea to a per-cell
// editable grid. The flow now is:
//   1. Load FCS file → App auto-loads spillover via GET /api/compensation/spillover/:id
//   2. Click "🔬 Comp" toolbar button → compact modal opens; useEffect re-fetches spillover
//   3. Click "View Full Matrix →" → full editor modal with "✓ Apply compensation"
//   4. Click "✓ Apply compensation" → POST /api/compensation/apply
//   5. App refetches plot data — density by default (plotMode defaults to "density")

// 2×2 identity matrix for the 2-channel mock (FSC-A, SSC-A).
const SPILLOVER_RESPONSE = {
  file_id: "test-file-id",
  channel_names: ["FSC-A", "SSC-A"],
  matrix: [
    [1, 0],
    [0, 1],
  ],
  cond: 1.0,
};

function useSpilloverMock() {
  server.use(
    http.get(
      "http://127.0.0.1:8765/api/compensation/spillover/:fileId",
      () => HttpResponse.json(SPILLOVER_RESPONSE),
    ),
  );
}

async function loadFile(user: ReturnType<typeof userEvent.setup>) {
  (window as any).opencyto = {
    openFcsFiles: vi.fn().mockResolvedValue(["/fake/WBC_CP8.fcs"]),
  };
  await user.click(screen.getByText(/Browse FCS/i));
  await waitFor(() => expect(screen.getByTestId("file-event-count")).toBeInTheDocument());
}

async function openFullMatrixEditor(user: ReturnType<typeof userEvent.setup>) {
  // Multiple elements may contain "🔬 Comp" (toolbar button + modal header text).
  // We want the toolbar button specifically.
  const compButtons = screen.getAllByText(/🔬\s*Comp/i);
  const toolbarBtn = compButtons.find((el) => el.tagName.toLowerCase() === "button");
  expect(toolbarBtn).toBeDefined();
  await user.click(toolbarBtn!);
  await waitFor(() => expect(screen.getByText(/View Full Matrix/i)).toBeInTheDocument());
  await user.click(screen.getByText(/View Full Matrix/i));
  await waitFor(() => expect(screen.getByText(/Apply compensation/i)).toBeInTheDocument());
}

describe("Compensation apply — click and refetch", () => {
  it("calls /api/compensation/apply then refetches plot data", async () => {
    useSpilloverMock();
    let compensationApplied = false;
    const densityFetchCount = { n: 0 };

    server.use(
      http.post("http://127.0.0.1:8765/api/compensation/apply", () => {
        compensationApplied = true;
        return HttpResponse.json({ file_id: "test-file-id", n_channels: 2, cond: 1.0 });
      }),
      http.get("http://127.0.0.1:8765/api/files/:fileId/density", () => {
        densityFetchCount.n++;
        return HttpResponse.json({
          file_id: "test-file-id", x_channel: "FSC-A", y_channel: "SSC-A",
          transform_x: "linear", transform_y: "linear",
          x_min: 0, x_max: 5, y_min: 0, y_max: 5,
          bins_x: 4, bins_y: 4,
          counts: [[1,2,3,4],[1,2,3,4],[1,2,3,4],[1,2,3,4]],
        });
      }),
    );

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByText(/Connected/i));
    await loadFile(user);

    // Record density fetch count after initial plot load, before apply.
    const countBeforeApply = densityFetchCount.n;

    await openFullMatrixEditor(user);
    await user.click(screen.getByText(/Apply compensation/i));

    await waitFor(() => expect(compensationApplied).toBe(true));
    // After apply, the app refetches density (default plotMode is "density").
    await waitFor(() => expect(densityFetchCount.n).toBeGreaterThan(countBeforeApply));
  });

  it("shows error when compensation matrix is rejected by backend", async () => {
    useSpilloverMock();
    server.use(
      http.post("http://127.0.0.1:8765/api/compensation/apply", () =>
        HttpResponse.json({ detail: "Matrix is singular" }, { status: 400 }),
      ),
    );

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByText(/Connected/i));
    await loadFile(user);

    await openFullMatrixEditor(user);
    await user.click(screen.getByText(/Apply compensation/i));

    await waitFor(() =>
      expect(screen.getByText(/Matrix is singular|HTTP 400/i)).toBeInTheDocument(),
    );
  });
});
