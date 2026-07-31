using System;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using MMRCPlayer.Models;
using MMRCPlayer.Utilities;
using MediaPlayer = LibVLCSharp.Shared.MediaPlayer;

namespace MMRCPlayer.Services;

public class MediaPlayerService : IDisposable
{
    private readonly Dispatcher _dispatcher;
    private readonly DeviceConfig _config;
    private readonly HttpClient _httpClient;
    private string? _cacheDir;

    private LibVLC? _libVLC;
    private MediaPlayer? _primaryPlayer;
    private MediaPlayer? _bufferPlayer;
    private bool _isBufferActive;
    private CancellationTokenSource? _placeholderCts;
    private readonly SemaphoreSlim _playLock = new(1, 1);

    private FileState? _currentState;
    private FileState? _placeholderState;
    private bool _isPlaying;
    private bool _isPaused;
    private double _savedPosition;
    private bool _isPlaceholder;
    private double? _pendingSeek;
    private double _lastDuration;

    public event Action<double, double>? OnTimeChanged;
    public event Action? OnPlaybackEnd;
    public event Action<string>? OnError;

    public LibVLCSharp.WPF.VideoView? VideoPrimary { get; set; }
    public LibVLCSharp.WPF.VideoView? VideoBuffer { get; set; }
    public System.Windows.Controls.Image? BrandBg { get; set; }
    public System.Windows.Controls.Image? ImagePrimary { get; set; }
    public Action? HideImages { get; set; }
    public MediaPlayer? PrimaryPlayer => _primaryPlayer;
    public MediaPlayer? BufferPlayer => _bufferPlayer;
    private MediaPlayer? GetActivePlayer()
    {
        if (_isBufferActive) return _bufferPlayer ?? _primaryPlayer;
        return _primaryPlayer;
    }

    public double CurrentTime
    {
        get
        {
            var p = GetActivePlayer();
            if (p == null) return 0;
            try
            {
                var pos = p.Position;
                var len = p.Length;
                if (len > 0) return pos * (len / 1000.0);
                return 0;
            }
            catch { return 0; }
        }
    }
    public double Duration
    {
        get
        {
            var p = GetActivePlayer();
            if (p == null) return 0;
            try
            {
                if (_isPlaying && !_isPaused)
                {
                    var len = p.Length;
                    if (len > 0) _lastDuration = len / 1000.0;
                }
                return _lastDuration;
            }
            catch { return _lastDuration; }
        }
    }
    public bool IsPlaying => _isPlaying && !_isPaused;

    public MediaPlayerService(Dispatcher dispatcher, DeviceConfig config)
    {
        _dispatcher = dispatcher;
        _config = config;
        _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        _cacheDir = Paths.CacheDir;
        Directory.CreateDirectory(_cacheDir);
    }

    public void InitializeCore()
    {
        Core.Initialize();
    }

    public Task InitializePlayersAsync()
    {
        return Task.Run(() =>
        {
            _libVLC = new LibVLC(
                "--no-video-title-show",
                "--quiet",
                "--no-stats",
                "--no-sub-autodetect-file",
                "--no-snapshot-preview",
                "--no-osd",
                "--avcodec-hw=none",
                "--no-plugins-cache",
                "--no-lua"
            );

            _primaryPlayer = new MediaPlayer(_libVLC)
            {
                EnableHardwareDecoding = false
            };
            _primaryPlayer.EndReached += OnPrimaryEndReached;
            _primaryPlayer.TimeChanged += OnPrimaryTimeChanged;
            _primaryPlayer.Playing += OnPrimaryPlaying;
            _primaryPlayer.Paused += OnPrimaryPaused;
            _primaryPlayer.Stopped += OnPrimaryStopped;
            _primaryPlayer.EncounteredError += OnPrimaryError;

            _bufferPlayer = new MediaPlayer(_libVLC)
            {
                EnableHardwareDecoding = false
            };
            _bufferPlayer.EndReached += OnBufferEndReached;
            _bufferPlayer.TimeChanged += OnBufferTimeChanged;
            _bufferPlayer.Playing += OnBufferPlaying;
            _bufferPlayer.Paused += OnBufferPaused;
            _bufferPlayer.Stopped += OnBufferStopped;
            _bufferPlayer.EncounteredError += OnBufferError;
        });
    }

