using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using MMRCPlayer.Models;
using MMRCPlayer.Utilities;
using SocketIOClient;

namespace MMRCPlayer.Services;

public class SocketService : IDisposable
{
    private readonly DeviceConfig _config;
    private readonly Dispatcher _dispatcher;
    private SocketIOClient.SocketIO? _socket;
    private CancellationTokenSource? _pingCts;
    private bool _isRegistered;
    private DateTime _lastPongTime = DateTime.MinValue;
    private int _missedPongs;

    public event Action? OnConnected;
    public event Action? OnDisconnected;
    public event Action<FileState>? OnPlay;
    public event Action<string>? OnStop;
    public event Action? OnPause;
    public event Action? OnResume;
    public event Action? OnRestart;
    public event Action<double>? OnSeek;
    public event Action<int, double?, bool>? OnVolume;
    public event Action<int>? OnPdfPage;
    public event Action<int>? OnPptxPage;
    public event Action<int>? OnFolderPage;
    public event Action? OnPlaceholderRefresh;
    public event Action? OnRegistered;
    public event Action<string>? OnStatusChanged;
    public event Action<FileState>? OnStateSync;

    public bool IsConnected => _socket?.Connected == true;
    public bool IsRegistered => _isRegistered;

    public SocketService(DeviceConfig config, Dispatcher dispatcher)
    {
        _config = config;
        _dispatcher = dispatcher;
    }

    public async Task ConnectAsync()
    {
        try
        {
            var serverUrl = _config.ServerUrl;
            if (!serverUrl.StartsWith("http://") && !serverUrl.StartsWith("https://"))
                serverUrl = "http://" + serverUrl;

            var uri = new Uri(serverUrl);
            _socket = new SocketIOClient.SocketIO(uri, new SocketIOOptions
            {
                Transport = SocketIOClient.Transport.TransportProtocol.WebSocket,
                ConnectionTimeout = TimeSpan.FromSeconds(20),
                Reconnection = true,
                ReconnectionDelay = _config.ReconnectDelay,
                ReconnectionAttempts = int.MaxValue
            });

            SetupEventHandlers();
            ShowStatus("Connecting...");

            await _socket.ConnectAsync();
        }
        catch (Exception ex)
        {
            ShowStatus($"Connection error: {ex.Message}");
            ScheduleReconnect();
        }
    }

