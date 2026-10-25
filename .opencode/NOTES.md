# GameSir Connect — reverse-engineering notes

Goal: reimplement GameSir Connect (Windows Electron app) for Linux, possibly as a webapp.

## Artifacts in this directory (not a git repo yet)

- `GameSir Connect Setup 1.14.5.exe` — NSIS installer; 7z gives `app-32.7z` (Electron app) + uninstaller.
- `GameSir Connect/` — the installed app (Electron). Useful paths:
  - `resources/app.asar` — bundle. Extract with a small asar header parser (12-byte prefix, then
    uint32 LE json length at offset 12, data base = 16 + json_len). 7z cannot read asar.
    Key files: `dist/electron/main.js` (all HID/protocol code, ~840 KB minified), `dist/electron/renderer.js` (Vue UI, 5 MB).
  - `resources/dfu/` — **plain TypeScript sources**: `gs_pc3.h` (vendor command enum + structs),
    `fwDownloader.ts`, `uDiskDfuUtil.ts`, `udiskDllWarpper.ts`; plus Windows x86 DLLs.
- `cyclone2.pdf` — 2-page fold-out quick-start, **vector art, no text layer**
  (`gs -sDEVICE=txtwrite` produces 0 bytes). Render with ghostscript and read via vision, or crop regions.

## Stack

Electron + Vue 2 + Vuex + vue-router + vue-i18n. HID layer lives in the main process; UI talks over IPC.
12 models: C2, C3, G7ProCE, K2_8K, N2S, RedMagic, T3CE, T3Lite, T3Pro, T3XS, T4N2, T4NPro.

## Two transports — decisive for portability

1. **Pure JS over hidraw** (`node-hid`) — only `proxyC2` and `proxyT3Lite`. 64-byte reports, first byte `0x0F`:
   - `[15,1]` enter profile config, `[15,2,flag]` exit, `[15,3,page,offHi,offLo,len,...payload]` write profile chunk,
   - `[15,4,page,offHi,offLo,len]` read profile chunk, `[15,7,idx]` switch profile, `[15,9]` read FW version,
   - `[15,13,...]` RGB, `[15,32,102,85,l,r]` vibrate, `[15,252]` enter upgrade mode.
   Profile write = serialize (`$a.fromModel`), diff against cached bytes, write only the changed range.
2. **Vendor Windows x86 DLL via ffi-napi** — most newer models: `sapjoyuniapis_x86_v1.0.16.dll`,
   `sapjoyuniapis_t4n2_x86_v2606151.dll`, `mod_t3xs.dll`, `JL_upgradeUtility_x86.dll`, `XInputUtil_x86.dll`.
   JS only calls e.g. `T3XS_Execute(cmd, ...)`. Not portable; needs reimplementation from `gs_pc3.h` + USB captures.

## Cyclone 2 (C2) specifics

- Model entry: `Proxy:(e,t,r)=>new ys(e,t,r)` (proxyC2, JS transport), `UdiskProductName:"GS_C2_DEVICE"`,
  Wired mode `ConfigModeVid:13623 (0x3537)`, `ConfigModePid:4125 (0x101D)`, `UsagePage:65520 (0xFFF0)`.
- Deadzone fields in the profile object: `StickConfig.LeftStickCenterDeadzone / LeftStickEdgeDeadzone /
  RightStick... / LeftStickEnableRawDeadzon`, `TriggerConfig.LeftTriggerCenterDeadzone / LeftTriggerEdgeDeadzone /
  RightTrigger... / EnableQuickTrigger_Left|Right`.
- Mode switching hint from the app's own i18n: RU «Кнопка M + нажатие крестовины, чтобы переключить режим»,
  FR "Appuyer sur M+croix directionnelle pour changer de mode".
