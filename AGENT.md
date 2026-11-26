# AGENT.md — rules for AI agents / правила для AI-агентов

Applies to every agent working in this repository. The Russian section is the
original wording of the project rules and wins if the two differ.

Обязательно для всех агентов, работающих с репозиторием. Русская версия —
исходная формулировка правил проекта; при расхождении она приоритетна.

---

## English

### 1. Version control

- **Never push.** All commits stay local; `origin/v340` must remain untouched.
- No force push, reset, rebase or any other rewrite of shared refs.
- Run `git status` before editing. Treat unfamiliar or uncommitted files as the
  user's work: investigate, never overwrite or delete silently. Ask before
  destructive operations.
- Commit locally after a change is tested; use a short imperative message.
  Never publish it.
- Never commit secrets, local `.env`, databases or generated runtime data;
  document new configuration in `.env.example` instead.
- When behaviour or UI modules change, update the relevant README/dev docs and
  keep links valid — some docs already reference missing files.

### 2. Compatibility is mandatory

Supported installation variants: Docker/Compose **and** local process; SQLite
**and** PostgreSQL; local disk **and** S3/MinIO; HA primary **and** replica.

- Before changing env/config, read `install.sh`, `install-local.sh` and
  `.env.example`. Keep all three consistent; a variable introduced in one
  installer must be preserved on reinstall in the other.
- Never hard-code paths, ports, credentials or container names in code. Use
  the existing config/env (`PORT`, `MMRC_*`, `STORAGE_*`, `S3_*`, `DB_*`).
- Do not add solutions that work on only one backend. Any behaviour that
  differs between SQLite/PostgreSQL or local/S3 must be handled explicitly and
  covered by tests for both.
- Do not assume live PostgreSQL, MinIO, ADB or a browser are available. If they
  were not exercised, say so explicitly instead of claiming compatibility.

### 3. Verification checklist

Run before committing:

- `npm test` (unit tests + CI smoke);
- `node --check` on every changed `.js`;
- `git diff --check`;
- `bash -n install.sh install-local.sh scripts/ci-test.sh`;
- `docker compose config` for sqlite/local, sqlite/s3, postgres/local,
  postgres/s3, plus the deploy and HA configurations;
- smoke check with a non-default `PORT` when touching startup or health checks.

Note: `scripts/` is listed in `.gitignore`, but some files there are tracked —
do not delete it as "generated junk".

### 4. Local iteration

- For a quick check, `docker cp` changed files into the already running
  container (in this workspace: `mmrc`) instead of rebuilding the image; then
  hard-reload the admin page with `Ctrl+F5`.
- For a full check, build locally, e.g.
  `docker build --build-arg INCLUDE_DOCKER_CLI=true -t pingwin1900/mmrc:v340 .`
  Never push the resulting image.
- After commits, remember that a previously built image is stale — rebuild or
  `docker cp` again if the change must be visible in the container.

### 5. Domain rules

- User priority: "choose an APK version, then update the device". Installing
  sends player config; updating/refreshing does not. Compare versions as
  numbers with prereleases, never as strings. Batch actions must surface HTTP
  errors instead of reporting a fake success.
- Storage is S3-primary. Reconcile reports never mutate data; `unknown` never
  justifies deletion or a commit. `cleanupMissingFiles()` is `dryRun: true` by
  default. HLS remains a local working cache. Trailers are written to
  `temp/scratch` and committed under a logical `converted/trailers/<md5>.mp4`
  key. Admin downloads use a short-lived scoped ticket — no Bearer token in
  the URL.
- HA replicas (`MMRC_HA_MODE=true`) must not run startup/periodic reconcile,
  scratch cleanup or duplicate notifications: only the primary does.
- Bulk UI actions must be a single backend request — never one HTTP call per
  item: nginx allows ~20 immediate requests and then 10/s, so a fan-out of 100
  acknowledge calls returns 429. Paginate long lists server-side instead of
  shipping all rows. On 429, do not generate another notification/report: that
  is a feedback loop. Keep already visible data on a failed poll.
