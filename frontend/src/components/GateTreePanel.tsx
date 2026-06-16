import React from "react";
import type { GateNode } from "../types/gates";

function iconButtonStyle(color: string): React.CSSProperties {
  return {
    padding: "0.15rem 0.35rem",
    borderRadius: "0.25rem",
    border: "none",
    fontSize: "0.75rem",
    cursor: "pointer",
    background: "transparent",
    color,
  };
}

interface GateTreePanelProps {
  tree: GateNode[];
  totalEvents: number;
  activeGateId: string | null;
  onSelectGate: (id: string | null) => void;
  onDeleteGate: (id: string) => Promise<void>;
  /** Called with the parent gate id, or null when creating a root-level gate (A-4). */
  onCreateChild: (parentId: string | null) => void;
  /** O: rename a gate by id (PATCH name). */
  onRenameGate?: (id: string, newName: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}

const GateTreeNode: React.FC<{
  node: GateNode;
  activeGateId: string | null;
  onSelectGate: (id: string | null) => void;
  onDeleteGate: (id: string) => Promise<void>;
  onCreateChild: (parentId: string) => void;
  onRenameGate?: (id: string, newName: string) => Promise<void>;
}> = ({ node, activeGateId, onSelectGate, onDeleteGate, onCreateChild, onRenameGate }) => {
  const [expanded, setExpanded] = React.useState(true);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  // O: inline rename state
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const editInputRef = React.useRef<HTMLInputElement>(null);

  const hasChildren = (node.children?.length ?? 0) > 0;
  const isActive = activeGateId === node.id;

  // O: focus input when entering rename mode
  React.useEffect(() => {
    if (editingName !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingName]);

  const commitRename = async () => {
    if (editingName === null) return;
    const trimmed = editingName.trim();
    if (!trimmed) {
      setRenameError("Name cannot be empty");
      return;
    }
    if (trimmed === node.name) {
      setEditingName(null);
      setRenameError(null);
      return;
    }
    try {
      await onRenameGate?.(node.id, trimmed);
      setEditingName(null);
      setRenameError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRenameError(msg);
    }
  };

  const typeIcon =
    node.type === "polygon"
      ? "⬡"
      : node.type === "ellipse"
        ? "⬭"
        : node.type === "quadrant" || node.type === "quad"
          ? "⊞"
          : node.type === "boolean"
            ? "∧"
            : node.type === "interval"
              ? "─"
              : "▭";

  return (
    <div style={{ paddingLeft: `${node.depth * 14}px` }}>
      <div
        onClick={() => {
          if (editingName !== null) return; // don't select while renaming
          onSelectGate(node.id);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.35rem",
          padding: "0.25rem 0.4rem",
          borderRadius: "0.4rem",
          background: isActive ? "rgba(34,197,94,0.18)" : "transparent",
          cursor: editingName !== null ? "default" : "pointer",
          fontSize: "0.8rem",
          color: isActive ? "#bbf7d0" : "#e5e7eb",
        }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => !x);
            }}
          >
            {expanded ? "▾" : "▸"}
          </span>
        ) : (
          <span style={{ width: "0.8rem" }} />
        )}
        <span>{typeIcon}</span>

        {/* O: inline rename input */}
        {editingName !== null ? (
          <input
            ref={editInputRef}
            value={editingName}
            onChange={(e) => {
              setEditingName(e.target.value);
              setRenameError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditingName(null);
                setRenameError(null);
              }
            }}
            onBlur={() => {
              void commitRename();
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              fontSize: "0.8rem",
              background: "rgba(30,41,59,0.9)",
              border: renameError
                ? "1px solid #ef4444"
                : "1px solid rgba(99,102,241,0.6)",
              borderRadius: "0.2rem",
              color: "#e5e7eb",
              padding: "0.1rem 0.3rem",
              outline: "none",
              minWidth: 0,
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            onDoubleClick={(e) => {
              if (!onRenameGate) return;
              e.stopPropagation();
              setEditingName(node.name);
              setRenameError(null);
            }}
            title={onRenameGate ? "Double-click to rename" : undefined}
          >
            {node.name}
          </span>
        )}

        {renameError && (
          <span style={{ color: "#fca5a5", fontSize: "0.7rem", whiteSpace: "nowrap" }}>
            {renameError}
          </span>
        )}

        <span
          style={{
            color: "#9ca3af",
            whiteSpace: "nowrap",
            fontSize: "0.75rem",
          }}
        >
          {node.count.toLocaleString()}{" "}
          ({(node.pct_of_parent ?? node.pct_of_total ?? 0).toFixed(1)}%)
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCreateChild(node.id);
          }}
          title="Add child gate"
          style={iconButtonStyle("#4ade80")}
        >
          +
        </button>
        {confirmDelete ? (
          <>
            <span style={{ fontSize: "0.72rem", color: "#fca5a5" }}>
              {hasChildren ? "Delete subtree?" : "Delete?"}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void onDeleteGate(node.id);
              }}
              style={iconButtonStyle("#ef4444")}
            >
              ✓
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(false);
              }}
              style={iconButtonStyle("#6b7280")}
            >
              ✕
            </button>
          </>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) setConfirmDelete(true);
              else void onDeleteGate(node.id);
            }}
            title="Delete gate"
            style={iconButtonStyle("#fca5a5")}
          >
            ✕
          </button>
        )}
      </div>
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <GateTreeNode
            key={child.id}
            node={child}
            activeGateId={activeGateId}
            onSelectGate={onSelectGate}
            onDeleteGate={onDeleteGate}
            onCreateChild={onCreateChild}
            onRenameGate={onRenameGate}
          />
        ))}
    </div>
  );
};

