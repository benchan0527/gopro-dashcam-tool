# GoPro Dashcam Tool

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

### 簡介

`gopro-dashcam-tool` 係一個用 Electron 寫嘅桌面 app,專門用作:

1. **合 GoPro / 行車記錄儀影片** — 用 `ffmpeg` 將多段 TS → MP4
2. **由 GoPro MP4 / LRV 抽出 telemetry** — GPS、G-Force、Speed
3. **產生 SRT 字幕** — 將 telemetry 變成可顯示嘅字幕

### 主要功能

#### 🎬 Dashcam Merger(行車記錄合片器)

- 支援多種 MP4 輸入,先用 `mpegts` 格式 rewrap 加快 concat
- **Pre-flight 磁碟檢查** — 自動揀 temp dir,如果輸出碟唔夠位就去 system temp
- **Auto-split 大檔案** — 預設每段 256 GB,超過自動分 part
- **Live info panel** — 顯示 CPU%、RAM、disk free、ffmpeg speed、bitrate、fps、ETA
- **兩段 ETA** — Phase 1 (MP4→TS) 預估 + Phase 2 (concat) 預估
- **⏯ Resume mode** — 如果 app 食 RAM/CPU/disk 死咗而中斷,relaunch 時會自動偵測 `outputDir` 入面嘅 orphaned `filelist_*.txt` 同 `.ts` 檔,**直接跳去 Phase 2 concat**(見下)
- **Orphan clean-up** — 提示用戶刪掉或 resume,唔會默默食碟

#### 📡 Telemetry Extractor

