# FreeCyto / OpenCyto Studio (MVP scaffold)

FreeCyto is an open-source, desktop flow cytometry analysis application inspired by FlowJo.  
This repository currently contains an **MVP scaffold** for a local Python backend (FastAPI) and
an Electron + React frontend that can already:

- Load `.fcs` files from disk
- Parse events and channel metadata via FlowIO
- Downsample and stream events over HTTP
- Render a 2D scatter plot (dot plot) in the desktop app
- Let you pick X/Y channels and per-axis transforms (Linear, Log, Arcsinh, Logicle)

This README summarises the **current implementation stage** and the planned next steps.

---

## Repository structure

- `backend/` – Python 3.11+ FastAPI service
  - `main.py` – app entrypoint, CORS setup, router wiring, `/api/health`
  - `requirements.txt` – scientific + web stack (FastAPI, NumPy, SciPy, scikit-learn, FlowIO, etc.)
  - `routers/`
    - `files.py` – file API:
      - `POST /api/files/load` – load one or more FCS files, cache events in memory, return metadata
      - `GET /api/files/{file_id}/channels` – full `FileMetadata` (channel list, counts, etc.)
      - `GET /api/files/{file_id}/events` – downsampled events with optional per-axis transforms
    - `compensation.py` – compensation API:
      - `POST /api/compensation/apply`, `DELETE /api/compensation/{file_id}`, `GET /api/compensation/status/{file_id}`
  - `models/`
    - `file_models.py` – Pydantic models for file load/events and compensation
  - `services/`
    - `fcs_parser.py` – FlowIO-based FCS parser; stable file IDs; 2D NumPy arrays
    - `storage.py` – LRU file store (raw + compensated events); cache status
    - `transforms.py` – per-channel transforms (exact logicle via `logicle` package)
    - `compensation.py` – `np.linalg.solve`-based compensation; non-destructive
  - `run.ps1` / `run.sh` – start backend with project venv
  - `README.md` – backend-specific run instructions

- `frontend/` – Electron + React + Vite desktop app
  - `electron/main.js` – Electron main process:
    - Dev mode: loads Vite dev server at `http://localhost:5173/`
    - Prod mode: loads built `index.html`
  - `electron/preload.js` – minimal `contextBridge` preload (extensible later)
  - `index.html` – Vite entry HTML with React mount point
  - `src/`
    - `main.tsx` – React root renderer
    - `App.tsx` – current MVP UI:
      - Left: backend health card (FastAPI at `127.0.0.1:8765`)
      - Right: **Quick FSC/SSC Preview** panel:
        - **Browse FCS…** (native dialog via `openFcsFiles` IPC)
        - List of *Loaded files* with quick switching between samples
        - X/Y channel and transform dropdowns (Linear / Log / Arcsinh / Logicle)
        - WebGL scatter plot (`WebGLScatter.tsx`, deck.gl) + compensation UI
    - `WebGLScatter.tsx` – deck.gl scatter layer for event dots
  - `package.json` – Electron + React + Vite + deck.gl
  - `vite.config.ts` – Vite configuration with React plugin

- `docs/`
  - `PROJECT_LOG.md` – step-by-step project log and roadmap (see below)

- `packaging/` – reserved for electron-builder and Python bundling scripts (not yet implemented)
- `tests/` – pytest placeholder (`test_fcs_parser.py`); `tests/fixtures/README.md` for FCS corpus
- `Makefile` – `dev-backend`, `dev-frontend`, `dev` targets

---

## Current implementation stage

**Backend**

- FastAPI app with:
  - CORS restricted to Electron + Vite dev origins (see Phase 1)
  - `/api/health` for liveness
  - Global exception handler returning JSON `detail`/`type` on 500
- FCS parsing:
  - Uses FlowIO to read FCS 2.x/3.x files (`.fcs`/`.lmd` only)
  - Stable file IDs from content hash (first 64 KB)
  - Extracts `$PnN`, `$PnS`, `$PnR`, `$PnE` into `ChannelMetadata`
  - Converts the FlowIO event buffer into a 2D NumPy array `(events, channels)`
  - LRU in-memory store (cap via `OPENCYTO_CACHE_MB`); `DELETE /api/files/{file_id}`, `GET /api/files/cache/status`
- Event streaming:
  - `GET /api/files/{file_id}/events` returns:
    - A random downsample (up to `max_events`, default 50k)
    - Either all channels or a selected subset (via `x_channel`, `y_channel`)
    - Optional per-axis transforms (exact logicle via `logicle` package):
      - `transform_x`, `transform_y` ∈ {`linear`, `log`, `arcsinh`, `logicle`}
      - `arcsinh_cofactor` parameter for arcsinh
- Compensation:
  - Raw events kept; compensation writes to separate `comp_events` via `np.linalg.solve`
  - `POST /api/compensation/apply`, `DELETE /api/compensation/{file_id}`, `GET /api/compensation/status/{file_id}`

**Frontend**

- Electron shell:
  - Dev: launches a `1280x800` window pointed at `http://localhost:5173/`
  - Preload with `contextIsolation: true`, `nodeIntegration: false`
