using System.IO;
using System.Text.Json;
using MMRCPlayer.Models;
using MMRCPlayer.Utilities;

namespace MMRCPlayer.Services;

public class ConfigService
{
    public DeviceConfig Config { get; private set; } = new();

    public void Load()
    {
        if (File.Exists(Paths.ConfigPath))
        {
            try
            {
                var json = File.ReadAllText(Paths.ConfigPath);
                Config = JsonSerializer.Deserialize<DeviceConfig>(json) ?? new DeviceConfig();
                return;
            }
            catch { }
        }
    }

    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(Paths.ConfigPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            var json = JsonSerializer.Serialize(Config, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Paths.ConfigPath, json);
        }
        catch { }
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
