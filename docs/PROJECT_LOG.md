# Project Log – FreeCyto / OpenCyto Studio

> Last updated: 2026‑03‑04

This log tracks the implementation stages of the FreeCyto (OpenCyto Studio) MVP.

---

## 2026‑03‑04 – Initial scaffold and FCS preview loop

### Repo bootstrap

- Created monorepo layout:
  - `backend/` – Python FastAPI service
  - `frontend/` – Electron + React + Vite desktop app
  - `packaging/` – placeholder for electron-builder + Python bundling
  - `tests/` – placeholder for pytest + Vitest
  - `docs/` – documentation and logs
- Added top-level `README.md` describing architecture, current state, and roadmap.

### Backend Phase 0 – FastAPI skeleton

- Added `backend/main.py`:
  - FastAPI app with title/version.
  - CORS middleware with permissive dev configuration.
  - `/api/health` endpoint for liveness checks.
  - Uvicorn `__main__` block (`python main.py` / `python -m uvicorn` style).
- Created `backend/requirements.txt` with:
  - Web stack: `fastapi`, `uvicorn[standard]`.
  - Scientific stack: `numpy`, `pandas`, `scipy`, `scikit-learn`.
  - Cytometry stack: `flowio`, `fcsparser`, `umap-learn`, `anndata`.
- Created `backend/run.ps1` and `backend/README.md` to standardise running via the project venv.

### Backend Phase 1 – FCS parsing and event streaming

- Implemented `services/fcs_parser.py`:
  - Uses `FlowData` (FlowIO) to parse `.fcs` files.
  - Extracts channel metadata from TEXT segment:
    - `$P(i)N` → `ChannelMetadata.name`.
    - `$P(i)S` → `stain`.
    - `$P(i)R` → `range` (float when possible).
    - `$P(i)E` → `amplification`.
  - Derives number of channels from `flow.channels` or `$PAR`.
  - Converts `flow.events` buffer into a 2D NumPy array:
    - Always `(event_count, n_channels)` even if FlowIO yields a flat `array.array`.
  - Builds `FileMetadata` (ID, path, event count, channel list).
- Implemented `services/storage.py`:
  - In-memory mapping `file_id → (FileMetadata, events)`.
  - Helpers:
    - `register_file`, `get_file_metadata`, `get_file_events`.
    - `get_file_events_downsampled(file_id, max_events)` with random downsampling.
    - `set_file_events(file_id, events)` to support compensation.
- Implemented `models/file_models.py`:
  - `FileLoadRequest`, `ChannelMetadata`, `FileMetadata`, `FileLoadResponse`.
  - `FileEventsResponse` for the events endpoint.
- Implemented `routers/files.py`:
  - `POST /api/files/load`
    - Accepts a list of file paths and `downsample_events`.
    - Uses `fcs_parser.load_and_register_files` to parse and populate the store.
    - Returns `FileLoadResponse` with `FileMetadata` (including channels).
  - `GET /api/files/{file_id}/channels`
    - Returns full `FileMetadata` for an already loaded file.
  - `GET /api/files/{file_id}/events`
    - Accepts:
      - `max_events` (default 50,000; upper bound 500,000).
      - `x_channel`, `y_channel` (optional channel names to subset columns).
      - `transform_x`, `transform_y` (optional; see below).
      - `arcsinh_cofactor` (for arcsinh transform).
    - Downsamples events and optionally selects X/Y columns.
    - Returns events as nested Python lists for JSON serialisation.
    - Surfaces useful 400/500 errors when channels or transforms are invalid.

### Backend – transform and compensation core

- Added `services/transforms.py`:
  - Transform functions:
    - `linear` – identity.
    - `log` – log10 with non-positive values clamped to 1.
    - `arcsinh` – `arcsinh(x / cofactor)` with configurable cofactor (default 150).
    - `logicle` – approximate logicle using a scaled arcsinh (parameters `t, w, m, a`).
  - `TRANSFORMS` registry and `apply_transform(column, name, **kwargs)` helper.
- Extended `GET /api/files/{file_id}/events` to:
  - Accept `transform_x`, `transform_y` and `arcsinh_cofactor`.
  - Apply transforms to each axis column before serialisation.
- Added `services/compensation.py`:
  - `apply_compensation(file_id, spillover)`:
    - Validates that spillover is square and matches `events.shape[1]`.
    - Computes `inv(spillover)` and overwrites events with `events @ inv(spillover)`.
- Added `CompensationApplyRequest` / `CompensationApplyResponse` to `file_models.py`.
- Implemented `routers/compensation.py`:
  - `POST /api/compensation/apply`:
    - Validates file existence.
    - Calls `apply_compensation`; surfaces shape/invertibility issues as 400s.
