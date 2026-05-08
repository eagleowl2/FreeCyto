/**
 * ExperimentTree — Phase T
 *
 * Sidebar tree: Experiments ▸ Groups ▸ Samples
 * Supports expand/collapse, click-to-select, right-click context menus,
 * and drag-drop of samples between groups via HTML5 drag API.
 */

import React, { useCallback, useRef, useState } from "react";
import { useExperiment } from "../../context/ExperimentContext";
import type { ExperimentListItem, Group, Sample } from "../../types/experiment";

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  root: {
    fontFamily: "inherit",
    fontSize: 13,
    userSelect: "none" as const,
    padding: "4px 0",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 8px",
    borderBottom: "1px solid #333",
    marginBottom: 4,
  } as React.CSSProperties,
  headerLabel: {
    fontWeight: 600,
    color: "#ccc",
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  } as React.CSSProperties,
  addBtn: {
    background: "none",
    border: "none",
    color: "#4da6ff",
    cursor: "pointer",
    fontSize: 18,
    lineHeight: 1,
    padding: "0 2px",
  } as React.CSSProperties,
  node: (depth: number, selected: boolean, hovered: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    padding: `3px 8px 3px ${8 + depth * 16}px`,
    cursor: "pointer",
    borderRadius: 3,
    background: selected ? "#1e3a5f" : hovered ? "#2a2a3e" : "transparent",
    color: selected ? "#90c8ff" : "#ccc",
  }),
  chevron: (open: boolean): React.CSSProperties => ({
    display: "inline-block",
    width: 12,
    marginRight: 4,
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    transition: "transform 0.15s",
    color: "#888",
    fontSize: 10,
    flexShrink: 0,
  }),
  icon: {
    marginRight: 5,
    flexShrink: 0,
    fontSize: 12,
  } as React.CSSProperties,
  label: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  badge: {
    fontSize: 10,
    color: "#888",
    marginLeft: 4,
    flexShrink: 0,
  } as React.CSSProperties,
  statusDot: (status: string): React.CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    marginRight: 4,
    flexShrink: 0,
    background: status === "loaded" ? "#4caf50" : status === "error" ? "#f44336" : "#888",
  }),
  menu: {
    position: "fixed" as const,
    background: "#1e1e2e",
    border: "1px solid #444",
    borderRadius: 4,
    zIndex: 9999,
    minWidth: 160,
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    padding: "4px 0",
  } as React.CSSProperties,
  menuItem: {
    padding: "6px 16px",
    cursor: "pointer",
    color: "#ccc",
    fontSize: 13,
  } as React.CSSProperties,
  menuSep: {
    height: 1,
    background: "#333",
    margin: "4px 0",
  } as React.CSSProperties,
  empty: {
    color: "#555",
    fontSize: 12,
    padding: "8px 16px",
    fontStyle: "italic",
  } as React.CSSProperties,
} as const;

// ─── Context menu ─────────────────────────────────────────────────────────────

interface MenuState {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean }[];
}

function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  return (
    <>
      {/* Invisible backdrop to catch outside clicks */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onMouseDown={onClose}
      />
      <div style={{ ...styles.menu, left: menu.x, top: menu.y }}>
        {menu.items.map((item, i) =>
          item.label === "---" ? (
            <div key={i} style={styles.menuSep} />
          ) : (
            <div
              key={i}
              style={{ ...styles.menuItem, color: item.danger ? "#f44336" : "#ccc" }}
              onMouseDown={(e) => { e.stopPropagation(); item.action(); onClose(); }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#2a2a3e"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {item.label}
            </div>
          ),
        )}
      </div>
    </>
  );
}

// ─── Inline input dialog ──────────────────────────────────────────────────────

function InlineInput({
  placeholder,
  onConfirm,
  onCancel,
}: {
  placeholder: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState("");
  return (
    <input
      autoFocus
      value={val}
      placeholder={placeholder}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && val.trim()) onConfirm(val.trim());
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => { if (!val.trim()) onCancel(); }}
      style={{
        background: "#12121e",
        border: "1px solid #4da6ff",
        borderRadius: 3,
        color: "#eee",
        fontSize: 12,
        padding: "2px 6px",
        width: "100%",
        outline: "none",
      }}
    />
  );
}

// ─── Sample node ──────────────────────────────────────────────────────────────

