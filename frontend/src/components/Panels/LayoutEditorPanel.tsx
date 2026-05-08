/**
 * LayoutEditorPanel — Phase U
 *
 * Tabbed panel with three views:
 *   1. Templates   — list of saved layouts + create / delete
 *   2. Gate Tree   — visual hierarchy for the selected layout (LayoutEditor)
 *   3. Workflow    — ordered GatingStep designer (WorkflowDesigner)
 *   4. Metadata    — name / description / author / tags editor (TemplateMetadataEditor)
 */

import React, { useCallback, useEffect, useState } from "react";
import { LayoutEditor } from "../Editors/LayoutEditor";
import { TemplateMetadataEditor } from "../Editors/TemplateMetadataEditor";
import { WorkflowDesigner } from "../Editors/WorkflowDesigner";
import type { GatingStep, LayoutDetail, LayoutListItem } from "../../types/layout";

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function listLayouts(): Promise<LayoutListItem[]> {
  return fetchJSON<LayoutListItem[]>("/api/layouts");
}

async function getLayoutDetail(id: string): Promise<LayoutDetail> {
  return fetchJSON<LayoutDetail>(`/api/layouts/${id}`);
}

async function deleteLayoutAPI(id: string): Promise<void> {
  const res = await fetch(`/api/layouts/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status} ${res.statusText}`);
}

