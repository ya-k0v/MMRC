using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using MMRCPlayer.Models;
using MMRCPlayer.Services;
using MMRCPlayer.Utilities;

namespace MMRCPlayer;

public partial class App : Application
{
    private Mutex? _mutex;

    private static void Log(string msg)
    {
        try
        {
            Paths.EnsureDirectories();
            var line = $"[{DateTime.Now:HH:mm:ss}] [App] {msg}";
            File.AppendAllText(Paths.LogFile, line + Environment.NewLine);
        }
        catch { }
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        AppDomain.CurrentDomain.UnhandledException += (_, ex) =>
        {
            Log($"UnhandledException: {ex.ExceptionObject}");
        };
        DispatcherUnhandledException += (_, ex) =>
        {
            Log($"DispatcherUnhandledException: {ex.Exception}");
            ex.Handled = true;
        };
        TaskScheduler.UnobservedTaskException += (_, ex) =>
        {
            Log($"UnobservedTaskException: {ex.Exception}");
        };

        Log("OnStartup begin");
        _mutex = new Mutex(true, "MMRCPlayer_SingleInstance", out bool createdNew);

        if (!createdNew)
        {
            Log("Another instance running, exiting");
            MessageBox.Show("MMRC Player is already running.", "MMRC Player", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        base.OnStartup(e);

        try
        {
            var args = Environment.GetCommandLineArgs();
            Log($"Args: {string.Join(" ", args)}");
            string? serverArg = null;
            string? deviceIdArg = null;
            bool fsArg = false;

            for (int i = 1; i < args.Length; i++)
            {
                switch (args[i].ToLowerInvariant())
                {
                    case "--server":
                    case "-s":
                        if (i + 1 < args.Length) serverArg = args[i + 1];
                        break;
                    case "--device-id":
                    case "-d":
                        if (i + 1 < args.Length) deviceIdArg = args[i + 1];
                        break;
                    case "--fs":
                        fsArg = true;
                        break;
                }
            }

            if (!string.IsNullOrEmpty(serverArg) && !string.IsNullOrEmpty(deviceIdArg))
            {
                var serverUrl = serverArg
                    .Replace("http://", "")
                    .Replace("https://", "")
                    .TrimEnd('/');

                var config = new DeviceConfig
                {
                    ServerUrl = serverUrl,
                    DeviceId = deviceIdArg,
                    Fullscreen = fsArg,
                    PingInterval = 20000,
                    ReconnectDelay = 5000,
                    WatchdogInterval = 60000,
                    BufferMinMs = 30000,
                    BufferMaxMs = 60000,
                    CacheSize = 200L * 1024 * 1024,
                    CrossfadeDurationMs = 500
                };

                SaveConfig(config);
                Log($"Launching with args: {serverUrl} / {deviceIdArg} / fs={fsArg}");
                LaunchMainWindow(config, fsArg);
            }
            else if (IsConfigured())
            {
                var config = LoadConfig();
                Log($"Launching from config: {config.ServerUrl} / {config.DeviceId} / fs={fsArg || config.Fullscreen}");
                LaunchMainWindow(config, fsArg || config.Fullscreen);
            }
            else
            {
                Log("No config found, showing SettingsWindow");
                var settingsWindow = new SettingsWindow();
                if (settingsWindow.ShowDialog() == true && settingsWindow.SavedConfig != null)
                {
                    Log($"First launch: launching with {settingsWindow.SavedConfig.ServerUrl}");
                    LaunchMainWindow(settingsWindow.SavedConfig, settingsWindow.SavedConfig.Fullscreen);
                }
                else
                {
                    Log("No config provided, shutting down");
                    Shutdown();
                }
            }
        }
        catch (Exception ex)
        {
            Log($"FATAL: {ex}");
            MessageBox.Show($"Fatal startup error:\n{ex.Message}\n\n{ex.InnerException?.Message}",
                "MMRC Player", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
        }
    }

    private void LaunchMainWindow(DeviceConfig config, bool startFullscreen)
    {
        try
        {
            Log("Creating MainWindow...");
            var mainWindow = new MainWindow(config, startFullscreen);
            Log("MainWindow created, calling Show()...");
            mainWindow.Show();
            Log("MainWindow.Show() done");
        }
        catch (Exception ex)
        {
            Log($"LaunchMainWindow FAILED: {ex}");
            MessageBox.Show($"Failed to start MMRC Player:\n{ex.Message}\n\n{ex.InnerException?.Message}",
                "MMRC Player", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
        }
    }

    private static bool IsConfigured()
    {
        if (!File.Exists(Paths.ConfigPath)) return false;

        try
        {
            var json = File.ReadAllText(Paths.ConfigPath);
            var config = JsonSerializer.Deserialize<DeviceConfig>(json);
            return !string.IsNullOrWhiteSpace(config?.ServerUrl) &&
                   !string.IsNullOrWhiteSpace(config?.DeviceId);
        }
        catch { return false; }
    }

    private static DeviceConfig LoadConfig()
    {
        try
        {
            var json = File.ReadAllText(Paths.ConfigPath);
            return JsonSerializer.Deserialize<DeviceConfig>(json) ?? new DeviceConfig();
        }
        catch { return new DeviceConfig(); }
    }

    private static void SaveConfig(DeviceConfig config)
    {
        Paths.EnsureDirectories();
        var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Paths.ConfigPath, json);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { _mutex?.ReleaseMutex(); } catch { }
        try { _mutex?.Dispose(); } catch { }
        base.OnExit(e);
    }
}
