using System;
using System.Threading.Tasks;
using System.Windows.Threading;
using MMRCPlayer.Models;
using MMRCPlayer.Utilities;

namespace MMRCPlayer.Services;

public class ProgressService : IDisposable
{
    private readonly SocketService _socket;
    private readonly Dispatcher _dispatcher;
    private readonly DeviceConfig _config;
    private DispatcherTimer? _timer;
    private Func<FileState?>? _getCurrentState;
    private Func<double>? _getCurrentTime;
    private Func<double>? _GetDuration;
    private Func<bool>? _getIsPlaceholder;

    public ProgressService(SocketService socket, Dispatcher dispatcher, DeviceConfig config)
    {
        _socket = socket;
        _dispatcher = dispatcher;
        _config = config;
    }

    public void SetStateProvider(Func<FileState?> getState, Func<double> getCurrentTime, Func<double> getDuration, Func<bool> getIsPlaceholder)
    {
        _getCurrentState = getState;
        _getCurrentTime = getCurrentTime;
        _GetDuration = getDuration;
        _getIsPlaceholder = getIsPlaceholder;
    }

    public void Start()
    {
        Stop();
        _timer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(1)
        };
        _timer.Tick += Timer_Tick;
        _timer.Start();

        Timer_Tick(_timer, EventArgs.Empty);
    }

    public void Stop()
    {
        if (_timer != null)
        {
            _timer.Stop();
            _timer.Tick -= Timer_Tick;
            _timer = null;
        }
    }

    private async void Timer_Tick(object? sender, EventArgs e)
    {
        try
        {
            if (_getCurrentState == null || _getCurrentTime == null || _GetDuration == null || _getIsPlaceholder == null) return;

            var state = _getCurrentState();
            if (state == null || string.IsNullOrEmpty(state.File)) return;

            if (_getIsPlaceholder())
            {
                return;
            }

            var currentTime = _getCurrentTime();
            var duration = _GetDuration();

            if (state.ContentType is ContentType.Pdf or ContentType.Pptx or ContentType.Folder)
                duration = 0;

            int? page = state.ContentType switch
            {
                ContentType.Pdf or ContentType.Pptx or ContentType.Folder => state.Page,
                _ => null
            };

            System.Diagnostics.Debug.WriteLine($"[Progress] type={state.ContentType} file={state.File} ct={currentTime:F1} dur={duration:F1}");

            await _socket.SendProgressAsync(
                state.ContentType.AsString(),
                state.File,
                currentTime,
                duration,
                page,
                state.StreamProtocol,
                state.StreamUrl
            );
        }
        catch { }
    }

    public void Dispose()
    {
        Stop();
    }
}
