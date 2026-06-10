# 🐳 MMRC Docker Deployment

Полное руководство по запуску MMRC в Docker-контейнерах.

---

## 🚀 Быстрая установка (Production)

Для production-серверов используйте one-command установку:

```bash
sudo curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/main/install.sh | bash
```

Скрипт автоматически:
- Установит Docker (если не установлен)
- Скачает конфигурацию
- Сгенерирует `.env` с безопасным JWT_SECRET
- Запустит все сервисы
- Установит CLI утилиту `mmrc`

### Управление через CLI

```bash
mmrc status       # Статус сервисов
mmrc logs         # Просмотр логов
mmrc update       # Обновление до последней версии
mmrc backup       # Создание бэкапа
mmrc ssl          # Настройка SSL сертификата
```

---

## 🛠️ Разработка (через Makefile)

---

## 📋 Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                        Docker Host                           │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │   Nginx      │   │   mmrc       │   │   mmrc       │    │
│  │   (proxy)    │──▶│   server     │   │ optimizer    │    │
│  │  :80/:443    │   │   :3000      │   │   worker     │    │
│  └──────────────┘   └──────┬───────┘   └──────┬───────┘    │
│                            │                  │             │
│  ┌──────────────┐   ┌──────▼──────────────────▼───────┐    │
│  │   mmrc       │   │         Shared Volumes          │    │
│  │  streamer    │──▶│                                 │    │
│  │  worker      │   │  • mmrc-data   (/data)          │    │
│  └──────────────┘   │  • mmrc-config (/app/config)    │    │
│                     │  • mmrc-temp   (/app/.tmp)      │    │
│                     └─────────────────────────────────┘    │
│                                                             │
│  ┌──────────────┐                                          │
│  │   Network    │   mmrc-network (bridge)                  │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
```

### Компоненты

| Сервис | Описание | Порты |
|--------|----------|-------|
| `mmrc` | Основной сервер (API + Socket.IO + UI) | 3000 |
| `mmrc-optimizer` | Воркер ночной оптимизации видео | - |
| `mmrc-streamer` | Воркер HLS/DASH стриминга | - |

---

## 🚀 Быстрый старт

### 1. Клонирование

```bash
git clone https://github.com/ya-k0v/MMRC.git
cd MMRC
```

### 2. Инициализация

```bash
make init
# или вручную:
cp docker/.env.example .env
# Отредактируйте .env, особенно JWT_SECRET
```

### 3. Запуск

```bash
# Базовый запуск (сервер + воркеры)
make up

# С Nginx proxy
make up-nginx

# Проверить статус
make ps

# Проверить health
make health
```

### 4. Доступ

- Админ-панель: `http://localhost:3000/admin.html`
- Спикер-панель: `http://localhost:3000/speaker.html`
- Hero модуль: `http://localhost:3000/hero/`
- Health check: `http://localhost:3000/health`

---

## 📦 Docker Compose Profiles

| Profile | Описание | Команда |
|---------|----------|---------|
| (default) | Сервер + воркеры | `make up` |
| `nginx` | + Nginx reverse proxy | `make up-nginx` |
| `backup` | Сервис бэкапов | `make backup` |

---

## 🔧 Настройка

### Переменные окружения

**Основные:**
```env
NODE_ENV=production
JWT_SECRET=<обязательно_измените>
LOG_LEVEL=info
```

**Ресурсы:**
```env
# Общие
JOB_RESERVE_CPU_PERCENT=30
JOB_RESERVE_MEMORY_MB=2048

# Оптимизатор
OPTIMIZER_CPU_LIMIT=4.0
OPTIMIZER_MEMORY_LIMIT=8G

# Стрим-воркер
STREAMER_CPU_LIMIT=2.0
STREAMER_MEMORY_LIMIT=4G
```

**LDAP (опционально):**
```env
LDAP_URL=ldap://ad-server:389
LDAP_BIND_DN=CN=svc-mmrc,OU=Services,DC=example,DC=com
LDAP_SEARCH_BASE=OU=Users,DC=example,DC=com
```

