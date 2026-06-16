import { afterEach, describe, expect, it } from "vitest";
import { resetUiStore, useUiStore } from "../../stores/uiStore";

// The store is a module-level singleton; reset it between tests so each starts
// from the known initial (all-closed) state.
afterEach(() => {
  resetUiStore();
});

describe("uiStore — UI visibility slice (Phase X)", () => {
  it("initialises every flag to false", () => {
    const s = useUiStore.getState();
    expect(s.experimentPanelOpen).toBe(false);
    expect(s.groupPanelOpen).toBe(false);
    expect(s.dpPanelOpen).toBe(false);
    expect(s.platePanelOpen).toBe(false);
    expect(s.tablePanelOpen).toBe(false);
    expect(s.layoutEditorOpen).toBe(false);
    expect(s.compensationModalOpen).toBe(false);
    expect(s.compensationFullMatrixOpen).toBe(false);
    expect(s.applyGatesModalOpen).toBe(false);
    expect(s.saveLayoutModalOpen).toBe(false);
    expect(s.plateCreateOpen).toBe(false);
    expect(s.statsExpanded).toBe(false);
    expect(s.popExpanded).toBe(false);
  });

  it("accepts a direct boolean value (useState-style)", () => {
    useUiStore.getState().setTablePanelOpen(true);
    expect(useUiStore.getState().tablePanelOpen).toBe(true);
    useUiStore.getState().setTablePanelOpen(false);
    expect(useUiStore.getState().tablePanelOpen).toBe(false);
  });

  it("accepts a functional updater (useState-style)", () => {
    const { setExperimentPanelOpen } = useUiStore.getState();
    setExperimentPanelOpen((o) => !o);
    expect(useUiStore.getState().experimentPanelOpen).toBe(true);
    setExperimentPanelOpen((o) => !o);
    expect(useUiStore.getState().experimentPanelOpen).toBe(false);
  });

  it("updates only the targeted flag, leaving siblings untouched", () => {
    useUiStore.getState().setCompensationModalOpen(true);
    const s = useUiStore.getState();
    expect(s.compensationModalOpen).toBe(true);
    expect(s.compensationFullMatrixOpen).toBe(false);
    expect(s.saveLayoutModalOpen).toBe(false);
  });

  it("resetUiStore() returns all flags to false", () => {
    const st = useUiStore.getState();
    st.setTablePanelOpen(true);
    st.setStatsExpanded(true);
    st.setPlatePanelOpen(true);
    resetUiStore();
    const s = useUiStore.getState();
    expect(s.tablePanelOpen).toBe(false);
    expect(s.statsExpanded).toBe(false);
    expect(s.platePanelOpen).toBe(false);
  });
});
