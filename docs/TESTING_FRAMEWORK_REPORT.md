# Testing Framework Report

Date: 2026-04-13  
Source framework: `c:\Users\user837\Downloads\TESTING_FRAMEWORK.md`

---

## Commands Executed

### Frontend

```bash
cd frontend && npx vitest run src/test/transforms/logTransform.test.tsx
```

### Backend

```bash
cd backend && pytest tests/test_log_transform.py -v
```

---

## Frontend Test Result

Status: **FAILED**

Summary:

```text
Test Files  1 failed (1)
Tests       6 failed (6)
```

Failed tests:

```text
❯ src/test/transforms/logTransform.test.tsx (6 tests | 6 failed)
  × Log transform — click interaction > sends transform_x=log to the backend when Log is selected
  × Log transform — click interaction > does NOT crash when log transform produces a zero-width range (all same values)
  × Log transform — click interaction > does NOT crash when ALL events have value 0 and log transform clamps to log10(1)=0
  × Log transform — click interaction > shows an error message (not blank screen) when backend returns 500 on log transform
  × Log transform — click interaction > switching from linear to log to linear again fetches with correct transforms each time
  × Log transform — click interaction > only the LAST request wins when transforms are switched rapidly (stale cancellation)
```

Highlighted failure output:

```text
FAIL  src/test/transforms/logTransform.test.tsx > Log transform — click interaction > sends transform_x=log to the backend when Log is selected
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
```

```text
FAIL  src/test/transforms/logTransform.test.tsx > Log transform — click interaction > does NOT crash when log transform produces a zero-width range (all same values)
TestingLibraryElementError: Found multiple elements with the text: /422,888/
```

---

## Backend Test Result

Status: **FAILED**

Summary:

```text
=========================== short test summary info ===========================
FAILED tests/test_log_transform.py::TestLogTransformEndpoint::test_log_transform_on_negative_values_clamps_correctly
FAILED tests/test_log_transform.py::TestLogTransformEndpoint::test_log_transform_output_range_matches_density_range
=================== 2 failed, 3 passed, 1 warning in 2.04s ====================
```

Highlighted failure output:

```text
E   AttributeError: 'numpy.random._generator.Generator' object has no attribute 'zeros'
```

Locations:

```text
tests/test_log_transform.py:104
tests/test_log_transform.py:126
```

---

## Notes

- Frontend failures are in the integration suite `logTransform.test.tsx` and currently block a full pass.
- Backend failures come from test code using `rng.zeros(...)` (invalid API on NumPy Generator).

---

## Follow-up Fixes Applied (2026-04-13)

- Backend typo fixed in `backend/tests/test_log_transform.py`:
  - `rng.zeros(...)` -> `np.zeros(...)` at both failing locations.
- Frontend robustness updates:
  - Added MSW request debug logging in `frontend/src/test/setup.ts`.
  - Added `data-testid="file-event-count"` to the event count display in `frontend/src/App.tsx`.
  - Updated test waits to use `getByTestId("file-event-count")` in:
    - `frontend/src/test/transforms/logTransform.test.tsx`
    - `frontend/src/test/interactions/gateCreation.test.tsx`
    - `frontend/src/test/interactions/compensationApply.test.tsx`
  - Added test environment shims in `frontend/src/test/setup.ts` for:
    - `ResizeObserver`
    - `globalThis.opencyto` bridge
    - `HTMLCanvasElement.getContext`

### Re-run Results After Fixes

Backend:

```text
pytest tests/test_log_transform.py -v
5 passed, 1 warning in 1.13s
```

Frontend:

```text
npx vitest run src/test/transforms/logTransform.test.tsx
FAILED with Node heap OOM during run
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

Additional observed frontend output confirms MSW intercepts health and load requests before the OOM.
