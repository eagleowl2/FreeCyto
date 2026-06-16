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
| 2 | plot/view settings (plotMode, colormap, transforms, zoom, bg) | — | planned |
| 3 | gates (gateTree, activeGateId, stats, tools) | — | planned |
| 4 | compensation (spillover matrix, status) | — | planned |
| 5 | groups / templates | — | planned |
| 6 | plates | — | planned |
| 7 | files / channels | — | planned |

The Experiment/Group/Sample hierarchy already lives in
`src/context/ExperimentContext.tsx` (Phase T) and is left as-is for now.