- Mount shared rate limiters once per prefix, not on every router: two
  `adminLimiter` mounts doubled every admin request. Repeating read-only polls
  (logs) must skip the strict admin/speed limiters.
- A change made on the server (e.g. selected APK version) must be broadcast to
  all admin tabs. Recompute dependent UI (update targets, filters, badges)
  from one shared state on every path: local action, socket event, fresh device
  snapshot. Never require a UI reload to see the consequence of a selection.
- Do not offer an update for a device whose installed version is unknown or
  unparseable: only a known older version qualifies as outdated.
- Settings tree: navigation lives in its own module, cards stay in the DOM and
  are hidden, `system` is the default panel; Database/LDAP entries are added
  only when applicable. Summary chips are filters driven by one shared
  predicate/count function.
- Communicate in Russian unless the user asks otherwise.

### 6. UI and design

- **No emoji** in UI text, labels or code. Use only SVG icons from
  `public/js/shared/svg-icons.js` (`get<Name>Icon(size, color)`, default
  `currentColor`). Reuse an existing icon before adding a new one; a new icon
  must follow the same 24×24 `viewBox`, `stroke`/`fill` with `currentColor` and
  inline alignment. No icon fonts or pasted pictographs.
- Use existing design tokens from `public/css/app.css` (`:root`, `body.light`,
  `body.maintenance-ui`, `body.maintenance-ui.light`): colors, `--space-*`,
  radii, typography, motion. Prefer classes to inline styles; never add literal
  hex/rgba colors or arbitrary spacing when a token exists. A genuinely new
  color must be added as a token to **both** light and dark palettes.
- Verify every UI change in **dark and light** themes on all affected surfaces:
  admin, speaker, analytics, plus overlays, toasts, previews and the collapsed
  sidebar. Hero and maintenance pages are dark-only and duplicate tokens in
  `hero.css`; editing `app.css` does not affect them.
- Three theme mechanisms coexist: canonical `body.light`, the `maintenance-ui`
  palette layer and `html[data-theme]` (analytics charts only). Do not "fix"
  one blindly. Sidebar theme buttons are rebuilt on re-render — re-run
  `initThemeToggle()` after sidebar `innerHTML` changes.
- Scope CSS to the page (`body.admin-page …`, existing `st-*`/`pc-*` prefixes)
  so it does not leak into speaker/analytics. Respect existing breakpoints and
  `@media (pointer: coarse)` touch targets (≈40–44 px). Do not add `!important`
  to win specificity — fix the selector or stylesheet order instead.
- Accessibility: icon-only controls need `aria-label`/`title`, decorative SVG
  gets `aria-hidden="true"`. Preserve keyboard navigation, visible focus and
  `prefers-reduced-motion`. Icons are raw SVG injected via `innerHTML`, so
  always escape adjacent user data with `escapeHtml()`.
- Cover pure markup/logic with unit tests where possible; otherwise say
  explicitly that visual/browser verification was not performed.

### 7. Report after every change

End the reply with exactly three items:

1. **Что поменял** — files and concrete edits.
2. **Что это делает** — resulting behaviour/effect.
3. **Зачем** — task or problem being solved.

Add an explicit compatibility statement: which installation variants were
verified and which were not. If nothing was changed, say "Изменений не вносил".

---

## Русский

### 1. Работа с Git

- **Никогда не делайте push.** Все коммиты только локальные, `origin/v340` не
  трогаем.
- Запрещены force push, reset, rebase и любое переписывание общих refs.
- Перед правками смотрите `git status`. Незнакомые и незакоммиченные файлы —
  работа пользователя: сначала разобраться, не перезаписывать и не удалять
  молча. Перед разрушительными действиями спрашивать.
