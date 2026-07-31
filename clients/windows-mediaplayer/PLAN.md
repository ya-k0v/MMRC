# MMRC Windows Player — План реализации

## Стек технологий

| Компонент | Решение |
|-----------|---------|
| Язык | C# (.NET 8) |
| UI Framework | WPF |
| Socket.IO | SocketIOClient (NuGet) |
| Видео/Аудио | LibVLCSharp + LibVLCSharp.WPF |
| Изображения | WPF BitmapImage + анимации Opacity |
| Киск-режим | Win32 API (P/Invoke) |
| Always on top | WS_EX_TOPMOST \| WS_EX_TOOLWINDOW |
| Скрытие таскбара | SHAppBarMessage с ABS_AUTOHIDE |
| Автозапуск | Task Scheduler |
| Конфигурация | appsettings.json |

## Аналогия с Android

| Android | Windows |
|---------|---------|
| FrameLayout (слои) | Grid (слои: Video, Image, Status) |
| ExoPlayer (primary) | LibVLC (primary) |
| ExoPlayer (buffer) | LibVLC (buffer) — crossfade |
| ImageView + Glide | Image + BitmapImage + disk cache |
| SystemUiVisibility flags | Win32 API SetWindowLongPtr |
| WakeLock | SetThreadExecutionState(ES_DISPLAY_REQUIRED) |
| BootReceiver | Task Scheduler |
| SharedPreferences | appsettings.json |

## Структура проекта

```
clients/windows-mediaplayer/
├── PLAN.md
├── MMRCPlayer.sln
├── src/MMRCPlayer/
│   ├── MMRCPlayer.csproj
│   ├── App.xaml / App.xaml.cs
│   ├── MainWindow.xaml / MainWindow.xaml.cs
│   ├── appsettings.json
│   ├── Services/
│   │   ├── SocketService.cs
│   │   ├── MediaPlayerService.cs
│   │   ├── ImageService.cs
│   │   ├── KioskService.cs
│   │   ├── ConfigService.cs
│   │   └── ProgressService.cs
│   ├── Models/
│   │   ├── ContentType.cs
│   │   ├── FileState.cs
│   │   └── DeviceConfig.cs
│   └── Utilities/
│       ├── Win32Api.cs
│       └── FileHelper.cs
└── install.ps1
```

## Socket.IO Events (один к одному с Android)

### Client → Server:
- `player/register` — {device_id, device_type: "NATIVE_MEDIAPLAYER", platform: "Windows", capabilities}
- `player/ping` — heartbeat каждые 20s
- `player/progress` — {device_id, type, file, currentTime, duration, page?, stream_protocol?}
- `player/volumeState` — {device_id, level, muted}

### Server → Client:
- `player/play` — {type, file, page, stream_url, stream_protocol, originDeviceId, startAt, startDelayMs}
- `player/stop` — {reason}
- `player/pause`
- `player/resume`
- `player/restart`
- `player/seek` — {position}
- `player/volume` — {level, muted, reason}
- `player/pdfPage` — page number
- `player/pptxPage` — slide number
- `player/folderPage` — image number
- `placeholder/refresh`
- `player/registered`

## Типы контента

Video (mp4, webm, ogg, mkv, mov, avi), Audio (mp3, aac, wav, flac, ogg, m4a, opus),
Image (png, jpg, jpeg, gif, webp), PDF, PPTX, Folder, Streaming (HLS, DASH), Placeholder

## Порядок реализации

1. Scaffold проекта (.csproj, solution)
2. Win32Api.cs — P/Invoke
3. Models — ContentType, FileState, DeviceConfig
4. FileHelper.cs — URL building, type detection
5. ConfigService.cs
6. KioskService.cs
7. SocketService.cs
8. MediaPlayerService.cs
9. ImageService.cs
10. ProgressService.cs
11. MainWindow.xaml + .cs
12. App.xaml + .cs
13. appsettings.json
14. install.ps1
15. dotnet publish → .exe
