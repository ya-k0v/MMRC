# 📺 MMRC 3.1.1

**Система управления медиаконтентом для цифровых дисплеев**

![Version](https://img.shields.io/badge/version-3.1.1-blue)
![Node](https://img.shields.io/badge/node-20.x-green)
![License](https://img.shields.io/badge/license-Personal_Use_Only-red)

---

## 🚀 Быстрый старт

### Установка одной командой

```bash
# Production установка с Nginx и systemd
sudo bash dev/scripts/quick-install.sh
```

### Ручная установка

```bash
# 1. Установите зависимости
npm install

# 1.1 Включите git-hooks (post-merge миграции)
npm run setup-hooks

# 2. Создайте конфигурацию .env
cp .env.example .env
nano .env  # Настройте переменные окружения

# 3. Создайте структуру директорий
mkdir -p config config/hero data/{content,streams,converted,logs,temp}

# 3.1 Инициализируйте/обновите схему БД
npm run migrate-db

# 4. Запустите сервер
node server.js
```

**По умолчанию:**
- Сервер: `http://localhost:3000`
- Админ: `admin / admin123` (⚠️ **ОБЯЗАТЕЛЬНО СМЕНИТЬ** после первого входа!)

---

## 📚 Документация

Вся документация для администраторов, разработчиков и инструкции по установке находятся в папке [`dev/`](dev/):

- [`dev/README.md`](dev/README.md) — полное описание проекта, архитектура и возможности
- [`dev/INSTALL.md`](dev/INSTALL.md) — подробная инструкция по установке на новую ОС
- [`dev/QUICK-START.md`](dev/QUICK-START.md) — быстрый старт и настройка
- [`dev/DEPLOYMENT.md`](dev/DEPLOYMENT.md) — развертывание в продакшене
- [`dev/MANUAL.md`](dev/MANUAL.md) — эксплуатация, мониторинг, бэкапы
- [`dev/ANDROID_README.md`](dev/ANDROID_README.md) — Android клиент и ADB инструкции
- И другие документы в папке `dev/`

---

## 🎯 Основные возможности

- ✅ **SQLite** — быстрая БД с WAL mode
- ✅ **JWT Auth** — безопасная аутентификация
- ✅ **MD5 Deduplication** — экономия места на диске
- ✅ **FFmpeg** — автооптимизация видео и HLS стриминг
- ✅ **PDF/PPTX → изображения** — автоконвертация
- ✅ **Graceful Shutdown** — корректное завершение
- ✅ **Winston Logging** — структурированные логи
- ✅ **Rate Limiting** — защита от brute-force
- ✅ **Health Check** — мониторинг состояния

---

## 🔧 Требования

- **Node.js** 20.x+
- **FFmpeg** + **FFprobe**
- **LibreOffice** (для PDF/PPTX)
- **SQLite3**

---

## 🔐 Безопасность

После установки:
1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте JWT_SECRET** в `.env` файле
3. **Настройте файрвол** (используйте только Nginx)
4. **Настройте SSL/TLS** (через Nginx)

---

## 📱 Клиенты

- **Android TV / Media Player** — APK в корне проекта
- **MPV Player (Linux)** — нативный медиаплеер
- **Browser** — веб-плеер через Video.js

---

## 📄 Лицензия

Используется кастомная лицензия: только личное (персональное) использование физическими лицами.

- Использование юридическими лицами, ИП, госорганизациями и любыми организациями запрещено без письменного разрешения правообладателя.
- Полный текст: [LICENSE](LICENSE)

---

## 👤 Автор

**ya-k0v** - [GitHub](https://github.com/ya-k0v/MMRC)

**Версия:** 3.1.1

