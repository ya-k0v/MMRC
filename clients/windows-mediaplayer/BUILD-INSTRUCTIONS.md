# Сборка MMRC Player for Windows — Пошаговая инструкция

## 1. Установка .NET 8 SDK

Скачай и установи **.NET 8.0 SDK** (не Runtime!):

```
https://dotnet.microsoft.com/download/dotnet/8.0
```

Выбери: **Windows x64 → SDK 8.0.x**

После установки проверь в PowerShell:
```powershell
dotnet --version
# Должно вывести: 8.0.xxx
```

## 2. Клонируй/скопируй проект

Скопируй папку `clients/windows-mediaplayer` на Windows машину.

Например в: `C:\dev\MMRCPlayer\`

## 3. Сборка

Открой **PowerShell** и перейди в папку проекта:

```powershell
cd C:\dev\MMRCPlayer
```

### Вариант А: Через build.ps1 (рекомендуется)

```powershell
# Разрешить выполнение скриптов (если нужно):
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Сборка:
.\build.ps1
```

### Вариант Б: Вручную

```powershell
cd src\MMRCPlayer

# Восстановить NuGet пакеты:
dotnet restore -r win-x64

# Собрать и опубликовать:
dotnet publish -c Release -r win-x64 --self-contained true `
    -o ..\..\publish
```

### Результат

После сборки получишь папку `publish\` с содержимым:
```
publish\MMRCPlayer.exe
publish\appsettings.json
publish\*.dll          ← нативные библиотеки (LibVLC и др.)
```

Для распространения — заархивируй папку `publish\` в `.zip` или создай установщик через `build-installer.ps1`.

## 4. Настройка

### Вариант 1: appsettings.json

Отредактируй `publish\appsettings.json`:
```json
{
  "MMRCPlayer": {
    "ServerUrl": "http://192.168.1.100:3000",
    "DeviceId": "WIN001",
    "ShowStatus": false
  }
}
```

### Вариант 2: Аргументы командной строки

```powershell
.\MMRCPlayer.exe --server http://192.168.1.100:3000 --device-id WIN001
```

## 5. Запуск

```powershell
.\MMRCPlayer.exe
```

Приложение:
- Разворачивается на весь экран
- Скрывает таскбар
- Подключается к серверу
- Регистрируется как `NATIVE_MEDIAPLAYER`
- Начинает воспроизведение placeholder

## 6. Автозапуск при входе в Windows

```powershell
.\install.ps1 -ServerUrl "http://192.168.1.100:3000" -DeviceId "WIN001"
```

Это создаст задачу в **Task Scheduler**, которая запускает плеер при входе пользователя.

### Удаление автозапуска:
```powershell
.\install.ps1 -Uninstall
```

## 7. Выход из киск-режима (для отладки)

В киск-режиме все клавиши блокируются. Для выхода:
- Нажми **Esc** или **F11** (если киск-режим активен)
- Или закрой процесс через Task Manager → Details → MMRCPlayer.exe → End Task

## Возможные проблемы

### "NuGet package not found"
Убедись что .NET SDK установлен, а не только Runtime. Проверь:
```powershell
dotnet --list-sdks
```

### "The term 'dotnet' is not recognized"
Добавь путь к dotnet в PATH:
```
C:\Program Files\dotnet\
```
Или перезапусти PowerShell после установки SDK.

### "Unable to load DLL 'libvlccore'"
LibVLC подтянется автоматически через NuGet пакет `VideoLAN.LibVLC.Windows`. Если ошибка — попробуй:
```powershell
dotnet restore -r win-x64
```

### Плеер не подключается к серверу
Проверь:
1. Адрес сервера в `appsettings.json` или `--server` флаг
2. Что сервер запущен и доступен (`curl http://192.168.1.100:3000/api/version`)
3. Что device_id зарегистрирован на сервере

## Структура проекта

```
clients/windows-mediaplayer/
├── BUILD-INSTRUCTIONS.md          ← ты здесь
├── PLAN.md
├── README.md
├── build.ps1                      ← скрипт сборки
├── install.ps1                    ← скрипт установки автозапуска
├── MMRCPlayer.sln
└── src/MMRCPlayer/
    ├── MMRCPlayer.csproj
    ├── App.xaml / App.xaml.cs
    ├── MainWindow.xaml / MainWindow.xaml.cs
    ├── appsettings.json
    ├── Services/
    │   ├── SocketService.cs       ← Socket.IO
    │   ├── MediaPlayerService.cs  ← LibVLC (video/audio/stream)
    │   ├── ImageService.cs        ← Изображения + crossfade
    │   ├── KioskService.cs        ← Win32 fullscreen/topmost
    │   ├── ConfigService.cs       ← Конфигурация
    │   └── ProgressService.cs     ← Прогресс каждую секунду
    ├── Models/
    │   ├── ContentType.cs
    │   ├── FileState.cs
    │   └── DeviceConfig.cs
    └── Utilities/
        ├── Win32Api.cs            ← P/Invoke декларации
        └── FileHelper.cs          ← URL building
```

## Соответствие Android-клиенту

| Android | Windows |
|---------|---------|
| Socket.IO (io.socket) | SocketIOClient (NuGet) |
| ExoPlayer (dual, crossfade) | LibVLC (dual, crossfade) |
| Glide (image cache) | HttpClient + disk cache |
| FrameLayout (слои) | Grid (слои в XAML) |
| SystemUiVisibility | Win32 API SetWindowLongPtr |
| WakeLock | SetThreadExecutionState |
| BootReceiver | Task Scheduler |
| SharedPreferences | appsettings.json |
