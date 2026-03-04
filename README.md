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
      - `POST /api/compensation/apply` – apply a spillover (compensation) matrix to a file’s events
  - `models/`
    - `file_models.py` – Pydantic models for file load/events and compensation
  - `services/`
    - `fcs_parser.py` – FlowIO-based FCS parser; extracts channel metadata and returns 2D NumPy arrays
    - `storage.py` – in-memory store of `(FileMetadata, events)` per file; downsampling helpers
    - `transforms.py` – per-channel transforms (Linear, Log, Arcsinh, Logicle-style)
    - `compensation.py` – matrix-based compensation using `events @ inv(spillover)`
  - `run.ps1` – convenience script to start the backend using the project virtualenv
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
        - Text input for an FCS path and **Load FCS** button
        - List of *Loaded files* with quick switching between samples
        - X/Y channel dropdowns populated from backend metadata
        - X/Y transform dropdowns (Linear / Log / Arcsinh / Logicle)
        - SVG-based scatter plot backed by downsampled events from the backend
  - `package.json` – Electron + React + Vite dev setup
  - `vite.config.ts` – Vite configuration with React plugin

- `docs/`
  - `PROJECT_LOG.md` – step-by-step project log and roadmap (see below)

- `packaging/` – reserved for electron-builder and Python bundling scripts (not yet implemented)
- `tests/` – reserved for pytest + Vitest test suites (not yet implemented)

---

## Current implementation stage

**Backend**

- FastAPI app with:
  - CORS enabled (development-friendly, wide-open origins)
  - `/api/health` for liveness
- FCS parsing:
  - Uses FlowIO to read FCS 2.x/3.x files
  - Extracts `$PnN`, `$PnS`, `$PnR`, `$PnE` into `ChannelMetadata`
  - Converts the FlowIO event buffer into a 2D NumPy array `(events, channels)`
  - Stores `(FileMetadata, events)` in an in-memory store keyed by file ID
- Event streaming:
  - `GET /api/files/{file_id}/events` returns:
    - A random downsample (up to `max_events`, default 50k)
    - Either all channels or a selected subset (via `x_channel`, `y_channel`)
    - Optional per-axis transforms applied on the server:
      - `transform_x`, `transform_y` ∈ {`linear`, `log`, `arcsinh`, `logicle`}
      - `arcsinh_cofactor` parameter for arcsinh
- Compensation:
  - `POST /api/compensation/apply`:
    - Accepts a square spillover matrix
    - Validates dimensions and invertibility
    - Applies `events @ inv(spillover)` and overwrites stored events

**Frontend**

- Electron shell:
  - Dev: launches a `1280x800` window pointed at `http://localhost:5173/`
  - Preload with `contextIsolation: true`, `nodeIntegration: false`
- React app:
  - Health panel:
    - Calls `/api/health` and displays **Connected / Error**
    - Styled dark theme matching the design doc
  - Quick FCS preview panel:
    - Path text box + **Load FCS** button
    - On load:
      - Calls `POST /api/files/load` with the given path
      - Caches returned `file_id`, `event_count`, and channel names
      - Adds to the `Loaded files` list for quick switching
      - Picks sensible defaults for X/Y channels (FSC/SSC if present, otherwise first/second channel)
      - Requests downsampled events from `/api/files/{id}/events`
      - Normalises data to [0, 1] for each axis and renders a green SVG dot plot
    - Channel and transform dropdowns:
      - Changing X channel, Y channel, or transforms triggers an automatic refetch and re-render

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