function SampleNode({
  sample,
  expId,
  groupId,
  allGroupIds,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  sample: Sample;
  expId: string;
  groupId: string;
  allGroupIds: { id: string; name: string }[];
  onDragStart: (sampleId: string, srcGroupId: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (dstGroupId: string) => void;
}) {
  const { activeSampleId, selectSample, deleteSample } = useExperiment();
  const [hovered, setHovered] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const selected = activeSampleId === sample.id;

  const showMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const moveItems = allGroupIds
        .filter((g) => g.id !== groupId)
        .map((g) => ({
          label: `Move to "${g.name}"`,
          action: () => {
            // moveSample is called from the parent; we emit via a custom event for simplicity
            const event = new CustomEvent("freecyto:movesample", {
              detail: { expId, srcGroupId: groupId, sampleId: sample.id, dstGroupId: g.id },
            });
            window.dispatchEvent(event);
          },
        }));

      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          ...moveItems,
          ...(moveItems.length ? [{ label: "---", action: () => {} }] : []),
          {
            label: "Delete Sample",
            danger: true,
            action: () => {
              if (window.confirm(`Delete sample "${sample.name}"?`)) {
                deleteSample(expId, groupId, sample.id).catch(console.error);
              }
            },
          },
        ],
      });
    },
    [allGroupIds, groupId, expId, sample, deleteSample],
  );

  return (
    <>
      <div
        style={styles.node(2, selected, hovered)}
        draggable
        onDragStart={() => onDragStart(sample.id, groupId)}
        onDragOver={onDragOver}
        onDrop={() => onDrop(groupId)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => selectSample(sample.id)}
        onContextMenu={showMenu}
        title={sample.path ?? sample.name}
      >
        <span style={styles.statusDot(sample.load_status)} />
        <span style={{ ...styles.icon, fontSize: 11 }}>🧪</span>
        <span style={styles.label}>{sample.name}</span>
        {sample.gate_count > 0 && (
          <span style={styles.badge}>{sample.gate_count}g</span>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

// ─── Group node ───────────────────────────────────────────────────────────────

function GroupNode({
  group,
  expId,
  allGroupIds,
  dragState,
  onDragStart,
  onDrop,
}: {
  group: Group;
  expId: string;
  allGroupIds: { id: string; name: string }[];
  dragState: { sampleId: string; srcGroupId: string } | null;
  onDragStart: (sampleId: string, srcGroupId: string) => void;
  onDrop: (dstGroupId: string) => void;
}) {
  const { activeGroupId, selectGroup, createGroup, deleteGroup, addSample } = useExperiment();
  const [open, setOpen] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addingSample, setAddingSample] = useState(false);
  const selected = activeGroupId === group.id;

  const showMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Add Sample", action: () => setAddingSample(true) },
          { label: "---", action: () => {} },
          {
            label: "Delete Group",
            danger: true,
            action: () => {
              if (window.confirm(`Delete group "${group.name}" and all its samples?`)) {
                deleteGroup(expId, group.id).catch(console.error);
              }
            },
          },
        ],
      });
    },
    [expId, group, deleteGroup],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(false);
      onDrop(group.id);
    },
    [group.id, onDrop],
  );

  const nodeStyle: React.CSSProperties = {
    ...styles.node(1, selected, hovered),
    background: dropTarget
      ? "#1a3a2a"
      : selected
      ? "#1e3a5f"
      : hovered
      ? "#2a2a3e"
      : "transparent",
    border: dropTarget ? "1px dashed #4caf50" : "1px solid transparent",
  };

  return (
    <>
      <div
        style={nodeStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => { setOpen((o) => !o); selectGroup(group.id); }}
        onContextMenu={showMenu}
      >
        <span style={styles.chevron(open)}>▶</span>
        <span style={styles.icon}>📁</span>
        <span style={styles.label}>{group.name}</span>
        <span style={styles.badge}>{group.sample_count}</span>
      </div>

      {open && (
        <>
          {group.samples.map((s) => (
            <SampleNode
              key={s.id}
              sample={s}
              expId={expId}
              groupId={group.id}
              allGroupIds={allGroupIds}
              onDragStart={onDragStart}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            />
          ))}
          {addingSample && (
            <div style={{ padding: "4px 8px 4px 40px" }}>
              <InlineInput
                placeholder="Sample name…"
                onConfirm={(name) => {
                  addSample(expId, group.id, { name }).catch(console.error);
                  setAddingSample(false);
                }}
                onCancel={() => setAddingSample(false)}
              />
            </div>
          )}
          {group.samples.length === 0 && !addingSample && (
            <div style={{ ...styles.empty, paddingLeft: 40 }}>No samples</div>
          )}
        </>
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

// ─── Experiment node ──────────────────────────────────────────────────────────

function ExperimentNode({ exp }: { exp: ExperimentListItem }) {
  const {
    activeExperiment,
    selectExperiment,
    deleteExperiment,
    createGroup,
    moveSample,
  } = useExperiment();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [dragState, setDragState] = useState<{ sampleId: string; srcGroupId: string } | null>(null);

  const isActive = activeExperiment?.id === exp.id;
  const fullExp = isActive ? activeExperiment : null;

  // When this experiment becomes active and we open it, load full details
  const handleClick = useCallback(() => {
    setOpen((o) => !o);
    selectExperiment(exp.id);
  }, [exp.id, selectExperiment]);

  const showMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Add Group", action: () => { selectExperiment(exp.id); setOpen(true); setAddingGroup(true); } },
          { label: "---", action: () => {} },
          {
            label: "Delete Experiment",
            danger: true,
            action: () => {
              if (window.confirm(`Delete experiment "${exp.name}" and all its data?`)) {
                deleteExperiment(exp.id).catch(console.error);
              }
            },
          },
        ],
      });
    },
    [exp, deleteExperiment, selectExperiment],
  );

  // Handle drag-drop sample movement
  const handleDragStart = useCallback((sampleId: string, srcGroupId: string) => {
    setDragState({ sampleId, srcGroupId });
  }, []);

  const handleDrop = useCallback(
    (dstGroupId: string) => {
      if (!dragState || dragState.srcGroupId === dstGroupId) return;
      moveSample(exp.id, dragState.srcGroupId, dragState.sampleId, dstGroupId).catch(console.error);
      setDragState(null);
    },
    [dragState, exp.id, moveSample],
  );

  // Also listen for custom events from SampleNode context menu
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { expId, srcGroupId, sampleId, dstGroupId } = (e as CustomEvent).detail;
      if (expId === exp.id) {
        moveSample(expId, srcGroupId, sampleId, dstGroupId).catch(console.error);
      }
    };
    window.addEventListener("freecyto:movesample", handler);
    return () => window.removeEventListener("freecyto:movesample", handler);
  }, [exp.id, moveSample]);

  const allGroupIds = fullExp
    ? fullExp.groups.map((g) => ({ id: g.id, name: g.name }))
    : [];

  return (
    <>
      <div
        style={styles.node(0, isActive, hovered)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handleClick}
        onContextMenu={showMenu}
      >
        <span style={styles.chevron(open && isActive)}>▶</span>
        <span style={styles.icon}>🔬</span>
        <span style={styles.label}>{exp.name}</span>
        <span style={styles.badge}>{exp.group_count}g / {exp.sample_count}s</span>
      </div>

      {open && isActive && fullExp && (
        <>
          {fullExp.groups.map((grp) => (
            <GroupNode
              key={grp.id}
              group={grp}
              expId={exp.id}
              allGroupIds={allGroupIds}
              dragState={dragState}
              onDragStart={handleDragStart}
              onDrop={handleDrop}
            />
          ))}
          {addingGroup && (
            <div style={{ padding: "4px 8px 4px 24px" }}>
              <InlineInput
                placeholder="Group name…"
                onConfirm={(name) => {
                  createGroup(exp.id, { name }).catch(console.error);
                  setAddingGroup(false);
                }}
                onCancel={() => setAddingGroup(false)}
              />
            </div>
          )}
          {fullExp.groups.length === 0 && !addingGroup && (
            <div style={{ ...styles.empty, paddingLeft: 24 }}>No groups</div>
          )}
        </>
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

// ─── Root tree ────────────────────────────────────────────────────────────────

export function ExperimentTree() {
  const { experimentList, createExperiment } = useExperiment();
  const [creating, setCreating] = useState(false);

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.headerLabel}>Experiments</span>
        <button
          style={styles.addBtn}
          title="New experiment"
          onClick={() => setCreating(true)}
        >
          +
        </button>
      </div>

      {creating && (
        <div style={{ padding: "4px 8px" }}>
          <InlineInput
            placeholder="Experiment name…"
            onConfirm={(name) => {
              createExperiment({ name }).catch(console.error);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      {experimentList.length === 0 && !creating ? (
        <div style={styles.empty}>No experiments yet — click + to create one</div>
      ) : (
        experimentList.map((exp) => <ExperimentNode key={exp.id} exp={exp} />)
      )}
    </div>
  );
}
