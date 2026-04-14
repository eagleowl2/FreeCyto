# OpenCyto Studio — Frontend review log

Generated from a pass over `frontend/src`, `electron/`, config, and tooling. Items are **problems / risks** unless labeled as **observation** or **improvement**.

---

## Critical — data fetching & React effects

### 1. Async race: `cancelled` flag does not guard state updates inside `fetch*` helpers

**Location:** `App.tsx` — main `useEffect` (~lines 383–458) calling `fetchEventsAndPlot`, `fetchDensityAndPlot`, `fetchGateDensityAndPlot`.

**Issue:** The effect sets `cancelled = true` in the cleanup when dependencies change (e.g. user switches **linear → log** again before the previous request finishes). The helpers still call `setTransformedRange`, `setPoints`, `setDensity`, etc. **after** `await` with **no** cancellation check. Only some paths guard `setFcsStatus`; plot state can be overwritten by a **stale** response.

**Symptom:** Plot or density appears stuck, flashes wrong data, or “not responsive” after rapid transform/channel changes.

**Direction:** Use `AbortController` + `fetch` abort, or a monotonically increasing `requestId` / `transformGeneration` ref compared before every `setState` after await, or inline the fetch in the effect with a single guarded update block.

---

### 2. React Strict Mode doubles effect runs in development

**Location:** `main.tsx` wraps `<App />` in `<React.StrictMode>`.

**Issue:** The same data-fetch effect runs twice on mount; cleanup cancels the first run. Combined with (1), ordering bugs are easier to hit in dev.

**Observation:** Not a bug by itself; (1) is the fix target.

---

## High — transform / gates / channels

### 3. `clearGatesForTransformChange` depends on `gateList.length` only

**Location:** `App.tsx` `useCallback` deps `[file?.id, gateList.length]`.

**Issue:** If gate count stays the same while tree content changes (unlikely with current API) the callback could be stale. Low probability; listed for completeness.

---

### 4. Channel (X/Y) changes do not clear gates or reset `activeGateId`

**Location:** `App.tsx` — `<select>` for X/Y channel (`onChange={(e) => setXChannel(e.target.value)}` etc.).

**Issue:** Changing channels invalidates gate definitions that are tied to `x_channel` / `y_channel`. The UI may show gates that no longer apply; fetches use new channels while old gates remain in the tree until manually deleted.

**Direction:** Mirror transform behavior: optional clear gates + reset `activeGateId`, or backend validation + frontend filter.

---

### 5. `useEffect` on `file?.id` always resets `activeGateId` to `null`

**Location:** `App.tsx` ~563–568.

**Issue:** Whenever `file?.id` changes, `activeGateId` is cleared. **Intended** for new file. **Observation:** If `fetchGateTree` identity ever changed, this effect would re-fire and clear selection unexpectedly (currently `fetchGateTree` is `[]` deps — stable).

---

## High — build, types, dead code

### 6. `npm run typecheck` fails

**Location:** `WebGLScatter.tsx` + `@deck.gl/*` packages.

**Errors:** Missing declaration files for `@deck.gl/react`, `@deck.gl/layers`, `@deck.gl/core`; implicit `any` on layer callback parameter.

**Issue:** CI or strict pre-commit typecheck will fail. `vite build` may still succeed (no `tsc` in build script).

