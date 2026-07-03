using System;
using System.IO;
using System.Reflection;

namespace MMRCPlayer.Utilities;

public static class Paths
{
    public static string AppDir { get; } = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!;
    public static string LogDir { get; } = Path.Combine(AppDir, "logs");
    public static string ConfigPath { get; } = Path.Combine(AppDir, "config.json");
    public static string CacheDir { get; } = Path.Combine(AppDir, "cache");

    public static string LogFile => Path.Combine(LogDir, "mmrc.log");

    public static void EnsureDirectories()
    {
        Directory.CreateDirectory(LogDir);
        Directory.CreateDirectory(CacheDir);
    }
}
