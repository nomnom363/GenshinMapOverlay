# Genshin Map Overlay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-informational.svg)]()
[![Safety: 100% Ban Safe](https://img.shields.io/badge/Safety-100%25%20Ban%20Safe-brightgreen.svg)]()
[![Electron](https://img.shields.io/badge/Electron-33%2B-blue.svg)]()

A high-performance, real-time in-game map overlay for **Genshin Impact**. Displays interactive pins (Chests, Oculi, Puzzles, Quests, Materials) directly aligned on your in-game map and minimap using optical computer vision — **with zero game process memory tampering or DLL injection (100% ban safe)**.

---

## 🌟 Key Features

### 🕳️ Multi-Level Underground & Surface Map Layers
- **Subterranean Identification**: Instantly tell whether an item is on the surface or buried in an underground cave system.
- **Accurate Floor Badges**: Pins display their exact subterranean floor layer (`B1`, `B2`, `B3`, `B4`, `B5`, `L1`, etc.) matching the in-game multi-layer map.
- **Map Layer Filter**: Toggle between:
  - **All Layers**: View everything at once with clear underground indicators.
  - **☀️ Surface**: Hide subterranean clutter while exploring the open world.
  - **🕳️ Underground**: View only cave networks and underground items when spelunking.
- **Cave Entrance Navigation**: Underground items feature direct links to their cave entrances (`🚪 Cave Entrance #ID`).

### 🧭 Minimap Radar & Edge Proximity Indicator
- **Live Minimap Tracking**: Mini-radar circle tracks your character in real-time.
- **Verticality Chevrons (`▼`)**: Oculus and chest indicators on the minimap show a downward arrow when located in caves below you, preventing futile searching on mountain peaks.
- **Extended Radar**: Pins outside your immediate radar radius display sleek edge indicators around the minimap rim.
- **Proximity Ring**: Nearby uncollected items trigger a pulsating focal ring.

### 🎯 Rock-Solid Zoom & Pan Anchoring
- Pins remain firmly anchored to their exact game coordinates when zooming in or out or panning across Teyvat, exactly matching the interactive map experience.

### 🖱️ Seamless In-Game Controls & Interaction
- **Click-Through Transparency**: Zero interference with game mouse controls, camera rotation, or map panning.
- **Right-Click to Collect**: Hover over any pin and right-click to instantly mark it as found/unfound.
- **Full Pin Details**: Click any pin to open community comments, guides, and screenshot evidence.
- **Minimap Pin Tracking**: Click `📍 Track` on any item to guide your path on the minimap.
- **Auto-Closing Sidebar**: Panels close automatically when clicking outside or pressing `Escape`.

### ☁️ 1-Click AppSample Cloud Sync
- Built-in local bridge at `http://127.0.0.1:48762/sync` allows seamless two-way progress synchronization with [genshin-impact-map.appsample.com](https://genshin-impact-map.appsample.com/).

---

## 🛡️ 100% Ban Safe Guarantee

Unlike unsafe cheat tools or injectors, **Genshin Map Overlay does not touch Genshin Impact**:
- ❌ **No DLL Injection**
- ❌ **No Memory Reading or Process Hooking**
- ❌ **No Game File Modification**

**How it works:**
1. The app captures your desktop screen through the standard Windows Desktop Duplication / Graphics Capture API.
2. An offline OpenCV computer vision engine detects your map location and zoom scale purely by analyzing map landmarks.
3. Markers are drawn onto an independent, transparent, click-through overlay window positioned over the game.
4. From the perspective of Genshin Impact and anti-cheat (mhyprot2 / HoYoKProtect), this application is identical to watching a video or running Discord overlay.

---

## ⌨️ Hotkeys & Shortcuts

| Hotkey | Action | Description |
| :--- | :--- | :--- |
| **Right-Click** | **Mark as Found** | Right-click directly over any pin on the map to toggle collected state |
| **F4** | **Mark Hovered** | Keyboard alternative to mark currently hovered pin |
| **Alt + E** | **Mark Nearest** | Automatically marks the closest pin within your character's radius |
| **F7** | **Toggle Overlay** | Show or hide the entire overlay |
| **F8** | **Toggle Sidebar** | Open or close the categories and settings sidebar |
| **F10** | **Cycle Opacity** | Cycle through overlay opacity presets (100%, 75%, 50%) |
| **M** | **Game Map** | Fades the overlay automatically when opening/closing the map |
| **Escape** | **Close Panel** | Closes opened pin details or settings sidebar |

---

## 🚀 Getting Started

### Prerequisites
- **Operating System**: Windows 10 or Windows 11 (64-bit)
- **Node.js**: v18.0.0 or higher ([Download Node.js](https://nodejs.org/))
- **Python**: v3.8 or higher ([Download Python](https://www.python.org/))
- **Genshin Impact**: Borderless Windowed or Fullscreen mode

Install Python dependencies for window & mouse tracking:
```bash
pip install pywin32
```

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/GenshinMapOverlay.git
   cd GenshinMapOverlay
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

3. **Start the Overlay**:
   ```bash
   npm start
   ```

4. Launch **Genshin Impact**, open your map in-game (**M**), and the overlay will automatically calibrate and lock onto your coordinates!

---

## 📦 Building an Executable

To compile a standalone Windows installer / executable:

```bash
# Package directory build
npm run pack

# Build full NSIS Windows installer
npm run dist
```
The output executable will be created in the `dist/` directory.

---

## ☁️ How to Sync with AppSample

1. In the overlay sidebar (**F8**), click **🌐 Sync in Chrome** (or open `http://127.0.0.1:48762/sync` in Chrome).
2. Log into your account on [genshin-impact-map.appsample.com](https://genshin-impact-map.appsample.com/).
3. Follow the one-click instruction prompt on the bridge page to import all your marked chests, oculi, and waypoints directly into `found.json`.

---

## 📁 Project Architecture

```
GenshinMapOverlay/
├── assets/                  # Icons and visual assets
├── src/
│   ├── main.js              # Electron main process (lifecycle, capture, window management)
│   ├── config.js            # Configuration & user settings store
│   ├── bridge.html          # Local HTTP sync server bridge
│   ├── bridge_snippet.js    # Browser sync injection script
│   ├── hotkey-helper.js     # Native Windows hotkey registration
│   ├── data/
│   │   ├── categories.json  # Marker categories & type mappings
│   │   ├── overlays.json    # Official Teyvat underground maps & floor layouts (290 overlays)
│   │   ├── store.js         # Marker cache & multi-layer underground parser
│   │   ├── found.js         # High-speed local found progress storage (found.json)
│   │   └── tileset.js       # Map tile definitions & coordinate bounding boxes
│   ├── overlay/
│   │   ├── index.html       # Overlay canvas, Layer Filter bar, & Spot details DOM
│   │   ├── overlay.css      # Styling for HUD, layer pills, and theme
│   │   ├── overlay.js       # Canvas rendering, minimap radar, underground badges, pan/zoom
│   │   └── preload.js       # Electron secure IPC bridge for overlay
│   ├── shared/
│   │   ├── geo.js           # Coordinate conversions (Lng/Lat <-> Game Space)
│   │   ├── hud.js           # In-game HUD element bounds detection
│   │   ├── i18n.js          # Multi-language translation support
│   │   └── media.js         # Thumbnail & image loader
│   └── tracker/
│       ├── tracker.js       # CV matching worker orchestrator
│       ├── tracker-core.js  # Frame difference & motion tracker
│       ├── matcher-core.js  # OpenCV template matching & tile pyramid search
│       └── minimap-core.js  # Player position & rotation extraction from minimap
├── window_tracker.py        # Companion script: zero-overhead Windows input & window tracking
├── package.json             # NPM metadata and build scripts
├── .gitignore               # Standard git ignore rules
└── LICENSE                  # MIT License
```

---

## 🤝 Contributing

Contributions are welcome! If you encounter bugs, have ideas for new features, or want to contribute improvements:
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more details.

---

*Disclaimer: Genshin Map Overlay is an independent open-source tool and is not affiliated with, endorsed by, or associated with miHoYo / HoYoverse. Genshin Impact and all related assets are trademarks of HoYoverse.*
