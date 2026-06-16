/**
 * uiStore — Phase X, slice 1: UI visibility state.
 *
 * Holds the panel/modal "open" and section "expanded" booleans that previously
 * lived as ~13 independent `useState` hooks inside the App.tsx monolith. These
 * are pure presentational toggles with no cross-domain coupling, so they are the
 * safest first slice to lift out of the component into a shared Zustand store.
 *
 * Design note — drop-in compatibility:
 *   Each setter intentionally mirrors React's `useState` updater signature,
 *   i.e. it accepts either a value (`setX(true)`) or a functional updater
 *   (`setX((prev) => !prev)`). This let the App.tsx migration be a pure
 *   mechanical substitution: only the declaration site changed; every existing
 *   call site (`setTablePanelOpen(true)`, `setExperimentPanelOpen((o) => !o)`,
 *   `setStatsExpanded(next)`) keeps working unchanged.
 *
 * Future slices (plot/view settings, gates, compensation, groups, plates, …)
 * should follow this same pattern as separate stores under src/stores/. See
 * src/stores/README.md.
 */

import { create } from "zustand";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type BoolSetter = (v: SetStateAction<boolean>) => void;

/** The boolean visibility fields owned by this store. */
interface UiFlags {
  // Side-panel toggles (expand/collapse in the sidebar)
  experimentPanelOpen: boolean;
  groupPanelOpen: boolean;
  dpPanelOpen: boolean;
  platePanelOpen: boolean;
  // Standalone editor / table overlays
  tablePanelOpen: boolean;
  layoutEditorOpen: boolean;
  // Modals
  compensationModalOpen: boolean;
  compensationFullMatrixOpen: boolean;
  applyGatesModalOpen: boolean;
  saveLayoutModalOpen: boolean;
  plateCreateOpen: boolean;
  // Inline section expand toggles
  statsExpanded: boolean;
  popExpanded: boolean;
}

type BoolKey = keyof UiFlags;

/** Each flag gets a `set<Flag>` action with the React `useState` signature. */
type UiSetters = {
  [K in BoolKey as `set${Capitalize<K>}`]: BoolSetter;
};

export type UiState = UiFlags & UiSetters;

const INITIAL_FLAGS: UiFlags = {
  experimentPanelOpen: false,
  groupPanelOpen: false,
  dpPanelOpen: false,
  platePanelOpen: false,
  tablePanelOpen: false,
  layoutEditorOpen: false,
  compensationModalOpen: false,
  compensationFullMatrixOpen: false,
  applyGatesModalOpen: false,
  saveLayoutModalOpen: false,
  plateCreateOpen: false,
  statsExpanded: false,
  popExpanded: false,
};

export const useUiStore = create<UiState>((set) => {
  /** Build a React-style setter bound to a single boolean field. */
  const makeSetter = (key: BoolKey): BoolSetter => (v) =>
    set((s) => ({
      [key]: typeof v === "function" ? (v as (prev: boolean) => boolean)(s[key]) : v,
    }) as Pick<UiFlags, BoolKey>);

  return {
    ...INITIAL_FLAGS,
    setExperimentPanelOpen: makeSetter("experimentPanelOpen"),
    setGroupPanelOpen: makeSetter("groupPanelOpen"),
    setDpPanelOpen: makeSetter("dpPanelOpen"),
    setPlatePanelOpen: makeSetter("platePanelOpen"),
    setTablePanelOpen: makeSetter("tablePanelOpen"),
    setLayoutEditorOpen: makeSetter("layoutEditorOpen"),
    setCompensationModalOpen: makeSetter("compensationModalOpen"),
    setCompensationFullMatrixOpen: makeSetter("compensationFullMatrixOpen"),
    setApplyGatesModalOpen: makeSetter("applyGatesModalOpen"),
    setSaveLayoutModalOpen: makeSetter("saveLayoutModalOpen"),
    setPlateCreateOpen: makeSetter("plateCreateOpen"),
    setStatsExpanded: makeSetter("statsExpanded"),
    setPopExpanded: makeSetter("popExpanded"),
  };
});

/** Reset all UI flags to their initial (closed/collapsed) state — for tests. */
export function resetUiStore(): void {
  useUiStore.setState({ ...INITIAL_FLAGS });
}
