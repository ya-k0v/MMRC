# ADB Power: команды электропитания по версиям Android

Справочник команд для стабильной работы Android-панелей и приставок по ADB: сон, пробуждение, запрет
отключения сети и «мягкие» настройки. Список расширяемый — каждая команда для новой прошивки/версии
добавляется отдельной строкой в таблицу (см. «Как пополнять»).

Легенда:
- `да` — команда есть в AOSP/штатной прошивке данной версии;
- `нет` — в стоковой прошивке данной версии отсутствует;
- `vendor` — в AOSP нет, но встречается в прошивках производителей (Lumien и китайские ROM) — проверять на устройстве;
- `*` — есть не во всех прошивках/ветках, проверять `cmd <сервис> help`.

## Сон и гашение дисплея

| Команда | Android 10 | 11 | 12 | 13 | 14 | 15 | 16 | Примечание |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `input keyevent 223` (KEYCODE_SLEEP) | да | да | да | да | да | да | да | Глубокий сон системы. Есть с API 20. На приставках может обрушить сеть. |
| `input keyevent 276` (KEYCODE_SOFT_SLEEP) | да | да | да | да | да | да | да | Мягкий suspend (API 20+): экран гаснет, сеть обычно остаётся. Поддержан не везде. |
| `input keyevent 26` (KEYCODE_POWER) | да | да | да | да | да | да | да | Опасно: на ТВ-приставках гасит Wi-Fi насовсем (см. риски). Избегать. |
| `cmd power sleep [--disable-wakelocks]` | нет | нет | нет | нет | нет | нет | да* | PowerManagerShellCommand. Сама подкоманда появилась в **Android 16**; флаг `--disable-wakelocks` — только свежие сборки 16+. Проверять `cmd power help`. |
| `cmd power set-screen-state off` | vendor | vendor | vendor | vendor | vendor | vendor | vendor | **В AOSP нет ни в одной версии** (в PowerManagerShellCommand такой команды не существует). Работает только на прошивках, где добавлена — проверять `cmd power help`. |
| `cmd display power-off 0` | нет | нет | нет | нет | нет | да | да | DisplayManagerShellCommand. Появилась в **Android 15**. id дисплея обычно `0`. |
| `settings put system screen_brightness 0` | да | да | да | да | да | да | да | Мягкое гашение: подсветка в 0, система и сеть живут. Обратно — `... 200`. |
| `svc power stayon false` | да | да | да | да | да | да | да | Снять удержание экрана перед сном (приставки). |
| `settings put system screen_off_timeout 1000` | да | да | да | да | да | да | да | Таймаут гашения 1 с: экран гаснет сам, система остаётся живой. |

## Удержание экрана бодрствующим (скринсейвер и таймаут)

Скринсейвер (Daydream/Ambient Mode) и таймаут экрана — **отдельные** от сна подсистемы: панель гаснет по
неактивности даже при включённом экране. Значения `settings put secure/settings` **сбрасываются при
перезагрузке**, поэтому их применяют заново после каждого пробуждения (в конструкторе — список «Удержание
после пробуждения»). На Android 11+ TV есть «невнимательный сон» (inattentive sleep, `ATTENTIVE_TIMEOUT`).

| Команда | Android 10 | 11 | 12 | 13 | 14 | 15 | 16 | Примечание |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `svc power stayon true` | да | да | да | да | да | да | да | Запретить таймаут экрана на питании (AC). Для всех источников — `settings put global stay_on_while_plugged_in 7`. |
| `settings put secure screensaver_enabled 0` | да | да | да | да | да | да | да | Выключить скринсейвер/Ambient Mode. Сбрасывается перезагрузкой. |
| `settings put secure screensaver_activate_on_sleep 0` | да | да | да | да | да | да | да | Не включать скринсейвер при засыпании. |
| `settings put secure screensaver_activate_on_dock 0` | да | да | да | да | да | да | да | Не включать скринсейвер на док-станции/зарядке. |
| `settings put secure attentive_timeout 2147483647` | нет | да | да | да | да | да | да | Android 11+ TV: отключить «невнимательный сон» (неактивность не гасит экран). |
| `settings put secure amazon_ambient_enabled 0` | * | * | * | * | * | * | * | Fire OS 8: отдельный Ambient Experience скринсейвер. |
| `wm dismiss-keyguard` | да | да | да | да | да | да | да | Снять экран блокировки после пробуждения, чтобы был виден плеер. |

