# FreeCyto / OpenCyto Studio

[![CI](https://github.com/eagleowl2/FreeCyto/actions/workflows/ci.yml/badge.svg)](https://github.com/eagleowl2/FreeCyto/actions/workflows/ci.yml)

FreeCyto is an open-source, desktop flow cytometry analysis application inspired by FlowJo.  
This repository contains a **fully-featured flow cytometry workstation** with a local Python backend (FastAPI) and
an Electron + React frontend supporting:

**Core Functionality**
- Load and manage multiple `.fcs` files from disk
- Parse events and channel metadata via FlowIO with intelligent caching
- 2D scatter plots (dot plots) with WebGL rendering for 100k+ events
- Per-axis transforms: Linear, Log, Arcsinh, Logicle (exact implementation)
- Compensation matrix application with spillover table editor

**Gating & Analysis**
- Rectangle, polygon, interval, ellipse, and boolean expression gates
- Quadrant gates with automatic naming (Q1/Q2/Q3/Q4)
- Gate hierarchy with parent-child relationships and topological evaluation
- Dual-parameter labels (e.g., CD3+/CD4+) with automatic naming
- Backgating support (plot parent population with child overlay)
- Per-gate population statistics (count, percentage of parent, percentage of total)

**Workspace Management**
- Save and load named gate templates (layouts) with snapshot-based application
- Reproducible analysis workflows via template snapshots
- Batch gate application across multiple samples
- Sample grouping and population export

**Plate/Batch Processing**
- 6/12/24/48/96-well plate layouts with per-well file assignment
- Per-well gate statistics aggregation across entire plates
- Heat-map visualization for quick pattern identification

**Visualization & Export**
- Density contour lines on scatter plots
- Time-axis badges for temporal gating
- PNG export of plots
- Gated FCS 3.1 export (filtered events written back to new files)

**UX Features**
- Cursor-aware boolean expression builder with clickable gate-name chips
- Undo/redo for interactive gating
- Modal-based compensation matrix editor with full CRUD
- Responsive layout with collapsible panels
- Dark theme optimized for flow cytometry analysis

This README summarises the **current implementation stage** and active development areas.

---

## Repository structure

### Backend (`backend/`)
Python 3.11+ FastAPI service with modular architecture:

- **`main.py`** – app entrypoint, CORS setup, router registration, `/api/health`
- **`requirements.txt`** – dependencies (FastAPI, NumPy, SciPy, scikit-learn, FlowIO, logicle, etc.)
- **`routers/`** – API endpoints by domain
  - `files.py` – file loading and event streaming
    - `POST /api/files/load` – load FCS files, cache in memory
    - `GET /api/files/{file_id}/channels` – channel metadata
    - `GET /api/files/{file_id}/events` – downsampled events with transforms
  - `compensation.py` – spillover matrix management
    - `POST /api/compensation/apply` – apply compensation matrix
    - `DELETE /api/compensation/{file_id}` – remove compensation
    - `GET /api/compensation/status/{file_id}` – check compensation state
  - `gates.py` – interactive gating (create, edit, delete, evaluate)
    - `POST /api/gates` – create gate (rectangle, polygon, interval, ellipse, boolean, quadrant)
    - `GET /api/gates/{file_id}` – gate tree for file
    - `PUT /api/gates/{gate_id}` – edit gate parameters
    - `DELETE /api/gates/{gate_id}` – delete gate
    - `GET /api/gates/{gate_id}/stats` – population statistics
  - `groups.py` – sample grouping
  - `derived_params.py` – derived parameters and labels
  - `layouts.py` – gate template save/load/apply
    - `POST /api/layouts` – save current gate tree as template
    - `GET /api/layouts` – list available layouts
    - `POST /api/layouts/{layout_id}/apply` – apply layout to file
    - `DELETE /api/layouts/{layout_id}` – delete layout
  - `plates.py` – plate/batch processing
    - `POST /api/plates` – create plate (6/12/24/48/96-well)
    - `GET /api/plates` – list plates
    - `POST /api/plates/{plate_id}/wells` – assign files to wells
    - `GET /api/plates/{plate_id}/stats` – per-well gate statistics
  - `workspace.py` – full session save/restore
  - `session.py` – session management

- **`models/`** – Pydantic data models
  - `file_models.py` – file metadata, events, transforms
  - `gate_models.py` – gate definitions (all types)
  - `plate_models.py` – plate layouts and well info
  - (others organized by domain)

- **`services/`** – business logic
  - `fcs_parser.py` – FlowIO-based FCS parsing with stable file IDs
  - `storage.py` – LRU in-memory event store (cap: 2 GB)
  - `transforms.py` – per-axis transforms (linear, log, arcsinh, exact logicle)
  - `compensation.py` – spillover matrix application via `np.linalg.solve`
  - `gates.py` – gate evaluation with topological ordering and parent-child logic
  - `layouts.py` – layout snapshot management
  - `plate_service.py` – plate creation and statistics aggregation
  - `groups.py` – sample grouping logic
  - `workspace.py` – session serialization/deserialization

- **`tests/`** – comprehensive pytest suite
  - `test_phase_s.py` – boolean gates, snapshots, plate processing (22 tests)
  - `test_phase_r.py` – quadrant gates, dual labels, backgating (24 tests)
  - `test_phase_p.py` – batch operations, population export (18 tests)
  - `test_backend_workflow.py` – polygon gating, boundary conditions (40+ tests)
  - `test_flowjo_parity.py` – FlowJo validation tests (15+ tests)
  - `test_workspace_roundtrip.py` – save/load fidelity (6 tests)
  - Plus fixtures for test data

### Frontend (`frontend/`)
Electron + React + Vite + TypeScript desktop application:

- **`electron/main.js`** – Electron main process
  - Dev mode: loads Vite dev server at `http://localhost:5173/`
  - Prod mode: loads built `index.html`
  - Native file dialogs for FCS loading
  
- **`electron/preload.js`** – IPC bridge with context isolation

- **`src/App.tsx`** – main application (2700+ lines)
  - **File Panel** – load/switch samples, view metadata
  - **Plot Panel** – WebGL scatter plot (deck.gl) with:
    - Channel and transform selection
    - Density contour lines
    - Interactive gating (draw rectangle, polygon, interval)
    - Time-axis badges
  - **Gates Panel** – hierarchical gate tree with:
    - Create/edit/delete gates
    - Live population statistics
    - Parent-child relationships
  - **Compensation Panel** – spillover matrix editor with:
    - Full CRUD capability
    - Load from file button
    - Apply/reset with live preview
  - **Layouts Panel** – template management
  - **Groups Panel** – sample grouping
  - **Plate View Panel** – batch processing with:
    - Create plates (6/12/24/48/96-well)
    - Assign files to wells
    - Visualize per-well gate statistics as heat-map
  - **Workspace Panel** – save/load full session

- **`src/ScatterCanvas.tsx`** – WebGL scatter plot wrapper

- **`src/test/`** – frontend tests (Vitest)

- **`package.json`** – Electron, React, Vite, deck.gl, TypeScript

- **`vite.config.ts`** – Vite build configuration

### Documentation
- **`docs/PROJECT_LOG.md`** – detailed chronological development log (phases 0–S)
- **`docs/NEXT_STEPS.md`** – future roadmap
- **`docs/ARCHITECTURE.md`** – system design (gate evaluation, storage, API)

### Build & Config
- **`Makefile`** – `make dev`, `make dev-backend`, `make dev-frontend` targets
- **`.claude/launch.json`** – dev server configuration
- **`backend/run.sh` / `run.ps1`** – backend startup scripts
- **`packaging/`** – electron-builder config (for future releases)

---

## Current implementation stage

### Phase 0–3 (Foundational)
- **Core FCS I/O**: FlowIO parser, stable file IDs (SHA-256 hash), 2D NumPy arrays
- **Caching**: LRU in-memory store (cap: 2 GB), eviction, status API
- **Event streaming**: Downsampling, per-axis transforms (linear, log, arcsinh, **exact logicle**)
- **Compensation**: Non-destructive spillover matrix via `np.linalg.solve`, raw/compensated duality
- **CORS security**: Restricted to Electron (`null`), Vite dev server (`localhost:5173`, `127.0.0.1:5173`)

### Phase H–I (Interactive gating foundation)
- **Moveable gates** – drag-to-reposition rectangle and polygon gates in real time
- **Undo/redo** – full editing history with keyboard shortcuts (Ctrl+Z / Ctrl+Y)
- **Histogram** – frequency distribution for univariate gating
- **Interval gates** – 1D gates for univariate channels
- **Polygon drag** – redraw polygon by dragging vertices

### Phase J (Compensation UX)
- **Spillover matrix editor** – modal with full CRUD (load from file, edit cells, apply, reset)
- **Time badges** – render time-axis events with small "T" badges for temporal alignment
- **Gated FCS export** – write filtered populations back as FCS 3.1 files

### Phase K (Grouping & templates)
- **Sample groups** – group files by condition/treatment
- **Gating templates** – save current gate tree as reusable layout
- **Batch statistics** – apply layout across multiple samples simultaneously

### Phase L (Legacy boolean gates & parameters)
- **Early boolean gate support** – foundational expression parsing
- **Derived parameters** – computed channels (e.g., ratio, log-ratio)

### Phase M (Advanced export)
- **FCS export enhancement** – full FCS 3.1 spec compliance
- **PNG export** – save plots as images

### Phase N (Ellipse gates & contours)
- **Ellipse gates** – covariance-based gating via `np.linalg.eig`
- **Density contours** – KDE-based contour lines on scatter plots

### Phase O (Rename & contours)
- **Gate renaming** – update gate names with history preservation
- **Contour refinement** – improved density visualization

### Phase P (Population analysis)
- **Export UI** – export gated populations to CSV/FCS
- **Plot interactivity** – zoom, pan, crosshairs
- **Statistics panel** – real-time count/percentage updates

### Phase Q-1 to Q-4 (Advanced features)
- **Q-1: Batch application** – apply gates from one file to many
- **Q-2: Population report** – summary statistics across populations
- **Q-3: Layout snapshots** – save gate trees as frozen snapshots (not live re-reads)
- **Q-4: Compensation visualization** – pre/post plots, condition number display

### Phase R (FlowJo parity)
- **Quadrant gates** – automatic 4-quadrant splitting with naming (Q1, Q2, Q3, Q4)
- **Dual-parameter labels** – e.g., "CD3+/CD4+" with automatic naming from parent gates
- **Backgating** – plot parent population with child overlay

### Phase S (Boolean expressions & Plates)
- **S-1: Expression builder** – cursor-aware UI for boolean gate composition
  - Clickable gate-name chips with auto-quoting for special characters
  - AND/OR/NOT operator buttons
  - Recursive descent parser with AST evaluation
- **S-4: Template snapshots** – apply from stored snapshot, not live re-reads
  - Delete template functionality
- **P-1: Plate processing** – batch analysis on plate layouts
  - Support for 6, 12, 24, 48, 96-well formats
  - Per-well file assignment
  - Heat-map visualization of gate statistics
  - Efficient aggregation (no re-evaluation)

### Test Coverage
- **Backend**: 255+ tests passing (phases H–S)
  - Gate evaluation (rectangle, polygon, interval, ellipse, boolean, quadrant)
  - Compensation application
  - Layout snapshots
  - Plate operations
  - FlowJo parity validation
  - Workspace roundtrip (save/load fidelity)
- **Frontend**: 14+ tests passing (UI interactions, plot rendering)
  - Gate creation workflow
  - Compensation matrix apply
  - Plot zoom/pan
  - (2 pre-existing failures unrelated to new work)

---

## Key technical decisions

### Security & Performance
- **CORS lockdown** – Only Electron (`null`), localhost dev servers allowed. Methods/headers restricted.
- **Non-destructive compensation** – Raw events never modified. Separate `comp_events` track applied spillover.
- **LRU caching** – In-memory store capped at 2 GB; old files evicted on overflow.
- **Stable file IDs** – SHA-256 hash of first 64 KB ensures same file = same ID across sessions.
- **WebGL rendering** – deck.gl scales to 100k+ events; SVG would timeout.

### Scientific Correctness
- **Exact logicle** – Uses `logicle` package (not approximations); auto-parameter estimation from PnR.
- **Topological gate ordering** – Evaluation respects parent-child dependencies; no circular references.
- **Polygon boundary conditions** – Ray-casting algorithm handles edge cases (rays, vertices, crossings).
- **Covariance ellipses** – `np.linalg.eig` for eigenvector/eigenvalue decomposition.
- **Spillover solve** – `np.linalg.solve` for speed; backslash solve with Gaussian elimination.

### Frontend Architecture
- **Cursor-aware text insertion** – Expression builder tracks position; auto-spaces around tokens.
- **Snapshot-based layouts** – Apply from stored gate tree, not live re-read from source (prevents drift).
- **React state immutability** – All updates via setState preserve history for undo/redo.
- **Modal-driven editing** – Compensation, layouts, plates edited in modals; sidebar shows summary.
- **Responsive collapsible panels** – Adaptive layout hides secondary features until needed.

### Backend Architecture
- **Router/service separation** – Routers handle HTTP; services contain logic; models define contracts.
- **Service composition** – Gates service calls files service for event data; plates service calls gates.
- **In-memory store** – `FileRecord` holds raw + compensated events + gate tree + metadata.
- **Pydantic validation** – All requests validated; 400 on bad input; 404 on missing resources.
- **Global exception handler** – Unhandled errors return JSON `{detail, type}` for client-side logging.

---

## Development timeline

See **`docs/PROJECT_LOG.md`** for the complete chronological log with all implementation details.

### Summary by phase:

| Phase | Focus | Key Deliverable |
|-------|-------|-----------------|
| 0–3 | Foundational I/O, caching, security | FCS parsing, LRU store, CORS lockdown, logicle |
| H–I | Interactive gating basics | Moveable gates, undo/redo, histogram, interval gates |
| J | Compensation UX | Modal editor, time badges, FCS export |
| K | Grouping & workflows | Sample groups, templates, batch apply |
| L | Parameters | Boolean gates (early), derived parameters |
| M | Export | PNG export, FCS export enhancements |
| N | Ellipse & contours | Ellipse gates (KDE), density lines |
| O | Refinement | Gate rename, contour improvements |
| P | Population analysis | Export UI, zoom/pan, stats panel |
| Q-1 to Q-4 | Advanced analysis | Batch apply, population report, layout snapshots, compensation viz |
| R | FlowJo parity | Quadrant gates, dual-parameter labels, backgating |
| S | Boolean + Plates | Expression builder, snapshot fixes, plate processing |

**Total**: 255+ backend tests, 14+ frontend tests, 4,100+ lines of new code added in latest session

---

## How to run the application

### Prerequisites
- **Python 3.12+** with `venv` support (CI covers 3.12 and 3.14)
- **Node.js 20+** and `npm`

> **Ports 8765 and 5173 are pinned — do not reassign them.** The backend's CORS
> allowlist (`backend/main.py`) admits only `localhost:5173`, and the frontend calls
> a hardcoded API base on `:8765`. If either service lands on a different port,
> every API call fails CORS and surfaces in the UI as **"Failed to fetch"**. Vite is
> configured with `strictPort: true` so a busy port fails loudly. Free the port
> rather than reassigning it.

### Backend

```bash
cd backend

# First time: create and activate venv
python -m venv venv
# On Windows:
.\venv\Scripts\Activate.ps1
# On macOS/Linux:
source venv/bin/activate

# Install dependencies (add requirements-dev.txt to run the test suite)
pip install -r requirements.txt -r requirements-dev.txt

# Run the server
python main.py
```

The API will be available at `http://127.0.0.1:8765`  
Health check: `curl http://127.0.0.1:8765/api/health`

**Environment variables** (optional):
- `OPENCYTO_CACHE_MB=2048` – in-memory event cache cap (default: 2 GB)
- `OPENCYTO_LOG_LEVEL=INFO` – logging level (default: INFO)

### Frontend (Electron + React + Vite)

In a separate terminal:

```bash
cd frontend

# First time: install dependencies
npm install

# Start dev server + Electron
npm run dev
```

This will:
1. Start Vite dev server on `http://localhost:5173`
2. Launch Electron window (1280×800)
3. Auto-reload on code changes

### Running tests

**Backend (pytest)**:
```bash
cd backend
pytest tests/ -v                    # all tests
pytest tests/test_phase_s.py -v    # specific phase
pytest tests/ --cov                # with coverage
```

**Frontend (Vitest)**:
```bash
cd frontend
npm test -- --run                  # run all tests
npm test -- --watch                # watch mode
npm test -- src/test/interactions  # specific directory
```

### Continuous integration

`.github/workflows/ci.yml` runs on every push and PR to `main`:

| Job | Steps |
|-----|-------|
| `backend` (Python 3.12 + 3.14) | `pip install -r requirements.txt -r requirements-dev.txt` → `pytest -q` |
| `frontend` | `npm ci` → `tsc --noEmit` → `vitest run` → `vite build` → relative-asset-path check |

The last frontend step guards a packaging invariant: Electron loads
`dist/index.html` over `file://` in a packaged build, so an absolute
`/assets/...` reference would 404 and yield a blank window. `vite.config.ts` sets
`base: "./"` to keep asset paths relative, and CI fails if that regresses.

Run the same checks locally before pushing:

```bash
cd backend && python -m pytest -q
cd frontend && npx tsc --noEmit && npx vitest run && npx vite build
```

### Production build (experimental)

```bash
cd frontend
npm run build           # creates dist/ folder
npm run dist            # packages Electron app (requires electron-builder)
```

`dist/` is generated output and is **not** committed — it is listed in
`.gitignore`. In a packaged build Electron loads `frontend/dist/index.html`;
`frontend/index.html` is the Vite *source* entry (it references raw
`/src/main.tsx`) and must never be the production target.

---

## Planned enhancements

### Near-term
- **Workspace persistence** – full save/restore to JSON
- **Kinetic gating** – add time-based gating strategies
- **Multi-file overlay** – compare plots across samples
- **Advanced statistics** – median intensity, geometric mean, percentile gates
- **Scripting** – Python API for headless batch processing

### Medium-term
- **Additional gate types** – ML-based clustering (FlowSOM), auto-gating (SPADE)
- **Interactive machine learning** – train classifiers on gated populations
- **Real-time streaming** – consume events from FACS instruments
- **Plugin system** – user-defined gate types and analysis modules

### Long-term
- **Multi-color support** – 10+ color experiments, compensation matrix refinement
- **Spectral unmixing** – advanced compensation for multiplexed panels
- **Electron packaging** – installers for Windows/macOS/Linux
- **Cloud collaboration** – shared workspaces, team annotations

See **`docs/NEXT_STEPS.md`** for more details and definition-of-done criteria.

---

## Quick API reference

### File Management
```
POST   /api/files/load                      Load FCS files
GET    /api/files/{file_id}/channels        Get channel metadata
GET    /api/files/{file_id}/events          Get downsampled events
GET    /api/files/{file_id}/cache/status    Check cache state
DELETE /api/files/{file_id}                 Remove file from cache
```

### Gates
```
POST   /api/gates                           Create gate
GET    /api/gates/{file_id}                 Get gate tree for file
PUT    /api/gates/{gate_id}                 Edit gate
DELETE /api/gates/{gate_id}                 Delete gate
GET    /api/gates/{gate_id}/stats           Get population statistics
```

### Compensation
```
POST   /api/compensation/apply              Apply spillover matrix
DELETE /api/compensation/{file_id}          Reset compensation
GET    /api/compensation/status/{file_id}   Get compensation state
```

### Layouts (Gate Templates)
```
POST   /api/layouts                         Save gate tree as template
GET    /api/layouts                         List templates
POST   /api/layouts/{layout_id}/apply       Apply template to file
DELETE /api/layouts/{layout_id}             Delete template
```

### Plates (Batch Processing)
```
POST   /api/plates                          Create plate
GET    /api/plates                          List plates
GET    /api/plates/{plate_id}               Get plate with wells
POST   /api/plates/{plate_id}/wells         Assign files to wells
GET    /api/plates/{plate_id}/stats         Get per-well gate stats
DELETE /api/plates/{plate_id}               Delete plate
```

### Workspace
```
POST   /api/workspace/save                  Save full session
GET    /api/workspace/load                  Load session
```

---

## Contributing

Contributions are welcome! Areas of active development:
- Gate evaluation optimizations
- Frontend UI/UX refinements
- Test coverage expansion
- Documentation improvements

Please see `CONTRIBUTING.md` (coming soon) for guidelines.

---

## License

FreeCyto is **open-source** and available under the **MIT License** (details in `LICENSE.md`).

---

## Contact & Support

- **Issues & feature requests**: GitHub Issues
- **Project log**: See `docs/PROJECT_LOG.md` for development history
- **Architecture details**: See `docs/ARCHITECTURE.md` for system design

---

**Last updated**: May 2026  
**Latest phase**: S (Boolean gates, layout snapshots, plate processing)  
**Test status**: 255+ backend tests ✓ | 14+ frontend tests ✓

