# Changelog

All notable changes to the **Genshin Map Overlay** project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.3] - 2026-10-28

### Added
- **Intelligent 3D In-World Navigation (Elevation & Height Awareness)**:
  - **Up & Down Vertical Chevrons**: Navigation arrow now displays dynamic 3D elevation chevrons (`▲ ▲` for climbing / high peaks, `▼ ▼` for descending / caves / ravines).
  - **Adaptive Color Gradients**: High altitude targets render with Radiant Amber/Gold gradients, underground and canyon targets render with Neon Cyan/Indigo gradients, and ground-level targets render in crisp Sky Blue.
  - **Elevation & Obstacle Badges**: Navigation HUD now displays clear vertical indicators (`▲ HIGH / CLIMB UP`, `▼ LOW / IN CAVE / RAVINE`, `▼ DEEP UNDERGROUND (Floor BX)`, `▲ UPPER TOWER (Floor LX)`).
  - **Proximity Vertical Alerts**: When arriving within 12 meters of a target with vertical difference, the overlay specifically alerts `🧗 LOOK UP! (~Xm above on cliff/structure)` or `🕳️ LOOK DOWN! (~Xm below in cave/ravine)`.
  - **Community Intelligence & Tip Extraction**: Automatically analyzes marker community summaries and comments to detect terrain hints (e.g. cliff peak, tree branch, glide down, breakable rocks) and displays a 1-line actionable tip right on the navigation HUD.
- **Smart Cave & Wall Routing**:
  - **Stage 1 (Head to Cave Entrance)**: When tracking a target inside a cave, mountain, or behind walls, navigation routes to the **Cave Entrance** first with a dedicated `🚪 Cave Entrance (~Xm)` badge, preventing players from running blindly into solid cliff faces.
  - **Stage 2 (Inside Cave -> Target)**: Once within 18m of the entrance or inside the cave, the arrow seamlessly transitions to guide the player directly to the pin inside.
  - **Big Map Entrance Route & Beacon**: When viewing the big map, draws the approach route to the Cave Entrance beacon, followed by a dashed tunnel route leading into the cave to the target.

### Fixed
- **Navigation Arrow Disappearing & Freezing**:
  - Fixed an issue where the in-world arrow would freeze or disappear when the big map was closed. Enabled continuous 60 FPS animation loop whenever navigation is active (`!!navigatingPin`).
  - Added persistent player position retention (60-second grace window with dead reckoning) so brief minimap template correlation drops (e.g. from grass, sprinting, shadows, combat, or dialog) no longer cause the arrow to flicker or vanish.
  - Seed initial player position from big map center on open so navigation works immediately even before the first minimap scan locks.
  - Enhanced minimap player arrow direction extraction with adaptive hue/contrast checks and lower pixel count threshold (5px), ensuring reliable character heading detection across 720p, 768p, 1080p, and 1440p resolutions.

---

## [1.2.2] - 2026-10-28

### Fixed
- **In-Game Map Selection & Click-Through**:
  - Fixed an issue where the transparent overlay window intercepted clicks and prevented selecting in-game Teleport Waypoints, domains, or dragging the in-game map.
  - Removed lingering capture buffers when cursor leaves pins, immediately releasing mouse events to the game (`api.mouse(false)`).
  - Added a dedicated `wheel` event handler on the overlay canvas to immediately release capture, ensuring mouse wheel zoom smoothly reaches Genshin without interruption.
  - Clicking outside the spot card now immediately releases mouse capture to the in-game map.
- **Navigation Route Stickiness & Zoom Anchoring**:
  - Fixed pins and the navigation route line sliding and drifting across the screen when zooming in and out.
  - Implemented Instant Zoom Anchoring: whenever zoom scale changes, velocity extrapolation and low-pass lag are bypassed, locking pins and navigation 100% solidly to the in-game map terrain.
  - Aligned navigation beacon and focal rings with pin icon centers instead of bottom tips.
  - Cleaned up navigation route rendering: off-screen teleport waypoints now show a neat border guide indicator rather than piercing lines cutting across the map, and the target pin displays an unmistakable `🎯 [Marker Name]` badge.

---

## [1.2.1] - 2026-10-28

### Added
- **Dedicated Pin Navigation Hotkey (`navigateTarget`, Default: `F6`)**:
  - Added a configurable global hotkey to instantly start/stop GPS tracking to the hovered pin or currently inspected spot card.
  - Fully customizable in Settings > Hotkeys & Shortcuts.
  - Added direct keyboard shortcuts (`T` / `N`) while hovering over any pin on the map or in the spot card to immediately begin navigation.
- **Immediate Undo for Last Marked Pin**:
  - Pressing the Mark Hotkey (`F4`) when no pin is hovered automatically unmarks the last marked pin, allowing quick one-key undo.

### Fixed
- **Pin Unmarking & Re-toggling**:
  - Fixed an issue where pins marked as collected could not be unmarked when "Hide collected" was enabled.
  - Implemented `findAnyPinAt()` coordinate search that detects collected/hidden pins near cursor position, allowing right-clicking to unmark and restore them immediately.
  - Fixed duplicate right-click firing on both `mousedown` and `mouseup`, unifying right-click toggle strictly onto `mouseup`.
  - Added explicit state forwarding to `FoundStore` to eliminate any synchronization drift between renderer and main process.
  - Removed debounce delay on direct `#spot-found` button clicks so users can toggle collected/uncollected without hesitation.
- **Software Double-Click Detection**:
  - Implemented high-precision software double-click detection (~450ms click interval tracking) on map pins.
  - Completely bypasses transparent Electron window native `dblclick` event dropouts, ensuring double-clicking pins reliably triggers navigation every time.

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
- **OpenCV Runtime Initialization**:
  - Restored `node_modules/@techstark/opencv-js` in the packaged archive so `window.cv` loads properly, eliminating `TypeError: Cannot read properties of undefined (reading 'then')`.
  - Added polling retry logic and defensive validation in `loadCv()` to ensure graceful initialization.
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
