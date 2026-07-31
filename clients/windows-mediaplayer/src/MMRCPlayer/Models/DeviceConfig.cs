namespace MMRCPlayer.Models;

public class DeviceConfig
{
    public string ServerUrl { get; set; } = "http://localhost:3000";
    public string DeviceId { get; set; } = "win-001";
    public bool ShowStatus { get; set; }
    public bool Fullscreen { get; set; }
    public int PingInterval { get; set; } = 20000;
    public int ReconnectDelay { get; set; } = 5000;
    public int WatchdogInterval { get; set; } = 60000;
    public int BufferMinMs { get; set; } = 30000;
    public int BufferMaxMs { get; set; } = 60000;
    public long CacheSize { get; set; } = 200L * 1024 * 1024;
    public int CrossfadeDurationMs { get; set; } = 500;
}
