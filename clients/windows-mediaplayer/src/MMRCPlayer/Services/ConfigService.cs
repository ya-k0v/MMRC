using System.IO;
using System.Text.Json;
using MMRCPlayer.Models;

namespace MMRCPlayer.Services;

public class ConfigService
{
    private static readonly string ConfigPath = Path.Combine(
        AppDomain.CurrentDomain.BaseDirectory, "appsettings.json");

    private static readonly string LocalConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MMRCPlayer", "config.json");

    public DeviceConfig Config { get; private set; } = new();

    public void Load()
    {
        if (File.Exists(LocalConfigPath))
        {
            try
            {
                var json = File.ReadAllText(LocalConfigPath);
                Config = JsonSerializer.Deserialize<DeviceConfig>(json) ?? new DeviceConfig();
                return;
            }
            catch { }
        }

        if (File.Exists(ConfigPath))
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("MMRCPlayer", out var section))
                {
                    Config = JsonSerializer.Deserialize<DeviceConfig>(section.GetRawText()) ?? new DeviceConfig();
                }
                else
                {
                    Config = JsonSerializer.Deserialize<DeviceConfig>(json) ?? new DeviceConfig();
                }
            }
            catch { }
        }
    }

    public void Save()
    {
        var dir = Path.GetDirectoryName(LocalConfigPath);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        var json = JsonSerializer.Serialize(Config, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(LocalConfigPath, json);
    }

    public void UpdateFromArgs(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "--server":
                case "-s":
                    Config.ServerUrl = args[i + 1];
                    break;
                case "--device-id":
                case "-d":
                    Config.DeviceId = args[i + 1];
                    break;
                case "--show-status":
                    Config.ShowStatus = args[i + 1].ToLowerInvariant() is "true" or "1";
                    break;
            }
        }
    }
}
