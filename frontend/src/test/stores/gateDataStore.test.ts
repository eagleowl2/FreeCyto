import { afterEach, describe, expect, it } from "vitest";
import {
  resetGateDataStore,
  useGateDataStore,
  type GateStatsData,
} from "../../stores/gateDataStore";
import type { GateNode } from "../../types/gates";

// The store is a module-level singleton; reset it between tests so each starts
// from the known initial state.
afterEach(() => {
  resetGateDataStore();
});

/** Minimal gate node — only the fields these tests actually assert on. */
function gate(id: string, name: string, children: GateNode[] = []): GateNode {
  return {
    id,
    file_id: "f1",
    name,
    type: "rectangle",
    parent_gate_id: null,
    count: 100,
    pct_total: 25,
    pct_of_parent: 25,
    pct_of_total: 25,
    parent_count: 400,
    depth: 0,
    order: 0,
    x_channel: "FSC-A",
    y_channel: "SSC-A",
    transform_x: "linear",
    transform_y: "linear",
    arcsinh_cofactor: 150,
    x_min: 0,
    x_max: 1,
    y_min: 0,
    y_max: 1,
    children,
  } as GateNode;
}

const STATS: GateStatsData = {
  gate_id: "g1",
  gate_name: "Lymphocytes",
  count: 100,
  pct_of_parent: 25,
  pct_total: 25,
  channel_stats: [
    { channel_name: "FSC-A", display_name: "FSC-A", mean: 1, median: 2, sd: 3, cv: 4 },
  ],
};

describe("gateDataStore — gate data slice (Phase X)", () => {
  it("initialises empty, with nothing selected and no error", () => {
    const s = useGateDataStore.getState();
    expect(s.gateTree).toEqual([]);
    expect(s.activeGateId).toBeNull();
    expect(s.gateTreeLoading).toBe(false);
    expect(s.gateTreeError).toBeNull();
    expect(s.gateMessage).toBeNull();
    expect(s.gateStats).toBeNull();
    expect(s.gateStatsLoading).toBe(false);
    // Default sort matches the columns the tables render first.
    expect(s.statsSortCol).toBe("channel");
    expect(s.statsSortDir).toBe("asc");
    expect(s.popSortCol).toBe("name");
    expect(s.popSortDir).toBe("asc");
  });

  it("accepts a direct value (useState-style)", () => {
    useGateDataStore.getState().setActiveGateId("g1");
    expect(useGateDataStore.getState().activeGateId).toBe("g1");
    useGateDataStore.getState().setActiveGateId(null);
    expect(useGateDataStore.getState().activeGateId).toBeNull();
  });

  it("accepts a functional updater (useState-style)", () => {
    const { setStatsSortDir } = useGateDataStore.getState();
    // This is how the table header toggles sort direction.
    setStatsSortDir((d) => (d === "asc" ? "desc" : "asc"));
    expect(useGateDataStore.getState().statsSortDir).toBe("desc");
    setStatsSortDir((d) => (d === "asc" ? "desc" : "asc"));
    expect(useGateDataStore.getState().statsSortDir).toBe("asc");
  });

  it("holds a nested gate tree", () => {
    const tree = [gate("p1", "Lymphocytes", [gate("c1", "CD3+")])];
    useGateDataStore.getState().setGateTree(tree);
    const s = useGateDataStore.getState();
    expect(s.gateTree).toHaveLength(1);
    expect(s.gateTree[0].children[0].name).toBe("CD3+");
  });

  it("replaces the tree via a functional updater without touching selection", () => {
    useGateDataStore.getState().setGateTree([gate("p1", "A")]);
    useGateDataStore.getState().setActiveGateId("p1");
    useGateDataStore.getState().setGateTree((t) => [...t, gate("p2", "B")]);
    const s = useGateDataStore.getState();
    expect(s.gateTree.map((g) => g.name)).toEqual(["A", "B"]);
    expect(s.activeGateId).toBe("p1");
  });

  it("stores gate stats and clears them", () => {
    useGateDataStore.getState().setGateStats(STATS);
    expect(useGateDataStore.getState().gateStats?.gate_name).toBe("Lymphocytes");
    expect(useGateDataStore.getState().gateStats?.channel_stats).toHaveLength(1);
    useGateDataStore.getState().setGateStats(null);
    expect(useGateDataStore.getState().gateStats).toBeNull();
  });

  it("tracks loading and error independently of the data", () => {
    // A failed refetch must be able to surface an error while the previously
    // fetched tree is still on screen.
    const st = useGateDataStore.getState();
    st.setGateTree([gate("p1", "A")]);
    st.setGateTreeLoading(true);
    st.setGateTreeError("HTTP 500");
    const s = useGateDataStore.getState();
    expect(s.gateTree).toHaveLength(1);
    expect(s.gateTreeLoading).toBe(true);
    expect(s.gateTreeError).toBe("HTTP 500");
  });

  it("updates only the targeted field, leaving siblings untouched", () => {
    useGateDataStore.getState().setPopSortCol("count");
    const s = useGateDataStore.getState();
    expect(s.popSortCol).toBe("count");
    expect(s.popSortDir).toBe("asc");
    expect(s.statsSortCol).toBe("channel");
  });

  it("resetGateDataStore() returns every field to its initial value", () => {
    const st = useGateDataStore.getState();
    st.setGateTree([gate("p1", "A")]);
    st.setActiveGateId("p1");
    st.setGateStats(STATS);
    st.setGateTreeError("boom");
    st.setGateMessage("created");
    st.setPopSortCol("pct_total");

    resetGateDataStore();

    const s = useGateDataStore.getState();
    expect(s.gateTree).toEqual([]);
    expect(s.activeGateId).toBeNull();
    expect(s.gateStats).toBeNull();
    expect(s.gateTreeError).toBeNull();
    expect(s.gateMessage).toBeNull();
    expect(s.popSortCol).toBe("name");
  });
});
