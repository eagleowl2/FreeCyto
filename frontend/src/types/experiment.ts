/** Phase T — Experiment / Group / Sample type hierarchy */

export interface SampleMeta {
  treatment?: string | null;
  condition?: string | null;
  replicate?: number | null;
  timepoint?: string | null;
  notes?: string | null;
}

export interface Sample {
  id: string;
  name: string;
  file_id: string | null;
  path: string | null;
  load_status: "pending" | "loaded" | "error";
  compensation_applied: boolean;
  gate_count: number;
  created_date: string;
  modified_date: string;
  meta: SampleMeta;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  template_id: string | null;
  created_date: string;
  sample_count: number;
  samples: Sample[];
}

export interface ExperimentMeta {
  instrument?: string | null;
  operator?: string | null;
  panel?: string | null;
  organism?: string | null;
  tissue?: string | null;
  notes?: string | null;
}

export interface Experiment {
  id: string;
  name: string;
  description: string;
  default_plate_format: string;
  created_date: string;
  modified_date: string;
  meta: ExperimentMeta;
  group_count: number;
  sample_count: number;
  groups: Group[];
}

export interface ExperimentListItem {
  id: string;
  name: string;
  description: string;
  group_count: number;
  sample_count: number;
  created_date: string;
  modified_date: string;
}

/** Request bodies */
export interface ExperimentCreateRequest {
  name: string;
  description?: string;
  default_plate_format?: string;
  meta?: ExperimentMeta;
}

export interface GroupCreateRequest {
  name: string;
  description?: string;
  template_id?: string | null;
}

export interface SampleAddRequest {
  name: string;
  file_id?: string | null;
  path?: string | null;
  meta?: SampleMeta;
}

export interface SampleUpdateRequest {
  name?: string;
  file_id?: string | null;
  path?: string | null;
  load_status?: string;
  compensation_applied?: boolean;
  gate_count?: number;
  meta?: SampleMeta;
}
