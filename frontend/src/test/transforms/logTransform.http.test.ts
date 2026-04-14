import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { resetRequestLog } from "../mocks/server";

const BASE = "http://127.0.0.1:8765";

beforeEach(() => resetRequestLog());

describe("Log transform — HTTP parameters", () => {
  it("GET /events with transform_x=log returns 200 and finite values", async () => {
    const res = await fetch(
      `${BASE}/api/files/test-file-id/events?x_channel=FSC-A&y_channel=SSC-A` +
      "&transform_x=log&transform_y=linear&max_events=50",
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { events: number[][] };
    expect(data.events.length).toBeGreaterThan(0);
    data.events.forEach((row) => {
      expect(isFinite(row[0]!)).toBe(true);
      expect(isFinite(row[1]!)).toBe(true);
    });
  });

  it("GET /events with transform_x=log where backend returns 500 propagates the error", async () => {
    server.use(
      http.get(`${BASE}/api/files/:id/events`, ({ request }) => {
        const tx = new URL(request.url).searchParams.get("transform_x");
        if (tx === "log") {
          return HttpResponse.json({ detail: "Log transform failed" }, { status: 500 });
        }
        return HttpResponse.json({ channel_names: ["FSC-A"], events: [[1.0, 1.0]] });
      }),
    );

    const res = await fetch(
      `${BASE}/api/files/test-file-id/events?x_channel=FSC-A&y_channel=SSC-A` +
      "&transform_x=log&transform_y=linear&max_events=50",
    );
    expect(res.status).toBe(500);
    const data = await res.json() as { detail: string };
    expect(data.detail).toMatch(/Log transform failed/);
  });

  it("stale request simulation: second fetch supersedes first", async () => {
    let currentGen = 0;
    const results: string[] = [];

    const fakeEffect = async (transform: string, gen: number) => {
      const res = await fetch(
        `${BASE}/api/files/test-file-id/events?transform_x=${transform}&` +
        "x_channel=FSC-A&y_channel=SSC-A&max_events=50",
      );
      if (gen !== currentGen) return;
      await res.json();
      results.push(transform);
    };

    currentGen = 1;
    const p1 = fakeEffect("log", 0);
    currentGen = 2;
    const p2 = fakeEffect("arcsinh", 2);
    await Promise.all([p1, p2]);

    expect(results).toEqual(["arcsinh"]);
    expect(results).not.toContain("log");
  });
});