    private void SetupEventHandlers()
    {
        if (_socket == null) return;

        _socket.OnConnected += (sender, e) =>
        {
            Log("Socket connected");
            _ = _dispatcher.BeginInvoke(async () =>
            {
                try
                {
                    ShowStatus("Connected");
                    await RegisterDeviceAsync();
                    StartPingTimer();
                    OnConnected?.Invoke();
                }
                catch { }
            });
        };

        _socket.OnDisconnected += (sender, reason) =>
        {
            Log($"Socket disconnected: {reason}");
            _ = _dispatcher.BeginInvoke(() =>
            {
                _isRegistered = false;
                StopPingTimer();
                ShowStatus("Disconnected. Reconnecting...");
                OnDisconnected?.Invoke();
            });
        };

        _socket.OnReconnectAttempt += (sender, attempt) =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                ShowStatus($"Reconnecting... (attempt {attempt})");
            });
        };

        _socket.OnReconnectFailed += (sender, e) =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                ShowStatus("Reconnect failed. Retrying...");
                ScheduleReconnect();
            });
        };

        _socket.On("player/registered", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                _isRegistered = true;
                _lastPongTime = DateTime.UtcNow;
                _missedPongs = 0;
                OnRegistered?.Invoke();
            });
        });

        _socket.On("player/pong", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                _lastPongTime = DateTime.UtcNow;
                _missedPongs = 0;
            });
        });

        _socket.On("player/play", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    var fileState = ParsePlayData(data);
                    OnPlay?.Invoke(fileState);
                }
                catch (Exception ex)
                {
                    ShowStatus($"Play error: {ex.Message}");
                }
            });
        });

        _socket.On("player/stop", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                string reason = "manual_stop";
                try
                {
                    var data = response.GetValue<JsonElement>();
                    if (data.TryGetProperty("reason", out var reasonProp))
                        reason = reasonProp.GetString() ?? reason;
                }
                catch { }
                OnStop?.Invoke(reason);
            });
        });

        _socket.On("player/pause", response =>
        {
            _ = _dispatcher.BeginInvoke(() => OnPause?.Invoke());
        });

        _socket.On("player/resume", response =>
        {
            _ = _dispatcher.BeginInvoke(() => OnResume?.Invoke());
        });

        _socket.On("player/restart", response =>
        {
            _ = _dispatcher.BeginInvoke(() => OnRestart?.Invoke());
        });

        _socket.On("player/seek", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    double position = 0;
                    if (data.ValueKind == JsonValueKind.Number)
                        position = data.GetDouble();
                    else if (data.TryGetProperty("position", out var posProp))
                        position = posProp.GetDouble();
                    OnSeek?.Invoke(position);
                }
                catch { }
            });
        });

        _socket.On("player/volume", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    int level = 100;
                    bool muted = false;

                    if (data.TryGetProperty("level", out var levelProp))
                        level = levelProp.GetInt32();
                    if (data.TryGetProperty("muted", out var mutedProp))
                        muted = mutedProp.GetBoolean();

                    OnVolume?.Invoke(level, null, muted);
                }
                catch { }
            });
        });

        _socket.On("player/pdfPage", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    int page = data.ValueKind == JsonValueKind.Number
                        ? data.GetInt32()
                        : int.Parse(data.GetString() ?? "1");
                    OnPdfPage?.Invoke(page);
                }
                catch { }
            });
        });

        _socket.On("player/pptxPage", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    int slide = data.ValueKind == JsonValueKind.Number
                        ? data.GetInt32()
                        : int.Parse(data.GetString() ?? "1");
                    OnPptxPage?.Invoke(slide);
                }
                catch { }
            });
        });

        _socket.On("player/folderPage", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    int image = data.ValueKind == JsonValueKind.Number
                        ? data.GetInt32()
                        : int.Parse(data.GetString() ?? "1");
                    OnFolderPage?.Invoke(image);
                }
                catch { }
            });
        });

        _socket.On("placeholder/refresh", response =>
        {
            _ = _dispatcher.BeginInvoke(() => OnPlaceholderRefresh?.Invoke());
        });

        _socket.On("player/state", response =>
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                try
                {
                    var data = response.GetValue<JsonElement>();
                    var fileState = ParsePlayData(data);
                    if (!string.IsNullOrEmpty(fileState.File))
                        OnStateSync?.Invoke(fileState);
                }
                catch { }
            });
        });

    }

    private FileState ParsePlayData(JsonElement data)
    {
        var state = new FileState();

        if (data.TryGetProperty("type", out var typeProp))
            state.Type = typeProp.GetString();
        if (data.TryGetProperty("file", out var fileProp))
            state.File = fileProp.GetString();
        if (data.TryGetProperty("page", out var pageProp))
            state.Page = pageProp.GetInt32();
        if (data.TryGetProperty("stream_url", out var streamProp))
            state.StreamUrl = streamProp.GetString();
        if (data.TryGetProperty("stream_protocol", out var protoProp))
            state.StreamProtocol = protoProp.GetString();
        if (data.TryGetProperty("originDeviceId", out var originProp))
            state.OriginDeviceId = originProp.GetString();
        if (data.TryGetProperty("currentTime", out var ctProp))
            state.CurrentTime = ctProp.GetDouble();
        if (data.TryGetProperty("duration", out var durProp))
            state.Duration = durProp.GetDouble();

        if (string.IsNullOrEmpty(state.Type) && !string.IsNullOrEmpty(state.File))
            state.Type = FileHelper.DetectByExtension(state.File).AsString();

        return state;
    }

    private async Task RegisterDeviceAsync()
    {
        if (_socket == null || !_socket.Connected) return;

        var registration = new
        {
            device_id = _config.DeviceId,
            device_type = "NATIVE_MEDIAPLAYER",
            platform = $"Windows {Environment.OSVersion.VersionString} | MMRC 1.0.0",
            app_version = "1.0.0",
            model = Environment.MachineName,
            manufacturer = "Microsoft",
            capabilities = new
            {
                video = true,
                audio = true,
                images = true,
                pdf = true,
                pptx = true,
                streaming = true
            }
        };

        await _socket.EmitAsync("player/register", registration);
    }

    public async Task SendProgressAsync(string type, string file, double currentTime, double duration, int? page = null, string? streamProtocol = null, string? streamUrl = null)
    {
        if (_socket == null || !_socket.Connected || !_isRegistered) return;

        var progress = new
        {
            device_id = _config.DeviceId,
            type,
            file,
            currentTime,
            duration,
            page,
            stream_protocol = streamProtocol,
            stream_url = streamUrl
        };

        await _socket.EmitAsync("player/progress", progress);
    }

    public async Task SendVolumeStateAsync(int level, bool muted)
    {
        if (_socket == null || !_socket.Connected || !_isRegistered) return;

        var state = new
        {
            device_id = _config.DeviceId,
            level,
            muted
        };

        await _socket.EmitAsync("player/volumeState", state);
    }

    private void StartPingTimer()
    {
        StopPingTimer();
        _pingCts = new CancellationTokenSource();
        var token = _pingCts.Token;

        Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(_config.PingInterval, token);
                    if (_socket?.Connected == true && !token.IsCancellationRequested)
                    {
                        await _socket.EmitAsync("player/ping", new { device_id = _config.DeviceId });
                        var missed = Interlocked.Increment(ref _missedPongs);
                        if (missed >= 3)
                        {
                            await RegisterDeviceAsync();
                            Interlocked.Exchange(ref _missedPongs, 0);
                        }
                    }
                }
                catch (TaskCanceledException) { break; }
                catch { }
            }
        }, token);
    }

    private void StopPingTimer()
    {
        _pingCts?.Cancel();
        _pingCts?.Dispose();
        _pingCts = null;
    }

    private void ScheduleReconnect()
    {
        Task.Run(async () =>
        {
            await Task.Delay(_config.ReconnectDelay);
            await ConnectAsync();
        });
    }

    private void ShowStatus(string message)
    {
        OnStatusChanged?.Invoke(message);
    }

    public async Task DisconnectAsync()
    {
        StopPingTimer();

        if (_socket != null)
        {
            await _socket.DisconnectAsync();
            _socket.Dispose();
            _socket = null;
        }
    }

    public void Dispose()
    {
        StopPingTimer();
        try { _socket?.DisconnectAsync().Wait(2000); } catch { }
        _socket?.Dispose();
        _socket = null;
    }

    private void Log(string msg)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] [Socket] {msg}";
        System.Diagnostics.Debug.WriteLine(line);
        try
        {
            Paths.EnsureDirectories();
            File.AppendAllText(Paths.LogFile, line + Environment.NewLine);
        }
        catch { }
    }
}
