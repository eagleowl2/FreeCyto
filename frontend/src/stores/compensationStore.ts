/**
 * compensationStore — Phase X, slice 5: compensation / spillover matrix state.
 *
 * Holds the spillover matrix editor state and apply/remove lifecycle for the
 * active file's compensation: the fetched spillover data (channel names,
 * matrix, condition number), the editable table cells, and the
 * applying/success/error status shown in the status bar, plot header badge,
 * and the compensation modal/editor.
 *
 * Design note — drop-in compatibility (same convention as the earlier slices):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setCompStatus("idle")`) or a functional updater, so all existing
 *   App.tsx call sites are unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

/** Q-4: spillover matrix as returned by `/api/compensation/spillover/:id`. */
export type SpilloverData = { file_id: string; channel_names: string[]; matrix: number[][]; cond: number };

export type CompStatus = "idle" | "applying" | "error" | "success";

/** The compensation fields owned by this store. */
interface CompensationFields {
  /** J-2: spillover table editor state — channel names (row/col headers). */
  spillChNames: string[];
  /** J-2: matrix cells as editable strings. */
  spillMatrix: string[][];
  compStatus: CompStatus;
  compError: string | null;
  /** Condition number of the most recently applied spillover matrix (null = raw / unknown). */
  compCond: number | null;
  /** Whether the backend currently has compensation applied for the active file. */
  isCompensated: boolean;
  /** Q-4: backing data for the compensation modal / full matrix editor. */
  spilloverData: SpilloverData | null;
  spilloverLoading: boolean;
}

type CompensationKey = keyof CompensationFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type CompensationSetters = {
  [K in CompensationKey as `set${Capitalize<K>}`]: Setter<CompensationFields[K]>;
};

export type CompensationState = CompensationFields & CompensationSetters;

function initialFields(): CompensationFields {
  return {
    spillChNames: [],
    spillMatrix: [],
    compStatus: "idle",
    compError: null,
    compCond: null,
    isCompensated: false,
    spilloverData: null,
    spilloverLoading: false,
  };
}

export const useCompensationStore = create<CompensationState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter =
    <K extends CompensationKey>(key: K): Setter<CompensationFields[K]> =>
    (v) =>
      set((s) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: CompensationFields[K]) => CompensationFields[K])(s[key])
            : v,
      }) as Pick<CompensationFields, K>);

  return {
    ...initialFields(),
    setSpillChNames: makeSetter("spillChNames"),
    setSpillMatrix: makeSetter("spillMatrix"),
    setCompStatus: makeSetter("compStatus"),
    setCompError: makeSetter("compError"),
    setCompCond: makeSetter("compCond"),
    setIsCompensated: makeSetter("isCompensated"),
    setSpilloverData: makeSetter("spilloverData"),
    setSpilloverLoading: makeSetter("spilloverLoading"),
  };
});

/** Reset all compensation state to its initial state — for tests. */
export function resetCompensationStore(): void {
  useCompensationStore.setState({ ...initialFields() });
}