---

## 📊 Мониторинг

### Логи

```bash
# Все логи
make logs

# Только сервер
make logs-server

# Оптимизатор
make logs-optimizer

# Стрим-воркер
make logs-streamer
```

### Health Check

```bash
make health
# или
curl http://localhost:3000/health
```

### Shell доступ

```bash
make shell-server
make shell-optimizer
make shell-streamer
```

---

## 💾 Бэкапы

### Создание бэкапа

```bash
make backup
```

Бэкапы сохраняются в `docker/backups/`.

### Восстановление

```bash
make restore BACKUP=main-2024-01-01_1200.db
```

### Ручной бэкап

```bash
# Бэкап через sqlite3
docker compose exec mmrc sqlite3 /app/config/main.db ".backup /data/main-backup.db"

# Копирование на хост
docker cp mmrc-config:/app/config/main.db ./main.db.backup
```

---

## 🔄 Обновление

```bash
# Остановить сервисы
make down

# Обновить код
git pull origin main

# Пересобрать образы
make build

# Запустить
make up

# Применить миграции
make migrate
```

---

## 🔐 SSL/TLS (Nginx)

### 1. Получить сертификаты

```bash
# Используя Let's Encrypt
sudo certbot certonly --standalone -d your-domain.com
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem docker/nginx/ssl/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem docker/nginx/ssl/
```

### 2. Включить HTTPS в nginx.conf

Раскомментируйте HTTPS server block в `docker/nginx/nginx.conf`.

### 3. Перезапустить

```bash
make up-nginx
```

---

## 🗑️ Очистка

```bash
# Остановить сервисы
make down

# Удалить всё (контейнеры, volumes, images)
make clean

# Только удалить volumes (ВНИМАНИЕ: удалит все данные!)
make clean-data
```

---

## 🐛 Решение проблем

### Сервер не запускается

```bash
# Проверить логи
make logs-server

# Проверить права на volumes
docker volume inspect mmrc_mmrc-data
```

### Проблемы с FFmpeg

```bash
# Проверить FFmpeg в контейнере
docker compose exec mmrc ffmpeg -version
```

### Проблемы с производительностью

```bash
# Проверить ресурсы контейнеров
docker stats

# Увеличить лимиты в .env
OPTIMIZER_CPU_LIMIT=8.0
OPTIMIZER_MEMORY_LIMIT=16G
```

### Нет места на диске

```bash
# Очистить неиспользуемые Docker объекты
docker system prune -a --volumes

# Очистить кэш трейлеров
docker compose exec mmrc find /data/cache/trailers -type f -mtime +7 -delete
```

---

## 📁 Структура volumes

```
mmrc-data:/data
├── content/           # Медиафайлы устройств
│   ├── DEVICE001/
│   └── DEVICE002/
├── streams/           # HLS/DASH стримы
├── cache/
│   ├── trailers/      # Кэш трейлеров
│   └── converted/     # PDF/PPTX → изображения
└── logs/              # Логи приложения

mmrc-config:/app/config
├── main.db            # Основная БД
├── app-settings.json  # Настройки
├── video-optimization.json
└── hero/
    └── heroes.db      # БД героев
```

---

## 🔗 Интеграция с CI/CD

### GitHub Actions

При мерже PR в `main` автоматически запускается workflow `.github/workflows/docker-build.yml`:

1. Собирается multi-platform образ (amd64 + arm64)
2. Пушится в Docker Hub как `ya-k0v/mmrc:latest`
3. Отправляется уведомление в Discord (если настроен webhook)

### Ручной запуск

```bash
gh workflow run docker-build.yml
```

### Обновление на сервере

После получения уведомления об обновлении:

```bash
mmrc update
```

Или вручную:

```bash
cd /opt/mmrc
docker compose pull
docker compose up -d
```

---

## 📞 Поддержка

- GitHub: https://github.com/ya-k0v/MMRC
- Issues: https://github.com/ya-k0v/MMRC/issues
