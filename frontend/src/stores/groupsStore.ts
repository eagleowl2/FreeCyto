/**
 * groupsStore — Phase X, slice 6: sample groups, gating templates, batch stats.
 *
 * The "K:" block of App.tsx: the list of sample groups fetched from
 * `/api/groups`, the new-group form, which group is expanded in the panel, the
 * batch-statistics table computed for a group, and the gating-template
 * save/apply form.
 *
 * These three concerns share one store because they are one panel and one
 * workflow — a template is applied *to* a group, and batch stats are computed
 * *over* a group, so their state is read and written together. Splitting them
 * would mean three stores that always change in lockstep.
 *
 * As in slice 4, the line is drawn at **state vs I/O**: `fetchGroups`,
 * `createGroup` and `deleteGroup` stay in App.tsx and call these setters.
 * Moving the fetching itself would be a real behaviour change (request
 * lifecycle, cancellation, dedup) and is out of scope for the migration.
 *
 * Design note — drop-in compatibility (same convention as slices 1–5):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setGroupError(null)`) or a functional updater
 *   (`setGroups((prev) => …)`), so all existing App.tsx call sites are unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

/** K: one sample within a group. */
export type SampleInfo = { file_id: string; label: string };

/** K: a sample group, optionally bound to a gating template. */
export type GroupInfo = {
  id: string;
  name: string;
  samples: SampleInfo[];
  template_id: string | null;
};

/** K: one row of the batch-statistics table (one gate on one sample). */
export type BatchStatRow = {
  file_id: string;
  label: string;
  gate_name: string;
  count: number;
  pct_of_parent: number;
  pct_of_total: number;
  parent_count: number;
};

/** Lifecycle of a template save/apply operation. */
export type TemplateStatus = "idle" | "working" | "done" | "error";

/** The group/template fields owned by this store. */
interface GroupsFields {
  /** Sample groups for the session. Empty until fetched. */
  groups: GroupInfo[];
  /** New-group form: name input. */
  newGroupName: string;
  /** New-group form: selected file ids. */
  newGroupFileIds: string[];
  groupError: string | null;
  /** Which group is expanded in the panel, or null for none. */
  expandedGroupId: string | null;
  /** Gate name to compute batch statistics for. */
  batchGateName: string;
  /** Batch stats for one group, tagged with the group they belong to. */
  batchStats: { groupId: string; rows: BatchStatRow[] } | null;
  batchStatsLoading: boolean;
  /** Template form: file to snapshot the gate tree from. */
  tplSourceFileId: string;
  tplName: string;
  tplStatus: TemplateStatus;
  tplError: string | null;
}

type GroupsKey = keyof GroupsFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type GroupsSetters = {
  [K in GroupsKey as `set${Capitalize<K>}`]: Setter<GroupsFields[K]>;
};

export type GroupsState = GroupsFields & GroupsSetters;

function initialFields(): GroupsFields {
  return {
    groups: [],
    newGroupName: "",
    newGroupFileIds: [],
    groupError: null,
    expandedGroupId: null,
    batchGateName: "",
    batchStats: null,
    batchStatsLoading: false,
    tplSourceFileId: "",
    tplName: "",
    tplStatus: "idle",
    tplError: null,
  };
}

export const useGroupsStore = create<GroupsState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter =
    <K extends GroupsKey>(key: K): Setter<GroupsFields[K]> =>
    (v) =>
      set((s) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: GroupsFields[K]) => GroupsFields[K])(s[key])
            : v,
      }) as Pick<GroupsFields, K>);

  return {
    ...initialFields(),
    setGroups: makeSetter("groups"),
    setNewGroupName: makeSetter("newGroupName"),
    setNewGroupFileIds: makeSetter("newGroupFileIds"),
    setGroupError: makeSetter("groupError"),
    setExpandedGroupId: makeSetter("expandedGroupId"),
    setBatchGateName: makeSetter("batchGateName"),
    setBatchStats: makeSetter("batchStats"),
    setBatchStatsLoading: makeSetter("batchStatsLoading"),
    setTplSourceFileId: makeSetter("tplSourceFileId"),
    setTplName: makeSetter("tplName"),
    setTplStatus: makeSetter("tplStatus"),
    setTplError: makeSetter("tplError"),
  };
});

/** Reset all group/template state to its initial state — for tests. */
export function resetGroupsStore(): void {
  useGroupsStore.setState({ ...initialFields() });
}
