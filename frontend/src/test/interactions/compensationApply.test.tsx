import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { App } from "../../App";

describe("Compensation apply — click and refetch", () => {
  it("calls /api/compensation/apply then refetches events", async () => {
    let compensationApplied = false;
    const eventFetchCount = { n: 0 };

    server.use(
      http.post("http://127.0.0.1:8765/api/compensation/apply", () => {
        compensationApplied = true;
        return HttpResponse.json({ is_compensated: true, cond: 12.3 });
      }),
      http.get("http://127.0.0.1:8765/api/files/:fileId/events", () => {
        eventFetchCount.n++;
        return HttpResponse.json({ channel_names: ["FSC-A", "SSC-A"], events: [[10000, 8000]] });
      }),
    );

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByText(/Connected/i));
    (window as any).opencyto = {
      openFcsFiles: vi.fn().mockResolvedValue(["/fake/WBC_CP8.fcs"]),
    };
    await user.click(screen.getByText(/Browse FCS/i));
    await waitFor(() => expect(screen.getByTestId("file-event-count")).toBeInTheDocument());

    const countAfterLoad = eventFetchCount.n;

    // Paste a 3×3 identity compensation matrix (file has 3 channels in mock)
    const textarea = screen.getByPlaceholderText(/1,0,0/i);
    await user.clear(textarea);
    await user.type(textarea, "1,0,0\n0,1,0\n0,0,1");

    await user.click(screen.getByText(/Apply compensation/i));

    await waitFor(() => expect(compensationApplied).toBe(true));
    await waitFor(() => expect(eventFetchCount.n).toBeGreaterThan(countAfterLoad));
  });

  it("shows error when compensation matrix is rejected by backend", async () => {
    server.use(
      http.post("http://127.0.0.1:8765/api/compensation/apply", () =>
        HttpResponse.json({ detail: "Matrix is singular" }, { status: 400 }),
      ),
    );

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByText(/Connected/i));
    (window as any).opencyto = {
      openFcsFiles: vi.fn().mockResolvedValue(["/fake/WBC_CP8.fcs"]),
    };
    await user.click(screen.getByText(/Browse FCS/i));
    await waitFor(() => expect(screen.getByTestId("file-event-count")).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText(/1,0,0/i);
    await user.clear(textarea);
    await user.type(textarea, "1,0,0\n0,1,0\n0,0,1");
    await user.click(screen.getByText(/Apply compensation/i));

    await waitFor(() =>
      expect(screen.getByText(/Matrix is singular|HTTP 400/i)).toBeInTheDocument(),
    );
  });
});
