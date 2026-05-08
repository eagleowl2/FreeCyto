/** Phase U — Layout Editor types (returned by /api/layouts endpoints) */

export type ConditionType = "always" | "if_parent_count_gt" | "if_parent_pct_gt";

export interface GatingStep {
  gate_name: string;
  condition_type: ConditionType;
  threshold: number;
  notes: string;
}

export interface LayoutMetadata {
  description: string;
  author: string;
  compatible_channels: string[];
  tags: string[];
}

/** Compact summary returned by GET /api/layouts */
export interface LayoutListItem {
  id: string;
  name: string;
  source_file_id: string;
  gate_count: number;
  description: string;
  author: string;
  tags: string[];
  created_date: string;
  modified_date: string;
  strategy_step_count: number;
}

/** Full detail returned by GET /api/layouts/:id */
export interface LayoutDetail {
  id: string;
  name: string;
  source_file_id: string;
  gate_count: number;
  metadata: LayoutMetadata;
  strategy: GatingStep[];
  created_date: string;
  modified_date: string;
}

/** POST /api/layouts request body */
export interface LayoutCreateRequest {
  name: string;
  source_file_id: string;
}

/** PUT /api/layouts/:id request body (all fields optional) */
export interface LayoutUpdateRequest {
  name?: string;
  metadata?: LayoutMetadata;
}

/** PUT /api/layouts/:id/strategy request body */
export interface StrategyUpdateRequest {
  steps: GatingStep[];
}