**Direction:** Add `declare module` shims in `vite-env.d.ts` or remove unused Deck code (see #7).

---

### 7. `WebGLScatter.tsx` appears unused; Deck.gl still pulls maintenance cost

**Location:** No import of `WebGLScatter` from `App.tsx` or elsewhere in `src/`.

**Issue:** Dead component; keeps `@deck.gl/*` dependencies and typecheck failures (#6). Bundle may exclude it if tree-shaken, but repo still carries cost.

**Direction:** Delete or wire up; remove deck.gl deps if deleted.

---

### 8. ESLint not configured

**Location:** `package.json` — `"lint": "echo \"TODO: add ESLint\""`.

**Issue:** No automated lint for hooks deps, a11y, or style.

---

## Medium — configuration & environment

### 9. Hardcoded `API_BASE`

**Location:** `App.tsx` — `const API_BASE = "http://127.0.0.1:8765"`.

**Issue:** No `import.meta.env.VITE_*` override for staging/production or different ports.

---

### 10. Electron preload source drift

**Location:** `electron/preload.ts` exposes only `version`; **`electron/preload.js`** exposes `openFcsFiles`, `saveWorkspaceFile`, `loadWorkspaceFile`.

**Issue:** TypeScript source does not match runtime preload; confusing and error-prone for contributors. `App.tsx` uses `globalThis as any` for `opencyto` APIs.

**Direction:** Sync `preload.ts` with `preload.js` or generate one from the other; add a typed `window.opencyto` interface.

---

### 11. Session restore uses module-level flag

**Location:** `App.tsx` — `let sessionRestoreCheckDone = false`.

**Issue:** Survives hot reload in dev in odd ways; only one offer per full page load (may be intended).

---

## Medium — UX & UI

### 12. Duplicate “All Events” / population context

**Location:** Breadcrumb row above plot **and** `GateTreePanel` root row (“All Events” + count).

**Issue:** Redundant UI; contributed to earlier layout confusion (observation).

---

### 13. Loading state vs blank plot

**Location:** Main effect sets `transformedRange` to `null` at start of fetch.

**Issue:** User may see empty axis area during load; no skeleton or explicit “Updating…” on plot (only `fcsStatus` elsewhere).

---

### 14. Density canvas performance

**Location:** `PseudocolorCanvas.tsx` — nested pixel loops fill `ImageData`.

**Issue:** Large `width × height` can block main thread; no `OffscreenCanvas` / worker.

---

## Low — accessibility & HTML

### 15. Interactive elements lack ARIA labels

**Location:** Many `button` / `div onClick` / plot overlay without `aria-label` or live regions for errors.

---

### 16. `index.html` has no CSP meta

**Observation:** Electron/web may want Content-Security-Policy for packaged app.

---

## Low — code structure

### 17. Monolithic `App.tsx`

**Issue:** Thousands of lines mixing layout, data fetching, gates, plot math, workspace — hard to test and reason about.

**Direction:** Extract hooks (`usePlotData`, `useGateTree`) and presentational components.

---

### 18. `visibleGates` uses `flattenTree(gateTree)` again

**Location:** `App.tsx` — `gateList` already flattens; `visibleGates` flattens a second time.

**Observation:** Minor duplicate work.

---

### 19. `getJson` / `postJson` assume JSON body on error

**Issue:** Non-JSON error bodies still throw with `text()` — OK; empty response edge cases rarely handled.

---

## Summary table

| ID | Severity   | Category        | Summary                                      |
|----|------------|-----------------|-----------------------------------------------|
| 1  | Critical   | State / async   | Stale in-flight fetches overwrite plot state |
| 2  | Observation | React dev      | Strict Mode amplifies races                   |
| 3  | Low        | Hooks           | `clearGates` deps narrow                      |
| 4  | High       | Gates           | Channel change vs gate consistency            |
| 5  | Observation | Effects        | `activeGateId` reset on file change           |
| 6  | High       | TypeScript      | `typecheck` fails (Deck.gl)                   |
| 7  | Medium     | Dead code       | Unused `WebGLScatter` + deck.gl               |
| 8  | Medium     | Tooling         | No ESLint                                     |
| 9  | Medium     | Config          | Hardcoded API URL                             |
| 10 | Medium     | Electron        | preload.ts vs preload.js mismatch             |
| 11 | Low        | Session         | Module flag for restore                       |
| 12 | Low        | UX              | Duplicate All Events UI                       |
| 13 | Low        | UX              | Blank plot during refetch                     |
| 14 | Low        | Performance     | Canvas CPU fill                               |
| 15 | Low        | a11y            | Missing labels                                |
| 16 | Low        | Security        | No CSP                                        |
| 17 | Medium     | Maintainability | Large `App.tsx`                               |
| 18 | Low        | Perf            | Double flatten                                |
| 19 | Low        | Network         | Error handling                                |

---

## Recommended fix order for “transform not responsive”

1. **Fix #1 (request cancellation / serial request id)** — highest impact.
2. **Re-test** linear ↔ log with slow network (throttle) to confirm.
3. Optionally **#4** if channels are changed with gates present.
4. **#6 / #7** so `typecheck` is green in CI.

---

## Resolved (implementation log)

### #1 — Plot fetch staleness (2026)

Implemented **`plotRequestGenerationRef`** in `App.tsx`: each plot-data effect run and each explicit refetch (workspace load, compensation apply/reset) bumps a monotonic generation and passes it into `fetchEventsAndPlot`, `fetchDensityAndPlot`, and `fetchGateDensityAndPlot`. After every `await`, helpers and the gate-scatter branch compare `plotGeneration` to `plotRequestGenerationRef.current` and **skip all `setState`** if superseded. Removed the previous `cancelled` flag-only approach that did not guard helper internals.

---

*End of log.*
