using System;
using System.IO;
using MMRCPlayer.Models;

namespace MMRCPlayer.Utilities;

public static class FileHelper
{
    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp4", "webm", "ogg", "mkv", "mov", "avi", "m4v", "ts"
    };

    private static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp3", "aac", "wav", "flac", "ogg", "m4a", "opus", "weba"
    };

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"
    };

    private static readonly HashSet<string> PdfExtensions = new(StringComparer.OrdinalIgnoreCase) { "pdf" };
    private static readonly HashSet<string> PptxExtensions = new(StringComparer.OrdinalIgnoreCase) { "pptx", "ppt" };

    public static string EnsureUrl(string serverUrl)
    {
        var url = serverUrl.Trim().TrimEnd('/');
        if (string.IsNullOrEmpty(url)) return url;
        if (!url.StartsWith("http://") && !url.StartsWith("https://"))
            url = "http://" + url;
        return url;
    }

    public static string GetFileUrl(string serverUrl, string deviceId, string fileName)
    {
        var baseUri = EnsureUrl(serverUrl).TrimEnd('/');
        var encoded = Uri.EscapeDataString(fileName);
        return $"{baseUri}/api/files/resolve/{Uri.EscapeDataString(deviceId)}/{encoded}";
    }

    public static string GetPlaceholderUrl(string serverUrl, string deviceId)
    {
        var baseUri = EnsureUrl(serverUrl).TrimEnd('/');
        return $"{baseUri}/api/devices/{Uri.EscapeDataString(deviceId)}/placeholder";
    }

    public static string GetConfigUrl(string serverUrl, string deviceId)
    {
        var baseUri = EnsureUrl(serverUrl).TrimEnd('/');
        return $"{baseUri}/api/devices/{Uri.EscapeDataString(deviceId)}/config";
    }

    public static string GetAudioLogoUrl(string serverUrl)
    {
        var baseUri = EnsureUrl(serverUrl).TrimEnd('/');
        return $"{baseUri}/audio-logo.svg";
    }

    public static string GetConvertedPageUrl(string serverUrl, string deviceId, string fileName, string pageType, int pageNumber)
    {
        var baseUri = EnsureUrl(serverUrl).TrimEnd('/');
        var encoded = Uri.EscapeDataString(fileName);
        return $"{baseUri}/api/devices/{Uri.EscapeDataString(deviceId)}/converted/{encoded}/{pageType}/{pageNumber}";
    }

    public static string GetFolderImageUrl(string serverUrl, string deviceId, string folderName, int imageNumber)
    {
        var baseUri = EnsureUrl(serverUrl).TrimEnd('/');
        var encoded = Uri.EscapeDataString(folderName);
        return $"{baseUri}/api/devices/{Uri.EscapeDataString(deviceId)}/folder/{encoded}/image/{imageNumber}";
    }

    public static ContentType DetectContentType(string? explicitType, string? fileName, string? originalName)
    {
        if (!string.IsNullOrEmpty(explicitType))
        {
            var fromString = ContentTypeExtensions.FromString(explicitType);
            if (fromString != ContentType.Video || explicitType == "video")
                return fromString;
        }

        var nameToCheck = !string.IsNullOrEmpty(originalName) ? originalName : fileName;
        if (string.IsNullOrEmpty(nameToCheck))
            return ContentType.Video;

        return DetectByExtension(nameToCheck);
    }

    public static ContentType DetectByExtension(string fileName)
    {
        var ext = Path.GetExtension(fileName)?.TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(ext))
            return ContentType.Video;

        if (VideoExtensions.Contains(ext)) return ContentType.Video;
        if (AudioExtensions.Contains(ext)) return ContentType.Audio;
        if (ImageExtensions.Contains(ext)) return ContentType.Image;
        if (PdfExtensions.Contains(ext)) return ContentType.Pdf;
        if (PptxExtensions.Contains(ext)) return ContentType.Pptx;
        return ContentType.Video;
    }

    public static bool IsVideo(this ContentType type) => type == ContentType.Video || type == ContentType.Streaming;
    public static bool IsImage(this ContentType type) => type == ContentType.Image || type == ContentType.Pdf || type == ContentType.Pptx || type == ContentType.Folder;
    public static bool IsAudio(this ContentType type) => type == ContentType.Audio;
    public static bool IsStatic(this ContentType type) => type == ContentType.Image || type == ContentType.Pdf || type == ContentType.Pptx || type == ContentType.Folder;
}