## Пробуждение

| Команда | Android 10 | 11 | 12 | 13 | 14 | 15 | 16 | Примечание |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `input keyevent 224` (KEYCODE_WAKEUP) | да | да | да | да | да | да | да | Основная мягкая команда пробуждения (API 20+). |
| `input keyevent 82` (KEYCODE_MENU) | да | да | да | да | да | да | да | Запасная «мягкая» клавиша пробуждения без toggle. |
| `input keyevent 170` (KEYCODE_TV) | да | да | да | да | да | да | да | Кнопка перехода на ТВ-вход: на многих панелях будит экран, не гасит сеть. |
| `input keyevent 177` (KEYCODE_TV_POWER) | да | да | да | да | да | да | да | Питание ТВ-панели по CEC. Не то же, что 170 (это KEYCODE_TV). |
| `input keyevent 179` (KEYCODE_STB_POWER) | да | да | да | да | да | да | да | Питание приставки (Set-Top Box) по CEC. |
| `input keyevent 181` (KEYCODE_AVR_POWER) | да | да | да | да | да | да | да | Питание AVR/ресивера по CEC. |
| `input keyevent 26` (KEYCODE_POWER) | да | да | да | да | да | да | да | Toggle: если экран уже светился — снова усыпит. Только последней ступенью. |
| `cmd power wakeup` | нет | нет | нет | нет | нет | нет | да* | PowerManagerShellCommand, добавлена в **Android 16**. Проверять `cmd power help`. |
| `cmd power set-screen-state on` | vendor | vendor | vendor | vendor | vendor | vendor | vendor | В AOSP нет, только если есть в прошивке. |
| `cmd display power-on 0` | нет | нет | нет | нет | нет | да | нет | Android 15. В Android 16 команда заменена на `power-reset`. |
| `cmd display power-reset 0` | нет | нет | нет | нет | нет | нет | да | Android 16: сбрасывает переопределённое состояние дисплея (заменил `power-on`). |
| снять stay-on: `svc power stayon false` | да | да | да | да | да | да | да | Без этого часть прошивок не гасит экран по таймауту. |

## Гашение/включение HDMI-выхода без сна

Сценарий: панель должна уйти в standby (на входе «нет сигнала»), а бокс остаётся в сети и плеер жив.
Это **не сон**: `input keyevent 223/26` усыпляет систему и роняет сеть (у iconBIT — насовсем). Нужно
именно выключить видеовыход. Штатной shell-команды до Android 15 нет, поэтому каналы по убыванию
универсальности (все — проверять на конкретной прошивке):

| Команда | Когда доступна | Примечание |
| --- | --- | --- |
| `cmd display power-off <id>` / `cmd display power-on <id>` | Android 15+ | DisplayManagerShellCommand гасит/включает логический дисплей (`id` обычно `0`). Проверять `cmd display help`; на Android 16 — `cmd display power-reset <id>`. |
| `service call SurfaceFlinger <N> i32 <mode>` | зависит от сборки | смена power mode дисплея (0=OFF, 1=DOZE, 2=NORMAL). Номер транзакции `N` различается по версиям — искать в `ISurfaceComposer` конкретной прошивки, «наугад» опасно. |
| Allwinner: `/sys/class/disp/disp/attr/*`, `/sys/class/hdmi/hdmi/attr/*` | vendor, root | sunxi disp2/hdmi: узлы выключают сам выход (HG). Точный узел зависит от SoC/BSP — искать на устройстве (см. ниже). |
| `/dev/disp` ioctl `DISP_BLANK` (0x0C) или `DISP_CMD_HDMI_OFF/ON` | Linux sunxi | работает надёжно, но нужен свой бинарь (ioctl) — чистым shell не вызвать. |

Важно: `settings put system screen_brightness 0` / `screen_off_timeout` и `svc power stayon false` —
это гашение подсветки/таймаута; HDMI-сигнал при этом **идёт** (ТВ видит «чёрный экран», а не «нет
сигнала»). Для standby панели нужен именно сброс видеовыхода.

Разведка узлов на конкретной приставке (ADB, root):
```bash
adb -s <IP>:5555 shell 'cmd display help'
adb -s <IP>:5555 shell 'ls -l /sys/class/disp/disp/attr /sys/class/hdmi /sys/class/hdmi/hdmi/attr 2>/dev/null'
adb -s <IP>:5555 shell 'ls -l /sys/kernel/debug/dispdbg 2>/dev/null; ls -l /sys/class/graphics'
```