- Centralised router wiring in `routers/__init__.py` and updated `main.py` to include a single `api_router`.

---

## 2026‑03‑04 – Frontend scaffold and FCS preview UI

### Frontend scaffold

- Created Electron + React + Vite setup in `frontend/`:
  - `package.json` with:
    - Scripts: `dev`, `build`, `preview`, `typecheck`, `electron:build`.
    - Dev deps: Electron, Vite, React, TypeScript, electron-builder, concurrently, wait-on.
  - `vite.config.ts` with React plugin and dev server port 5173.
  - `index.html` with `#root` element and `src/main.tsx` entry.
  - `electron/main.js`:
    - Dev: loads `http://localhost:5173/`.
    - Prod: loads built `index.html`.
    - Uses `contextIsolation: true`, `nodeIntegration: false`, and a preload script.
  - `electron/preload.js` with a minimal `window.opencyto` bridge (version only for now).

### Health check UI

- Implemented `src/main.tsx` and an initial `App.tsx`:
  - Health card:
    - Calls `/api/health` on mount and on “Re-check”.
    - Displays **Connected** (green) or **Error** with message.
    - Styled with a dark, modern card layout.

### Quick FCS/SSC preview UI

- Evolved `App.tsx` into a two-panel layout:
  - **Left**:
    - “OpenCyto Studio” card with backend health status.
  - **Right**:
    - “Quick FSC/SSC Preview” card with:
      - File path input (`C:\path\to\sample.fcs`) and **Load FCS** button.
      - A “Loaded files” mini-list:
        - Each entry corresponds to a previously loaded file.
        - Selecting an entry switches the active file and refreshes the plot.
      - X/Y channel selectors:
        - Populated from the backend `channels` metadata.
        - Defaults:
          - Tries typical scatter channels (`FSC-A`, `SSC-A`, etc.).
          - Falls back to the first two channels if no FSC/SSC names exist.
      - X/Y transform selectors:
        - `Linear`, `Log`, `Arcsinh`, `Logicle`.
        - Changing transform or channel triggers an automatic refetch.
      - Scatter plot:
        - SVG-based rendering of a downsampled subset (15k events).
        - Normalises data per axis to [0, 1].
        - Styled as a green dot cloud on a dark panel.

### Multi-file support

- The frontend maintains an array of `LoadedFile` objects with:
  - `id`, `path`, `sample_name`, `event_count`, `channels[]`.
- When loading a new file:
  - The response from `POST /api/files/load` is used to construct a `LoadedFile`.
  - If the file ID is new, it is appended to `loadedFiles`; otherwise it replaces existing metadata.
  - The app sets the active file, derives default X/Y channels, and triggers an events fetch.
- When selecting a file from the “Loaded files” list:
  - The active `file`, `channelNames`, `xChannel`, `yChannel`, and transforms are updated.
  - A `useEffect` hook observes `(file.id, xChannel, yChannel, transformX, transformY)` and
    refetches events accordingly.

---

## Next planned steps (short-term)

These align with the original OpenCyto Studio plan and current momentum:

1. **Compensation UI**
   - Frontend:
     - Lightweight spillover matrix editor with:
       - Auto-population from `$SPILLOVER` header when available.
       - Manual table editing and CSV import.
     - “Apply compensation” button that calls `POST /api/compensation/apply`.
     - Simple pre/post-comp comparison plots (side-by-side or overlay).
   - Backend:
     - Extend storage to keep both raw and compensated views so we can toggle.

2. **Gating MVP**
   - Backend:
     - Gate models and in-memory gate tree.
     - Endpoints for polygon, rectangle, and threshold gates.
     - Basic stats: count and % of parent/total.
   - Frontend:
     - Gate drawing interaction on the scatter plot.
     - Live-updating gate statistics in a right-hand sidebar table.

3. **Workspace & persistence**
   - Backend:
     - `/api/workspace/save` and `/api/workspace/load` for JSON workspaces.
     - Schema including:
       - Loaded file list (paths, IDs).
       - Channel transforms.
       - Compensation matrices and gate definitions.
   - Frontend:
     - Workspace save/load dialogs.
     - Simple gate hierarchy view in a left sidebar.

4. **Tests & packaging**
   - Introduce pytest and Vitest with a few key tests:
     - FCS parsing correctness on reference files.
     - Transform correctness against known values.
     - Basic React component tests for `App`.
   - Add electron-builder config and Python bundling strategy (conda-pack or PyInstaller).
   - Produce first cross-platform installers (Windows/macOS/Linux) for early testers.