    public void AttachPlayersToViews()
    {
        _ = _dispatcher.BeginInvoke(() =>
        {
            if (VideoPrimary != null) VideoPrimary.MediaPlayer = _primaryPlayer;
            if (VideoBuffer != null) VideoBuffer.MediaPlayer = _bufferPlayer;
        });
    }

    public bool IsInitialized => _libVLC != null;

    public bool IsPlaceholder => _isPlaceholder;

    public async Task PlayVideoAsync(string url, string? originDeviceId = null)
    {
        await _playLock.WaitAsync();
        try
        {
            StopAll();
            _isPlaceholder = false;

            var effectiveUrl = await ResolveUrlAsync(url);
            var media = new Media(_libVLC!, new Uri(effectiveUrl));

            _currentState = new FileState
            {
                Type = "video",
                File = Path.GetFileName(new Uri(url).AbsolutePath),
                OriginDeviceId = originDeviceId
            };

            _ = _dispatcher.BeginInvoke(() =>
            {
                if (VideoPrimary != null)
                {
                    VideoPrimary.Visibility = Visibility.Visible;
                    VideoPrimary.Opacity = 1;
                }
                HideImages?.Invoke();
            });

            _primaryPlayer?.Play(media);
            _isPlaying = true;
            _isPaused = false;
        }
        catch (Exception ex) { Log($"PlayVideoAsync error: {ex.Message}"); }
        finally { _playLock.Release(); }
    }

    private async Task PlayVideoLoopAsync(string url)
    {
        await _playLock.WaitAsync();
        try
        {
            StopAll();

            var effectiveUrl = await ResolveUrlAsync(url);
            var media = new Media(_libVLC!, new Uri(effectiveUrl));
            media.AddOption(":input-repeat=65535");

            _currentState = new FileState
            {
                Type = "placeholder",
                File = Path.GetFileName(new Uri(url).AbsolutePath)
            };

            _ = _dispatcher.BeginInvoke(() =>
            {
                if (VideoPrimary != null)
                {
                    VideoPrimary.Visibility = Visibility.Visible;
                    VideoPrimary.Opacity = 1;
                }
                HideImages?.Invoke();
            });

            _primaryPlayer?.Play(media);
            _isPlaying = true;
            _isPaused = false;
        }
        catch (Exception ex) { Log($"PlayVideoLoopAsync error: {ex.Message}"); }
        finally { _playLock.Release(); }
    }

    public async Task PlayAudioAsync(string url, string? audioLogoSvgUrl = null, string? originDeviceId = null)
    {
        await _playLock.WaitAsync();
        try
        {
            if (_currentState?.Type == "audio")
                StopWithoutHiding();
            else
                StopAll();

            var effectiveUrl = await ResolveUrlAsync(url);
            var media = new Media(_libVLC!, new Uri(effectiveUrl));

            _currentState = new FileState
            {
                Type = "audio",
                File = Path.GetFileName(new Uri(url).AbsolutePath),
                OriginDeviceId = originDeviceId
            };

            _ = _dispatcher.BeginInvoke(() =>
            {
                if (VideoPrimary != null)
                    VideoPrimary.Visibility = Visibility.Collapsed;
                HideImages?.Invoke();
                if (BrandBg != null)
                {
                    try
                    {
                        var uri = new Uri("pack://application:,,,/Resources/audio-logo.png", UriKind.Absolute);
                        var bitmap = new System.Windows.Media.Imaging.BitmapImage(uri);
                        bitmap.Freeze();
                        BrandBg.Source = bitmap;
                    }
                    catch { }
                    BrandBg.Visibility = Visibility.Visible;
                    BrandBg.Opacity = 1;
                }
            });

            _primaryPlayer?.Play(media);
            _isPlaying = true;
            _isPaused = false;
        }
        catch (Exception ex) { Log($"PlayAudioAsync error: {ex.Message}"); }
        finally { _playLock.Release(); }
    }

