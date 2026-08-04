# Frontend state stores (Phase X)

Phase X incrementally lifts state out of the `App.tsx` monolith (~6,900 lines,
~95 `useState` hooks) into focused [Zustand](https://github.com/pmndrs/zustand)
stores. The goal is to decouple panels/features so they can subscribe to exactly
the slice of state they need, without prop-drilling through `App`.

## Why incremental

`App.tsx` is large and under-covered by tests, so a big-bang rewrite is high
risk. Instead each store is migrated as its own slice, verified end-to-end
(`tsc --noEmit` + `vitest`) before the next slice begins. Slices are ordered
least-coupled first.

## Conventions

- One store per cohesive domain, file named `<domain>Store.ts`, hook exported as
  `use<Domain>Store`.
- Provide a `reset<Domain>Store()` helper for test isolation.
- When migrating existing `App.tsx` state, **preserve call-site signatures**:
  give setters the React `useState` shape `(v | (prev => v)) => void` so the
  migration is a pure declaration-site substitution and call sites are untouched.
  This keeps each slice a small, reviewable, low-risk diff.

## Slices

| # | Store | State migrated | Status |
|---|-------|----------------|--------|
| 1 | `uiStore` | Panel/modal visibility + section expand toggles (13 flags) | ✅ done |
| 2 | `plotStore` | Plot/view settings: plotMode, density colormap + scale, bg theme, x/y transforms, backgate + contour toggles, zoom/pan (10 fields) | ✅ done |
| 3 | `gateDrawStore` | Gate drawing/tool interaction: gateTool, drawMode, in-progress + pending shapes, drag preview, name error (10 fields) | ✅ done |
| 4 | `gateDataStore` | Gate data: gateTree, activeGateId, gate stats, loading/error flags, sort columns | — | planned |
| 5 | compensation (spillover matrix, status) | — | planned |
| 6 | groups / templates | — | planned |
| 7 | plates | — | planned |
| 8 | files / channels | — | planned |

The gate domain was deliberately split across slices 3 and 4: the drawing half is
transient pointer/keyboard state with no I/O, while the data half is driven by
async effects against `/api/files/:id/gates` and `/api/gates/:id/stats`. Keeping
them apart made slice 3 the same zero-risk declaration-site substitution as
slices 1–2.

## Test isolation

Because the stores are module-level singletons, they do **not** reset when a
component unmounts the way the `useState` hooks they replaced did. `src/test/
setup.ts` calls every `reset*Store()` in a global `afterEach` so state written by
one test cannot leak into the next. **Add a `reset` call there whenever you add a
store.**

The Experiment/Group/Sample hierarchy already lives in
`src/context/ExperimentContext.tsx` (Phase T) and is left as-is for now.
