/**
 * LayoutEditor — Phase U
 *
 * Visual drag-drop gate hierarchy editor showing the gate tree for a
 * selected layout.  Users can:
 *   - Expand/collapse branches
 *   - Drag gates to reorder among siblings
 *   - View gate type, channels, and child count
 *
 * NOTE: Persisting gate-tree structural changes (reparent / reorder) is a
 * complex operation that requires round-tripping through the gate service.
 * This component provides the visual UX; the "Save as layout" button captures
 * the current live tree state via POST /api/layouts.
 */

import React, { useState } from "react";
import type { LayoutDetail } from "../../types/layout";

// ─── Types (local) ────────────────────────────────────────────────────────────

interface GateNode {
  id: string;
  name: string;
  gate_type?: string;
  x_channel?: string;
  y_channel?: string;
  children: GateNode[];
  parent_id?: string | null;
  event_count?: number;
  pct_of_parent?: number;
}

// ─── Gate node row ────────────────────────────────────────────────────────────

interface NodeRowProps {
  node: GateNode;
  depth: number;
  dragOver: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (targetId: string) => void;
}

function NodeRow({
  node,
  depth,
  dragOver,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: NodeRowProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isDropTarget = dragOver === node.id;

  const typeColor: Record<string, string> = {
    rectangle: "#2d8a4e",
    polygon: "#1a6fb5",
    ellipse: "#9b4dca",
    quadrant: "#c87900",
  };
  const dotColor = typeColor[node.gate_type ?? ""] ?? "#888";

  return (
    <>
      <div
        draggable
        onDragStart={() => onDragStart(node.id)}
        onDragOver={(e) => {
          e.preventDefault();
          onDragOver(node.id);
        }}
        onDragEnd={onDragEnd}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(node.id);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 6px",
          paddingLeft: 8 + depth * 18,
          borderRadius: 4,
          background: isDropTarget ? "#dbeafe" : "transparent",
          border: isDropTarget ? "1px dashed #3b82f6" : "1px solid transparent",
          cursor: "grab",
          userSelect: "none",
          marginBottom: 1,
        }}
      >
        {/* expand toggle */}
        <span
          style={{
            width: 16,
            fontSize: 10,
            cursor: hasChildren ? "pointer" : "default",
            color: hasChildren ? "#333" : "transparent",
          }}
          onClick={() => hasChildren && setExpanded((e) => !e)}
        >
          {hasChildren ? (expanded ? "▼" : "▶") : "•"}
        </span>

        {/* gate type dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            marginRight: 6,
            flexShrink: 0,
          }}
        />

        {/* name */}
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{node.name}</span>

        {/* channels */}
        {(node.x_channel || node.y_channel) && (
          <span style={{ fontSize: 10, color: "#666", marginRight: 6 }}>
            {[node.x_channel, node.y_channel].filter(Boolean).join(" / ")}
          </span>
        )}

        {/* type badge */}
        {node.gate_type && (
          <span
            style={{
              fontSize: 9,
              background: dotColor + "22",
              color: dotColor,
              borderRadius: 3,
              padding: "1px 5px",
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            {node.gate_type}
          </span>
        )}

        {/* child count */}
        {hasChildren && (
          <span style={{ fontSize: 10, color: "#aaa", marginLeft: 6 }}>
            {node.children.length} child{node.children.length > 1 ? "ren" : ""}
          </span>
        )}
      </div>

      {expanded &&
        node.children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            dragOver={dragOver}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDrop={onDrop}
          />
        ))}
    </>
  );
}

// ─── Gate count legend ────────────────────────────────────────────────────────

function GateLegend() {
  const types = [
    { label: "Rectangle", color: "#2d8a4e" },
    { label: "Polygon", color: "#1a6fb5" },
    { label: "Ellipse", color: "#9b4dca" },
    { label: "Quadrant", color: "#c87900" },
    { label: "Other", color: "#888" },
  ];
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
      {types.map((t) => (
        <div key={t.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: t.color,
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: "#555" }}>{t.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  layout: LayoutDetail;
}

export function LayoutEditor({ layout }: Props) {
  // We cast the stored gate_tree (any[]) to GateNode[] — the shape matches
  const gateTree = (layout as any).gate_tree as GateNode[] | undefined;

  const [localTree, setLocalTree] = useState<GateNode[]>(gateTree ?? []);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Flatten tree for lookup
  function flatten(nodes: GateNode[]): GateNode[] {
    return nodes.flatMap((n) => [n, ...flatten(n.children)]);
  }

  function handleDragStart(id: string) {
    setDragging(id);
  }

  function handleDragOver(id: string) {
    setDragOver(id);
  }

  function handleDragEnd() {
    setDragging(null);
    setDragOver(null);
  }

  function handleDrop(targetId: string) {
    if (!dragging || dragging === targetId) {
      handleDragEnd();
      return;
    }
    // Simple sibling reorder: swap within same parent
    setLocalTree((prev) => reorderSiblings(prev, dragging, targetId));
    handleDragEnd();
  }

  // Move dragged node to just before the target (same-parent only)
  function reorderSiblings(nodes: GateNode[], fromId: string, toId: string): GateNode[] {
    return nodes.map((node) => {
      const fromIdx = node.children.findIndex((c) => c.id === fromId);
      const toIdx = node.children.findIndex((c) => c.id === toId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const next = [...node.children];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return { ...node, children: next };
      }
      return { ...node, children: reorderSiblings(node.children, fromId, toId) };
    });
  }

  if (localTree.length === 0) {
    return (
      <div style={{ color: "#888", fontSize: 13, padding: 8 }}>
        No gates in this layout.
      </div>
    );
  }

  const allNodes = flatten(localTree);
  const totalGates = allNodes.length;

  return (
    <div>
      <GateLegend />
      <div style={{ fontSize: 11, color: "#666", marginBottom: 8 }}>
        {totalGates} gate{totalGates !== 1 ? "s" : ""} · drag rows to reorder siblings
      </div>
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          background: "#fafafa",
          padding: "6px 4px",
          maxHeight: 380,
          overflowY: "auto",
        }}
      >
        {localTree.map((node) => (
          <NodeRow
            key={node.id}
            node={node}
            depth={0}
            dragOver={dragOver}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
          />
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#aaa", marginTop: 6 }}>
        Tip: To permanently restructure gates, use the Gate Panel on an open file, then re-save the layout.
      </div>
    </div>
  );
}