- React app:
  - Health panel:
    - Calls `/api/health` and displays **Connected / Error**
    - Styled dark theme matching the design doc
  - Quick FCS preview panel:
    - **Browse FCS…** button (native file dialog via Electron IPC; `.fcs`/`.lmd` only)
    - On load:
      - Calls `POST /api/files/load` with the selected path(s)
      - Caches returned `file_id`, `event_count`, and channel names
      - Adds to the `Loaded files` list for quick switching
      - Picks sensible defaults for X/Y channels (FSC/SSC if present, otherwise first/second channel)
      - Requests downsampled events from `/api/files/{id}/events`
      - Normalises data to [0, 1] and renders a **WebGL scatter** (deck.gl); error message shown if fetch fails
    - Channel and transform dropdowns:
      - Changing X channel, Y channel, or transforms triggers an automatic refetch and re-render
    - Compensation textarea + **Apply compensation** calling `POST /api/compensation/apply`

---

## Review-driven fixes (Phase 1–3)

After the MVP code review, the following hardening was applied. Full explanations are in `docs/PROJECT_LOG.md` (section *Review-driven hardening*).

**Phase 1 – Danger**

- **D-1 CORS** – API no longer accepts all origins. Only `null` (Electron), `http://localhost:5173`, and `http://127.0.0.1:5173` are allowed; methods and headers are restricted.
- **D-2 Compensation** – Raw events are never overwritten. Storage keeps both `raw_events` and `comp_events`; compensation uses `np.linalg.solve` and exposes `DELETE /api/compensation/{file_id}` and `GET /api/compensation/status/{file_id}` to reset or inspect.

**Phase 2 – Architecture**

- **A-1 LRU cache** – In-memory store is capped (default 2 GB via `OPENCYTO_CACHE_MB`). Oldest files are evicted when the cap is exceeded. `DELETE /api/files/{file_id}` and `GET /api/files/cache/status` added.
- **A-2 Stable file IDs** – File IDs are derived from a SHA-256 hash of the first 64 KB of file content (16 hex chars), so the same file gets the same ID across sessions and paths.
- **A-3 WebGL scatter** – Scatter plot uses deck.gl (`WebGLScatter.tsx`) instead of thousands of SVG circles, so it scales to large event counts and is ready for interactive gating.
- **A-4 Errors** – Global exception handler in the backend returns JSON with `detail` and `type`; frontend shows error text above the plot when events fail to load.
- **A-5 File picker** – FCS loading uses a native file dialog (Electron IPC `openFcsFiles`) restricted to `.fcs`/`.lmd`; backend rejects other extensions.

**Phase 3 – Backend scientific correctness**

- **B-1 Logicle** – Logicle transform uses the exact `logicle` package implementation; `estimate_logicle_params()` added for heuristic T/W.
- **B-2 Transform state** – `ChannelTransform` model and `active_transforms` on `FileRecord` added as scaffolding for per-channel transform persistence.
- **B-3 Run scripts** – `backend/run.sh` and root `Makefile` (`dev-backend`, `dev-frontend`, `dev`) added for Linux/macOS and consistent dev UX.
- **B-4 Test corpus** – `tests/fixtures/README.md` and placeholder `tests/test_fcs_parser.py` added for future FCS regression tests.

---

## PROJECT_LOG (high level)

See `docs/PROJECT_LOG.md` for a detailed, chronological log.  
High-level completed stages:

1. **Monorepo scaffold**
   - `backend/`, `frontend/`, `packaging/`, `tests/`, `docs/`
2. **Backend Phase 0/1**
   - FastAPI skeleton with `/api/health`
   - FCS parser + in-memory store + event downsampling
   - Per-axis transforms service
   - Compensation API (apply spillover matrix)
3. **Frontend Phase 0/1**
   - Electron + React + Vite dev setup
   - Health card + FCS path input
   - Downsampled scatter plot wired to backend
   - Channel & transform controls, multiple-file loading and switching
4. **Review Phase 1–3** (see *Review-driven fixes* above and `docs/PROJECT_LOG.md`)
   - Danger: CORS tightening, non-destructive compensation
   - Architecture: LRU cache, stable file IDs, WebGL scatter, error handling, native file picker
   - Backend: exact logicle, transform scaffolding, run scripts, test corpus scaffolding

---

## How to run the current MVP

### Backend

```powershell
cd backend
.\venv\Scripts\Activate.ps1           # activate existing venv
python main.py                        # or: .\venv\Scripts\python.exe main.py
```

The API will be available at `http://127.0.0.1:8765` (check `/api/health`).

### Frontend (Electron + Vite)

```powershell
cd frontend
npm install       # first time only
npm run dev
```

This starts Vite on port 5173 and launches Electron pointing at the dev server.

---

## Next planned steps

Short-term roadmap items (taken from the OpenCyto Studio plan and current work):

1. **Compensation UI**
   - Frontend editor for spillover matrices (load from header, edit manually)
   - “Apply compensation” toggle and basic pre/post-comp plots
2. **Gating MVP**
   - Backend gate engine and `/api/gates/*` endpoints for polygon/rect/threshold
   - Frontend gate drawing on the scatter plot and live gate stats
3. **Workspace & persistence**
   - JSON workspace save/load (`/api/workspace/*`)
   - Left-hand workspace tree and simple gate hierarchy view
4. **Packaging**
   - electron-builder config and Python bundling (conda-pack or PyInstaller)
   - First installable builds for Windows/macOS/Linux