async function applyLayoutAPI(layoutId: string, targetFileId: string): Promise<void> {
  const res = await fetch(
    `/api/layouts/${layoutId}/apply?target_file_id=${encodeURIComponent(targetFileId)}`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

type Tab = "templates" | "tree" | "workflow" | "metadata";

const TABS: { id: Tab; label: string }[] = [
  { id: "templates", label: "Templates" },
  { id: "tree", label: "Gate Tree" },
  { id: "workflow", label: "Workflow" },
  { id: "metadata", label: "Metadata" },
];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #ddd", marginBottom: 12 }}>
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: "6px 14px",
            border: "none",
            borderBottom: active === t.id ? "2px solid #0066cc" : "2px solid transparent",
            background: "transparent",
            cursor: "pointer",
            fontWeight: active === t.id ? 700 : 400,
            color: active === t.id ? "#0066cc" : "#555",
            fontSize: 13,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Templates tab ────────────────────────────────────────────────────────────

interface TemplatesTabProps {
  items: LayoutListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onApply: (id: string) => void;
  onRefresh: () => void;
  loading: boolean;
  applyFileId: string;
  onApplyFileIdChange: (v: string) => void;
  error: string | null;
}

function TemplatesTab({
  items,
  selectedId,
  onSelect,
  onDelete,
  onApply,
  onRefresh,
  loading,
  applyFileId,
  onApplyFileIdChange,
  error,
}: TemplatesTabProps) {
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {items.length} layout{items.length !== 1 ? "s" : ""}
        </span>
        <button onClick={onRefresh} style={smallBtn}>
          {loading ? "…" : "↺ Refresh"}
        </button>
      </div>

      {error && <div style={{ color: "#c00", fontSize: 12, marginBottom: 6 }}>{error}</div>}

      {items.length === 0 && !loading && (
        <div style={{ color: "#888", fontSize: 12 }}>
          No layouts saved yet. Open a file, create gates, then click "Save layout" in the Gate panel.
        </div>
      )}

      <div style={{ maxHeight: 280, overflowY: "auto", marginBottom: 10 }}>
        {items.map((item) => (
          <div
            key={item.id}
            onClick={() => onSelect(item.id)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              padding: "8px 10px",
              marginBottom: 4,
              border: `1px solid ${selectedId === item.id ? "#0066cc" : "#ddd"}`,
              borderRadius: 6,
              background: selectedId === item.id ? "#e8f0fe" : "#fafafa",
              cursor: "pointer",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{item.name}</div>
              {item.description && (
                <div
                  style={{
                    fontSize: 11,
                    color: "#555",
                    marginBottom: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.description}
                </div>
              )}
              <div style={{ fontSize: 10, color: "#888" }}>
                {item.gate_count} gate{item.gate_count !== 1 ? "s" : ""}
                {item.strategy_step_count > 0 && ` · ${item.strategy_step_count} workflow step${item.strategy_step_count > 1 ? "s" : ""}`}
                {item.author && ` · ${item.author}`}
              </div>
              {item.tags.length > 0 && (
                <div style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {item.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        fontSize: 9,
                        background: "#e0e7ff",
                        color: "#3730a3",
                        borderRadius: 3,
                        padding: "1px 5px",
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete layout "${item.name}"?`)) onDelete(item.id);
              }}
              style={{ ...smallBtn, color: "#c00", marginLeft: 8, flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {selectedId && (
        <div
          style={{
            borderTop: "1px solid #eee",
            paddingTop: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Apply selected layout to file:
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={applyFileId}
              onChange={(e) => onApplyFileIdChange(e.target.value)}
              placeholder="Target file ID"
              style={{ flex: 1, padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4, fontSize: 12 }}
            />
            <button
              onClick={() => selectedId && onApply(selectedId)}
              disabled={!applyFileId.trim()}
              style={{ ...smallBtn, background: "#2d8a4e", color: "#fff" }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function LayoutEditorPanel() {
  const [tab, setTab] = useState<Tab>("templates");
  const [items, setItems] = useState<LayoutListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LayoutDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyFileId, setApplyFileId] = useState("");
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listLayouts();
      setItems(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function selectLayout(id: string) {
    setSelectedId(id);
    setError(null);
    try {
      const d = await getLayoutDetail(id);
      setDetail(d);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteLayoutAPI(id);
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleApply(id: string) {
    setApplyMsg(null);
    setError(null);
    try {
      await applyLayoutAPI(id, applyFileId.trim());
      setApplyMsg("Layout applied successfully.");
    } catch (e) {
      setError(String(e));
    }
  }

  function handleMetaSaved(updated: LayoutDetail) {
    setDetail(updated);
    setItems((prev) =>
      prev.map((item) =>
        item.id === updated.id
          ? {
              ...item,
              name: updated.name,
              description: updated.metadata.description,
              author: updated.metadata.author,
              tags: updated.metadata.tags,
              modified_date: updated.modified_date,
            }
          : item
      )
    );
  }

  function handleWorkflowSaved(steps: GatingStep[]) {
    if (!detail) return;
    setDetail({ ...detail, strategy: steps });
    setItems((prev) =>
      prev.map((item) =>
        item.id === detail.id
          ? { ...item, strategy_step_count: steps.length }
          : item
      )
    );
  }

  const needsSelection = !detail && (tab === "tree" || tab === "workflow" || tab === "metadata");

  return (
    <div style={{ padding: "12px 14px", maxWidth: 680 }}>
      <TabBar active={tab} onChange={setTab} />

      {tab === "templates" && (
        <TemplatesTab
          items={items}
          selectedId={selectedId}
          onSelect={selectLayout}
          onDelete={handleDelete}
          onApply={handleApply}
          onRefresh={load}
          loading={loading}
          applyFileId={applyFileId}
          onApplyFileIdChange={setApplyFileId}
          error={error}
        />
      )}

      {applyMsg && tab === "templates" && (
        <div style={{ color: "#080", fontSize: 12, marginTop: 6 }}>{applyMsg}</div>
      )}

      {needsSelection && (
        <div style={{ color: "#888", fontSize: 13 }}>
          Select a layout from the Templates tab first.
        </div>
      )}

      {tab === "tree" && detail && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            Gate Hierarchy — {detail.name}
          </div>
          <LayoutEditor layout={detail} />
        </div>
      )}

      {tab === "workflow" && detail && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            Workflow — {detail.name}
          </div>
          <WorkflowDesigner layout={detail} onSaved={handleWorkflowSaved} />
        </div>
      )}

      {tab === "metadata" && detail && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            Metadata — {detail.name}
          </div>
          <TemplateMetadataEditor layout={detail} onSaved={handleMetaSaved} />
        </div>
      )}
    </div>
  );
}

// ─── Shared small button ──────────────────────────────────────────────────────

const smallBtn: React.CSSProperties = {
  padding: "3px 9px",
  background: "#eee",
  border: "1px solid #ccc",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};
