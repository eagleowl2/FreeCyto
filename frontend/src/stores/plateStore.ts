/**
 * plateStore — Phase X, slice 7: plate layout panel.
 *
 * The "P-1:" block of App.tsx: the list of plates fetched from `/api/plates`,
 * which plate is active, the create-plate form, the gate name and heat-map
 * statistics computed across a plate's wells, and the well-assignment
 * interaction mode.
 *
 * As in slices 4 and 6, the line is drawn at **state vs I/O**: the fetch and
 * mutation calls against `/api/plates` stay in App.tsx and call these setters.
 *
 * Design note — drop-in compatibility (same convention as slices 1–6):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setActivePlateId(null)`) or a functional updater
 *   (`setPlates((prev) => …)`), so all existing App.tsx call sites are unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

/** P-1: one well in a plate layout. */
export type PlateWellInfo = {
  well_id: string;
  row: number;
  col: number;
  file_id: string | null;
  label: string | null;
};

/** P-1: a plate layout (96/48/24-well). */
export type PlateInfo = {
  id: string;
  name: string;
  rows: number;
  cols: number;
  wells: PlateWellInfo[];
};

/** P-1: per-well statistics for the heat map. */
export type PlateStatWell = {
  well_id: string;
  file_id: string | null;
  label: string | null;
  row: number;
  col: number;
  count: number;
  pct_of_parent: number;
  pct_of_total: number;
  total_events: number;
};

/** P-1: heat-map statistics for one gate across a whole plate. */
export type PlateStatsData = {
  plate_id: string;
  plate_name: string;
  gate_name: string;
  rows: number;
  cols: number;
  wells: PlateStatWell[];
};

/** The plate fields owned by this store. */
interface PlateFields {
  /** Plate layouts for the session. Empty until fetched. */
  plates: PlateInfo[];
  /** Currently selected plate, or null when none is chosen. */
  activePlateId: string | null;
  /** Gate name to compute the well heat map for. */
  plateGateName: string;
  plateStats: PlateStatsData | null;
  plateStatsLoading: boolean;
  /** Create-plate form: name input. */
  plateCreateName: string;
  /** Create-plate form: well-count format ("96" | "48" | "24"). */
  plateCreateFormat: string;
  /** True while the panel is in click-a-well-to-assign-a-file mode. */
  plateAssignMode: boolean;
  /** Which well is awaiting a file assignment, or null. */
  plateAssignWellId: string | null;
}

type PlateKey = keyof PlateFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type PlateSetters = {
  [K in PlateKey as `set${Capitalize<K>}`]: Setter<PlateFields[K]>;
};

export type PlateState = PlateFields & PlateSetters;

function initialFields(): PlateFields {
  return {
    plates: [],
    activePlateId: null,
    plateGateName: "",
    plateStats: null,
    plateStatsLoading: false,
    plateCreateName: "",
    plateCreateFormat: "96",
    plateAssignMode: false,
    plateAssignWellId: null,
  };
}

export const usePlateStore = create<PlateState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter =
    <K extends PlateKey>(key: K): Setter<PlateFields[K]> =>
    (v) =>
      set((s) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: PlateFields[K]) => PlateFields[K])(s[key])
            : v,
      }) as Pick<PlateFields, K>);

  return {
    ...initialFields(),
    setPlates: makeSetter("plates"),
    setActivePlateId: makeSetter("activePlateId"),
    setPlateGateName: makeSetter("plateGateName"),
    setPlateStats: makeSetter("plateStats"),
    setPlateStatsLoading: makeSetter("plateStatsLoading"),
    setPlateCreateName: makeSetter("plateCreateName"),
    setPlateCreateFormat: makeSetter("plateCreateFormat"),
    setPlateAssignMode: makeSetter("plateAssignMode"),
    setPlateAssignWellId: makeSetter("plateAssignWellId"),
  };
});

/** Reset all plate state to its initial state — for tests. */
export function resetPlateStore(): void {
  usePlateStore.setState({ ...initialFields() });
}
