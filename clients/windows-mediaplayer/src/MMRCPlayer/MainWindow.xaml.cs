using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;
using LibVLCSharp.WPF;
using MMRCPlayer.Models;
using MMRCPlayer.Services;
using MMRCPlayer.Utilities;

namespace MMRCPlayer;

public partial class MainWindow : Window
{
    private readonly DeviceConfig _deviceConfig;
    private readonly bool _startFullscreen;
    private readonly SocketService _socket;
    private readonly MediaPlayerService _mediaPlayer;
    private readonly ImageService _imageService;
    private readonly ProgressService _progress;
    private FileState? _currentState;
    private DispatcherTimer? _watchdogTimer;
    private bool _isFullscreen;
    private readonly SemaphoreSlim _playLock = new(1, 1);
    private OverlayWindow? _overlayWindow;
    private VideoView? _videoPrimaryView;
    private VideoView? _videoBufferView;
    private DateTime _lastPlayTime;
    private string? _lastPlayFile;
    private bool _isRestarting;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    public MainWindow(DeviceConfig config, bool startFullscreen = false)
    {
        InitializeComponent();
        _deviceConfig = config;
        _startFullscreen = startFullscreen;
        _socket = new SocketService(_deviceConfig, Dispatcher);
        _mediaPlayer = new MediaPlayerService(Dispatcher, _deviceConfig);
        _imageService = new ImageService(Dispatcher);
        _progress = new ProgressService(_socket, Dispatcher, _deviceConfig);
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            Log("Window_Loaded begin");

            _overlayWindow = new OverlayWindow();
            _overlayWindow.SetText($"ID: {_deviceConfig.DeviceId} | v1.0.0");
            _overlayWindow.Owner = this;
            _overlayWindow.OnDoubleClick += OpenSettings;
            _overlayWindow.Show();
            UpdateOverlayPosition();

            Activated += (_, _) => { if (_overlayWindow != null) _overlayWindow.Topmost = true; };
            Deactivated += (_, _) => { if (_overlayWindow != null) _overlayWindow.Topmost = false; };

            _imageService.ImagePrimary = ImagePrimary;
            _imageService.ImageBuffer = ImageBuffer;

            _mediaPlayer.VideoPrimary = _videoPrimaryView;
            _mediaPlayer.VideoBuffer = _videoBufferView;
            _mediaPlayer.BrandBg = BrandBg;
            _mediaPlayer.ImagePrimary = ImagePrimary;
            _mediaPlayer.HideImages = () => _imageService.HideImages();

            Log("Loading LibVLC plugins...");
            StatusText.Text = "Loading media engine...";
            StatusText.Visibility = Visibility.Visible;

            _videoPrimaryView = new VideoView { Background = System.Windows.Media.Brushes.Black, Visibility = Visibility.Collapsed };
            _videoBufferView = new VideoView { Background = System.Windows.Media.Brushes.Black, Visibility = Visibility.Collapsed };
            VideoGrid.Children.Insert(0, _videoBufferView);
            VideoGrid.Children.Insert(0, _videoPrimaryView);

            _mediaPlayer.VideoPrimary = _videoPrimaryView;
            _mediaPlayer.VideoBuffer = _videoBufferView;

            await Task.Run(() => _mediaPlayer.InitializeCore());
            await _mediaPlayer.InitializePlayersAsync();
            _mediaPlayer.AttachPlayersToViews();

            Log("LibVLC initialized");
            StatusText.Visibility = Visibility.Collapsed;

            _mediaPlayer.OnPlaybackEnd += OnMediaPlaybackEnd;
            _mediaPlayer.OnError += OnMediaError;
            _mediaPlayer.OnTimeChanged += OnMediaTimeChanged;

            _progress.SetStateProvider(
                () => _currentState,
                () => _mediaPlayer.CurrentTime,
                () => _mediaPlayer.Duration,
                () => _mediaPlayer.IsPlaceholder
            );

            SetupSocketEvents();
            _progress.Start();

            if (_startFullscreen)
                EnterFullscreen();

            StartWatchdog();

            Log("Connecting to server...");
            await _socket.ConnectAsync();
            Log("Window_Loaded done");
        }
        catch (Exception ex)
        {
            var errMsg = $"Window_Loaded error: {ex.Message} | {ex.InnerException?.Message}";
            Log(errMsg);
            MessageBox.Show(errMsg, "MMRC Player", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        try { _progress.Stop(); } catch { }
        try { _watchdogTimer?.Stop(); } catch { }
        try { _mediaPlayer?.PrimaryPlayer?.Stop(); } catch { }
        try { _mediaPlayer?.BufferPlayer?.Stop(); } catch { }
        try { _mediaPlayer?.Dispose(); } catch { }
        try { _socket?.Dispose(); } catch { }
        try { _overlayWindow?.Close(); } catch { }

        if (_isRestarting) return;

        var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        _ = Task.Run(async () =>
        {
            await Task.Delay(1000);
            try { System.Diagnostics.Process.GetProcessById(pid).Kill(); } catch { }
        });
    }

    private void Window_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.F11)
        {
            if (_isFullscreen)
                ExitFullscreen();
            else
                EnterFullscreen();
        }
        else if (e.Key == Key.F2)
        {
            OpenSettings();
        }
    }

    private void EnterFullscreen()
    {
        _isFullscreen = true;
        WindowStyle = WindowStyle.None;
        WindowState = WindowState.Normal;
        Topmost = true;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Left = 0;
        Top = 0;
        Width = SystemParameters.PrimaryScreenWidth;
        Height = SystemParameters.PrimaryScreenHeight;
        WindowState = WindowState.Maximized;
        UpdateOverlayPosition();
        Log("Entered fullscreen");
    }

    private void ExitFullscreen()
    {
        _isFullscreen = false;
        WindowState = WindowState.Normal;
        WindowStyle = WindowStyle.SingleBorderWindow;
        Topmost = false;
        ResizeMode = ResizeMode.CanResize;
        ShowInTaskbar = true;
        Width = 1280;
        Height = 720;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        UpdateOverlayPosition();
        Log("Exited fullscreen");
    }

    private void UpdateOverlayPosition()
    {
        if (_overlayWindow == null || !IsLoaded) return;
        try
        {
            if (_isFullscreen)
            {
                _overlayWindow.UpdatePosition(
                    SystemParameters.PrimaryScreenWidth - _overlayWindow.ActualWidth - 4,
                    SystemParameters.PrimaryScreenHeight - _overlayWindow.ActualHeight - 4);
            }
            else
            {
                GetWindowRect(new WindowInteropHelper(this).Handle, out var rect);
                _overlayWindow.UpdatePosition(
                    rect.Right - _overlayWindow.ActualWidth - 4,
                    rect.Bottom - _overlayWindow.ActualHeight - 4);
            }
        }
        catch { }
    }

    protected override void OnLocationChanged(EventArgs e)
    {
        base.OnLocationChanged(e);
        UpdateOverlayPosition();
    }

    protected override void OnRenderSizeChanged(SizeChangedInfo sizeInfo)
    {
        base.OnRenderSizeChanged(sizeInfo);
        UpdateOverlayPosition();
    }

    private void SetupSocketEvents()
    {
        _socket.OnStatusChanged += (msg) =>
        {
            Log($"Status: {msg}");
            Dispatcher.BeginInvoke(() =>
            {
                if (_deviceConfig.ShowStatus)
                {
                    StatusText.Text = msg;
                    StatusText.Visibility = Visibility.Visible;
                }
            });
        };

        _socket.OnConnected += () =>
        {
            try { Log("Socket connected"); Dispatcher.BeginInvoke(() => ShowStatusBriefly("Connected")); } catch { }
        };

        _socket.OnDisconnected += () =>
        {
            try { Log("Socket disconnected"); Dispatcher.BeginInvoke(() => ShowStatusBriefly("Disconnected")); } catch { }
        };

        _socket.OnRegistered += () =>
        {
            Log("Socket registered");
            Dispatcher.BeginInvoke(async () =>
            {
                try
                {
                    ShowStatusBriefly("Registered");
                    if (_currentState?.ContentType == ContentType.Audio && BrandBg != null)
                    {
                        try
                        {
                            var uri = new Uri("pack://application:,,,/Resources/audio-logo.png", UriKind.Absolute);
                            var bitmap = new System.Windows.Media.Imaging.BitmapImage(uri);
                            bitmap.Freeze();
                            BrandBg.Source = bitmap;
                            BrandBg.Visibility = Visibility.Visible;
                            BrandBg.Opacity = 1;
                        }
                        catch { }
                    }
                    else if (_currentState != null && _currentState.ContentType != ContentType.Placeholder)
                    {
                        Log("Socket registered - active content present, skipping placeholder");
                    }
                    else
                    {
                        Log("Socket registered - loading placeholder");
                        await _mediaPlayer.LoadPlaceholderAsync(_deviceConfig.ServerUrl, _deviceConfig.DeviceId);
                    }
                }
                catch { }
            });
        };

        _socket.OnPlay += async (fileState) =>
        {
            try
            {
                Log($"OnPlay: type={fileState.Type}, file={fileState.File}");
                await HandlePlayAsync(fileState);
            }
            catch { }
        };

        _socket.OnStop += (reason) =>
        {
            try
            {
                Log($"OnStop: reason={reason}");
                HandleStop(reason);
            }
            catch { }
        };

        _socket.OnPause += () => { try { _mediaPlayer.Pause(); } catch { } };
        _socket.OnResume += () => { try { _mediaPlayer.Resume(); } catch { } };
        _socket.OnRestart += () => { try { _mediaPlayer.Restart(); } catch { } };
        _socket.OnSeek += (pos) => { try { _mediaPlayer.Seek(pos); } catch { } };
        _socket.OnVolume += (lvl, _, muted) => { try { _mediaPlayer.SetVolume(lvl); _mediaPlayer.SetMute(muted); } catch { } };
        _socket.OnPdfPage += async (p) => { try { await HandlePageNavigationAsync(p); } catch { } };
        _socket.OnPptxPage += async (s) => { try { await HandlePageNavigationAsync(s); } catch { } };
        _socket.OnFolderPage += async (i) => { try { await HandlePageNavigationAsync(i); } catch { } };

        _socket.OnPlaceholderRefresh += async () =>
        {
            try
            {
                _imageService.ClearCache();
                await _mediaPlayer.LoadPlaceholderAsync(_deviceConfig.ServerUrl, _deviceConfig.DeviceId);
            }
            catch { }
        };

        _socket.OnStateSync += async (fs) => { try { await HandlePlayAsync(fs); } catch { } };
    }

    private async Task HandlePlayAsync(FileState fileState)
    {
        var now = DateTime.UtcNow;
        if (fileState.File == _lastPlayFile && (now - _lastPlayTime).TotalMilliseconds < 500)
            return;

        await _playLock.WaitAsync();
        try
        {
            _lastPlayTime = now;
            _lastPlayFile = fileState.File;
            var previousType = _currentState?.ContentType;
            _currentState = fileState;
            var deviceId = fileState.OriginDeviceId ?? _deviceConfig.DeviceId;
            var serverUrl = _deviceConfig.ServerUrl;
            var isFromPlaceholder = _mediaPlayer.IsPlaceholder || previousType == null;

            ShowLoading(true);
            try
            {
                switch (fileState.ContentType)
                {
                    case ContentType.Video:
                        var videoUrl = FileHelper.GetFileUrl(serverUrl, deviceId, fileState.File!);
                        Log($"Playing video: {videoUrl}");
                        if (isFromPlaceholder || previousType is not (ContentType.Video or ContentType.Streaming))
                            await _mediaPlayer.PlayVideoAsync(videoUrl, fileState.OriginDeviceId);
                        else
                            await _mediaPlayer.PlayVideoWithCrossfadeAsync(videoUrl, fileState.OriginDeviceId);
                        break;

                    case ContentType.Audio:
                        var audioUrl = FileHelper.GetFileUrl(serverUrl, deviceId, fileState.File!);
                        var logoUrl = FileHelper.GetAudioLogoUrl(serverUrl);
                        await _mediaPlayer.PlayAudioAsync(audioUrl, logoUrl, fileState.OriginDeviceId);
                        break;

                    case ContentType.Streaming:
                        Log($"PlayStreamAsync: StreamUrl={fileState.StreamUrl}, Protocol={fileState.StreamProtocol}");
                        if (isFromPlaceholder || previousType is not (ContentType.Video or ContentType.Streaming))
                            await _mediaPlayer.PlayStreamAsync(fileState.StreamUrl!, fileState.StreamProtocol ?? "hls", fileState.OriginDeviceId, fileState.File);
                        else
                            await _mediaPlayer.PlayStreamWithCrossfadeAsync(fileState.StreamUrl!, fileState.StreamProtocol ?? "hls", fileState.OriginDeviceId, fileState.File);
                        break;

                    case ContentType.Image:
                        var imageUrl = FileHelper.GetFileUrl(serverUrl, deviceId, fileState.File!);
                        var hasVideo = _mediaPlayer.IsPlaying && (previousType == ContentType.Video || previousType == ContentType.Streaming);
                        if (hasVideo)
                        {
                            await _imageService.ShowImageAsync(imageUrl, _deviceConfig.CrossfadeDurationMs);
                            await _mediaPlayer.CrossfadeToImageAsync(_deviceConfig.CrossfadeDurationMs);
                        }
                        else
                        {
                            await _imageService.ShowImageAsync(imageUrl, _deviceConfig.CrossfadeDurationMs);
                            _mediaPlayer.StopWithoutHiding();
                        }
                        break;

                    case ContentType.Pdf:
                        var pdfUrl = FileHelper.GetConvertedPageUrl(serverUrl, deviceId, fileState.File!, "page", fileState.Page ?? 1);
                        var hasVideoPdf = _mediaPlayer.IsPlaying && (previousType == ContentType.Video || previousType == ContentType.Streaming);
                        if (hasVideoPdf)
                        {
                            await _imageService.ShowImageAsync(pdfUrl, _deviceConfig.CrossfadeDurationMs);
                            await _mediaPlayer.CrossfadeToImageAsync(_deviceConfig.CrossfadeDurationMs);
                        }
                        else
                        {
                            await _imageService.ShowImageAsync(pdfUrl, _deviceConfig.CrossfadeDurationMs);
                            _mediaPlayer.StopWithoutHiding();
                        }
                        break;

                    case ContentType.Pptx:
                        var pptxUrl = FileHelper.GetConvertedPageUrl(serverUrl, deviceId, fileState.File!, "slide", fileState.Page ?? 1);
                        var hasVideoPptx = _mediaPlayer.IsPlaying && (previousType == ContentType.Video || previousType == ContentType.Streaming);
                        if (hasVideoPptx)
                        {
                            await _imageService.ShowImageAsync(pptxUrl, _deviceConfig.CrossfadeDurationMs);
                            await _mediaPlayer.CrossfadeToImageAsync(_deviceConfig.CrossfadeDurationMs);
                        }
                        else
                        {
                            await _imageService.ShowImageAsync(pptxUrl, _deviceConfig.CrossfadeDurationMs);
                            _mediaPlayer.StopWithoutHiding();
                        }
                        break;

                    case ContentType.Folder:
                        var folderUrl = FileHelper.GetFolderImageUrl(serverUrl, deviceId, fileState.File!, fileState.Page ?? 1);
                        var hasVideoFolder = _mediaPlayer.IsPlaying && (previousType == ContentType.Video || previousType == ContentType.Streaming);
                        if (hasVideoFolder)
                        {
                            await _imageService.ShowImageAsync(folderUrl, _deviceConfig.CrossfadeDurationMs);
                            await _mediaPlayer.CrossfadeToImageAsync(_deviceConfig.CrossfadeDurationMs);
                        }
                        else
                        {
                            await _imageService.ShowImageAsync(folderUrl, _deviceConfig.CrossfadeDurationMs);
                            _mediaPlayer.StopWithoutHiding();
                        }
                        break;
                }
            }
            catch (Exception ex)
            {
                Log($"Play error: {ex.Message}");
                ShowStatusBriefly($"Error: {ex.Message}");
            }
            finally
            {
                ShowLoading(false);
            }
        }
        finally { _playLock.Release(); }
    }

    private void HandleStop(string reason)
    {
        switch (reason)
        {
            case "switch_content":
                if (BrandBg != null) BrandBg.Visibility = Visibility.Collapsed;
                break;

            case "placeholder_refresh":
                _imageService.ClearCache();
                _mediaPlayer.StopAll();
                _imageService.HideImages();
                _ = _mediaPlayer.LoadPlaceholderAsync(_deviceConfig.ServerUrl, _deviceConfig.DeviceId);
                break;

            default:
                _currentState = null;
                _mediaPlayer.StopAll();
                _imageService.HideImages();
                _ = _mediaPlayer.LoadPlaceholderAsync(_deviceConfig.ServerUrl, _deviceConfig.DeviceId);
                break;
        }
    }

    private async Task HandlePageNavigationAsync(int pageNumber)
    {
        if (_currentState == null || string.IsNullOrEmpty(_currentState.File)) return;

        var deviceId = _currentState.OriginDeviceId ?? _deviceConfig.DeviceId;
        _currentState.Page = pageNumber;

        switch (_currentState.ContentType)
        {
            case ContentType.Pdf:
                await _imageService.ShowImageAsync(
                    FileHelper.GetConvertedPageUrl(_deviceConfig.ServerUrl, deviceId, _currentState.File, "page", pageNumber),
                    _deviceConfig.CrossfadeDurationMs);
                break;
            case ContentType.Pptx:
                await _imageService.ShowImageAsync(
                    FileHelper.GetConvertedPageUrl(_deviceConfig.ServerUrl, deviceId, _currentState.File, "slide", pageNumber),
                    _deviceConfig.CrossfadeDurationMs);
                break;
            case ContentType.Folder:
                await _imageService.ShowImageAsync(
                    FileHelper.GetFolderImageUrl(_deviceConfig.ServerUrl, deviceId, _currentState.File, pageNumber),
                    _deviceConfig.CrossfadeDurationMs);
                break;
        }
    }

    private void OnMediaPlaybackEnd()
    {
        Dispatcher.BeginInvoke(() =>
        {
            if (_mediaPlayer.IsPlaceholder) return;
            if (_currentState?.ContentType is ContentType.Video or ContentType.Audio or ContentType.Streaming)
                _ = _mediaPlayer.LoadPlaceholderAsync(_deviceConfig.ServerUrl, _deviceConfig.DeviceId);
        });
    }

    private void OnMediaError(string error) => Dispatcher.BeginInvoke(() => ShowStatusBriefly(error));
    private void OnMediaTimeChanged(double ct, double dur) { }

    private void ShowStatusBriefly(string message)
    {
        if (!_deviceConfig.ShowStatus) return;
        StatusText.Text = message;
        StatusText.Visibility = Visibility.Visible;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        timer.Tick += (s, e) => { StatusText.Visibility = Visibility.Collapsed; timer.Stop(); };
        timer.Start();
    }

    private void ShowLoading(bool show)
    {
        Dispatcher.BeginInvoke(() => LoadingIndicator.Visibility = show ? Visibility.Visible : Visibility.Collapsed);
    }

    private void StartWatchdog()
    {
        _watchdogTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _watchdogTimer.Tick += (s, e) =>
        {
            if (!_socket.IsConnected && !_socket.IsRegistered)
                ShowStatusBriefly("Connection lost");
        };
        _watchdogTimer.Start();
    }

    private bool _isSettingsOpen;

    private void OpenSettings()
    {
        if (!IsLoaded || _isSettingsOpen) return;
        _isSettingsOpen = true;
        Log("OpenSettings: showing dialog");

        var oldServer = _deviceConfig.ServerUrl;
        var oldId = _deviceConfig.DeviceId;

        try
        {
            var settings = new SettingsWindow();
            var result = settings.ShowDialog();
            _isSettingsOpen = false;

            if (result != true || settings.SavedConfig == null) return;

            var newConfig = settings.SavedConfig;
            if (newConfig.ServerUrl == oldServer && newConfig.DeviceId == oldId)
            {
                Log("OpenSettings: config unchanged, applying in-place");
                _deviceConfig.ShowStatus = newConfig.ShowStatus;
                _deviceConfig.Fullscreen = newConfig.Fullscreen;
                if (newConfig.Fullscreen && !_isFullscreen)
                    EnterFullscreen();
                else if (!newConfig.Fullscreen && _isFullscreen)
                    ExitFullscreen();
                return;
            }

            Log("OpenSettings: server/device changed, restarting");
            _isRestarting = true;
            var w = new MainWindow(newConfig, newConfig.Fullscreen);
            w.Show();
            this.Close();
        }
        catch (Exception ex)
        {
            Log($"OpenSettings error: {ex.Message}");
            _isSettingsOpen = false;
        }
    }

    private void Log(string msg)
    {
        try
        {
            Paths.EnsureDirectories();
            var line = $"[{DateTime.Now:HH:mm:ss}] [Main] {msg}";
            File.AppendAllText(Paths.LogFile, line + Environment.NewLine);
        }
        catch { }
    }
}
