# Test Listener Flow

This folder provides a reusable local field-listening flow for the flame detector test bench.

## One-click commands

- Double-click `start-listener.bat` to build the field server and start the read-only backend plus the field frontend.
- Double-click `stop-listener.bat` to stop only the process tree started by this flow.

## Default endpoints

- Frontend: `http://127.0.0.1:3002`
- Backend health: `http://127.0.0.1:3003/api/health`
- Backend summary: `http://127.0.0.1:3003/api/field/summary`

The backend uses `CLOSURE_MODE=field` and reads the PLC process state and detector data. It does not write PLC Q/M areas through this entry point. Stage timing and field test result records are handled by the existing field runtime.

## Runtime files

The flow stores its PID, status flags, and log in the `runtime` subfolder. The runtime files are ignored by Git.

- `runtime/listener.pid`
- `runtime/listener.status.json`
- `runtime/listener.log`
- `runtime/records/test-results-YYYY-MM-DD.log`

Each completed PLC batch is appended to the result log with detector metrics, process-stage metrics, and inspection-position values for later algorithm review.

## Port overrides

Use alternate ports when another local service is already using 3002 or 3003:

```bat
set TEST_LISTENER_SERVER_PORT=3303
set TEST_LISTENER_FRONTEND_PORT=3302
start-listener.bat
```

To skip the server build after a verified build, set `TEST_LISTENER_SKIP_BUILD=1` before starting.

The listener binds to `127.0.0.1` only. Confirm the PLC and detector configuration before using it with live equipment.
