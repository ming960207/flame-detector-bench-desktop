using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var instanceLock = new Mutex(true, "Global\\FlameDetectorBench.WebView", out var isFirstInstance);
        if (!isFirstInstance)
        {
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new BenchApplicationContext());
    }
}

internal sealed class BenchApplicationContext : ApplicationContext
{
    private readonly BackendHost _backend = new();
    private BenchForm? _form;

    public BenchApplicationContext()
    {
        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            var layout = AppLayout.Resolve();
            var port = PortFinder.Find();
            _backend.Start(layout, port);
            await _backend.WaitForReadyAsync().ConfigureAwait(true);

            _form = new BenchForm(layout, port);
            _form.FormClosed += HandleFormClosed;
            await _form.InitializeAsync().ConfigureAwait(true);
            _form.Show();
        }
        catch (Exception error)
        {
            var message = error is COMException
                ? "未找到 Microsoft Edge WebView2 Runtime。请在目标电脑安装 WebView2 Runtime 后重试。\n\n" + error.Message
                : error.Message;
            MessageBox.Show(message, "火焰探测器检测台启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitThread();
        }
    }

    private void HandleFormClosed(object? sender, FormClosedEventArgs args)
    {
        ExitThread();
    }

    protected override void ExitThreadCore()
    {
        _form?.Dispose();
        _backend.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class BenchForm : Form
{
    private readonly AppLayout _layout;
    private readonly int _backendPort;
    private readonly WebView2 _webView = new();

    public BenchForm(AppLayout layout, int backendPort)
    {
        _layout = layout;
        _backendPort = backendPort;
        Text = "火焰探测器检测台";
        Width = 1600;
        Height = 900;
        MinimumSize = new Size(1280, 720);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(2, 6, 23);
        AutoScaleMode = AutoScaleMode.Dpi;
        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);
    }

    public async Task InitializeAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FlameDetectorBench",
            "webview");
        Directory.CreateDirectory(userDataFolder);

        var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
        await _webView.EnsureCoreWebView2Async(environment);
        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.NewWindowRequested += (_, args) => args.Handled = true;
        _webView.NavigationStarting += HandleNavigationStarting;

        var runtime = new
        {
            backendHttpUrl = $"http://127.0.0.1:{_backendPort}",
            backendWsUrl = $"ws://127.0.0.1:{_backendPort}",
        };
        var runtimeScript = $"window.desktopRuntime = {JsonSerializer.Serialize(runtime)};";
        await core.AddScriptToExecuteOnDocumentCreatedAsync(runtimeScript);

        var indexPath = Path.Combine(_layout.WebRoot, "index.html");
        if (!File.Exists(indexPath))
        {
            throw new FileNotFoundException("未找到前端构建文件", indexPath);
        }
        core.Navigate(new Uri(indexPath).AbsoluteUri);
    }

    private void HandleNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (!args.Uri.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
        {
            args.Cancel = true;
        }
    }
}

internal sealed class BackendHost : IDisposable
{
    private readonly StringBuilder _errorOutput = new();
    private Process? _process;
    private int _port;

    public void Start(AppLayout layout, int port)
    {
        var nodePath = layout.NodePath;
        var serverEntry = Path.Combine(layout.ServerRoot, "dist", "main.js");
        if (!File.Exists(nodePath))
        {
            throw new FileNotFoundException("未找到内置 Node.js 运行时", nodePath);
        }
        if (!File.Exists(serverEntry))
        {
            throw new FileNotFoundException("未找到后端构建文件", serverEntry);
        }

        var dataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FlameDetectorBench",
            "runtime");
        Directory.CreateDirectory(dataDirectory);
        CopyIfMissing(Path.Combine(layout.ServerRoot, "system-config.json"), Path.Combine(dataDirectory, "system-config.json"));
        CopyIfMissing(Path.Combine(layout.ServerRoot, "plc-configs.json"), Path.Combine(dataDirectory, "plc-configs.json"));

        _port = port;
        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{serverEntry}\"",
            WorkingDirectory = layout.ServerRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.Environment["NODE_ENV"] = "production";
        startInfo.Environment["SERVER_PORT"] = port.ToString();
        startInfo.Environment["DESKTOP_EMBEDDED_SERVER"] = "1";
        startInfo.Environment["CLOSURE_MODE"] = "field";
        startInfo.Environment["APP_DATA_DIR"] = dataDirectory;

        _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        _process.OutputDataReceived += (_, args) => { };
        _process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                lock (_errorOutput)
                {
                    _errorOutput.AppendLine(args.Data);
                }
            }
        };
        if (!_process.Start())
        {
            throw new InvalidOperationException("无法启动后端服务");
        }
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();
    }

    public async Task WaitForReadyAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
        var healthUrl = $"http://127.0.0.1:{_port}/api/health";
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (_process?.HasExited == true)
            {
                throw new InvalidOperationException($"后端服务提前退出。\n{GetErrorOutput()}");
            }

            try
            {
                using var response = await client.GetAsync(healthUrl).ConfigureAwait(false);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch (HttpRequestException)
            {
            }
            catch (TaskCanceledException)
            {
            }
            await Task.Delay(250).ConfigureAwait(false);
        }

        throw new TimeoutException($"后端服务 30 秒内未就绪：{healthUrl}\n{GetErrorOutput()}");
    }

    public void Dispose()
    {
        if (_process is null)
        {
            return;
        }

        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(true);
                _process.WaitForExit(5000);
            }
        }
        catch (InvalidOperationException)
        {
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }

    private string GetErrorOutput()
    {
        lock (_errorOutput)
        {
            return _errorOutput.ToString();
        }
    }

    private static void CopyIfMissing(string source, string target)
    {
        if (File.Exists(target) || !File.Exists(source))
        {
            return;
        }
        File.Copy(source, target);
    }
}

internal sealed class AppLayout
{
    private AppLayout(string appRoot)
    {
        AppRoot = appRoot;
        WebRoot = Path.Combine(appRoot, "dist");
        ServerRoot = Path.Combine(appRoot, "server");
        NodePath = Path.Combine(appRoot, "runtime", "node.exe");
    }

    public string AppRoot { get; }
    public string WebRoot { get; }
    public string ServerRoot { get; }
    public string NodePath { get; }

    public static AppLayout Resolve()
    {
        var baseDirectory = AppContext.BaseDirectory;
        var packagedRoot = Path.Combine(baseDirectory, "app");
        if (Directory.Exists(Path.Combine(packagedRoot, "dist")) && Directory.Exists(Path.Combine(packagedRoot, "server")))
        {
            return new AppLayout(packagedRoot);
        }

        var current = new DirectoryInfo(baseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "package.json")) && Directory.Exists(Path.Combine(current.FullName, "server")))
            {
                return new AppLayout(current.FullName);
            }
            current = current.Parent;
        }

        throw new DirectoryNotFoundException("无法定位项目运行目录");
    }
}

internal static class PortFinder
{
    public static int Find()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