- 用 [gpmf-extract](https://www.npmjs.com/package/gpmf-extract) + [gopro-telemetry](https://www.npmjs.com/package/gopro-telemetry) 讀 GPMF stream
- 抽 GPS coords、speed (km/h)、G-force (x/y/z)
- 用 [node-geocoder](https://www.npmjs.com/package/node-geocoder) 反查地址(可選 offline Nominatim)
- 產生 SRT 字幕,例如:
  ```
  00:00:01,000 --> 00:00:02,000
  Speed: 45 km/h
  GPS: 22.2855°N, 114.1577°E
  G-Force: 0.12g
  ```

#### 🗺 Offline Geocoding (可選)

- 用 [Nominatim](https://nominatim.org/) + OSM `.osm.pbf` 做 **離線反查**
- 詳細安裝睇 [`docs/NOMINATIM_SETUP.md`](docs/NOMINATIM_SETUP.md)

### 系統需求

- Windows 10 / 11 (x64)
- Node.js ≥ 18
- `ffmpeg` + `ffprobe` 喺 `PATH`(或者用 [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static))

### 安裝

```bash
git clone https://github.com/benchan0527/gopro-dashcam-tool.git
cd gopro-dashcam-tool
npm install
```

### 跑 dev mode

```bash
npm start
# 或者 Windows 上面 double-click:
./start-gui.bat
```

會開個 Electron window,介面分兩部分:

1. **Extract Telemetry** — 揀 MP4 / LRV 抽 SRT
2. **Dashcam Merger** — 合多段行車記錄片

### Package 落 `.exe`

```bash
npx electron-builder --win
```

會出 `dist/gopro-dashcam-tool Setup x.x.x.exe`。

---

### 🎬 Dashcam Merger 用法

1. **揀 source folder** — 應用程式會 scan 入面嘅 MP4
2. **揀要合嘅 files**(可 multi-select / sort / invert)
3. **揀 output folder**(可另設 temp folder)
4. **撳 Start Merge**
5. 完成之後按 `Show in Explorer` 開 output

### ⏯ Resume Mode 用法

如果你個 merge 中途死咗(Ctrl+C / OOM / BSOD / 斷電):

1. **唔好郁 output dir 入面嘅 `filelist_*.txt` 同 `partNNNN.ts` files**
2. **重新開 app**
3. Pick 返同一個 output folder
4. App 會自動 detect 到上次嘅 session,顯示 **橙色 resume banner**:
   ```
   ╔═══════════════════════════════════════════════╗
   ║ ⏯ Previous session detected                    ║
   ║ TS segments: 680/680 present (201.57 GB)        ║
   ║ ⚠ Partial output detected (will be removed)     ║
   ║ [▶ Resume (skip Phase 1)] [✗ Discard temp] [×] ║
   ╚═══════════════════════════════════════════════╝
   ```
5. 撳 **▶ Resume** → 跳過 Phase 1 嘅 680 次 ffmpeg convert,直接 concat

**Safety checks**:
- File count mismatch(你揀少咗/多咗 input)→ 拒絕 resume,提示 fresh merge
- Missing .ts file → 列缺邊啲,拒絕 resume
- Partial / corrupt mp4(無 moov atom)→ 自動 unlink
- Output name 用 `_resumed` suffix 避免覆蓋

**驗證測試** — 喺真實 workflow 上面:
- 680 .ts files × ~300 MB = 201.57 GB
- After kill → re-detect 100% present
- Resume concat speed ~3× real-time(400 MB/s)

### Project 結構

```
gopro-dashcam-tool/
├── src/
│   ├── main.js          # Electron main + IPC handlers + Dashcam merge engine
│   ├── preload.js       # Context bridge
│   ├── renderer.js      # UI logic
│   └── index.html       # UI markup + CSS
├── docs/
│   └── NOMINATIM_SETUP.md
├── extract.js           # CLI: batch extract telemetry
├── batch_process.js     # CLI: batch process multiple files
├── fast_merge.py        # Python alternative (legacy)
├── merge_*.ps1          # PowerShell helpers (legacy)
├── start-gui.bat        # Launch Electron app
├── start_fast_merge.bat # Launch fast_merge.py
└── package.json
```

### Troubleshooting

| 問題 | 解法 |
|------|------|
| `ffmpeg` not found | 裝 ffmpeg 入 PATH,或者 `npm i ffmpeg-static` |
| "No directory has enough disk space" | 預設要 input ×1.95,清吓 temp folder 或加 temp dir |
| Resume banner 唔彈出 | 檢查 `outputDir` 入面係咪有 `filelist_*.txt` |
| Resume 失敗(有 missing .ts) | Files 喺 app 重啟之間被刪咗,只能 fresh merge |

### License

MIT

---

## English

### Overview

`gopro-dashcam-tool` is an Electron desktop app for:

1. **Merging GoPro / dashcam footage** — multi-segment TS → MP4 via ffmpeg
2. **Extracting telemetry from GoPro MP4 / LRV** — GPS, G-Force, Speed
3. **Generating SRT subtitles** — overlay telemetry in any video player

### Key Features

#### 🎬 Dashcam Merger

- Re-wrap MP4 inputs to `mpegts` for fast concat
- **Pre-flight disk check** — auto-picks temp dir (output → system temp fallback)
- **Auto-split oversized outputs** — 256 GB per segment by default
- **Live info panel** — CPU%, RAM, disk free, ffmpeg speed / bitrate / fps, ETA
- **Two-stage ETA** — Phase 1 (MP4→TS) + Phase 2 (concat)
- **⏯ Resume mode** — if the app dies (Ctrl+C / OOM / BSOD / power loss), relaunch will detect orphaned `filelist_*.txt` + `.ts` files in the output directory and **skip Phase 1 entirely**, jumping straight to concat (see below)
- **Orphan cleanup** — user prompted to discard or resume; no silent disk consumption

#### 📡 Telemetry Extractor

- Uses [gpmf-extract](https://www.npmjs.com/package/gpmf-extract) + [gopro-telemetry](https://www.npmjs.com/package/gopro-telemetry) to parse GPMF streams
- Extracts GPS coords, speed (km/h), G-force (x/y/z)
- Reverse-geocodes via [node-geocoder](https://www.npmjs.com/package/node-geocoder) (offline Nominatim supported)
- Generates SRT subtitles like:
  ```
  00:00:01,000 --> 00:00:02,000
  Speed: 45 km/h
  GPS: 22.2855°N, 114.1577°E
  G-Force: 0.12g
  ```

#### 🗺 Offline Geocoding (optional)

- [Nominatim](https://nominatim.org/) + OSM `.osm.pbf` for fully **offline** reverse geocoding
- See [`docs/NOMINATIM_SETUP.md`](docs/NOMINATIM_SETUP.md)

### Requirements

- Windows 10 / 11 (x64)
- Node.js ≥ 18
- `ffmpeg` + `ffprobe` in `PATH` (or install [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static))

### Install

```bash
git clone https://github.com/benchan0527/gopro-dashcam-tool.git
cd gopro-dashcam-tool
npm install
```

### Run dev mode

```bash
npm start
# Or on Windows, double-click:
./start-gui.bat
```

The Electron window has two sections:

1. **Extract Telemetry** — pick MP4 / LRV files to extract SRT
2. **Dashcam Merger** — stitch multi-segment dashcam footage

### Package as `.exe`

```bash
npx electron-builder --win
```

Produces `dist/gopro-dashcam-tool Setup x.x.x.exe`.

---

### 🎬 Dashcam Merger Usage

1. **Pick source folder** — app scans for MP4s
2. **Select files to merge** (multi-select / sort / invert supported)
3. **Pick output folder** (optional: separate temp folder)
4. **Click Start Merge**
5. After completion, click `Show in Explorer` to open output

### ⏯ Resume Mode Usage

If a merge dies midway (Ctrl+C / OOM / BSOD / power loss):

1. **Don't touch `filelist_*.txt` and `partNNNN.ts` files in the output dir**
2. **Relaunch the app**
3. Re-select the same output folder
4. App auto-detects the previous session and shows an **orange resume banner**:
   ```
   ╔═══════════════════════════════════════════════╗
   ║ ⏯ Previous session detected                    ║
   ║ TS segments: 680/680 present (201.57 GB)        ║
   ║ ⚠ Partial output detected (will be removed)     ║
   ║ [▶ Resume (skip Phase 1)] [✗ Discard temp] [×] ║
   ╚═══════════════════════════════════════════════╝
   ```
5. Click **▶ Resume** → skips 680 ffmpeg conversions in Phase 1, jumps straight to concat

**Safety checks**:
- File count mismatch (you selected a different number of inputs) → refuses to resume, prompts fresh merge
- Missing `.ts` file → lists missing files, refuses resume
- Partial / corrupt mp4 (no `moov` atom) → auto-unlinks before Phase 2
- Output name gets `_resumed` suffix to avoid clobbering

**Verified in real workflow**:
- 680 .ts files × ~300 MB = 201.57 GB
- After kill → re-detected 100% present
- Resume concat speed ~3× real-time (~400 MB/s)

### Project Layout

```
gopro-dashcam-tool/
├── src/
│   ├── main.js          # Electron main + IPC handlers + Dashcam merge engine
│   ├── preload.js       # Context bridge
│   ├── renderer.js      # UI logic
│   └── index.html       # UI markup + CSS
├── docs/
│   └── NOMINATIM_SETUP.md
├── extract.js           # CLI: batch extract telemetry
├── batch_process.js     # CLI: batch process multiple files
├── fast_merge.py        # Python alternative (legacy)
├── merge_*.ps1          # PowerShell helpers (legacy)
├── start-gui.bat        # Launch Electron app
├── start_fast_merge.bat # Launch fast_merge.py
└── package.json
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| `ffmpeg` not found | Install ffmpeg to PATH, or `npm i ffmpeg-static` |
| "No directory has enough disk space" | Needs input ×1.95 free. Clear temp folder or set explicit temp dir |
| Resume banner doesn't appear | Confirm `outputDir` contains `filelist_*.txt` |
| Resume fails (missing .ts) | Files were deleted between runs; only fresh merge is possible |

### License

MIT
