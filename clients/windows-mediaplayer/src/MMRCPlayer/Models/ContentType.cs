namespace MMRCPlayer.Models;

public enum ContentType
{
    Video,
    Audio,
    Image,
    Pdf,
    Pptx,
    Folder,
    Streaming,
    Placeholder
}

public static class ContentTypeExtensions
{
    public static string AsString(this ContentType type) => type switch
    {
        ContentType.Video => "video",
        ContentType.Audio => "audio",
        ContentType.Image => "image",
        ContentType.Pdf => "pdf",
        ContentType.Pptx => "pptx",
        ContentType.Folder => "folder",
        ContentType.Streaming => "streaming",
        ContentType.Placeholder => "placeholder",
        _ => "video"
    };

    public static ContentType FromString(string? type) => type?.ToLowerInvariant() switch
    {
        "video" => ContentType.Video,
        "audio" => ContentType.Audio,
        "image" => ContentType.Image,
        "pdf" => ContentType.Pdf,
        "pptx" => ContentType.Pptx,
        "folder" => ContentType.Folder,
        "streaming" => ContentType.Streaming,
        "placeholder" => ContentType.Placeholder,
        _ => ContentType.Video
    };
}
