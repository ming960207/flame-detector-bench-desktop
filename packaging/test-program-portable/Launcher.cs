using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
#if TEST_PROGRAM
    private const int DefaultFrontendPort = 3005;
    private const int DefaultBackendPort = 3004;
#else
    private const int DefaultFrontendPort = 3002;
    private const int DefaultBackendPort = 3003;
#endif
    private static readonly object LogLock = new object();
    private static readonly List<StreamWriter> LogWriters = new List<StreamWriter>();

    [STAThread]
    private static int Main(string[] args)
    {
        string tempRoot = null;
        Process backend = null;
        Process staticServer = null;
        Process browserBootstrap = null;
        string browserPath = null;
        string browserProfile = null;
        int frontendPort = DefaultFrontendPort;
        int backendPort = DefaultBackendPort;
#if TEST_PROGRAM
        string appData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FlameDetectorTestProgram");
        string existingConfigPath = Path.Combine(appData, "config.json");
        string existingConfig = File.Exists(existingConfigPath) ? File.ReadAllText(existingConfigPath) : string.Empty;
        string formalBackendUrl = ReadConfigString(existingConfig, "formalBackendUrl", "http://127.0.0.1:3003");
        string formalBackendWsUrl = ReadConfigString(existingConfig, "formalBackendWsUrl", "ws://127.0.0.1:3003");
#else
        string appData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FlameDetectorBenchPortable");
#endif

        try
        {
#if TEST_PROGRAM
            frontendPort = ReadPort(args, "--frontend-port", ReadConfigInt(existingConfig, "frontendPort", DefaultFrontendPort));
            backendPort = ReadPort(args, "--backend-port", ReadConfigInt(existingConfig, "backendPort", DefaultBackendPort));
            formalBackendUrl = ReadOption(args, "--formal-backend-url", formalBackendUrl);
            formalBackendWsUrl = ReadOption(args, "--formal-backend-ws-url", formalBackendWsUrl);
#else
            frontendPort = ReadPort(args, "--frontend-port", DefaultFrontendPort);
            backendPort = ReadPort(args, "--backend-port", DefaultBackendPort);
#endif
            if (frontendPort == backendPort)
            {
                throw new InvalidOperationException("Frontend and backend ports must be different.");
            }

            EnsurePortAvailable(frontendPort, "frontend");
            EnsurePortAvailable(backendPort, "backend");

            tempRoot = Path.Combine(Path.GetTempPath(), "FlameDetectorPortable-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            ExtractPayload(tempRoot);

#if TEST_PROGRAM
            CopyConfigIfMissing(tempRoot, "test-program.example.json", Path.Combine(appData, "config.json"));
            string runtimeData = Path.Combine(appData, "data");
            string recordsData = Path.Combine(appData, "data", "archives");
            string logsData = Path.Combine(appData, "logs");
#else
            string runtimeData = Path.Combine(appData, "runtime");
            string recordsData = Path.Combine(appData, "records");
            string logsData = Path.Combine(appData, "logs");
#endif
            Directory.CreateDirectory(runtimeData);
            Directory.CreateDirectory(recordsData);
            Directory.CreateDirectory(logsData);
#if TEST_PROGRAM
            string serverEntry = Path.Combine(tempRoot, "server", "dist", "test-program-main.js");
#else
            CopyConfigIfMissing(tempRoot, "system-config.example.json", Path.Combine(runtimeData, "system-config.json"));
            CopyConfigIfMissing(tempRoot, "plc-configs.example.json", Path.Combine(runtimeData, "plc-configs.json"));
            string serverEntry = Path.Combine(tempRoot, "server", "dist", "field-main.js");
#endif
            string nodePath = Path.Combine(tempRoot, "runtime", "node.exe");
            string staticEntry = Path.Combine(tempRoot, "static-server.mjs");
            if (!File.Exists(nodePath)) throw new FileNotFoundException("Bundled Node.js runtime is missing.", nodePath);
            if (!File.Exists(serverEntry)) throw new FileNotFoundException("Bundled backend entry is missing.", serverEntry);
            if (!File.Exists(staticEntry)) throw new FileNotFoundException("Bundled frontend server is missing.", staticEntry);

            var backendEnvironment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "NODE_ENV", "production" },
                { "APP_DATA_DIR", runtimeData },
            };
#if TEST_PROGRAM
            backendEnvironment["TEST_PROGRAM_PORT"] = backendPort.ToString();
            backendEnvironment["FORMAL_BACKEND_URL"] = formalBackendUrl;
            backendEnvironment["FORMAL_BACKEND_WS_URL"] = formalBackendWsUrl;
            backendEnvironment["TEST_PROGRAM_DATA_DIR"] = runtimeData;
            backendEnvironment["TEST_PROGRAM_RESULT_LOG_DIR"] = logsData;
#else
            backendEnvironment["CLOSURE_MODE"] = "field";
            backendEnvironment["SERVER_PORT"] = backendPort.ToString();
            backendEnvironment["TEST_RESULT_LOG_DIR"] = recordsData;
#endif
            backend = StartNode(
                nodePath,
                Quote(serverEntry),
                Path.Combine(tempRoot, "server"),
                backendEnvironment,
                Path.Combine(logsData, "backend.log"));
#if TEST_PROGRAM
            WaitForHttp("http://127.0.0.1:" + backendPort + "/api/test-program/health", backend, "test observer");
#else
            WaitForHttp("http://127.0.0.1:" + backendPort + "/api/health", backend, "backend");
#endif

            var staticEnvironment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "NODE_ENV", "production" },
            };
            string staticArguments = Quote(staticEntry)
                + " --host 127.0.0.1"
                + " --port " + frontendPort
                + " --backend-port " + backendPort
                + " --root " + Quote(Path.Combine(tempRoot, "dist"));
            staticServer = StartNode(
                nodePath,
                staticArguments,
                tempRoot,
                staticEnvironment,
                Path.Combine(logsData, "frontend.log"));
            WaitForHttp("http://127.0.0.1:" + frontendPort + "/", staticServer, "frontend");

            browserPath = FindBrowserPath();
            string browserName = Path.GetFileNameWithoutExtension(browserPath);
            browserProfile = Path.Combine(appData, "browser-profile");
            Directory.CreateDirectory(browserProfile);
            string browserArguments = "--app=" + Quote("http://127.0.0.1:" + frontendPort + "/")
                + " --user-data-dir=" + Quote(browserProfile)
                + " --no-first-run --no-default-browser-check --disable-background-mode";
            browserBootstrap = StartProcess(
                browserPath,
                browserArguments,
                appData,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
                null);

            WaitForBrowser(browserName, browserProfile, browserBootstrap);
            MonitorBrowser(browserName, browserProfile, backend, staticServer);
        }
        catch (Exception error)
        {
            ShowError(error.Message);
            return 1;
        }
        finally
        {
            if (!string.IsNullOrEmpty(browserPath) && !string.IsNullOrEmpty(browserProfile))
            {
                StopBrowser(Path.GetFileNameWithoutExtension(browserPath), browserProfile, browserBootstrap);
            }
            else
            {
                StopProcessTree(browserBootstrap);
            }
            StopProcessTree(staticServer);
            StopProcessTree(backend);
            CloseLogWriters();
            TryDeleteDirectory(tempRoot);
        }

        return 0;
    }

    private static int ReadPort(string[] args, string name, int defaultValue)
    {
        string value = ReadOption(args, name, null);
        int port;
        if (value == null) return defaultValue;
        if (!int.TryParse(value, out port) || port < 1 || port > 65535)
        {
            throw new InvalidOperationException("Invalid port value for " + name + ": " + value);
        }
        return port;
    }

    private static string ReadOption(string[] args, string name, string defaultValue)
    {
        string value = null;
        for (int index = 0; index < args.Length; index += 1)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase) && index + 1 < args.Length)
            {
                value = args[index + 1];
                break;
            }
            string prefix = name + "=";
            if (args[index].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                value = args[index].Substring(prefix.Length);
                break;
            }
        }
        return value ?? defaultValue;
    }

    private static int ReadConfigInt(string json, string property, int defaultValue)
    {
        string value = ReadConfigString(json, property, null);
        int parsed;
        return value != null && int.TryParse(value, out parsed) && parsed >= 1 && parsed <= 65535
            ? parsed
            : defaultValue;
    }

    private static string ReadConfigString(string json, string property, string defaultValue)
    {
        if (string.IsNullOrEmpty(json)) return defaultValue;
        Match match = Regex.Match(
            json,
            "\\\"" + Regex.Escape(property) + "\\\"\\s*:\\s*(?:\\\"([^\\\"]*)\\\"|(-?\\d+))",
            RegexOptions.IgnoreCase);
        if (!match.Success) return defaultValue;
        return match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
    }

    private static void EnsurePortAvailable(int port, string label)
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            listener.Start();
        }
        catch (SocketException)
        {
            throw new InvalidOperationException(
                "The " + label + " port " + port + " is already in use. "
                + "Close the conflicting service or start this EXE with a different --" + label + "-port.");
        }
        finally
        {
            listener.Stop();
        }
    }

    private static Process StartNode(
        string nodePath,
        string arguments,
        string workingDirectory,
        IDictionary<string, string> environment,
        string logPath)
    {
        return StartProcess(nodePath, arguments, workingDirectory, environment, logPath);
    }

    private static Process StartProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        IDictionary<string, string> environment,
        string logPath)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = logPath != null,
            RedirectStandardError = logPath != null,
        };
        foreach (KeyValuePair<string, string> item in environment)
        {
            startInfo.EnvironmentVariables[item.Key] = item.Value;
        }

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start()) throw new InvalidOperationException("Unable to start process: " + fileName);
        if (logPath != null) BeginLogCapture(process, logPath);
        return process;
    }

    private static void BeginLogCapture(Process process, string logPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(logPath));
        var writer = new StreamWriter(
            new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
            new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        lock (LogLock) LogWriters.Add(writer);
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            WriteLogLine(writer, args.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            WriteLogLine(writer, args.Data);
        };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
    }

    private static void WriteLogLine(StreamWriter writer, string line)
    {
        if (string.IsNullOrEmpty(line)) return;
        try
        {
            lock (LogLock) writer.WriteLine(line);
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private static void WaitForHttp(string url, Process process, string label)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                throw new InvalidOperationException(label + " process exited before becoming ready.");
            }

            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 1000;
                request.ReadWriteTimeout = 1000;
                request.Proxy = null;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode >= 200 && statusCode < 300) return;
                }
            }
            catch (WebException)
            {
            }
            Thread.Sleep(250);
        }

        throw new TimeoutException(label + " did not become ready within 30 seconds: " + url);
    }

    private static string FindBrowserPath()
    {
        string programFiles = Environment.GetEnvironmentVariable("ProgramW6432")
            ?? Environment.GetEnvironmentVariable("ProgramFiles");
        string programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new List<string>
        {
            Path.Combine(programFiles ?? string.Empty, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFilesX86 ?? string.Empty, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFiles ?? string.Empty, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86 ?? string.Empty, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }

        foreach (string name in new[] { "msedge.exe", "chrome.exe" })
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = name,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var process = Process.Start(startInfo))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(3000);
                    foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (File.Exists(line.Trim())) return line.Trim();
                    }
                }
            }
            catch
            {
            }
        }

        throw new InvalidOperationException(
            "Microsoft Edge or Google Chrome was not found. Install a system browser and try again.");
    }

    private static void WaitForBrowser(string processName, string profile, Process bootstrap)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (FindBrowserPids(processName, profile).Count > 0) return;
            Thread.Sleep(250);
        }
        throw new TimeoutException(
            "The browser did not open the application. Check the frontend log and browser installation.");
    }

    private static void MonitorBrowser(string processName, string profile, Process backend, Process staticServer)
    {
        bool observed = false;
        DateTime? missingSince = null;
        DateTime startupDeadline = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            if (backend.HasExited) throw new InvalidOperationException("Backend exited while the application was open.");
            if (staticServer.HasExited) throw new InvalidOperationException("Frontend server exited while the application was open.");

            HashSet<int> browserPids = FindBrowserPids(processName, profile);
            if (browserPids.Count > 0)
            {
                observed = true;
                missingSince = null;
            }
            else if (observed)
            {
                if (!missingSince.HasValue) missingSince = DateTime.UtcNow;
                if (DateTime.UtcNow - missingSince.Value >= TimeSpan.FromSeconds(3)) return;
            }
            if (!observed && DateTime.UtcNow >= startupDeadline)
            {
                throw new TimeoutException("The application window could not be monitored.");
            }
            Thread.Sleep(500);
        }
    }

    private static HashSet<int> FindBrowserPids(string processName, string profile)
    {
        var result = new HashSet<int>();
        string executableName = processName + ".exe";
        using (var searcher = new ManagementObjectSearcher(
            "SELECT Name, ProcessId, CommandLine FROM Win32_Process WHERE Name = '" + executableName + "'"))
        using (ManagementObjectCollection processes = searcher.Get())
        {
            foreach (ManagementObject item in processes)
            {
                string name = item["Name"] as string;
                string commandLine = item["CommandLine"] as string;
                if (!string.Equals(name, executableName, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrEmpty(commandLine)) continue;
                if (commandLine.IndexOf(profile, StringComparison.OrdinalIgnoreCase) < 0) continue;
                result.Add(Convert.ToInt32(item["ProcessId"]));
            }
        }
        return result;
    }

    private static void StopBrowser(string processName, string profile, Process bootstrap)
    {
        try
        {
            foreach (int pid in FindBrowserPids(processName, profile))
            {
                KillProcessTree(pid);
            }
        }
        catch
        {
        }
        StopProcessTree(bootstrap);
    }

    private static void StopProcessTree(Process process)
    {
        if (process == null) return;
        try
        {
            if (!process.HasExited) KillProcessTree(process.Id);
        }
        catch
        {
        }
        finally
        {
            try { process.Dispose(); } catch { }
        }
    }

    private static void KillProcessTree(int processId)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "taskkill.exe",
                Arguments = "/PID " + processId + " /T /F",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            using (var process = Process.Start(startInfo))
            {
                process.WaitForExit(5000);
            }
        }
        catch
        {
        }
    }

    private static void CopyConfigIfMissing(string tempRoot, string exampleName, string targetPath)
    {
        if (File.Exists(targetPath)) return;
        string sourcePath = Path.Combine(tempRoot, "config", exampleName);
        if (!File.Exists(sourcePath)) throw new FileNotFoundException("Configuration example is missing.", sourcePath);
        Directory.CreateDirectory(Path.GetDirectoryName(targetPath));
        File.Copy(sourcePath, targetPath);
    }

    private static void ExtractPayload(string targetRoot)
    {
        string resourceName = Assembly.GetExecutingAssembly()
            .GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith("Payload.zip", StringComparison.OrdinalIgnoreCase));
        if (resourceName == null) throw new InvalidOperationException("Embedded application payload is missing.");

        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
        using (var archive = new ZipArchive(resource, ZipArchiveMode.Read))
        {
            string root = Path.GetFullPath(targetRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string relativePath = entry.FullName
                    .Replace('/', Path.DirectorySeparatorChar)
                    .Replace('\\', Path.DirectorySeparatorChar);
                string destination = Path.GetFullPath(Path.Combine(targetRoot, relativePath));
                if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("Embedded payload contains an unsafe path.");
                }
                if (entry.FullName.EndsWith("/", StringComparison.Ordinal))
                {
                    Directory.CreateDirectory(destination);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                using (Stream input = entry.Open())
                using (Stream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    input.CopyTo(output);
                }
            }
        }
    }

    private static void CloseLogWriters()
    {
        lock (LogLock)
        {
            foreach (StreamWriter writer in LogWriters)
            {
                try { writer.Dispose(); } catch { }
            }
            LogWriters.Clear();
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        if (string.IsNullOrEmpty(path) || !Directory.Exists(path)) return;
        for (int attempt = 0; attempt < 3; attempt += 1)
        {
            try
            {
                Directory.Delete(path, true);
                return;
            }
            catch
            {
                Thread.Sleep(250);
            }
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(
            message,
            "Flame Detector Bench failed to start",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
    }
}
