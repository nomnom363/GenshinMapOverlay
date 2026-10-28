# Changelog

All notable changes to the **Genshin Map Overlay** project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.0] - 2026-10-28

### Added
- **Interactive Hotkey Configuration & Editor**:
  - Integrated a dedicated "Hotkeys & Shortcuts" panel directly into the sidebar settings.
  - Added plain-English action descriptions for all keybindings so users understand each shortcut's function.
  - Interactive "click to record" keybinding interface supporting function keys (`F1`–`F12`), modifiers (`Ctrl`, `Alt`, `Shift`), and letters.
  - Real-time shortcut re-registration via Electron `globalShortcut` and the background helper bridge without requiring an app restart.
  - One-click "Reset" button to restore default keybindings at any time.
- **Double-Click Pin Navigation**:
  - Double-clicking any pin on the in-game map immediately begins real-time tracking.
  - Spawns the transparent 3D in-world navigation arrow and calculates the recommended teleport route.
  - Double-clicking an already-tracked pin cancels and clears navigation.
- **Multi-Level Underground & Surface Layer System**:
  - Integrated 290 Teyvat subterranean layer maps parsed from AppSample layout metadata (`l=entrance|groupId|floorId`).
  - Automatic floor elevation classification (`B1`, `B2`, `B3`, `B4`, `B5`, `L1`, etc.) versus `☀️ Surface`.
  - Visual layer badges on map pins, downward chevrons on minimap radar, and cave entrance links in item cards.
  - 3-Way layer filter toggle: `All Layers`, `☀️ Surface`, `🕳️ Underground`.
- **In-World 3D Transparent Navigation Arrow**:
  - Ground-perspective cyan projection arrow rendered in front of the active character.
  - Real-time compass heading calculations derived from minimap rotation.
  - Trailing pulse chevrons, real-time distance HUD, and arrival beacon within 12 meters.
- **Big Map Fastest Teleport Recommendation**:
  - Pathfinding across all 831 Teleport Waypoints and Statues of The Seven.
  - Intelligently routes underground targets to cave-network waypoints or the closest surface entrance.
  - Pulsing beacon highlight, animated dashed route line, and quick "Focus Waypoint" button.

### Fixed
- **Windows Mouse Click-Through Bug**:
  - Fixed Electron Windows issue where `setIgnoreMouseEvents(false, { forward: true })` continued forwarding clicks through to the background.
  - Mouse clicks now cleanly register on the sidebar, category rows, and item cards.
- **Sidebar Category Expansion & Checkboxes**:
  - Removed event blocking (`stopPropagation`) on checkboxes to allow natural DOM `<label>` event delegation.
  - Clicking category headers (`.cat-head`) expands/collapses menus reliably, while checkboxes tick/untick immediately.
- **Micro-Gap Capture Dropping**:
  - Added a 250ms release hold buffer to `setCapture()` to prevent mouse capture from dropping during micro-movements.
- **Screen Capture Hooking Chrome**:
  - Fixed `setupCapture()` mistakenly latching onto `"Genshin Impact Interactive World Map - Google Chrome"`.
  - Added strict exclusions for browsers (`chrome`, `edge`, `firefox`, `browser`) to ensure capture exclusively targets the actual game process.
- **Draw Loop Runtime ReferenceError**:
  - Moved `const u = uiScale();` to the top of `draw()` to resolve an out-of-order `ReferenceError` when navigating pins.
- **Right-Click Pin Marking**:
  - Unified right-click handling across `mousedown`, `mouseup`, `contextmenu`, and the Python tracker (`hotkey:markAt`).
  - Implemented `findPinIndexAt()` to reliably detect pins within a 38px radius even during mouse movement.

---

## [1.1.2] - 2026-10-27

### Added
- AppSample Cloud Sync via local bridge and Google Chrome integration.
- Direct windowed & borderless fullscreen detection via `window_tracker.py`.
- F4 key shortcut to mark nearby/hovered markers as collected.
- Audio and toast feedback notifications on pin collection.

### Fixed
- Fixed window border offset calculations on high-DPI displays.
- Improved minimap template matching speed and stability.

---

## [1.0.0] - 2026-10-25

### Initial Release
- Ban-safe computer vision tracking (no memory reading or game injection).
- Big map marker overlay synchronized with in-game map panning and zoom.
- Minimap radar with edge indicators.
- Local SQLite/JSON caching of AppSample markers, categories, and community comments.
