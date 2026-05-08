/**
 * TemplateMetadataEditor — Phase U
 *
 * Edit a layout's name, description, author, and tags.
 * Saves via PUT /api/layouts/:id.
 */

import React, { useEffect, useState } from "react";
import type { LayoutDetail, LayoutMetadata } from "../../types/layout";

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function updateLayoutAPI(
  id: string,
  name: string,
  metadata: LayoutMetadata
): Promise<LayoutDetail> {
  return fetchJSON<LayoutDetail>(`/api/layouts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, metadata }),
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  layout: LayoutDetail;
  onSaved: (updated: LayoutDetail) => void;
}

export function TemplateMetadataEditor({ layout, onSaved }: Props) {
  const [name, setName] = useState(layout.name);
  const [description, setDescription] = useState(layout.metadata.description);
  const [author, setAuthor] = useState(layout.metadata.author);
  const [tagsInput, setTagsInput] = useState(layout.metadata.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Reset when a different layout is selected
  useEffect(() => {
    setName(layout.name);
    setDescription(layout.metadata.description);
    setAuthor(layout.metadata.author);
    setTagsInput(layout.metadata.tags.join(", "));
    setError(null);
    setSaved(false);
  }, [layout.id]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await updateLayoutAPI(layout.id, name, {
        description,
        author,
        compatible_channels: layout.metadata.compatible_channels,
        tags,
      });
      setSaved(true);
      onSaved(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "0 4px" }}>
      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Author</label>
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Tags (comma-separated)</label>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="T-cells, PBMC, CD4"
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Compatible channels (auto-detected)</label>
        <div style={{ fontSize: 12, color: "#555", fontFamily: "monospace" }}>
          {layout.metadata.compatible_channels.length > 0
            ? layout.metadata.compatible_channels.join(", ")
            : "— (save a layout from a file to auto-populate)"}
        </div>
      </div>

      <div style={{ marginBottom: 6 }}>
        <label style={labelStyle}>Gates</label>
        <div style={{ fontSize: 12, color: "#555" }}>
          {layout.gate_count} gate{layout.gate_count !== 1 ? "s" : ""}
        </div>
      </div>

      <div style={{ marginBottom: 6 }}>
        <label style={labelStyle}>Created</label>
        <div style={{ fontSize: 12, color: "#555" }}>
          {new Date(layout.created_date).toLocaleString()}
        </div>
      </div>

      {error && (
        <div style={{ color: "#c00", fontSize: 12, marginBottom: 6 }}>{error}</div>
      )}
      {saved && (
        <div style={{ color: "#080", fontSize: 12, marginBottom: 6 }}>Saved.</div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !name.trim()}
        style={btnStyle}
      >
        {saving ? "Saving…" : "Save metadata"}
      </button>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "#444",
  marginBottom: 3,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "5px 8px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 13,
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "#0066cc",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
};
