/**
 * WorkflowDesigner — Phase U
 *
 * Ordered GatingStep list editor.  Users can add steps, drag to reorder,
 * edit condition type / threshold / notes, and delete steps.
 * Saves via PUT /api/layouts/:id/strategy.
 */

import React, { useEffect, useRef, useState } from "react";
import type { ConditionType, GatingStep, LayoutDetail } from "../../types/layout";

// ─── API helper ───────────────────────────────────────────────────────────────

async function putStrategy(layoutId: string, steps: GatingStep[]): Promise<GatingStep[]> {
  const res = await fetch(`/api/layouts/${layoutId}/strategy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<GatingStep[]>;
}

// ─── Blank step ───────────────────────────────────────────────────────────────

function blankStep(): GatingStep {
  return { gate_name: "", condition_type: "always", threshold: 0, notes: "" };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  layout: LayoutDetail;
  onSaved: (steps: GatingStep[]) => void;
}

export function WorkflowDesigner({ layout, onSaved }: Props) {
  const [steps, setSteps] = useState<GatingStep[]>(layout.strategy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // drag state
  const dragIdx = useRef<number | null>(null);

  useEffect(() => {
    setSteps(layout.strategy);
    setError(null);
    setSaved(false);
  }, [layout.id]);

  // ── step mutations ─────────────────────────────────────────────────────────

  function addStep() {
    setSteps((prev) => [...prev, blankStep()]);
    setSaved(false);
  }

  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  function updateStep<K extends keyof GatingStep>(idx: number, key: K, val: GatingStep[K]) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, [key]: val } : s))
    );
    setSaved(false);
  }

  // ── drag to reorder ────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, idx: number) {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    setSteps((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx.current!, 1);
      next.splice(idx, 0, moved);
      dragIdx.current = idx;
      return next;
    });
  }

  function handleDragEnd() {
    dragIdx.current = null;
  }

  // ── save ───────────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const saved_steps = await putStrategy(layout.id, steps);
      setSteps(saved_steps);
      setSaved(true);
      onSaved(saved_steps);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      {steps.length === 0 && (
        <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
          No steps yet. Click "Add step" to define the gating sequence.
        </div>
      )}

      {steps.map((step, idx) => (
        <div
          key={idx}
          draggable
          onDragStart={(e) => handleDragStart(e, idx)}
          onDragOver={(e) => handleDragOver(e, idx)}
          onDragEnd={handleDragEnd}
          style={stepCardStyle}
        >
          {/* drag handle */}
          <div style={dragHandleStyle} title="Drag to reorder">
            ⠿
          </div>

          <div style={{ flex: 1 }}>
            {/* Step number + gate name */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontWeight: 700, color: "#555", minWidth: 20, fontSize: 11 }}>
                {idx + 1}.
              </span>
              <input
                value={step.gate_name}
                onChange={(e) => updateStep(idx, "gate_name", e.target.value)}
                placeholder="Gate name"
                style={{ ...inlineInput, flex: 1 }}
              />
            </div>

            {/* Condition row */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <label style={smallLabel}>Apply when</label>
              <select
                value={step.condition_type}
                onChange={(e) =>
                  updateStep(idx, "condition_type", e.target.value as ConditionType)
                }
                style={inlineInput}
              >
                <option value="always">Always</option>
                <option value="if_parent_count_gt">Parent count &gt;</option>
                <option value="if_parent_pct_gt">Parent % &gt;</option>
              </select>
              {step.condition_type !== "always" && (
                <input
                  type="number"
                  min={0}
                  value={step.threshold}
                  onChange={(e) =>
                    updateStep(idx, "threshold", parseFloat(e.target.value) || 0)
                  }
                  style={{ ...inlineInput, width: 70 }}
                />
              )}
            </div>

            {/* Notes */}
            <input
              value={step.notes}
              onChange={(e) => updateStep(idx, "notes", e.target.value)}
              placeholder="Notes (optional)"
              style={{ ...inlineInput, width: "100%", color: "#666" }}
            />
          </div>

          <button
            onClick={() => removeStep(idx)}
            title="Remove step"
            style={removeBtn}
          >
            ✕
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={addStep} style={addBtnStyle}>
          + Add step
        </button>
        <button onClick={handleSave} disabled={saving} style={saveBtnStyle}>
          {saving ? "Saving…" : "Save workflow"}
        </button>
      </div>

      {error && <div style={{ color: "#c00", fontSize: 12, marginTop: 6 }}>{error}</div>}
      {saved && <div style={{ color: "#080", fontSize: 12, marginTop: 6 }}>Workflow saved.</div>}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const stepCardStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  background: "#f8f8f8",
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "8px 10px",
  marginBottom: 6,
  cursor: "grab",
};

const dragHandleStyle: React.CSSProperties = {
  fontSize: 18,
  color: "#aaa",
  lineHeight: 1,
  paddingTop: 2,
  userSelect: "none",
  cursor: "grab",
};

const inlineInput: React.CSSProperties = {
  padding: "3px 6px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 12,
};

const smallLabel: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  whiteSpace: "nowrap",
};

const removeBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#c00",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  paddingTop: 2,
};

const addBtnStyle: React.CSSProperties = {
  padding: "5px 12px",
  background: "#555",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

const saveBtnStyle: React.CSSProperties = {
  padding: "5px 12px",
  background: "#0066cc",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};