    public async Task PlayVideoWithCrossfadeAsync(string url, string? originDeviceId = null)
    {
        await _playLock.WaitAsync();
        try
        {
            _lastDuration = 0;

            var effectiveUrl = await ResolveUrlAsync(url);
            var media = new Media(_libVLC!, new Uri(effectiveUrl));

            var targetPlayer = _isBufferActive ? _primaryPlayer : _bufferPlayer;
            var sourcePlayer = _isBufferActive ? _bufferPlayer : _primaryPlayer;
            var targetView = _isBufferActive ? VideoPrimary : VideoBuffer;
            var sourceView = _isBufferActive ? VideoBuffer : VideoPrimary;

            _currentState = new FileState
            {
                Type = "video",
                File = Path.GetFileName(new Uri(url).AbsolutePath),
                OriginDeviceId = originDeviceId
            };

            _ = _dispatcher.BeginInvoke(() =>
            {
                HideImages?.Invoke();

                if (targetView != null && sourceView != null)
                {
                    targetView.Visibility = Visibility.Visible;
                    targetView.Opacity = 0;
                    targetPlayer?.Play(media);

                    var fadeDuration = TimeSpan.FromMilliseconds(_config.CrossfadeDurationMs);
                    var fadeIn = new DoubleAnimation(0, 1, fadeDuration);
                    var fadeOut = new DoubleAnimation(1, 0, fadeDuration);

                    fadeOut.Completed += (s, e) =>
                    {
                        try { sourcePlayer?.Stop(); } catch { }
                        sourceView.Visibility = Visibility.Collapsed;
                        _isBufferActive = !_isBufferActive;
                    };

                    targetView.BeginAnimation(System.Windows.UIElement.OpacityProperty, fadeIn);
                    sourceView.BeginAnimation(System.Windows.UIElement.OpacityProperty, fadeOut);
                }
                else
                {
                    targetPlayer?.Play(media);
                }
            });

            _isPlaying = true;
            _isPaused = false;
        }
        catch (Exception ex) { Log($"PlayVideoWithCrossfadeAsync error: {ex.Message}"); }
        finally { _playLock.Release(); }
    }

    public async Task PlayStreamAsync(string streamUrl, string protocol, string? originDeviceId = null, string? fileName = null)
    {
        await _playLock.WaitAsync();
        try
        {
            StopAll();

            var fullUrl = streamUrl;
            if (!fullUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !fullUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                var serverBase = FileHelper.EnsureUrl(_config.ServerUrl).TrimEnd('/');
                var path = fullUrl.StartsWith("/") ? fullUrl : "/" + fullUrl;
                fullUrl = serverBase + path;
            }

            Log($"PlayStreamAsync: url={fullUrl}, protocol={protocol}");
            var media = new Media(_libVLC!, new Uri(fullUrl));

            if (protocol?.ToLowerInvariant() == "hls")
            {
                media.AddOption(":adaptive-use-access");
                media.AddOption(":adaptive-logic-codec");
            }

            _currentState = new FileState
            {
                Type = "streaming",
                File = fileName ?? streamUrl,
                StreamUrl = streamUrl,
                StreamProtocol = protocol,
                OriginDeviceId = originDeviceId
            };

            _ = _dispatcher.BeginInvoke(() =>
            {
                if (VideoPrimary != null)
                {
                    VideoPrimary.Visibility = Visibility.Visible;
                    VideoPrimary.Opacity = 1;
                }
                HideImages?.Invoke();

                if (_primaryPlayer != null)
                    _primaryPlayer.Play(media);
                else
                    Log("PlayStreamAsync: _primaryPlayer is null, cannot play");
            });

            _isPlaying = true;
            _isPaused = false;
        }
        catch (Exception ex) { Log($"PlayStreamAsync error: {ex.Message}"); OnError?.Invoke(ex.Message); }
        finally { _playLock.Release(); }
    }

