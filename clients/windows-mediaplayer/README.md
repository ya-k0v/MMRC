# MMRC Player for Windows

Цифровой signage-плеер для Windows. Аналог Android-клиента MMRC.

## Требования

- Windows 10/11 x64
- .NET 8.0 SDK (для сборки)
- Сетевой доступ к MMRC серверу

## Быстрая сборка

```powershell
# На Windows с установленным .NET 8 SDK:
.\build.ps1

# Результат: publish\MMRCPlayer.exe (~60MB self-contained)
```

## Установка

```powershell
# Автоматическая установка (Task Scheduler):
.\install.ps1 -ServerUrl "http://192.168.1.100:3000" -DeviceId "WIN001"

# Запуск немедленно:
Start-ScheduledTask -TaskName "MMRCPlayer"
```

## Ручной запуск

```powershell
.\publish\MMRCPlayer.exe --server http://192.168.1.100:3000 --device-id WIN001
```

## Конфигурация

Создайте `appsettings.json` рядом с exe:

```json
{
  "MMRCPlayer": {
    "ServerUrl": "http://192.168.1.100:3000",
    "DeviceId": "WIN001",
    "ShowStatus": false,
    "CrossfadeDurationMs": 500
  }
}
```

Или используйте аргументы командной строки:
- `--server <url>` — адрес сервера
- `--device-id <id>` — ID устройства
- `--show-status true|false` — показывать статус

## Удаление

```powershell
.\install.ps1 -Uninstall
```

## Киск-режим

Приложение автоматически:
- Разворачивается на весь экран
- Скрывает таскбар
- Скрывает все системные элементы
- Блокирует Alt+Tab, Win, Ctrl+Alt+Del
- Не гасит экран

Нажмите **Esc** или **F11** для выхода из киск-режима.

## Архитектура

| Компонент | Описание |
|-----------|----------|
| SocketService | Socket.IO подключение, авторегистрация |
| MediaPlayerService | LibVLC, dual player для crossfade |
| ImageService | Загрузка изображений с кэшированием |
| KioskService | Win32 API: fullscreen, topmost, taskbar |
| ProgressService | Отправка прогресса каждую секунду |
| ConfigService | Чтение конфигурации |

## Функционал (аналог Android)

- Видео (mp4, webm, mkv, mov, avi)
- Аудио (mp3, aac, wav, flac, ogg, m4a)
- Изображения (png, jpg, jpeg, gif, webp)
- PDF (конвертируется сервером в изображения)
- PPTX (конвертируется сервером в изображения)
- Папки (ZIP архивы изображений)
- Стриминг (HLS, DASH)
- Placeholder (контент-заглушка)
- Crossfade переходы
- Автопереподключение
- Громкость
- Навигация по страницам
