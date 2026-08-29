# Flame Detector Test Program Flow

This folder starts the isolated, read-only test observer and its frontend.

## One-click commands

- Double-click `start-test-program.bat` to build and start the observer UI.
- Double-click `stop-test-program.bat` to stop only the process tree created by this flow.

## Default endpoints

- Test UI: `http://127.0.0.1:3005`
- Test observer: `http://127.0.0.1:3004`
- Formal status source: `http://127.0.0.1:3003`

The observer connects to the formal field status backend through read-only HTTP and WebSocket messages. It does not open a PLC connection, detector connection, or control endpoint. The formal program must be running separately.

## Archive output

By default, run data is stored under `runtime/data/archives`. Each completed or aborted run creates:

- a detailed JSON file with bounded raw and processed waveform samples;
- a Markdown report with stage timing, relay transitions, waveform counts, and decision evidence;
- an index file for the history table;
- a one-line `runtime/logs/test-results.log` record for each completed or aborted run.

The top-right gear dialog reads the formal PLC step durations as a read-only
reference and stores confirmed observer-side stage plans in
`runtime/data/test-program-config.json`. It never writes the formal PLC
configuration; changes apply to the next run.

## Optional environment variables

```bat
set FORMAL_BACKEND_URL=http://127.0.0.1:3003
set TEST_PROGRAM_SERVER_PORT=3004
set TEST_PROGRAM_FRONTEND_PORT=3005
set TEST_PROGRAM_DATA_DIR=D:\test-program-data
set TEST_PROGRAM_SKIP_BUILD=1
start-test-program.bat
```

The test UI is observation-only. Use the formal program for all equipment control actions.
