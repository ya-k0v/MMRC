# Roadmap исправлений по итогам ревью (ветка `v340`)

Все изменения только локально: `git push` не выполняется. После каждого этапа — тесты,
проверка конфигов и локальный коммит.

## Приоритеты и этапы

| Этап | Что исправляем | Файлы | Статус |
| --- | --- | --- | --- |
| 1. Выбор версии APK и обновление устройств | Ложный «успех» массового обновления; устаревшая `releaseVersion` после выбора версии; устаревший снимок устройств в карточке питания; строковое сравнение версий; потеря `disabled` после перерисовки списка | `public/js/admin.js`, `public/js/admin/device-power.js`, `tests/unit/admin-device-power.test.js` | в работе |
| 2. UI/available | Поле «Ветка» не рендерится; клавиатурная навигация дерева настроек; CSS-специфичность пунктов меню и чипов на тач-устройствах; счётчик «Активных» сессий | `public/js/admin/settings-panels.js`, `public/js/admin/settings-nav.js`, `public/css/admin.css`, `src/routes/admin.js`, тесты | сделано |
| 3. Целостность S3 | Битый объект остаётся «подтверждённым»: skip-ветка без checksum, нет удаления mismatch-объекта, startup reconcile не сверяет размер | `src/storage/sync.js`, `src/storage/reconcile.js`, тесты | сделано |
| 4. Установка и окружение | Новые `STORAGE_*` не проброшены в `mmrc` базового Compose; `MMRC_MEMORY_LIMIT`/`MMRC_PIDS_LIMIT` игнорируются; install-скрипты хардкодят reconcile-значения и не сохраняют их при reinstall; CI smoke привязан к `:3000`; fallback на `minioadmin` | `docker-compose.yml`, `docker-compose.deploy.yml`, `install.sh`, `install-local.sh`, `scripts/ci-test.sh`, `src/storage/s3.js`, тесты | сделано |
| 5. HA | Периодическая сверка работает на репликах и чистит общий `mmrc-temp`; дубли notification | `server.js`, `src/utils/ha.js`, тесты | сделано |

## Заметки

- Поле «Ветка» пользователь просил сначала не трогать, затем уточнил: «меняй всё» — этап 2 включён.
- Сценарий «выбрал версию → обновил устройство» приоритетный и вынесен в этап 1.
- Push в `origin/v340` запрещён.
