/**
 * gateDataStore — Phase X, slice 4: gate data + stats.
 *
 * The second half of the gate domain (slice 3, `gateDrawStore`, took the
 * transient drawing half). This store holds the gate hierarchy fetched from the
 * backend, which gate is selected, the per-gate channel statistics, and the
 * loading/error flags and table sort columns that hang off them.
 *
 * Unlike slices 1–3 this state IS written by async effects — `fetchGateTree`
 * against `/api/files/:id/gates` and `fetchGateStats` against
 * `/api/gates/:id/stats`. Those fetch functions deliberately stay in App.tsx:
 * this store owns the *state*, not the I/O. Keeping the async logic out means
 * the migration remains a declaration-site substitution, with the effects
 * simply calling setters that behave exactly as before.
 *
 * Design note — drop-in compatibility (same convention as the earlier slices):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setActiveGateId(null)`) or a functional updater
 *   (`setGateTree((t) => …)`), so all existing App.tsx call sites are unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";
import type { GateNode } from "../types/gates";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

/** Summary statistics for one channel within a gated population. */
export type ChannelStat = {
  channel_name: string;
  display_name: string;
  mean: number;
  median: number;
  sd: number;
  cv: number | null;
};

/** G: per-gate channel statistics, as returned by `/api/gates/:id/stats`. */
export type GateStatsData = {
  gate_id: string;
  gate_name: string;
  count: number;
  pct_of_parent: number;
  pct_total: number;
  channel_stats: ChannelStat[];
};

/** P-3: sortable columns in the per-gate statistics table. */
export type StatsSortCol = "channel" | "mean" | "median" | "sd" | "cv";
/** Q-2: sortable columns in the population summary table. */
export type PopulationSortCol = "name" | "count" | "pct_parent" | "pct_total";
export type SortDir = "asc" | "desc";

/** The gate-data fields owned by this store. */
interface GateDataFields {
  /** The gate hierarchy for the active file. Empty until fetched. */
  gateTree: GateNode[];
  /** Currently selected gate, or null for the ungated root population. */
  activeGateId: string | null;
  gateTreeLoading: boolean;
  gateTreeError: string | null;
  /** Transient user-facing message from the last gate operation. */
  gateMessage: string | null;
  gateStats: GateStatsData | null;
  gateStatsLoading: boolean;
  statsSortCol: StatsSortCol;
  statsSortDir: SortDir;
  popSortCol: PopulationSortCol;
  popSortDir: SortDir;
}

type GateDataKey = keyof GateDataFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type GateDataSetters = {
  [K in GateDataKey as `set${Capitalize<K>}`]: Setter<GateDataFields[K]>;
};

export type GateDataState = GateDataFields & GateDataSetters;

function initialFields(): GateDataFields {
  return {
    gateTree: [],
    activeGateId: null,
    gateTreeLoading: false,
    gateTreeError: null,
    gateMessage: null,
    gateStats: null,
    gateStatsLoading: false,
    statsSortCol: "channel",
    statsSortDir: "asc",
    popSortCol: "name",
    popSortDir: "asc",
  };
}

export const useGateDataStore = create<GateDataState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter =
    <K extends GateDataKey>(key: K): Setter<GateDataFields[K]> =>
    (v) =>
      set((s) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: GateDataFields[K]) => GateDataFields[K])(s[key])
            : v,
      }) as Pick<GateDataFields, K>);

  return {
    ...initialFields(),
    setGateTree: makeSetter("gateTree"),
    setActiveGateId: makeSetter("activeGateId"),
    setGateTreeLoading: makeSetter("gateTreeLoading"),
    setGateTreeError: makeSetter("gateTreeError"),
    setGateMessage: makeSetter("gateMessage"),
    setGateStats: makeSetter("gateStats"),
    setGateStatsLoading: makeSetter("gateStatsLoading"),
    setStatsSortCol: makeSetter("statsSortCol"),
    setStatsSortDir: makeSetter("statsSortDir"),
    setPopSortCol: makeSetter("popSortCol"),
    setPopSortDir: makeSetter("popSortDir"),
  };
});

/** Reset all gate data to its initial state — for tests. */
export function resetGateDataStore(): void {
  useGateDataStore.setState({ ...initialFields() });
}
