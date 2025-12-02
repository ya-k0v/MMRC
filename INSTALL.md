# 📦 Инструкция по установке VideoControl на новую ОС

Это руководство поможет установить VideoControl на чистую операционную систему.

## 📋 Требования

### Системные требования
- **ОС**: Linux (Ubuntu 20.04+, Debian 11+, или аналогичные)
- **Node.js**: 20.x или выше
- **npm**: 9.x или выше (обычно устанавливается вместе с Node.js)

### Внешние зависимости
- **FFmpeg** + **FFprobe** (для обработки видео)
- **LibreOffice** (опционально, для конвертации PDF/PPTX)
- **SQLite3** (обычно предустановлен)

## 🚀 Пошаговая установка

### Шаг 1: Установка Node.js

```bash
# Для Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Проверка версии
node --version  # Должно быть v20.x.x или выше
npm --version   # Должно быть 9.x.x или выше
```

### Шаг 2: Установка FFmpeg

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y ffmpeg

# Проверка
ffmpeg -version
ffprobe -version
```

### Шаг 3: Установка LibreOffice (опционально)

```bash
# Ubuntu/Debian
sudo apt-get install -y libreoffice

# Проверка
libreoffice --version
```

### Шаг 4: Клонирование и установка проекта

```bash
# Клонируем репозиторий
git clone https://github.com/ya-k0v/VideoControl.git
cd VideoControl

# Устанавливаем зависимости
npm install

# Проверяем окружение
bash scripts/check-environment.sh
```

### Шаг 5: Создание директорий данных

```bash
# Создаем необходимые директории
mkdir -p config data/content data/streams data/converted data/logs data/temp

# Устанавливаем права доступа
chmod -R 755 data config
```

### Шаг 6: Инициализация базы данных

База данных создастся автоматически при первом запуске, но можно инициализировать вручную:

```bash
# Создаем основную БД
sqlite3 config/main.db < src/database/init.sql

# Создаем Hero БД (если используется Hero модуль)
mkdir -p config/hero
sqlite3 config/hero/heroes.db < src/hero/database/schema.sql
```

### Шаг 7: Запуск сервера

```bash
# Запуск в режиме разработки
npm start

# Или через systemd (production)
sudo cp videocontrol.service /etc/systemd/system/
sudo systemctl enable videocontrol
sudo systemctl start videocontrol
```

## ✅ Проверка установки

### Автоматическая проверка

```bash
# Запускаем скрипт проверки окружения
bash scripts/check-environment.sh
```

Скрипт проверит:
- ✅ Версию Node.js и npm
- ✅ Наличие FFmpeg и FFprobe
- ✅ Установленные npm пакеты
- ✅ Структуру директорий
- ✅ Права доступа
- ✅ Доступность портов

### Ручная проверка

```bash
# Проверяем, что сервер запускается
node server.js

# В другом терминале проверяем health endpoint
curl http://localhost:3000/health
```

Ожидаемый ответ:
```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "uptime": 5,
  "memory": {...},
  "database": "connected"
}
```

## 🔧 Настройка для production

### Быстрая установка (рекомендуется)

```bash
# Интерактивная установка с Nginx и systemd
sudo bash scripts/quick-install.sh
```

### Ручная настройка

1. **Настройка Nginx** (см. `nginx/videocontrol.conf`)
2. **Настройка systemd** (см. `videocontrol.service`)
3. **Настройка файрвола** (открыть порт 80/443)

## 🧹 Очистка проекта

После установки можно очистить временные файлы:

```bash
# Базовая очистка
bash scripts/cleanup.sh

# Агрессивная очистка (включая старые логи)
bash scripts/cleanup.sh --aggressive
```

## 🐛 Решение проблем

### Проблема: Node.js не найден

```bash
# Проверяем установку
which node
node --version

# Если не установлен, устанавливаем заново
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Проблема: FFmpeg не найден

```bash
# Устанавливаем FFmpeg
sudo apt-get update
sudo apt-get install -y ffmpeg

# Проверяем
ffmpeg -version
```

### Проблема: npm install завершается с ошибкой

```bash
# Очищаем кэш npm
npm cache clean --force

# Удаляем node_modules и package-lock.json
rm -rf node_modules package-lock.json

# Устанавливаем заново
npm install
```

### Проблема: Нет прав на создание директорий

```bash
# Проверяем текущего пользователя
whoami

# Создаем директории с правильными правами
mkdir -p config data/content data/streams data/converted data/logs data/temp
chmod -R 755 data config

# Если нужно, меняем владельца
sudo chown -R $USER:$USER data config
```

### Проблема: Порт 3000 занят

```bash
# Проверяем, что использует порт
sudo netstat -tuln | grep 3000
# или
sudo ss -tuln | grep 3000

# Меняем порт через переменную окружения
export PORT=3001
npm start
```

## 📚 Дополнительная документация

- `README.md` - Общее описание проекта
- `QUICK-START.md` - Быстрый старт
- `docs/MANUAL.md` - Руководство по эксплуатации
- `public/ADMIN_PANEL_README.md` - Документация админ-панели

## 🔐 Безопасность

После установки:

1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте файрвол** (закройте порт 3000, используйте только Nginx)
3. **Настройте SSL/TLS** (через Nginx)
4. **Регулярно обновляйте зависимости**: `npm audit` и `npm update`

## 📞 Поддержка

Если возникли проблемы:
1. Проверьте логи: `tail -f data/logs/combined-*.log`
2. Запустите проверку окружения: `bash scripts/check-environment.sh`
3. Проверьте документацию в `docs/`

---

**Версия:** 3.0.0  
**Последнее обновление:** 2025-11-28