- После проверки изменений сделать локальный коммит с коротким сообщением.
  Публиковать его нельзя.
- Не коммитить секреты, локальный `.env`, базы данных и сгенерированные данные;
  новые настройки описывать в `.env.example`.
- При изменении поведения или UI-модулей обновлять соответствующие README/dev-доки
  и следить за валидностью ссылок — часть доков уже ссылается на несуществующие файлы.

### 2. Совместимость обязательна

Поддерживаемые варианты установки: Docker/Compose **и** локальный запуск;
SQLite **и** PostgreSQL; локальный диск **и** S3/MinIO; primary **и** replica в HA.

- Перед изменением env/конфигов читать `install.sh`, `install-local.sh` и
  `.env.example`, держать их согласованными: новая переменная должна
  сохраняться при reinstall в обоих установщиках.
- Не хардкодить пути, порты, учётные данные и имена контейнеров. Использовать
  существующий конфиг/окружение (`PORT`, `MMRC_*`, `STORAGE_*`, `S3_*`, `DB_*`).
- Не добавлять решения, работающие только на одном бэкенде. Различия между
  SQLite/PostgreSQL и local/S3 обрабатывать явно и покрывать тестами для обоих.
- Не предполагать, что живые PostgreSQL, MinIO, ADB и браузер доступны. Если
  проверка не проводилась — прямо сказать об этом, а не заявлять о совместимости.

### 3. Чек-лист проверки

Перед коммитом:

- `npm test` (юнит-тесты + CI smoke);
- `node --check` для каждого изменённого `.js`;
- `git diff --check`;
- `bash -n install.sh install-local.sh scripts/ci-test.sh`;
- `docker compose config` для sqlite/local, sqlite/s3, postgres/local,
  postgres/s3, а также deploy и HA;
- smoke с нестандартным `PORT`, если трогались старт или health-check.

Важно: `scripts/` есть в `.gitignore`, но часть файлов там отслеживается Git —
не удалять каталог как «мусор».

### 4. Локальная итерация

- Для быстрой проверки `docker cp` изменённых файлов в уже запущенный контейнер
  (в этом рабочем месте — `mmrc`) вместо пересборки образа; затем жёсткий
  reload админки `Ctrl+F5`.
- Для полной проверки собрать образ локально, например
  `docker build --build-arg INCLUDE_DOCKER_CLI=true -t pingwin1900/mmrc:v340 .`
  Образ не публиковать.
- После новых коммитов ранее собранный образ устарел — чтобы увидеть изменения
  в контейнере, пересоберите его или снова сделайте `docker cp`.

### 5. Правила по проекту

- Приоритетный сценарий: «выбрал версию APK → обновил устройство». Установка
  отправляет конфиг плеера, обновление/перезапуск — нет. Версии сравниваются
  по частям с учётом пререлизов, не как строки. Массовые действия обязаны
  показывать HTTP-ошибки, а не ложный «успех».
- Хранилище — S3-primary. Отчёты сверки ничего не меняют; `unknown` никогда не
  оправдывает удаление или коммит. `cleanupMissingFiles()` по умолчанию
  `dryRun: true`. HLS — локальный рабочий кэш. Трейлеры пишутся в
  `temp/scratch` и коммитятся под логическим ключом
  `converted/trailers/<md5>.mp4`. Скачивание в админке — через короткоживущий
  scoped-тикет, без Bearer-токена в URL.
- HA-реплики (`MMRC_HA_MODE=true`) не запускают стартовую/периодическую сверку,
  чистку scratch и дубли уведомлений — это делает только primary.
- Массовые действия в UI делаются **одним** запросом, а не по запросу на каждый
  элемент: nginx пропускает ~20 запросов сразу и затем 10/с, поэтому 100
  acknowledge-запросов дают 429. Длинные списки режутся на страницы на сервере.
  На 429 не создавайте новое уведомление/отчёт — это петля усиления ошибки;
  при неудачном опросе сохраняйте уже показанные данные.
