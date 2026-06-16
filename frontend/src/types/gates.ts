/**
 * Gate tree types and utilities.
 * Matches backend GateResponse (nested via children).
 */

export interface GateNode {
  id: string;
  file_id: string;
  name: string;
  type: string;
  parent_gate_id: string | null;
  depth: number;
  order: number;
  x_channel: string;
  y_channel: string;
  transform_x?: string;
  transform_y?: string;
  x_min?: number | null;
  y_min?: number | null;
  x_max?: number | null;
  y_max?: number | null;
  vertices?: number[][] | null;
  expression?: string | null;
  // N: ellipse gate geometry (all in transformed space)
  center_x?: number | null;
  center_y?: number | null;
  radius_x?: number | null;
  radius_y?: number | null;
  angle?: number;
  // V: quad gate crosshair (type='quad' only)
  x_threshold?: number | null;
  y_threshold?: number | null;
  count: number;
  pct_total: number;
  pct_of_parent: number;
  pct_of_total: number;
  parent_count: number;
  children: GateNode[];
}

/**
 * Flatten tree to list (depth-first, root then children in order).
 */
export function flattenTree(nodes: GateNode[]): GateNode[] {
  const out: GateNode[] = [];
  function walk(list: GateNode[]) {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

/**
 * Find a node by id in the tree (depth-first).
 */
export function findNode(nodes: GateNode[], id: string): GateNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = n.children?.length ? findNode(n.children, id) : null;
    if (found) return found;
  }
  return null;
}

/**
 * Return path from root to node (names), or empty if not found.
 * e.g. ["All Events", "Singlets", "Lymphocytes"]
 */
export function breadcrumb(nodes: GateNode[], id: string): string[] {
  const path: string[] = [];
  function walk(list: GateNode[], acc: string[]): boolean {
    for (const n of list) {
      const next = [...acc, n.name];
      if (n.id === id) {
        path.push(...next);
        return true;
      }
      if (n.children?.length && walk(n.children, next)) return true;
    }
    return false;
  }
  walk(nodes, []);
  return path;
}

/**
 * Return path from root to node as GateNode[], or empty if not found.
 * Used for breadcrumb UI (name, count, id per segment).
 */
export function breadcrumbPath(nodes: GateNode[], id: string | null): GateNode[] {
  if (id == null) return [];
  const path: GateNode[] = [];
  function walk(list: GateNode[], acc: GateNode[]): boolean {
    for (const n of list) {
      const next = [...acc, n];
      if (n.id === id) {
        path.push(...next);
        return true;
      }
      if (n.children?.length && walk(n.children, next)) return true;
    }
    return false;
  }
  walk(nodes, []);
  return path;
}