    public async Task PlayStreamWithCrossfadeAsync(string streamUrl, string protocol, string? originDeviceId = null, string? fileName = null)
    {
        await _playLock.WaitAsync();
        try
        {
            _lastDuration = 0;

            var fullUrl = streamUrl;
            if (!fullUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !fullUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                var serverBase = FileHelper.EnsureUrl(_config.ServerUrl).TrimEnd('/');
                var path = fullUrl.StartsWith("/") ? fullUrl : "/" + fullUrl;
                fullUrl = serverBase + path;
            }

            var media = new Media(_libVLC!, new Uri(fullUrl));

            if (protocol?.ToLowerInvariant() == "hls")
            {
                media.AddOption(":adaptive-use-access");
                media.AddOption(":adaptive-logic-codec");
            }

            var targetPlayer = _isBufferActive ? _primaryPlayer : _bufferPlayer;
            var sourcePlayer = _isBufferActive ? _bufferPlayer : _primaryPlayer;
            var targetView = _isBufferActive ? VideoPrimary : VideoBuffer;
            var sourceView = _isBufferActive ? VideoBuffer : VideoPrimary;

            _currentState = new FileState
            {
                Type = "streaming",
                File = fileName ?? streamUrl,
                StreamUrl = streamUrl,
                StreamProtocol = protocol,
                OriginDeviceId = originDeviceId
            };

            _ = _dispatcher.BeginInvoke(() =>
            {
                HideImages?.Invoke();

                if (targetView != null && sourceView != null)
                {
                    targetView.Visibility = Visibility.Visible;
                    targetView.Opacity = 0;
                    targetPlayer?.Play(media);

                    var fadeDuration = TimeSpan.FromMilliseconds(_config.CrossfadeDurationMs);
                    var fadeIn = new DoubleAnimation(0, 1, fadeDuration);
                    var fadeOut = new DoubleAnimation(1, 0, fadeDuration);

                    fadeOut.Completed += (s, e) =>
                    {
                        try { sourcePlayer?.Stop(); } catch { }
                        sourceView.Visibility = Visibility.Collapsed;
                        _isBufferActive = !_isBufferActive;
                    };

                    targetView.BeginAnimation(System.Windows.UIElement.OpacityProperty, fadeIn);
                    sourceView.BeginAnimation(System.Windows.UIElement.OpacityProperty, fadeOut);
                }
                else
                {
                    targetPlayer?.Play(media);
                }
            });

            _isPlaying = true;
            _isPaused = false;
        }
        catch (Exception ex) { Log($"PlayStreamWithCrossfadeAsync error: {ex.Message}"); OnError?.Invoke(ex.Message); }
        finally { _playLock.Release(); }
    }

    public void StopAll()
    {
        _placeholderCts?.Cancel();
        _lastDuration = 0;
        try { _primaryPlayer?.Stop(); } catch { }
        try { _bufferPlayer?.Stop(); } catch { }
        _isPlaying = false;
        _isPaused = false;
        _ = _dispatcher.BeginInvoke(() =>
        {
            if (VideoPrimary != null) VideoPrimary.Visibility = Visibility.Collapsed;
            if (VideoBuffer != null) VideoBuffer.Visibility = Visibility.Collapsed;
            if (BrandBg != null) BrandBg.Visibility = Visibility.Collapsed;
        });
    }

    public void StopWithoutHiding()
    {
        _placeholderCts?.Cancel();
        _lastDuration = 0;
        try { _primaryPlayer?.Stop(); } catch { }
        try { _bufferPlayer?.Stop(); } catch { }
        _isPlaying = false;
        _isPaused = false;
        _isPlaceholder = false;
        _ = _dispatcher.BeginInvoke(() =>
        {
            if (VideoPrimary != null) VideoPrimary.Visibility = Visibility.Collapsed;
            if (VideoBuffer != null) VideoBuffer.Visibility = Visibility.Collapsed;
        });
    }

    public void PauseForSwitch()
    {
        if (_isPlaceholder) return;
        try
        {
            _lastDuration = 0;
            var p = GetActivePlayer();
            if (p != null && _isPlaying)
            {
                _savedPosition = p.Position * p.Length / 1000.0;
                p.Pause();
                _isPaused = true;
                _isPlaying = false;
            }
        }
        catch (Exception ex) { Log($"PauseForSwitch error: {ex.Message}"); }
    }

