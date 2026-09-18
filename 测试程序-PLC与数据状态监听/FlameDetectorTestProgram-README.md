# Flame Detector Test Program Portable EXE

`FlameDetectorTestProgram.exe` is a single-file Windows x64 package for the
read-only test observer.

## Requirements

- Windows x64.
- Microsoft Edge or Google Chrome installed.
- The formal field status program running separately, normally at
  `http://127.0.0.1:3003`.
- No separate Node.js or .NET SDK installation is required.

The test program never opens a PLC or detector session and never sends a
control message. It observes the formal program through its read-only HTTP and
WebSocket status endpoints.

## Use

Double-click the EXE. It opens the test UI on port `3005` and runs the
read-only observer on port `3004`.

Optional command-line overrides:

```text
FlameDetectorTestProgram.exe --frontend-port 3305 --backend-port 3304 --formal-backend-url http://127.0.0.1:3303 --formal-backend-ws-url ws://127.0.0.1:3003
```

Both local ports must be unused and different.

## Persistent data and configuration

The first launch creates a configuration file only if it does not already
exist:

```text
%APPDATA%\FlameDetectorTestProgram\config.json
```

The gear button in the top-right corner saves the observer-side stage plan
without writing to the formal PLC program:

```text
%APPDATA%\FlameDetectorTestProgram\data\test-program-config.json
```

The current PLC steps are shown in that dialog as read-only reference data.
Saved plan changes apply to the next test run.

Run archives and logs are kept outside the temporary extracted runtime:

```text
%APPDATA%\FlameDetectorTestProgram\data\archives\
%APPDATA%\FlameDetectorTestProgram\logs\
%APPDATA%\FlameDetectorTestProgram\browser-profile\
```

Each completed or aborted run stores a detailed JSON file and a local HTML
report containing stage timings, relay transitions, waveform samples,
thresholds, detector values, and formal decision evidence. A minimal one-line
record for every run is appended to:

```text
%APPDATA%\FlameDetectorTestProgram\logs\test-results.log
```
