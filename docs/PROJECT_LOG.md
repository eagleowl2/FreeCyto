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

## 2026‑03‑04 – Review-driven hardening (Phase 1–3)

This section tracks the fixes applied in response to the MVP code review
(`FreeCyto_MVP_Review`), grouped by the review's phases.

### Phase 1 – Danger issues

- **D‑1 – Wide-open CORS on local API**
  - Tightened CORS configuration in `backend/main.py`:
    - Added `ALLOWED_ORIGINS = ["null", "http://localhost:5173", "http://127.0.0.1:5173"]`.
    - CORS middleware now uses `allow_origins=ALLOWED_ORIGINS`, `allow_methods=["GET","POST","DELETE"]`,
      `allow_headers=["Content-Type"]`, `allow_credentials=False`.
  - Effect: only the Electron renderer (file:// origin) and the Vite dev server can call the API.

- **D‑2 – Compensation overwrites raw events**
  - Refactored `services/storage.py` to introduce a `FileRecord` dataclass with:
    - `metadata`, immutable `raw_events`, optional `comp_events`, `comp_matrix`, `cond`,
      and `is_compensated` flag.
  - `get_file_events(file_id)` now returns `comp_events` when `is_compensated` is `True`,
    otherwise `raw_events`.
  - `services/compensation.py` now:
    - Uses `np.linalg.solve(spillover.T, events.T).T` instead of `inv(spillover)`.
    - Computes and stores the spillover matrix condition number.
    - Populates `comp_events` and compensation metadata via `storage.set_compensation`.
  - Added compensation endpoints in `routers/compensation.py`:
    - `POST /api/compensation/apply` – apply matrix and return summary.
    - `DELETE /api/compensation/{file_id}` – reset to raw events.
    - `GET /api/compensation/status/{file_id}` – report `{file_id,is_compensated,n_channels,cond}`.

### Phase 2 – Architecture

- **A‑1 – In-memory store has no eviction**
  - Implemented `FileStore` LRU cache in `services/storage.py`:
    - Uses `OrderedDict[str, FileRecord]` plus `bytes_used` and a memory cap
      `MAX_CACHE_BYTES = int(os.getenv("OPENCYTO_CACHE_MB","2048")) * 1024**2`.
    - `add(file_id, record)` evicts oldest records until there is room.
  - New APIs in `routers/files.py`:
    - `DELETE /api/files/{file_id}` – evict a file from cache.
    - `GET /api/files/cache/status` – return `{bytes_used,max_bytes,file_count}`.

- **A‑2 – File IDs not stable across sessions**
  - Added `stable_file_id(path: Path)` in `services/fcs_parser.py`:
    - Computes SHA‑256 on the first 64 KB of file content and uses the first 16 hex
      characters as the file ID.
  - `_extract_metadata()` now assigns `file_id = stable_file_id(path)`; IDs are stable
    across restarts and independent of filesystem path.

- **A‑3 – SVG scatter plot will not scale**
  - Introduced a WebGL renderer using deck.gl:
    - Added `@deck.gl/core`, `@deck.gl/react`, `@deck.gl/layers` to `frontend/package.json`.
    - Created `frontend/src/WebGLScatter.tsx` that renders points via a `ScatterplotLayer`.
  - Updated `App.tsx`:
    - Replaced per-event SVG `<circle>` rendering with `<WebGLScatter>` for dots.
    - Retained a lightweight SVG overlay for axes/border and status text only.
  - Result: the DOM no longer contains tens of thousands of `<circle>` elements; dots are
    GPU‑rendered and ready for interactive gating.

- **A‑4 – No error boundaries / silent failures**
  - Backend:
    - Added a global `@app.exception_handler(Exception)` in `backend/main.py` which:
      - Logs the error (method and URL) via the `opencyto` logger.
      - Returns JSON `{"detail": str(exc), "type": type(exc).__name__}` with HTTP 500.
    - All router code now consistently wraps unexpected conditions in `HTTPException`
      with meaningful `detail` strings.
  - Frontend:
    - `App.tsx` already uses `fcsError` to surface message text above the plot; when
      no points are available the SVG overlay shows a “Failed to load events: …”
      message instead of a blank panel. (A more formal `useEvents` hook / error
      boundary remains a future improvement.)

- **A‑5 – Path text input for file loading**
  - Electron:
    - `frontend/electron/preload.js` now exposes:
      - `window.opencyto.openFcsFiles()` via `ipcRenderer.invoke("dialog:openFcsFiles")`.
    - `frontend/electron/main.js` registers `ipcMain.handle("dialog:openFcsFiles", ...)`
      which:
      - Opens a native file dialog restricted to `.fcs` and `.lmd`.
      - Allows multi‑selection and returns `filePaths`.
  - Frontend UI:
    - `App.tsx` replaces the free‑text path `<input>` with a readonly field and a
      **“Browse FCS…”** button that:
      - Invokes `openFcsFiles()`.
      - Updates `fcsPath` and calls `handleLoadFcs(selectedPath)`.
  - Backend:
    - `load_fcs_file()` in `services/fcs_parser.py` now rejects unsupported
      extensions before opening the file (`.fcs`/`.lmd` only).

### Phase 3 – Backend scientific correctness

- **B‑1 – Exact logicle transform**
  - Added `logicle` to backend requirements.
  - Replaced the approximate logicle in `services/transforms.py` with:
    - `Logicle(T,W,M,A).transform(values)` from the `logicle` package.
  - Added `estimate_logicle_params(channel_data)` implementing a Bagwell-style
    heuristic for T and W based on the data distribution.

- **B‑2 – Transform state persistence scaffolding**
  - Created `models/transform_models.py` with `ChannelTransform` model capturing:
    - Channel name, transform type, arcsinh cofactor, and logicle T/W/M/A.
  - Extended `FileRecord` in `services/storage.py` with an `active_transforms` map
    ready to store per-channel transform state for gating/workspace persistence.

- **B‑3 – Linux/macOS backend entry point**
  - Added `backend/run.sh`:
    - Creates a virtualenv and installs requirements on first run.
    - Always starts `main.py` via the venv.
  - Added a root `Makefile` with:
    - `dev-backend`, `dev-frontend`, and `dev` targets for consistent developer UX.

- **B‑4 – FCS test corpus scaffolding**
  - Created `tests/fixtures/README.md` documenting how to assemble a reference FCS
    corpus and expected metrics.
  - Added a placeholder `tests/test_fcs_parser.py` (marked `@pytest.mark.skip`) to
    host future regression tests without failing the current test suite.

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