- Общий rate limiter монтируется один раз на префикс, а не на каждый router:
  два `adminLimiter` удваивали каждый admin-запрос. Частые read-only опросы
  (логи) должны быть исключены из строгих admin/speed лимитеров.
- Изменение на сервере (например, выбранная версия APK) рассылается всем
  вкладкам админки. Зависимый UI (цели обновления, фильтры, бейджи) пересчитывается
  из одного общего состояния на всех путях: локальное действие, socket-событие,
  свежий снимок устройств. Перезагрузка UI не должна быть нужна, чтобы увидеть
  последствия выбора.
- Не предлагать обновление устройству с неизвестной или неразбираемой версией
  плеера: устаревшей считается только достоверно более старая версия.
- Дерево настроек: навигация в отдельном модуле, карточки остаются в DOM и
  скрываются, по умолчанию «Система»; пункты БД и LDAP добавляются только когда
  применимо. Чипы сводки — фильтры с общим источником правды.
- Общаться на русском, если пользователь не попросил иначе.

### 6. UI и дизайн

- **Никаких emoji** в тексте интерфейса, подписях и коде. Только SVG-иконки из
  `public/js/shared/svg-icons.js` (`get<Name>Icon(size, color)`, по умолчанию
  `currentColor`). Сначала искать существующую иконку; новая должна повторять
  стиль модуля: `viewBox="0 0 24 24"`, `stroke`/`fill` с `currentColor`,
  встроенное выравнивание. Никаких шрифтов иконок и вставленных пиктограмм.
- Использовать существующие токены из `public/css/app.css` (`:root`,
  `body.light`, `body.maintenance-ui`, `body.maintenance-ui.light`): цвета,
  `--space-*`, радиусы, типографика, анимация. Предпочитать классы инлайн-
  стилям; не добавлять литеральные hex/rgba и произвольные отступы, если есть
  токен. Действительно новый цвет заводится токеном **в обеих** темах.
- Проверять каждое изменение UI в **тёмной и светлой** темах на всех затронутых
  поверхностях: админка, спикер, аналитика, оверлеи, тосты, превью и свёрнутый
  сайдбар. Hero и maintenance-страницы — только тёмные и дублируют токены в
  `hero.css`; правка `app.css` на них не влияет.
- Сосуществуют три механизма темы: канонический `body.light`, слой
  `maintenance-ui` и `html[data-theme]` (только графики аналитики). Не «чинить»
  один вслепую. Кнопки темы в сайдбаре пересоздаются при ререндере — после
  изменения `innerHTML` сайдбара снова вызывать `initThemeToggle()`.
- Ограничивать CSS страницей (`body.admin-page …`, префиксы `st-*`/`pc-*`), чтобы
  стили не протекали в спикер/аналитику. Соблюдать существующие брейкпоинты и
  `@media (pointer: coarse)` (тач-цели ≈40–44 px). Не добавлять `!important`
  ради победы в специфичности — исправлять селектор или порядок стилей.
- Доступность: иконочные кнопки получают `aria-label`/`title`, декоративный SVG —
  `aria-hidden="true"`. Сохранять навигацию с клавиатуры, видимый фокус и
  `prefers-reduced-motion`. Иконки — сырой SVG через `innerHTML`, поэтому
  соседние пользовательские данные всегда экранировать `escapeHtml()`.
- Чистую разметку/логику покрывать юнит-тестами; если это невозможно, прямо
  говорить, что визуальная проверка в браузере не проводилась.

### 7. Отчёт после любого изменения

В конце ответа обязательно три пункта:

1. **Что поменял** — файлы и конкретные правки.
2. **Что это делает** — эффект/поведение.
3. **Зачем** — задача или проблема, которая решается.

Добавить явную оговорку о совместимости: какие варианты установки проверены,
а какие нет. Если изменений не было, написать «Изменений не вносил».