export const GateTreePanel: React.FC<GateTreePanelProps> = ({
  tree,
  totalEvents,
  activeGateId,
  onSelectGate,
  onDeleteGate,
  onCreateChild,
  onRenameGate,
  loading = false,
  error = null,
}) => (
  <div style={{ fontSize: "0.8rem", color: "#e5e7eb" }}>
    <div
      onClick={() => onSelectGate(null)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.3rem 0.4rem",
        borderRadius: "0.4rem",
        background: activeGateId === null ? "rgba(34,197,94,0.18)" : "transparent",
        cursor: "pointer",
        color: activeGateId === null ? "#bbf7d0" : "#e5e7eb",
        fontSize: "0.82rem",
      }}
    >
      <span>⬡</span>
      <span style={{ fontWeight: 600 }}>All Events</span>
      <span style={{ color: "#9ca3af", marginLeft: "auto" }}>
        {totalEvents.toLocaleString()}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCreateChild(null);
        }}
        style={iconButtonStyle("#4ade80")}
      >
        +
      </button>
    </div>
    {loading && (
      <p
        style={{
          margin: "0.25rem 0 0",
          color: "#9ca3af",
          paddingLeft: "0.4rem",
          fontSize: "0.78rem",
        }}
      >
        Loading gates…
      </p>
    )}
    {!loading && error && (
      <p
        style={{
          margin: "0.25rem 0 0",
          color: "#fca5a5",
          paddingLeft: "0.4rem",
          fontSize: "0.78rem",
        }}
      >
        Failed to load gates: {error}
      </p>
    )}
    {tree.map((node) => (
      <GateTreeNode
        key={node.id}
        node={node}
        activeGateId={activeGateId}
        onSelectGate={onSelectGate}
        onDeleteGate={async (id) => {
          await onDeleteGate(id);
        }}
        onCreateChild={(parentId) => {
          onSelectGate(parentId);
          onCreateChild(parentId);
        }}
        onRenameGate={onRenameGate}
      />
    ))}
    {!loading && !error && tree.length === 0 && (
      <p
        style={{
          margin: "0.25rem 0 0",
          color: "#6b7280",
          paddingLeft: "0.4rem",
        }}
      >
        No gates. Draw a gate to get started.
      </p>
    )}
  </div>
);