## Сеть не должна отваливаться во сне

| Команда | Android 10 | 11 | 12 | 13 | 14 | 15 | 16 | Примечание |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `svc power stayon true` / `settings put global stay_on_while_plugged_in 7` | да | да | да | да | да | да | да | Битмаска питания: 1=AC, 2=USB, 4=беспроводная, 7=все. На панелях с Fake Standby перед сном снимать (`false`/`0`), иначе экран не погаснет. |
| `svc wifi enable` | да | да | да | да | да | да | да | Вернуть Wi-Fi после сна, если отключился. |
| `settings put global wifi_sleep_policy 2` | да* | * | * | * | * | * | * | «Wi-Fi никогда не спит». С Android 8 (API 26) устарела и во многих прошивках не действует — проверять. Для Ethernet не требуется. |
| `dumpsys deviceidle disable` | да | да | да | да | да | да | да | Отключить Doze целиком без root (сбрасывается перезагрузкой). Есть с Android 6 (API 23). |
| `dumpsys deviceidle whitelist +<package>` | да | да | да | да | да | да | да | Пакет вне Doze; на части прошивок переживает перезагрузку (`-<package>` — убрать). |
| `dumpsys deviceidle unforce` | да | да | да | да | да | да | да | Снять принудительный idle (после тестов Doze). |
| `cmd appops set <package> RUN_ANY_IN_BACKGROUND allow` | нет | да | да | да | да | да | да | Запретить системе фон-лимиты для приложения. Опация есть с Android 9, доступна с Android 11. |
| `am set-standby-bucket <package> active` | да | да | да | да | да | да | да | Вывести пакет из App Standby (есть с Android 6). |

## «Мягкие» настройки стабильности плеера

```bash
# выключить системные окна/уведомления поверх плеера не трогаем; только питание:
adb -s <IP>:5555 shell svc power stayon false          # перед «не спим, гасим дисплей»
adb -s <IP>:5555 shell settings put system screen_off_timeout 1000
adb -s <IP>:5555 shell dumpsys deviceidle whitelist +com.videocontrol.mediaplayer
adb -s <IP>:5555 shell am set-standby-bucket com.videocontrol.mediaplayer active
adb -s <IP>:5555 shell cmd appops set com.videocontrol.mediaplayer RUN_ANY_IN_BACKGROUND allow   # Android 11+
```

## Диагностика состояния

```bash
# какие подкоманды питания реально есть на прошивке (решать `да*`/`vendor`):
adb -s <IP>:5555 shell cmd power help
adb -s <IP>:5555 shell cmd display help
# состояние экрана и удержаний (порядок маркеров важен: mHoldingDisplay первый):
adb -s <IP>:5555 shell dumpsys power | grep -E "mHoldingDisplay|Display Power|mScreenOn|mScreenState|mWakefulness"
# состояние Doze:
adb -s <IP>:5555 shell dumpsys deviceidle get deep
adb -s <IP>:5555 shell dumpsys deviceidle get light
```

## Риски и эмпирика проекта

- Lumien 55" (LS5550SD): «Fake Standby» — экран гаснет, ADB остаётся жив. В `dumpsys power` при этом
  `mWakefulness=Awake`, `Display Power: state=ON`, гаснет только `mHoldingDisplay` — парсер обязан
  смотреть `mHoldingDisplay` раньше остальных маркеров.
- Lumien 32" «Smart AIO TV» (Android 13): `cmd power set-screen-state on/off` — не факт что есть,
  проверять `cmd power help`; фоллбэк `input keyevent 223/224`.
- iconBIT TRS2045: сеть во сне умирает, WoL не работает. Не слать `keyevent 223/26` — только
  «не спим, гасим дисплей» (`svc power stayon false` + `screen_off_timeout 1000` + `set-screen-state off`).
  В штатном приложении DS (обновление 2025-06) есть «отключение/включение HDMI-сигнала при сохранении
  питания плеера» — тот же принцип: гасим видеовыход, не усыпляя сеть. Официального сетевого API у iconBIT
  нет; в MMRC это делается ADB-шагами (гашение дисплея без сна).
- `input keyevent 26` на ТВ-приставках отключает Wi-Fi даже при `svc power stayon true` —
  штатного способа вернуть его без `svc wifi enable` нет (Stack Overflow 69629996).
