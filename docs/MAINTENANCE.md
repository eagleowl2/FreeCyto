# Maintenance notes & project invariants

Things that are load-bearing but not obvious from reading the code, plus a record
of the 2026-08-26 tech-debt sweep. Read this before "modernising" anything listed
under **Invariants** — each one has bitten before or was found mid-failure.

---

## Invariants

### Ports 8765 and 5173 are pinned

`backend/main.py` sets `ALLOWED_ORIGINS` to exactly `localhost:5173` /
`127.0.0.1:5173`, and the frontend calls a hardcoded API base on `:8765`.

If either service is allowed to auto-select a free port, every API call fails the
CORS preflight and the UI shows **"Failed to fetch"** — which looks identical to
the backend being down, and is easy to misdiagnose for a long time.

Guards in place:
- `frontend/vite.config.ts` → `server.strictPort: true` (fail loudly, don't drift)
- `.claude/launch.json` → `autoPort: false` on both services

**If a port is occupied, free it. Do not reassign it.** Widening the CORS list is
the only correct way to support a different port.

### Timestamps are deliberately *naive* UTC

`backend/timeutils.py::utcnow()` returns a **naive** datetime, not an aware one.

Layout and experiment records round-trip through `isoformat()` /
`fromisoformat()` into `~/.freecyto/*.json`, and files already on disk hold naive
strings. Switching to `datetime.now(timezone.utc)` would start writing `+00:00`
suffixes, and any comparison between a fresh value and a stored one raises
`TypeError: can't compare offset-naive and offset-aware datetimes`.

This is why the helper exists rather than a bare `datetime.now(timezone.utc)`.

### Electron production loads `dist/`, not the source entry

`frontend/index.html` is the **Vite source** entry — it references raw
`/src/main.tsx` and cannot run in a packaged app. Production must load
`frontend/dist/index.html`.

Additionally `vite.config.ts` sets `base: "./"` so built assets use relative
paths; over `file://` an absolute `/assets/...` resolves against the filesystem
root and 404s. CI asserts this (`Verify built assets use relative paths`).

### The display path must never alias the event memmap

`storage.get_file_events_downsampled()` always returns an in-memory array that
does not alias the on-disk memmap, so a display-path caller cannot write through
to the cache file. `test_backend_workflow` guards this — a regression shows up as
gate counts changing after an unrelated plot fetch.

Note the asymmetry, which is intentional:
- **downsampled branch** — fancy indexing already materialises a fresh array, so
  no extra copy is needed (wrapping it in `np.array()` duplicated ~15 MB per
  density request and was removed)
- **non-downsampled branch** — keeps its explicit `np.array()`, which is what
  detaches the result from the memmap

### Uvicorn's reloader is scoped to `backend/`

`backend/main.py` passes `reload_dirs=[backend/]`. Without it, uvicorn watches the
current working directory — from the repo root that means `frontend/node_modules`,
`backend/venv`, and every git worktree under `.claude/worktrees/` (each a full
repo copy with its own `node_modules` and 31 MB FCS fixtures). Unrelated frontend
edits then restart the backend.

### Frontend state lives in Zustand stores

See `frontend/src/stores/README.md` for the authoritative slice table. Two rules:

1. Store setters mirror React's `useState` signature — `(v | (prev => v)) => void`
   — so migrating a field is a declaration-site change only.
2. Stores are module singletons and do **not** reset on unmount. Every store needs
   a `reset<Domain>Store()` called from the global `afterEach` in
   `src/test/setup.ts`, or state leaks between tests.

---

## Tech-debt sweep — 2026-08-26

Baselines after: backend **348 passed / 1 skipped / 1 warning** (was 201
warnings), frontend **50/50**, `tsc --noEmit` clean, `vite build` clean.

### Removed: dead Electron TypeScript duplicates

`frontend/electron/main.ts` and `preload.ts` were never compiled — `package.json`
declares `electron/main.js` as the entry, and no build step targeted the `.ts`
files. They had drifted badly: `main.ts` was 39 lines with **zero** IPC handlers
against 100 lines and six handlers in the live `main.js`.

Anyone wiring up a TypeScript build for Electron — the natural move during
packaging — would have silently lost file-open, workspace save/load, and all debug
logging, with no error. Recoverable from history if a real TS migration happens;
it must port the handlers rather than resurrect these files.

### Fixed: packaged builds would have been a blank window

Electron's production branch loaded `../index.html` (the Vite source entry). Now
loads `../dist/index.html`, with `base: "./"` for relative assets. Verified the
build emits `./assets/...`; **not yet verified inside a real electron-builder
package** — confirm during the packaging phase.

### Fixed: `datetime.utcnow()` (18 call sites)

Deprecated and scheduled for removal. Consolidated into `backend/timeutils.py`,
preserving naive semantics (see Invariants). Cut test warnings from 201 to 1.

### Fixed: redundant 15 MB copy per density request

See the memmap invariant above.

### Trimmed: 6 unused backend dependencies

`pandas`, `scipy`, `scikit-learn`, `umap-learn`, `anndata`, and `fcsparser` had
**zero** references anywhere under `backend/`, but pulled in a very large
transitive tree (numba, h5py, joblib, ...) on every CI run and clean install.

They are commented out in `requirements.txt` with a note, not deleted, so
adopting one is a one-line change. Verified by installing the trimmed set into a
clean venv and running the full suite: 348 passed on numpy 2.5.2 / pytest 9.1.1.

Test-only dependencies moved to `requirements-dev.txt`.

### Git hygiene

- Untracked 11 `.pyc` files — gitignored but committed, so they showed as
  modified after every test run and polluted every diff.
- Untracked `frontend/dist/` — a committed bundle from 2026-04-14, five phases
  stale, not gitignored.
- Rewrote `.gitignore` to cover `dist/`, `.claude/worktrees/`, and logs.

### Deliberately left alone

- The five registered git worktrees under `.claude/worktrees/` — legitimate
  (`git worktree list`), not stray directories.
- The `window.opencyto` IPC bridge name and `logging.getLogger("opencyto")`.
  Legacy branding, but renaming touches the preload contract and every test for
  no functional gain. Only user-visible strings were updated.
- `frontend/index.html` remains the Vite source entry — correct for dev, and no
  longer the production target.
