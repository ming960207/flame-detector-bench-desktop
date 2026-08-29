# Flame Detector Test Listener Portable EXE

`FlameDetectorTestListener.exe` is a single-file Windows x64 launcher for the
field test listener flow.

## Requirements

- Windows x64.
- Microsoft Edge or Google Chrome installed on the computer.
- Access to the configured PLC and detector network.
- No separate Node.js or .NET SDK installation is required.

The EXE embeds the frontend, field backend, production Node.js runtime, and
runtime dependencies. The browser itself is provided by the operating system.

## Use

Double-click the EXE. It starts the field backend on port `3003`, serves the
frontend on port `3002`, and opens the interface in a dedicated browser profile.
Closing the interface stops the backend and frontend processes and removes the
temporary extracted runtime files.

Optional command-line overrides are available for diagnostics or port conflicts:

```text
FlameDetectorTestListener.exe --frontend-port 3302 --backend-port 3303
```

Both ports must be different and unused.

## Persistent data

The launcher keeps user-owned data outside the temporary extracted directory:

```text
%APPDATA%\FlameDetectorBenchPortable\runtime\system-config.json
%APPDATA%\FlameDetectorBenchPortable\runtime\plc-configs.json
%APPDATA%\FlameDetectorBenchPortable\records\
%APPDATA%\FlameDetectorBenchPortable\logs\
%APPDATA%\FlameDetectorBenchPortable\browser-profile\
```

Configuration examples are copied only on the first launch and never overwrite
existing user configuration.
