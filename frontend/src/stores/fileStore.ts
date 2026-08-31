/**
 * fileStore — Phase X, slice 8: loaded files and channel selection.
 *
 * The final slice of the App.tsx → Zustand migration. Owns which FCS files are
 * loaded, which one is active, its channel list, the two selected plot axes, and
 * the load status/error for the file picker.
 *
 * This store also owns the `LoadedFile` and `ChannelInfo` types, which were
 * previously module-level declarations in App.tsx. They live here rather than
 * being imported from App.tsx because the dependency has to point one way:
 * App.tsx imports the store, so the store cannot import back without a cycle.
 *
 * As in slices 4, 6 and 7, the line is drawn at **state vs I/O**: `handleLoadFcs`
 * and the `/api/files/*` calls stay in App.tsx and call these setters.
 *
 * Design note — drop-in compatibility (same convention as slices 1–7):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setXChannel("FSC-A")`) or a functional updater
 *   (`setLoadedFiles((prev) => …)`), so all existing App.tsx call sites are
 *   unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

/** An FCS file loaded into the backend session. */
export type LoadedFile = {
  id: string;
  path: string;
  sample_name?: string | null;
  event_count: number;
  channels: string[];
  spillover?: number[][] | null;
};

/** One channel (detector/parameter) of a loaded file. */
export type ChannelInfo = {
  name: string;
  index: number;
  stain: string | null;
  display_name: string;
  ui_label: string;
  range: number | null;
};

/** Q-1: summary of a file held by the backend, for the batch-copy picker. */
export type FileInfo = { id: string; sample_name: string; event_count: number };

/** Lifecycle of the single-file FCS load. */
export type FcsStatus = "idle" | "loading" | "loaded" | "error";

/** The file/channel fields owned by this store. */
interface FileFields {
  /** Path shown in the file picker input. */
  fcsPath: string;
  /** Files loaded in this session. */
  loadedFiles: LoadedFile[];
  /** The active file, or null when none is selected. */
  file: LoadedFile | null;
  /** Channels of the active file. */
  channels: ChannelInfo[];
  /** Selected X axis channel name. */
  xChannel: string;
  /** Selected Y axis channel name. */
  yChannel: string;
  /** Q-1: every file the backend knows about (superset of loadedFiles). */
  allFiles: FileInfo[];
  fcsStatus: FcsStatus;
  fcsError: string | null;
}

type FileKey = keyof FileFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type FileSetters = {
  [K in FileKey as `set${Capitalize<K>}`]: Setter<FileFields[K]>;
};

export type FileState = FileFields & FileSetters;

function initialFields(): FileFields {
  return {
    fcsPath: "",
    loadedFiles: [],
    file: null,
    channels: [],
    xChannel: "",
    yChannel: "",
    allFiles: [],
    fcsStatus: "idle",
    fcsError: null,
  };
}

export const useFileStore = create<FileState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter =
    <K extends FileKey>(key: K): Setter<FileFields[K]> =>
    (v) =>
      set((s) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: FileFields[K]) => FileFields[K])(s[key])
            : v,
      }) as Pick<FileFields, K>);

  return {
    ...initialFields(),
    setFcsPath: makeSetter("fcsPath"),
    setLoadedFiles: makeSetter("loadedFiles"),
    setFile: makeSetter("file"),
    setChannels: makeSetter("channels"),
    setXChannel: makeSetter("xChannel"),
    setYChannel: makeSetter("yChannel"),
    setAllFiles: makeSetter("allFiles"),
    setFcsStatus: makeSetter("fcsStatus"),
    setFcsError: makeSetter("fcsError"),
  };
});

/** Reset all file/channel state to its initial state — for tests. */
export function resetFileStore(): void {
  useFileStore.setState({ ...initialFields() });
}