- **Stick centering on the Cyclone 2 (verified on the user's unit): hold View (`⧉`, two squares) + Menu (`☰`) +
  Home (GameSir logo) together.** The centre is sampled while the sticks/triggers are untouched, so nothing may be
  moved during that phase. The app's own calibration tip is drawn as "M + ☰" (`icons/keys/MPlusMenu.png`) and its
  dialog texts describe the procedure: `Centering` → «do not touch sticks and triggers», then «rotate both sticks a
  full circle three times and gently press both triggers fully down three times», then wait out the countdown
  («Калибровка, пожалуйста, подождите терпеливо…»). Hair-trigger calibration is separate: after switching
  long→short travel press the trigger three times, after short→long once.
- Button glyphs as the vendor software draws them (extracted from `resources/app.asar`,
  `dist/electron/static/common/keys/`): **Menu = hamburger `☰` (three bars)**, View = two overlapping squares,
  Start/Share = distinct icons, **M = a plus sign** — the app's calibration tip is literally named
  `icons/keys/MPlusMenu.png` and shows "+" plus "☰", i.e. "M + Menu". So when a GameSir instruction says
  "hold M + Menu" the plus is the M button, not the Menu button.
  Physical positions: View = left of HOME, Menu = right of HOME (Xbox Start), M = extra front button.
- **Mode cycling on the Cyclone 2 = hold View (share/select) + Menu (start) for ~2 s** (GameSir FAQ + SteamDeck
  reports). The HOME LED shows the active mode: green = XInput, blue = DS4, red = NS. This combo also changes the
  mode the pad boots into, so it persists. `M + A` rotates the ABXY layout; `M + LT/RT` toggles hair trigger.
  Verified in practice: holding the wrong combo dropped the pad into DS4 mode (`054c:09cc`), where the vendor
  config channel does not exist at all — recover by cycling back with View + Menu until the LED is green.
- **A GameSir pad in DS4/PS4 mode enumerates as `054c:09cc` with product "Wireless Controller"** —
  the GameSir identity is only visible in `manufacturer` ("Guangzhou Chicken Run Network Technology Co., Ltd.").
  Vendor protocol is inert in that mode; Xbox mode exposes `0x3537:0575` / `0x3537:100b` (per Deadband docs).

### Verified on hardware (Cyclone 2 via 2.4G dongle, ids `3537:100b` -> `3537:0575`)

- Config interface: second HID interface of the pad (subclass 0, `usbhid` driver) = one hidraw node.
  Report descriptor: usage page `0xFF00`, **OUT report id 0x0F (63 bytes)**, IN id `0x10` (config replies),
  IN id `0x12` (gamepad key state, ~1 kHz stream).
- Wire format: write 64 bytes `[0x0F, cmd, p1..p4, payload(58)]`; replies on `0x10` as
  `[0x10, state, ...]`. The state byte is NOT `cmd + 1`; the full mapping (from the app's `Xo`/`wo`):
  `1` EnterProfileConfig, `2` ExitProfileConfig, `3` WriteProfile, `4` ReadProfile, `5` ReadProfileAck,
  `6` Ack, `7` SwitchProfile, `8/9` WriteProfileToEEPRom, `9` ReadFirmwareVersion, `10` ReadFirmwareVersionAck,
  `11` ReadCurrentProfile, `12` ReadCurrentProfileAck, `13/14` ReadRGB/Ack, `15` ProfileChanged,
  `16/17` RefreshProfile/Ack, `18..21` EEPROM, `240/241` Download/Ack, `242` HeartBeat, `243/244` ReadKeyStatus/Ack,
  `252` RequestToUpgrade, plus `AckWithBusy`, `ReadProfileComplete`, `ReadAudioAck`, `CalibrationResponse`,
  `SetStickCenterAck` in the extended set. Practical consequence: **do not gate replies on a computed ack**,
  accept any `0x10` frame in the window and validate the payload.
  Note `0xF2` (heartbeat) is sent by the host but never answered by the Cyclone 2 — use `0x09` for a liveness probe.
- Read chunk reply layout (raw 64-byte frame): `[0]=0x10, [1]=state(0x05 ReadProfileAck), [2]=page,
  [3]=offHi, [4]=offLo, [5]=len, [6..]=payload`. In WebHID `event.data` the report id is stripped, so every
  index shifts by one.
- Commands: `0x01` enter config, `0x02` exit, `0x03` write chunk, `0x04` read chunk,
  `0x09` FW version, `0x0B` current profile index, `0xF2` heartbeat.
  Read chunk: `[0x0F, 4, page, offHi, offLo, len]`, reply echoes page/offset/len then payload.
- Profile page = 680 bytes (`Ya.Values.EveryPacketLength`); pages 1-4 = profiles, 5 = Shift, 32 = Light (635 B).
- Reads sometimes get no reply for one chunk -> retry (the official app also queues/retries).
- **The pad re-enumerates mid-session** (e.g. `100b` -> `0575`) and the hidraw node is recreated, which
  loses a `uaccess` ACL applied to the old node. Tools must match by vendor id and re-open the node.
- Firmware string on this unit: pad `0352`, dongle `0120` (UTF-16LE in the `0x09` reply).

### Verified C2 profile layout (680 bytes, from `$a.fromModel` + hardware dump)

| Offset | Size | Content |
|---|---|---|
| 0x000 | 32 | profile name (UTF-8) |
| 0x020 | 32 | Fun_Data: motors, audio, shift, dpad lock, ABXY, report rate |
| 0x040 | 112 | 16 x mapping, 7 bytes each (turbo_en, turbo_speed, map_en, map_value1..3, toggle_en) |
| 0x0B0 | 159 | FL1 macro |
| 0x14F | 159 | FR1 macro |
| 0x1EE | 28 | LT (L2): turbo_en, turbo_speed, dead_en, front_dead, back_dead, anti_front, anti_back, ... |
| 0x20A | 28 | RT (R2), same layout |
| 0x226 | 32 | left stick: stick_en, stick_square, dead_en, front_dead, back_dead, anti_front, anti_back, linear(13), map(12) |
| 0x246 | 32 | right stick, same layout |
| 0x266 | 33 | motion Aim |
| 0x287 | 33 | motion Tilt |

Deadzone byte offsets (1 byte each, percent): LT `dead_en 0x1F0`, `center 0x1F1`, `edge 0x1F2`,
`anti_front 0x1F3`, `anti_back 0x1F4`; RT `0x20C/0x20D/0x20E/0x20F/0x210`;
LS `0x228/0x229/0x22A/0x22B/0x22C`; RS `0x248/0x249/0x24A/0x24B/0x24C`.
Factory values on this unit: LT/RT `dead_en=1, 5/95, anti 0/100`; LS/RS `dead_en=1, 2/100, anti 0/100`.
Profile writes are diff-based: the official app serializes, diffs against the cached bytes and sends only the
changed range, chunked as `[0x0F, 3, page, offHi, offLo, len, payload]`.

**Write path verified on hardware**: writing `[0x0F, 3, 1, 0x02, 0x29, 0x01, 50]` changed exactly one byte
(read back, whole-page diff = `['0x229']`), the left stick went dead in the centre while the right stick
(offset `0x249`, value 2) stayed responsive, and writing 2 back restored page 1 byte-for-byte identical to the
backup. So `0x229` = left stick inner/centre deadzone, `0x249` = right stick inner deadzone.
Deadzone value 50 blocked noticeably *less* than half of travel — the value-to-travel mapping is not 1:1
(to be measured; the UI should expose the range the pad actually applies).

**The pad pushes nothing on its own.** A passive 60 s watch of the config channel (XInput mode, pad awake)
produced zero frames — replies only come in response to host commands. The vendor app therefore writes a
heartbeat (`[0x0F, 0xF2, 0]`) right after opening the device, and only then does the `0x12` key-state stream
(≈1 kHz) start flowing. Any capture script must send something first; JSON-style "listen only" sees nothing.
Consequence for calibration: there is no spontaneous `CalibrationResponse` to catch — the host has to ask
(`0xFD` / `0xFE`), which still needs the mode/state values decoded.

**The pad sleeps aggressively** and then produces no report traffic at all; on wake the USB identity and hidraw
node can change (`0575` <-> `100b`), which drops a `uaccess` ACL applied to the old node. Keep the udev rule in
place while working.

Access rules live in the repo: `packaging/70-gamesir.rules` (+ `packaging/setup-udev.sh`, idempotent installer).
Symptom without them: hidraw node is `root:root 0600`, and Chromium's WebHID answers **"Failed to open the
device."** while the Gamepad API keeps working (it needs no permissions). The rule only matches `idVendor=="3537"`.
Prefer `70-` as the filename prefix — `uaccess` ACLs are applied by `73-seat-late.rules`.

**Why other cool tools need no rules:** their device class is already covered by the distribution.
DualShock 4 (`054c:09cc`) is covered on Arch by the `steam-devices` package
(`/usr/lib/udev/rules.d/60-steam-input.rules`: `KERNEL=="hidraw*", ATTRS{idVendor}=="054c",
ATTRS{idProduct}=="09cc", MODE="0660", TAG+="uaccess"`). The GameSir pad matches that rule **only in DS4 mode** —
which is exactly why the hidraw node had an ACL back when the pad presented as `054c:09cc`. In XInput it is
`3537:xxxx`, and that vendor appears in no stock rule: `70-uaccess.rules` grants joystick access for
`SUBSYSTEM=="input"` (`event*`/`js*`) only, never hidraw, and the vendor HID interface is not classified as an
input device. So the vendor channel needs exactly one rule — and in DS4/Switch modes it is useless anyway because
the channel does not exist.

Tooling used (Python, no deps, raw hidraw I/O): `tools/c2.py` (`dump` / `read` / `verify` / `set`),
`tools/restore.py` (restore pages from a backup dir or the web UI JSON, `--dry-run` supported),
`tools/watch.py`, `tools/stick2.py`. Бэкапы в `/tmp/opencode/` не переживают перезагрузку (уже потеряны);
постоянная копия первого полного дампа лежит в `dumps/session-start/` (в git не попадает), а рабочие байты,
на которых гоняются тесты, — в `tools/fixtures/` (`page-02/04/32.bin`, см. README там же).

**Observed profile shuffling:** during a session the pad can renumber its slots (profile 1 lost its content,
profile 2 ended up holding what slot 4 had) and change the active profile on its own; the calibration data is not
part of these 680-byte pages, so restoring a page never touches the stick calibration. Keep a fresh dump before
any experiment: `tools/c2.py dump DIR`, and compare with `tools/c2.py verify PAGE FILE`.

### Web UI details

- живой вид стиков на странице читает оси **сырыми** (без мёртвой зоны прошивки), поэтому сбитый центр виден
  сразу; детектор «сбитого центра» (`web/js/drift.js`) срабатывает, только если пад в покое (кнопки/курки не
  тронуты), стик стоит без движения ≥5 с, уход ≤0.35 и больше порога центра — намеренное удержание стика в игре
  баннер не вызывает. Тесты: `tools/test-drift.mjs`.

### Кнопки, макросы и раскладка (батч 2)

Запись кнопки: 7 байт начиная с `0x040` (`0x040 + 7*i`, порядок из вендорского `ja`):
`[turbo_en, turbo_speed, map_en, map_value1, map_value2, map_value3, toggle_en]`. Вендорский UI допускает
до трёх целей на кнопку (`maxMappingButtonCount = 3`, режим «map to multiple buttons»), а `map_en`
подразумевается при любой непустой цели.

Макрос: 159 байт, `0x0b0` (FL1/L4) и `0x14f` (FR1/R4) — сразу после блока из 15 записей по 7 байт (16..18-й
индексы формально «за пределами» списка `ja`, поэтому отдельные константы):
`[те же 7 байт записи][биты marco_en|key_open|cycle][cycle hi][cycle lo][step_num]`
`[30 × (step_data, hold hi, hold lo, [delay hi, delay lo])]`, где задержка есть только у первых 29 шагов
(29*5 + 3 + 11 = 159, совпадает с `FunctionKeyPacketLength`). Время — миллисекунды, 16 бит big endian.
Свой UI для этой модели ограничивает редактор 12 шагами, в профиле доступно 30.

**Раскладка A/B и X/Y — два независимых маркера, оба внутри профиля.**

* флаг `xinput_abxy_change` (0x2c): установлен — ABXY переставлены в XInput-режиме. Именно его ставит
  комбинация **M + A** на корпусе: наблюдали слоты 1–3, где ремапов нет вообще, но при `0x2c=1` пад ведёт себя
  как switch. `0x2d` (`switch_abxy_change`) — парный флаг для Switch-режима, сам по себе ничего не решает
  (встречались состояния `1/0` и `1/1` при одном и том же поведении);
* четыре ремапа `A(9)→10, B(10)→9, X(11)→12, Y(12)→11` в области `0x40`: дают switch и **без** флага —
  это видно на первом дампе сессии (профиль 4: флаги `0/0`, ремапы переставлены, поведение switch).

Поэтому признак switch в коде — «флаг ИЛИ ремапы», а кнопки раскладки пишут и снимают оба маркера вместе
(`readLayout` / `writeLayout` в `protocol.js`). Тесты: `tools/test-protocol.mjs` (флаг отдельно, ремапы
отдельно, запись/снятие пары, сверка с дампом).

**Скрытых областей нет:** страницы кроме 1–5 и 32 (0, 6–9, 16, 20, 24, 28, 31, 33, 34, 40, 48, 56, 64, 128,
255) читаются, но всегда возвращают нули — состояние раскладки лежит только в страницах профилей.

### Подсветка (батч 6, страница 32, 635 байт)

`[0]` индекс активной анимации (вендорский код ограничивает 3, хотя анимаций пять),
`[1..620]` пять анимаций по 124 байта, `[621..634]` хвост: бит audio-reactive, индекс эффекта, RGB цвета
профиля, бит «пробуждение при подъёме», таймаут сна, 7 зарезервированных байт (1 + 5·124 + 14 = 635).

Анимация: `[кадров, эффектов, скорость, яркость]` + 8 кадров по 15 байт (5 зон × RGB).
Зоны — Home и четыре подсветки под ABXY (в вендорской модели `Home, LowerLeft, LowerRight, UpperLeft,
UpperRight`). **Скорость хранится инвертированной**: `байт = 20 − скорость`, обе стороны (чтение и запись)
инвертируют её, диапазон 0..20.

Проверка модели — на живой странице пада: `node tools/check-roundtrip.mjs /tmp/opencode/live-page-32.bin`
пересобирает подсветку из прочитанного и требует байтового совпадения. Профильные проверки (маппинги,
макросы) на 635-байтной странице пропускаются — там те же смещения заняты кадрами.

**Тест кнопок подтверждает ремап напрямую:** полоса в живом блоке показывает то, что пад отдаёт хосту, поэтому
на слоте switch физическое нажатие A подсвечивает бейдж B.

**Словарь действий**: 144 записи, выгружены из `renderer.js`/`main.js` (`tools/extract-actions.py` →
`web/js/actions.json`). Коды: кнопки геймпада с 1, клавиатура с 64 (их собственная нумерация, не USB HID
usage), мышь и функции — своими блоками. Проверка на живых дампах: `node tools/check-roundtrip.mjs PAGE.bin`
пересобирает маппинги и макросы из прочитанного и требует байтового совпадения (на всех наших бэкапах сходится).

### Поля Fun_Data (батч 1, проверено по дампу)

`0x20..0x23` моторы, `0x24..0x28` аудио, `0x29` shift_en, `0x2a` shift_value, `0x2b` dpad_diagonal_lock_en,
`0x2c` xinput_abxy_change, `0x2d` switch_abxy_change, `0x2e` report_rates_gears, `0x2f..0x3f` резерв.

**Частота опроса** (`0x2e`): вендорский UI этой серии даёт список `{0: 250 Гц, 1: 500 Гц, 2: 1000 Гц}`
(у старших моделей другой список: `0/2/4/5` = 250/1000/4000/8000 Гц). На нашем паде значение `2` = 1000 Гц,
что совпадает с заявленной 1 кГц.

**Имя профиля** — 32 байта UTF‑8 в начале страницы; вендорский код занимает не больше 31 байта
(`slice(0, length - 1)`), последний байт остаётся нулём. Round-trip этого поля проверяется тестом на фикстуре.

**Копирование профиля** и **переключение активного на паде** — отдельные действия, идущие мимо общего диффа:
копирование пишет дифф в целевую страницу, переключение — команда `0x07` без ответа.

**Раскладка ABXY** — в профиле есть два служебных байта, `xinput_abxy_change` (0x2c) и `switch_abxy_change`
(0x2d), НО **вендорский рендерер их не упоминает вообще** (в `renderer.js` нет `xinputAbxyChange`/
`switchAbxyChange`), то есть официальное приложение для этой модели их не редактирует. Раскладка переключается
**на самом паде**: подсказка из их локализации — «Удерживайте кнопки M+A, чтобы сменить раскладку»
(`Layout_Tips`). Проверено на практике: запись этих байтов даёт непредсказуемый результат (при обоих флагах = 1
на паде включилась Xbox-раскладка), поэтому страница их только показывает и советует комбинацию M + A.

**Баг, найденный на этом же шаге:** `applyChanges` брал номер страницы из селектора, а буфер мог принадлежать
другой странице — теперь запоминается `loadedPage` (страница, из которой прочитан буфер), и запись отклоняется,
если селектор переключили без повторного чтения. Селектор профиля дополнительно читает выбранный профиль
автоматически, так что рассинхрон теперь возможен только вручную.

**Кнопка «Применить»** подсвечивается акцентным цветом и показывает число изменённых байт, пока в буфере есть
несохранённые правки; после записи возвращается в обычный вид.

**Снимок сессии**: при подключении страница читает все страницы (1–4, Shift, Light) и держит их в памяти,
кнопка «Откатить к снимку сессии» возвращает их диффами. Это замена авто-бэкапу «перед первой записью»:
файлы и разрешения не нужны, состояние всегда есть в памяти вкладки.

## Prior art on Linux (reuse, don't redo)

- `broroeror/gamesir-linux-tools` ("Deadband", Qt/QML) — Cyclone 2 + G7 Pro + Logitech G502 X, verified register
  map, `RESEARCH.md`, `CONTROLLER_MAP.md`, udev rule with `TAG+="uaccess"` (prefix `70-`: uaccess is applied in
  `73-seat-late.rules`).
- `HttpKiwi/GameGent` — Flask + React web UI + Python hidapi for Tarantula Pro (same shape as the target webapp).
- `questionablesyntax/g7ctl` — G7 Pro protocol.

## Environment notes

- Chromium WebHID on Linux opens `/dev/hidraw*` directly, so a udev `uaccess`/group rule is required on the host
  even when nothing is passed into a container. Docker only needs `--device` if the backend does I/O.
- No GameSir pad present by default; user's pad is a Cyclone 2.

## Публикация (GitHub Pages)

- Репозиторий: `git@github.com:Givemegitpls/gamesir-webui.git` (public, ветка `main`). Коммит/пуш делает
  пользователь — у агента на это прав нет.
- Сайт: `https://givemegitpls.github.io/gamesir-webui/`; `.github/workflows/pages.yml` публикует каталог
  `web/` как есть (без сборки) через `upload-pages-artifact` + `deploy-pages`. Pages включаются вручную:
  Settings → Pages → Source = «GitHub Actions».
- Все пути в `web/` относительные (`style.css`, `js/main.js`, `js/actions.json`), поэтому подкаталог Pages
  работает без base-href. HTTPS даёт secure context для WebHID, но udev-правило на хосте всё равно нужно.
- В git НЕ попадают: `GameSir Connect/`, `*.exe`, `cyclone2.pdf`, `dumps/`, `__pycache__/` (см. `.gitignore`).

## Live-вид и режим XInput (диагностика 26.10)

- **PID зависит от способа подключения**: провод даёт `3537:1053`, 2.4G-донгл — `3537:100b`; оба варианта
  «Xbox 360 Controller for Windows» с рабочим XInput и живым `xpad`. Не хардкодить PID: режим и конфигурируемость
  определяются по `vendorId` (0x3537), продукт — только для отображения.
  Два интерфейса: `1.0` — vendor class `0xFF/0x5D/0x01` (настоящий XInput, его забирает `xpad`), `1.1` — HID
  (вендорский канал конфигурации + keyboard/mouse коллекции). После обновления ядра до 7.2.11 `xpad` привязался
  сам, появились `js0` и `event*` с именем «Generic X-Box pad», и Gamepad API начал отдавать пад в Chromium.
- Первое наблюдение замирания live-вида ("~10 секунд") было сделано на **проводе**; после перехода на донгл
  воспроизвести не удалось. Если баг вернётся на кабеле — смотреть, не отваливается ли USB-устройство
  (journalctl -k: `usb 1-x: USB disconnect`) и что пишет `#padinfo`.
- На ядре 7.2.9 (до перезагрузки) `xpad` не был загружен и `/lib/modules` вообще не содержало модулей для
  запущенного ядра — тогда live-вид не мог работать в принципе: в `/proc/bus/input/devices` не было ни одного
  устройства с `ID_INPUT_JOYSTICK=1`, `navigator.getGamepads()` пустой.
- Плавающее замирание live-вида (стики, кнопки, шкалы стоят, лечится только reload) — это смерть rAF-цикла:
  `requestAnimationFrame(frame)` стоял последним оператором кадра, поэтому любое исключение обрывало цепочку
  навсегда. Теперь `live.js` планирует следующий кадр в `finally`, ловит исключение, пишет его в `#padinfo`
  (⚠ …) и возвращает нормальный статус после успешного кадра; плюс watchdog `setInterval` (2 с без кадров →
  перезапуск) и перезапуск по `visibilitychange`. Тест: `node tools/test-live.mjs` (фейковый DOM + rAF-очередь).
- Chromium держит пад в списке и после долгого простоя (проверено пробником: rAF 60 Гц, значения осей приходят
  после 28 с покоя), так что «протухание» Gamepad API и сон пада к этому багу отношения не имели.
- Для проверки страницы в живом Chromium удобен свой CDP-клиент на stdlib (WS handshake + `Runtime.evaluate`):
  он же ловит `window.onerror` и умеет перезагружать страницу. Лежит в `/tmp/opencode/probe/cdp.py` (не в git).

## Локализация (правило проекта)

- Страница двуязычная: `ru` (fallback) и `en`. Все строки — только в `web/js/locales/{ru,en}.js`,
  код обращается к `t()` из `web/js/i18n.js`; статическая разметка — атрибуты `data-i18n`,
  `data-i18n-html`, `data-i18n-title`, `data-i18n-aria`, `data-i18n-placeholder`
  (в HTML остаётся русский fallback — страница читаема до запуска модулей).
- **Каждая новая фича описывается на всех поддерживаемых языках — это часть готовности, а не
  отдельная задача.** Новый текст = новый ключ сразу в обоих словарях; `protocol.js`/`actions.js`
  держат `labelKey`, а не готовые подписи.
- Проверка: `node tools/test-i18n.mjs` (паритет ключей, совпадение `{placeholder}`, все ключи из
  html/js на месте, отсутствие кириллицы в модулях кроме автонима «Русский»). `tools/test-page.mjs`
  ищет текст калибровки в `locales/ru.js`, `tools/test-gamepad.mjs` и `tools/test-protocol.mjs`
  фиксируют язык через `setLang('ru')`, чтобы результат не зависел от окружения.
- Язык: `?lang=` → `localStorage['gamesir.lang']` → `navigator.language` → `ru`; переключатель
  `#lang` в шапке. Смена языка перерисовывает редактор из буфера `desired` (правки не теряются),
  udev-команды, статусы и видимый дрейф-баннер; live-бейджи перерисовываются следующим кадром.
- Технические логи (`#log`, `console`, `writePageDiff`) намеренно английские — проще прикладывать
  к issue. Новый язык: файл в `web/js/locales/`, запись в `DICTIONARIES` и `LANGS` в `i18n.js`.
