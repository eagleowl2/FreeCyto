Test fixtures for FreeCyto / OpenCyto Studio
============================================

This directory is intended to contain a small corpus of public FCS files and
their reference statistics for regression testing.

Recommended setup (per the MVP review):

- Download 3–5 public FCS files from FlowRepository (https://flowrepository.org)
  that include:
  - A known compensation matrix in the header.
  - Fluorescence data suitable for testing logicle.
  - At least one negative population.
- Either:
  - Commit them directly here if they are small (<5 MB each), or
  - Add a tests/download_fixtures.sh script that retrieves them at test time.
- Generate a references.json with, per file:
  - Event count.
  - Per-channel mean (raw).
  - Per-channel mean (compensated).
  - Per-channel logicle-transformed percentiles at standard parameters.

Until fixtures are added, the pytest tests that depend on them are marked as
skipped so they do not fail the test suite.