- `input keyevent 170` — это KEYCODE_TV (переход на ТВ-вход), а НЕ питание ТВ (питание — 177).
  На панелях исторически работал как «разбудить», но имя команды в старых профилях было ошибочным.
- Скринсейвер/Ambient Mode гасит экран отдельно от `screen_off_timeout` и `stay_on`; настройки
  `settings put secure` сбрасываются перезагрузкой — применять после каждого пробуждения.
- WoL: MAC у Ethernet и Wi-Fi разный, WoL надо включать в настройках устройства, а магический пакет
  надёжнее слать на подсетевой broadcast (`192.168.x.255`), а не только на `255.255.255.255`.
- Панель Lumien/Cultraview (MAC `A8:2C:3E:…`, 192.168.0.204): `nmap -p-` показал открытым только
  `5555/tcp` (ADB) — ни Standard-LAN `4664`, ни веб `8081`. Транспорт — только ADB; перед выбором
  `lan:`-шагов проверять `nmap -sS -Pn -p- <IP>` (4664 = Standard, 8081 = Basic web).
- iconBIT (MAC `98:AA:FC:…`, Mekotronics — OEM боксов, 192.168.0.213): открыты `5555/tcp` (ADB) и
  `14035/tcp`. Lumien-портов нет — управление только по ADB (у iconBIT сеть во сне умирает, WoL не помогает).
- Порт `14035` у iconBIT — не пульт, а **неаутентифицированный отладочный сокет внутри вендорского
  звукового HAL**: слушает `audio@2.0-service` (pid), код в `/vendor/lib/hw/sound_trigger.primary.cupid.so`
  (плата `cupid`, Allwinner SUNXI, подпись `ywx@Allwinner`). Строки: `>>>`, `Bad command %s.`,
  `Lost socket, cannot send trigger`, `parse_socket_data done (got null)`, `ZERO Models exist.` — интерфейс
  sound-trigger (keyphrase/события), не управление питанием. Для MMRC iconBIT остаётся на ADB. Сам открытый
  на `0.0.0.0:14035` сокет — потенциальный риск (доступен из LAN без авторизации).

## Вендор-протоколы Lumien (RS232 / LAN)

У панелей Lumien две разные линейки, и они НЕ взаимозаменяемы по сети:

- **Standard (LS5550SD и др.)** — ASCII-протокол, доступный и по RS232 (9600 8N1), и по LAN
  (**TCP/UDP порт 4664**), коды одинаковые. Кадр: `:` + ID («01») + `S`/`G` + тип + 3 ASCII-цифры + `CR`.
  Ответ начинается с `:01r…`.
  - `:01S0000\r` — подсветка off (в «Fake Standby» гасит только её, Android и платы живы);
  - `:01SE0000\r` / `:01SE0001\r` — экран off / on (тип `45`);
  - запрос состояния (`G`): `:01G0000\r` (питание), `:01GE000\r` (экран), `:01GS003\r` (MAC),
    `:01GS004\r` (модель), `:01GS005\r` (версия). Формат ответа — `:01r` + тип + значение.
    Живой запрос к 55" LS5550SD (`192.168.0.200`, 2026-10-13) вернул: `:01rE001` (экран вкл),
    `:01r0001` (подсветка вкл), `:01rS4 LS5550SDUHD-CS1382D-G` (модель), `:01rS5 20230728170958`
    (прошивка/дата). `GS`-ответы переменной длины, оканчиваются `CR`.
  - «Fake Standby» (п.8 системного меню) переназначает «выключение» на гашение подсветки, сохраняя
    доступ по RS232/LAN. Есть настройка авто-выключения при отсутствии сигнала (тип `46`).
- **Basic G2 (LB3235SDG2 и др., Android 13)** — порт **4664 закрыт**. Управление: RS232 (**38400 8N1**,
  `k01sA000` off / `k01sA001` on, HEX `6B 30 31 73 41 30 30 30 0D`) и **веб-интерфейс на порту 8081**
  (`http://IP:8081`, admin/admin). В меню «Управление питанием» есть RS232, **Wake-on-LAN** и авто-включение
  по появлению сигнала. По сети удобнее управлять её ADB-профилем, а не `lan:`-шагами.
- Standard G2: в мануале явно документированы **Wake-on-LAN** и «Signal Detection Wake».

