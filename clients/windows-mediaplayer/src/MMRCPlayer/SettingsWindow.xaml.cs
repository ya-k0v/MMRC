using System;
using System.IO;
using System.Text.Json;
using System.Windows;
using MMRCPlayer.Models;
using MMRCPlayer.Utilities;

namespace MMRCPlayer;

public partial class SettingsWindow : Window
{
    public DeviceConfig? SavedConfig { get; private set; }

    public SettingsWindow()
    {
        InitializeComponent();
        LoadSavedValues();
        ServerUrlInput.Focus();
    }

    private void LoadSavedValues()
    {
        if (File.Exists(Paths.ConfigPath))
        {
            try
            {
                var json = File.ReadAllText(Paths.ConfigPath);
                var config = JsonSerializer.Deserialize<DeviceConfig>(json);
                if (config != null)
                {
                    var displayUrl = config.ServerUrl
                        .Replace("http://", "")
                        .Replace("https://", "");
                    ServerUrlInput.Text = displayUrl;
                    DeviceIdInput.Text = config.DeviceId;
                    ShowStatusCheckbox.IsChecked = config.ShowStatus;
                    FullscreenCheckbox.IsChecked = config.Fullscreen;
                    return;
                }
            }
            catch { }
        }

        ServerUrlInput.Text = "192.168.0.1";
        DeviceIdInput.Text = "WIN001";
    }

    private void Log(string msg)
    {
        try
        {
            Paths.EnsureDirectories();
            var line = $"[{DateTime.Now:HH:mm:ss}] [Settings] {msg}";
            File.AppendAllText(Paths.LogFile, line + Environment.NewLine);
        }
        catch { }
    }

    private void SaveButton_Click(object sender, RoutedEventArgs e)
    {
        ErrorText.Visibility = Visibility.Collapsed;

        var serverUrl = ServerUrlInput.Text.Trim();
        var deviceId = DeviceIdInput.Text.Trim();
        var showStatus = ShowStatusCheckbox.IsChecked == true;
        var fullscreen = FullscreenCheckbox.IsChecked == true;

        Log($"Save clicked: server={serverUrl}, id={deviceId}");

        if (string.IsNullOrWhiteSpace(serverUrl))
        {
            ShowError("Укажите адрес сервера");
            return;
        }

        if (string.IsNullOrWhiteSpace(deviceId))
        {
            ShowError("Укажите ID устройства");
            return;
        }

        if (!Uri.TryCreate("http://" + serverUrl, UriKind.Absolute, out _))
        {
            ShowError("Некорректный адрес сервера");
            return;
        }

        serverUrl = serverUrl
            .Replace("http://", "")
            .Replace("https://", "")
            .TrimEnd('/');

        var config = new DeviceConfig
        {
            ServerUrl = serverUrl,
            DeviceId = deviceId,
            ShowStatus = showStatus,
            Fullscreen = fullscreen,
            PingInterval = 20000,
            ReconnectDelay = 5000,
            WatchdogInterval = 60000,
            BufferMinMs = 30000,
            BufferMaxMs = 60000,
            CacheSize = 200L * 1024 * 1024,
            CrossfadeDurationMs = 500
        };

        try
        {
            Paths.EnsureDirectories();
            var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Paths.ConfigPath, json);
            Log("Config saved");
        }
        catch (Exception ex)
        {
            Log($"Config save error: {ex.Message}");
            ShowError($"Ошибка сохранения: {ex.Message}");
            return;
        }

        SavedConfig = config;
        this.DialogResult = true;
        this.Close();
    }

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorText.Visibility = Visibility.Visible;
    }

    protected override void OnKeyDown(System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Enter)
        {
            SaveButton_Click(this, new RoutedEventArgs());
            e.Handled = true;
        }
        base.OnKeyDown(e);
    }
}
