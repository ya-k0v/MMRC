namespace MMRCPlayer.Models;

public class FileState
{
    public string? Type { get; set; }
    public string? File { get; set; }
    public int? Page { get; set; }
    public double CurrentTime { get; set; }
    public double Duration { get; set; }
    public string? StreamUrl { get; set; }
    public string? StreamProtocol { get; set; }
    public string? OriginDeviceId { get; set; }

    public ContentType ContentType => ContentTypeExtensions.FromString(Type);
}