    public void Pause()
    {
        if (_isPlaceholder) return;
        try
        {
            if (_isPlaying && !_isPaused)
            {
                var p = GetActivePlayer();
                if (p != null)
                {
                    _savedPosition = p.Position * p.Length / 1000.0;
                    p.Pause();
                    _isPaused = true;
                }
            }
        }
        catch (Exception ex) { Log($"Pause error: {ex.Message}"); }
    }

    public async Task CrossfadeToImageAsync(int durationMs)
    {
        try
        {
            var sourceView = _isBufferActive ? VideoBuffer : VideoPrimary;
            var sourcePlayer = _isBufferActive ? _bufferPlayer : _primaryPlayer;

            var fadeOut = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(durationMs));
            var tcs = new TaskCompletionSource<bool>();
            fadeOut.Completed += (s, e) =>
            {
                try { sourcePlayer?.Stop(); } catch { }
                _ = _dispatcher.BeginInvoke(() =>
                {
                    if (VideoPrimary != null) VideoPrimary.Visibility = Visibility.Collapsed;
                    if (VideoBuffer != null) VideoBuffer.Visibility = Visibility.Collapsed;
                });
                _isPlaying = false;
                _isPaused = false;
                _isPlaceholder = false;
                tcs.TrySetResult(true);
            };

            if (sourceView != null)
                sourceView.BeginAnimation(System.Windows.UIElement.OpacityProperty, fadeOut);
            else
                tcs.TrySetResult(true);

            await tcs.Task;
        }
        catch (Exception ex) { Log($"CrossfadeToImageAsync error: {ex.Message}"); }
    }

    public void Resume()
    {
        if (_isPlaceholder) return;
        try
        {
            if (_isPaused)
            {
                var p = GetActivePlayer();
                if (p != null)
                {
                    p.Play();
                    _isPaused = false;
                }
            }
        }
        catch (Exception ex) { Log($"Resume error: {ex.Message}"); }
    }

    public void Restart()
    {
        if (_isPlaceholder) return;
        try
        {
            var p = GetActivePlayer();
            if (p != null)
            {
                p.Position = 0;
                p.Play();
                _isPlaying = true;
                _isPaused = false;
            }
        }
        catch (Exception ex) { Log($"Restart error: {ex.Message}"); }
    }

    public void Seek(double positionSeconds)
    {
        if (_isPlaceholder) return;
        try
        {
            var p = GetActivePlayer();
            if (p == null) return;

            if (p.Length > 0)
            {
                p.Position = (float)(positionSeconds / (p.Length / 1000.0));
                _pendingSeek = null;
            }
            else
            {
                _pendingSeek = positionSeconds;
            }
        }
        catch (Exception ex) { Log($"Seek error: {ex.Message}"); }
    }

    public void SetVolume(int level)
    {
        try
        {
            var clamped = Math.Clamp(level, 0, 100);
            if (_primaryPlayer != null) _primaryPlayer.Volume = clamped;
            if (_bufferPlayer != null) _bufferPlayer.Volume = clamped;
        }
        catch (Exception ex) { Log($"SetVolume error: {ex.Message}"); }
    }

    public void SetMute(bool muted)
    {
        try
        {
            if (_primaryPlayer != null) _primaryPlayer.Mute = muted;
            if (_bufferPlayer != null) _bufferPlayer.Mute = muted;
        }
        catch (Exception ex) { Log($"SetMute error: {ex.Message}"); }
    }

    public async Task LoadPlaceholderAsync(string serverUrl, string deviceId)
    {
        Log("LoadPlaceholder: start");
        _placeholderCts?.Cancel();
        _placeholderCts = new CancellationTokenSource();
        var ct = _placeholderCts.Token;

        var maxRetries = 3;
        for (int i = 0; i < maxRetries && !ct.IsCancellationRequested; i++)
        {
            try
            {
                var placeholderUrl = FileHelper.GetPlaceholderUrl(serverUrl, deviceId);
                Log($"LoadPlaceholder: fetching {placeholderUrl}");
                var response = await _httpClient.GetStringAsync(placeholderUrl, ct);
                Log($"LoadPlaceholder: response={response}");
                var doc = System.Text.Json.JsonDocument.Parse(response);

                if (doc.RootElement.TryGetProperty("placeholder", out var placeholderProp))
                {
                    var placeholderFile = placeholderProp.GetString();
                    Log($"LoadPlaceholder: file={placeholderFile}");

                    if (string.IsNullOrEmpty(placeholderFile) || placeholderFile == "null")
                    {
                        Log("LoadPlaceholder: no placeholder, showing black");
                        ShowPlaceholderBlack();
                        return;
                    }

                    var fileUrl = FileHelper.GetFileUrl(serverUrl, deviceId, placeholderFile);
                    var ext = Path.GetExtension(placeholderFile)?.ToLowerInvariant();
                    var isVideo = ext is ".mp4" or ".webm" or ".mkv" or ".mov" or ".avi";
                    Log($"LoadPlaceholder: url={fileUrl}, isVideo={isVideo}");

                    _placeholderState = new FileState
                    {
                        Type = isVideo ? "video" : "image",
                        File = placeholderFile
                    };

                    _isPlaceholder = true;

                    if (isVideo)
                        await PlayVideoLoopAsync(fileUrl);
                    else
                        await PlayImageAsync(fileUrl);

                    Log("LoadPlaceholder: done");
                    return;
                }

                Log("LoadPlaceholder: no placeholder property, showing black");
                ShowPlaceholderBlack();
                return;
            }
            catch (TaskCanceledException) { return; }
            catch (Exception ex)
            {
                Log($"LoadPlaceholder: error ({i+1}/{maxRetries}): {ex.Message}");
                if (i < maxRetries - 1)
                    await Task.Delay(3000, ct);
            }
        }

        Log("LoadPlaceholder: exhausted retries, showing black");
        ShowPlaceholderBlack();
    }

    private async Task PlayImageAsync(string url)
    {
        StopAll();
        _isPlaceholder = true;

        try
        {
            var localPath = await DownloadOrGetCachedAsync(url);
            var bitmap = new System.Windows.Media.Imaging.BitmapImage();
            bitmap.BeginInit();
            bitmap.UriSource = new Uri(localPath);
            bitmap.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            bitmap.EndInit();
            bitmap.Freeze();

            _ = _dispatcher.BeginInvoke(() =>
            {
                if (BrandBg != null) BrandBg.Visibility = Visibility.Collapsed;
                if (VideoPrimary != null) VideoPrimary.Visibility = Visibility.Collapsed;
                if (VideoBuffer != null) VideoBuffer.Visibility = Visibility.Collapsed;
                HideImages?.Invoke();

                if (ImagePrimary != null)
                {
                    ImagePrimary.Source = bitmap;
                    ImagePrimary.Visibility = Visibility.Visible;
                    ImagePrimary.Opacity = 1;
                }
            });
        }
        catch { ShowPlaceholderBlack(); }
    }

    private void ShowPlaceholderBlack()
    {
        _ = _dispatcher.BeginInvoke(() =>
        {
            StopAll();
        });
    }

    private async Task<string> DownloadOrGetCachedAsync(string url)
    {
        var cacheKey = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(url)));
        var localPath = Path.Combine(_cacheDir!, cacheKey);

        if (File.Exists(localPath))
            return localPath;

        var bytes = await _httpClient.GetByteArrayAsync(url);
        await File.WriteAllBytesAsync(localPath, bytes);
        return localPath;
    }

    private Task<string> ResolveUrlAsync(string url)
    {
        return Task.FromResult(url);
    }

    public void ClearCache()
    {
        try
        {
            if (Directory.Exists(_cacheDir))
            {
                foreach (var file in Directory.GetFiles(_cacheDir))
                {
                    try { File.Delete(file); } catch { }
                }
            }
        }
        catch { }
    }

    private void OnPrimaryEndReached(object? sender, EventArgs e)
    {
        try
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                if (_isPlaceholder)
                {
                    try
                    {
                        _primaryPlayer!.Position = 0;
                        _primaryPlayer.Play();
                    }
                    catch { }
                    return;
                }
                _isPlaying = false;
                OnPlaybackEnd?.Invoke();
            });
        }
        catch { }
    }

    private void OnPrimaryTimeChanged(object? sender, MediaPlayerTimeChangedEventArgs e)
    {
        try
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                var timeSec = e.Time / 1000.0;
                var duration = (_primaryPlayer?.Length ?? 0) / 1000.0;
                OnTimeChanged?.Invoke(timeSec, duration);
            });
        }
        catch { }
    }

    private void OnPrimaryPlaying(object? sender, EventArgs e)
    {
        try
        {
            _isPlaying = true;
            _isPaused = false;

            if (_pendingSeek.HasValue && _primaryPlayer != null && _primaryPlayer.Length > 0)
            {
                _primaryPlayer.Position = (float)(_pendingSeek.Value / (_primaryPlayer.Length / 1000.0));
                _pendingSeek = null;
            }
        }
        catch { }
    }

    private void OnPrimaryPaused(object? sender, EventArgs e)
    {
        _isPaused = true;
    }

    private void OnPrimaryStopped(object? sender, EventArgs e)
    {
        _isPlaying = false;
    }

    private void OnPrimaryError(object? sender, EventArgs e)
    {
        try
        {
            _ = _dispatcher.BeginInvoke(() => { OnError?.Invoke("Playback error"); });
        }
        catch { }
    }

    private void OnBufferEndReached(object? sender, EventArgs e)
    {
        try
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                if (_isPlaceholder)
                {
                    try
                    {
                        _bufferPlayer!.Position = 0;
                        _bufferPlayer.Play();
                    }
                    catch { }
                    return;
                }
                _isPlaying = false;
                OnPlaybackEnd?.Invoke();
            });
        }
        catch { }
    }

    private void OnBufferTimeChanged(object? sender, MediaPlayerTimeChangedEventArgs e)
    {
        try
        {
            _ = _dispatcher.BeginInvoke(() =>
            {
                var timeSec = e.Time / 1000.0;
                var duration = (_bufferPlayer?.Length ?? 0) / 1000.0;
                OnTimeChanged?.Invoke(timeSec, duration);
            });
        }
        catch { }
    }

    private void OnBufferPlaying(object? sender, EventArgs e)
    {
        try
        {
            _isPlaying = true;
            _isPaused = false;

            if (_pendingSeek.HasValue && _bufferPlayer != null && _bufferPlayer.Length > 0)
            {
                _bufferPlayer.Position = (float)(_pendingSeek.Value / (_bufferPlayer.Length / 1000.0));
                _pendingSeek = null;
            }
        }
        catch { }
    }

    private void OnBufferPaused(object? sender, EventArgs e)
    {
        _isPaused = true;
    }

    private void OnBufferStopped(object? sender, EventArgs e)
    {
        _isPlaying = false;
    }

    private void OnBufferError(object? sender, EventArgs e)
    {
        try
        {
            _ = _dispatcher.BeginInvoke(() => { OnError?.Invoke("Playback error"); });
        }
        catch { }
    }

    public void Dispose()
    {
        _placeholderCts?.Cancel();
        _placeholderCts?.Dispose();
        try { _primaryPlayer?.Stop(); } catch { }
        try { _bufferPlayer?.Stop(); } catch { }
        _primaryPlayer?.Dispose();
        _primaryPlayer = null;
        _bufferPlayer?.Dispose();
        _bufferPlayer = null;
        _libVLC?.Dispose();
        _libVLC = null;
        _httpClient?.Dispose();
        _playLock?.Dispose();
    }

    private void Log(string msg)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] [Media] {msg}";
        System.Diagnostics.Debug.WriteLine(line);
        try
        {
            Paths.EnsureDirectories();
            File.AppendAllText(Paths.LogFile, line + Environment.NewLine);
        }
        catch { }
    }
}
