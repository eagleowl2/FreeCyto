/**
 * ExperimentContext — Phase T
 *
 * Provides the Experiment/Group/Sample hierarchy to the whole app.
 * State is loaded lazily from /api/experiments on first access and
 * kept in sync by refetching after mutations.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  Experiment,
  ExperimentCreateRequest,
  ExperimentListItem,
  Group,
  GroupCreateRequest,
  Sample,
  SampleAddRequest,
  SampleUpdateRequest,
} from "../types/experiment";

const API = "http://127.0.0.1:8765";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── context shape ───────────────────────────────────────────────────────────

interface ExperimentContextValue {
  /** Lightweight list — no groups/samples nested. */
  experimentList: ExperimentListItem[];
  /** Full details for the active experiment (groups + samples). */
  activeExperiment: Experiment | null;
  activeGroupId: string | null;
  activeSampleId: string | null;
  loading: boolean;
  error: string | null;

  // ── navigation ──────────────────────────────────────────────────────────
  selectExperiment: (expId: string | null) => void;
  selectGroup: (groupId: string | null) => void;
  selectSample: (sampleId: string | null) => void;

  // ── experiment CRUD ─────────────────────────────────────────────────────
  createExperiment: (req: ExperimentCreateRequest) => Promise<Experiment>;
  deleteExperiment: (expId: string) => Promise<void>;

  // ── group CRUD ───────────────────────────────────────────────────────────
  createGroup: (expId: string, req: GroupCreateRequest) => Promise<Group>;
  deleteGroup: (expId: string, groupId: string) => Promise<void>;

  // ── sample CRUD ──────────────────────────────────────────────────────────
  addSample: (expId: string, groupId: string, req: SampleAddRequest) => Promise<Sample>;
  updateSample: (expId: string, groupId: string, sampleId: string, req: SampleUpdateRequest) => Promise<Sample>;
  deleteSample: (expId: string, groupId: string, sampleId: string) => Promise<void>;
  moveSample: (expId: string, srcGroupId: string, sampleId: string, dstGroupId: string) => Promise<Sample>;

  /** Reload the active experiment from the server. */
  refreshActiveExperiment: () => Promise<void>;
}

const ExperimentContext = createContext<ExperimentContextValue | null>(null);

// ─── provider ────────────────────────────────────────────────────────────────

export function ExperimentProvider({ children }: { children: React.ReactNode }) {
  const [experimentList, setExperimentList] = useState<ExperimentListItem[]>([]);
  const [activeExperiment, setActiveExperiment] = useState<Experiment | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── load list on mount ──────────────────────────────────────────────────

  const loadList = useCallback(async () => {
    try {
      const list = await fetchJSON<ExperimentListItem[]>(`${API}/api/experiments`);
      setExperimentList(list);
    } catch (e: unknown) {
      console.warn("Failed to load experiment list", e);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // ── navigation ──────────────────────────────────────────────────────────

  const selectExperiment = useCallback(async (expId: string | null) => {
    setActiveGroupId(null);
    setActiveSampleId(null);
    if (!expId) {
      setActiveExperiment(null);
      return;
    }
    setLoading(true);
    try {
      const exp = await fetchJSON<Experiment>(`${API}/api/experiments/${expId}`);
      setActiveExperiment(exp);
    } catch (e: unknown) {
      setError(String(e));
      setActiveExperiment(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectGroup = useCallback((groupId: string | null) => {
    setActiveGroupId(groupId);
    setActiveSampleId(null);
  }, []);

  const selectSample = useCallback((sampleId: string | null) => {
    setActiveSampleId(sampleId);
  }, []);

  const refreshActiveExperiment = useCallback(async () => {
    if (!activeExperiment) return;
    const exp = await fetchJSON<Experiment>(`${API}/api/experiments/${activeExperiment.id}`);
    setActiveExperiment(exp);
    await loadList();
  }, [activeExperiment, loadList]);

  // ── experiment CRUD ─────────────────────────────────────────────────────

  const createExperiment = useCallback(async (req: ExperimentCreateRequest): Promise<Experiment> => {
    const exp = await fetchJSON<Experiment>(`${API}/api/experiments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    await loadList();
    return exp;
  }, [loadList]);

  const deleteExperiment = useCallback(async (expId: string) => {
    await fetchJSON<unknown>(`${API}/api/experiments/${expId}`, { method: "DELETE" });
    if (activeExperiment?.id === expId) {
      setActiveExperiment(null);
      setActiveGroupId(null);
      setActiveSampleId(null);
    }
    await loadList();
  }, [activeExperiment, loadList]);

  // ── group CRUD ───────────────────────────────────────────────────────────

  const createGroup = useCallback(async (expId: string, req: GroupCreateRequest): Promise<Group> => {
    const grp = await fetchJSON<Group>(`${API}/api/experiments/${expId}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    await refreshActiveExperiment();
    return grp;
  }, [refreshActiveExperiment]);

  const deleteGroup = useCallback(async (expId: string, groupId: string) => {
    await fetchJSON<unknown>(`${API}/api/experiments/${expId}/groups/${groupId}`, { method: "DELETE" });
    if (activeGroupId === groupId) setActiveGroupId(null);
    await refreshActiveExperiment();
  }, [activeGroupId, refreshActiveExperiment]);

  // ── sample CRUD ──────────────────────────────────────────────────────────

  const addSample = useCallback(async (expId: string, groupId: string, req: SampleAddRequest): Promise<Sample> => {
    const s = await fetchJSON<Sample>(`${API}/api/experiments/${expId}/groups/${groupId}/samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    await refreshActiveExperiment();
    return s;
  }, [refreshActiveExperiment]);

  const updateSample = useCallback(async (expId: string, groupId: string, sampleId: string, req: SampleUpdateRequest): Promise<Sample> => {
    const s = await fetchJSON<Sample>(
      `${API}/api/experiments/${expId}/groups/${groupId}/samples/${sampleId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      },
    );
    await refreshActiveExperiment();
    return s;
  }, [refreshActiveExperiment]);

  const deleteSample = useCallback(async (expId: string, groupId: string, sampleId: string) => {
    await fetchJSON<unknown>(
      `${API}/api/experiments/${expId}/groups/${groupId}/samples/${sampleId}`,
      { method: "DELETE" },
    );
    if (activeSampleId === sampleId) setActiveSampleId(null);
    await refreshActiveExperiment();
  }, [activeSampleId, refreshActiveExperiment]);

  const moveSample = useCallback(async (expId: string, srcGroupId: string, sampleId: string, dstGroupId: string): Promise<Sample> => {
    const s = await fetchJSON<Sample>(
      `${API}/api/experiments/${expId}/groups/${srcGroupId}/samples/${sampleId}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination_group_id: dstGroupId }),
      },
    );
    await refreshActiveExperiment();
    return s;
  }, [refreshActiveExperiment]);

  return (
    <ExperimentContext.Provider value={{
      experimentList,
      activeExperiment,
      activeGroupId,
      activeSampleId,
      loading,
      error,
      selectExperiment,
      selectGroup,
      selectSample,
      createExperiment,
      deleteExperiment,
      createGroup,
      deleteGroup,
      addSample,
      updateSample,
      deleteSample,
      moveSample,
      refreshActiveExperiment,
    }}>
      {children}
    </ExperimentContext.Provider>
  );
}

// ─── hook ─────────────────────────────────────────────────────────────────────

export function useExperiment(): ExperimentContextValue {
  const ctx = useContext(ExperimentContext);
  if (!ctx) throw new Error("useExperiment must be used inside <ExperimentProvider>");
  return ctx;
}
