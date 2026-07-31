using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MMRCPlayer.Utilities;

namespace MMRCPlayer.Services;

public class ImageService
{
    private readonly Dispatcher _dispatcher;
    private readonly string _cacheDir;
    private readonly HttpClient _httpClient;
    private string? _currentPrimarySource;
    private string? _currentBufferSource;

    public System.Windows.Controls.Image? ImagePrimary { get; set; }
    public System.Windows.Controls.Image? ImageBuffer { get; set; }

    public ImageService(Dispatcher dispatcher)
    {
        _dispatcher = dispatcher;
        _cacheDir = Paths.CacheDir;
        _httpClient = new HttpClient();
        _httpClient.Timeout = TimeSpan.FromSeconds(30);

        if (!Directory.Exists(_cacheDir))
            Directory.CreateDirectory(_cacheDir);
    }

    public async Task ShowImageAsync(string url, int crossfadeDurationMs = 500)
    {
        if (ImagePrimary == null || ImageBuffer == null) return;

        try
        {
            var localPath = await DownloadOrGetCachedAsync(url);

            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.UriSource = new Uri(localPath);
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.EndInit();
            bitmap.Freeze();

            _ = _dispatcher.BeginInvoke(() =>
            {
                ImageBuffer.Source = bitmap;
                ImageBuffer.Visibility = Visibility.Visible;
                ImageBuffer.Opacity = 0;

                var fadeIn = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(crossfadeDurationMs));
                var fadeOut = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(crossfadeDurationMs));

                fadeOut.Completed += (s, e) =>
                {
                    ImagePrimary.Source = null;
                    ImagePrimary.Visibility = Visibility.Collapsed;
                    (_currentPrimarySource, _currentBufferSource) = (_currentBufferSource, _currentPrimarySource);
                };

                ImageBuffer.BeginAnimation(System.Windows.Controls.Image.OpacityProperty, fadeIn);
                ImagePrimary.BeginAnimation(System.Windows.Controls.Image.OpacityProperty, fadeOut);
            });
        }
        catch { }
    }

    public Task ShowImageFromBytesAsync(byte[] imageBytes, int crossfadeDurationMs = 500)
    {
        if (ImagePrimary == null || ImageBuffer == null) return Task.CompletedTask;

        try
        {
            var bitmap = new BitmapImage();
            using var ms = new MemoryStream(imageBytes);
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.StreamSource = ms;
            bitmap.EndInit();
            bitmap.Freeze();

            _ = _dispatcher.BeginInvoke(() =>
            {
                ImageBuffer.Source = bitmap;
                ImageBuffer.Visibility = Visibility.Visible;
                ImageBuffer.Opacity = 0;

                var fadeIn = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(crossfadeDurationMs));
                var fadeOut = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(crossfadeDurationMs));

                fadeOut.Completed += (s, e) =>
                {
                    ImagePrimary.Source = null;
                    ImagePrimary.Visibility = Visibility.Collapsed;
                };

                ImageBuffer.BeginAnimation(System.Windows.Controls.Image.OpacityProperty, fadeIn);
                ImagePrimary.BeginAnimation(System.Windows.Controls.Image.OpacityProperty, fadeOut);
            });
        }
        catch { }
        return Task.CompletedTask;
    }

    public void HideImages()
    {
        if (ImagePrimary != null)
        {
            ImagePrimary.BeginAnimation(System.Windows.Controls.Image.OpacityProperty, null);
            ImagePrimary.Opacity = 0;
            ImagePrimary.Visibility = Visibility.Collapsed;
            ImagePrimary.Source = null;
        }
        if (ImageBuffer != null)
        {
            ImageBuffer.BeginAnimation(System.Windows.Controls.Image.OpacityProperty, null);
            ImageBuffer.Opacity = 0;
            ImageBuffer.Visibility = Visibility.Collapsed;
            ImageBuffer.Source = null;
        }
    }

    public async Task PreloadAdjacentPagesAsync(string serverUrl, string deviceId, string fileName, string pageType, int currentPage, int totalPages)
    {
        var tasks = new System.Collections.Generic.List<Task>();

        if (currentPage > 1)
        {
            var prevUrl = Utilities.FileHelper.GetConvertedPageUrl(serverUrl, deviceId, fileName, pageType, currentPage - 1);
            tasks.Add(DownloadOrGetCachedAsync(prevUrl));
        }
        if (currentPage < totalPages)
        {
            var nextUrl = Utilities.FileHelper.GetConvertedPageUrl(serverUrl, deviceId, fileName, pageType, currentPage + 1);
            tasks.Add(DownloadOrGetCachedAsync(nextUrl));
        }

        await Task.WhenAll(tasks);
    }

    private async Task<string> DownloadOrGetCachedAsync(string url)
    {
        var cacheKey = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(url)));
        var ext = Path.GetExtension(new Uri(url).AbsolutePath);
        if (string.IsNullOrEmpty(ext)) ext = ".bin";
        var localPath = Path.Combine(_cacheDir, cacheKey + ext);

        if (File.Exists(localPath))
            return localPath;

        var bytes = await _httpClient.GetByteArrayAsync(url);
        await File.WriteAllBytesAsync(localPath, bytes);
        return localPath;
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

    public void ClearMemoryCache()
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
    }
}
