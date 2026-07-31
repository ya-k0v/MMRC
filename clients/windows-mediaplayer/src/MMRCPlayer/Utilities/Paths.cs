using System;
using System.IO;
namespace MMRCPlayer.Utilities;

public static class Paths
{
    public static string AppDir { get; } = AppContext.BaseDirectory;
    public static string DataDir { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MMRCPlayer");
    public static string LogDir { get; } = Path.Combine(DataDir, "logs");
    public static string ConfigPath { get; } = Path.Combine(DataDir, "config.json");
    public static string CacheDir { get; } = Path.Combine(DataDir, "cache");

    public static string LogFile => Path.Combine(LogDir, "mmrc.log");

    public static void EnsureDirectories()
    {
        Directory.CreateDirectory(LogDir);
        Directory.CreateDirectory(CacheDir);
    }
}