В конструкторе профилей `lan:`-шаги (`lan::01SE0001` и т.п.) шлют команды серии Standard на TCP 4664
(см. `src/utils/lumien-lan.js`); для Basic они не подходят.

## Как пополнять

1. Добавить строку в нужную таблицу: команда + столбцы версий 10/11/12/13/14/15/16 (`да`/`нет`/`vendor`) + примечание.
2. Для неоднозначных версий сначала проверить на реальном устройстве:
   `adb -s <IP>:5555 shell cmd power help` / `cmd display help`.
3. Ключевые коды keyevent: SLEEP=223, WAKEUP=224, SOFT_SLEEP=276, POWER=26, MENU=82, TV=170,
   TV_POWER=177, STB_POWER=179, AVR_POWER=181 (сверено с AOSP `KeyEvent.java`).
4. Колонки версий сверять с исходниками AOSP по тегам `android-N.0.0_r1` (см. «Источники»): состав подкоманд
   `cmd power` / `cmd display` меняется от версии к версии и не совпадает с тем, что пишут в блогах.

## Источники

- AOSP `PowerManagerShellCommand.java` — подкоманды `cmd power`: теги `android-11.0.0_r1`…`android-16.0.0_r1`
  (`sleep`/`wakeup` отсутствуют до Android 16; `set-screen-state` не существует ни в одной версии).
- AOSP `DisplayManagerShellCommand.java` — `power-off`/`power-on` с Android 15, `power-reset` с Android 16
  (коммит a8458cd «Shell cmd power-reset instead of power-on», Bug 292300981).
- AOSP `KeyEvent.java` — `KEYCODE_SLEEP=223`, `KEYCODE_WAKEUP=224` (API 20, Bug 12938999);
  `KEYCODE_SOFT_SLEEP=276`, `KEYCODE_TV=170`, `KEYCODE_TV_POWER=177`, `KEYCODE_STB_POWER=179`,
  `KEYCODE_AVR_POWER=181` (сверено с тегом `android-13.0.0_r1`).
- developer.android.com — Ambient Mode (Android TV) и `FLAG_KEEP_SCREEN_ON`: скринсейвер гасит экран
  отдельно от таймаута; отключается `settings put secure screensaver_enabled 0`.
- source.android.com — TV standby / inattentive sleep (`ATTENTIVE_TIMEOUT`), `stay_on_while_plugged_in`
  битмаска 1=AC/2=USB/4=беспроводная/7=все.
- tech.rebounder.jp, Buzzblender docs, Snoozy (`screensaver_*`, `amazon_ambient_enabled`) — практика
  отключения скринсейвера и сброса настроек при перезагрузке.
- deepwiki warrenrees/ha_vidaatv, companion-module-android-tv#29 — WoL: подсетевой broadcast,
  разные MAC Ethernet/Wi-Fi, включение WoL на устройстве, не смешивать WoL и power-key.
- AOSP `DeviceIdleController.java` — команды `dumpsys deviceidle` с Android 6 (API 23): disable/enable/whitelist/unforce.
- e/OS commits: «Add adb command to put certain power groups to sleep», «Wake up adb command for powermanager».
- developer.android.com — Doze/App Standby: `dumpsys deviceidle force-idle / unforce / battery reset`.
- developer.android.com — `Settings.Global.WIFI_SLEEP_POLICY` устарела с API 26.
- Stack Overflow 69629996 — `keyevent 26` гасит Wi-Fi на Android TV, штатного обхода нет.
- Stack Overflow 40204605 — `dumpsys deviceidle disable / whitelist +pkg`.
- gist «Android Shell Commands» — `svc wifi enable`, `dumpsys deviceidle unforce`.
- Lumien.ru: «Параметры для управления панелью по RS232 и LAN» (xlsx, серия Standard) — кадр `:01S/G…CR`,
  порт LAN 4664; «Руководство пользователя Lumien Standard» — п.8 «Режим Fake Standby» (доступ по RS232/LAN).
- Lumien.ru: «Команды управления для Lumien Basic G2» / «Параметры протокола RS232 для панелей серии Basic»
  — RS232 38400 8N1, `k01sA000` off / `k01sA001` on, веб-интерфейс на порту 8081, Wake-on-LAN.
- AUVIX (auvix.ru, «Медиаплеер iconBIT DS2 — расширение функционала», 2025-06-24) — функции приложения DS:
  «отключение/включение HDMI-сигнала при сохранении питания плеера», «Запустить все» при включении экрана.