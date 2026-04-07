#!/bin/bash
set -e

# 1. Проверка root
if [[ $EUID -ne 0 ]]; then
  echo "Этот скрипт нужно запускать с правами root (sudo)!"
  exit 1
fi

# 2. Установка зависимостей
apt update && apt install -y nodejs npm ffmpeg sqlite3

# 3. Создание пользователя и группы (если не существует)
if ! id "vcuser" &>/dev/null; then
  useradd -r -s /bin/false vcuser
fi
if ! getent group vcgroup &>/dev/null; then
  groupadd vcgroup
fi
usermod -a -G vcgroup vcuser

# 4. Копирование .env.example -> .env, генерация JWT_SECRET
cd /vid/videocontrol
if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  sed -i "s|^JWT_SECRET=.*$|JWT_SECRET=$SECRET|" .env
  echo "JWT_SECRET сгенерирован и добавлен в .env"
fi

# 5. Установка npm-зависимостей
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev || npm install
else
  npm install
fi
npm run setup-hooks --silent || true

# 6. Создание директорий
mkdir -p config config/hero data/content data/streams data/converted data/logs data/temp
chown -R vcuser:vcgroup data config

# 6.1 Инициализация/миграция БД
SKIP_NPM_INSTALL=1 SKIP_SERVICE_RESTART=1 bash ./scripts/post-pull-sync.sh

# 7. Копирование systemd unit
cp videocontrol.service /etc/systemd/system/videocontrol.service
chown root:root /etc/systemd/system/videocontrol.service
chmod 644 /etc/systemd/system/videocontrol.service

# 8. Перезагрузка systemd и запуск сервиса
systemctl daemon-reload
systemctl enable videocontrol.service
systemctl restart videocontrol.service

# 9. Проверка статуса
systemctl status --no-pager videocontrol.service
