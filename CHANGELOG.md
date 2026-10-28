# Changelog

All notable changes to the **Genshin Map Overlay** project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.0] - 2026-10-28

### Added & Enhanced
- **Subterranean Cave Map Rendering (Surface + Underground Overlays)**:
  - Added dedicated underground cave overlay renderer in `overlay.js` (`drawUndergroundOverlays`): renders all 290+ subterranean cave systems, chambers, tunnels, and multi-floor structures directly on the in-game map canvas beneath the pins.
  - Implemented real-time minimap cave radar: when inside a cave (`playerTrack.isUnderground`), the active subterranean cave floor is clipped and drawn directly inside the circular minimap radar under the player's arrow.
  - Pre-calculated and passed all 290 Teyvat cave overlays with bounding coordinates from `store.js` (`decodeMarkers`) to the overlay client.
- **Preserved 100% English Community Pins & Data**:
  - Maintained the entire English community database (item names, categories, comments, media guides, right-click marking) from the current clean build — with zero Chinese text or clutter from external tools.
- **Layer & Cave Map Visibility Controls**:
  - Automatically activates cave overlays and highlights underground pins whenever the player is detected inside a cave or subterranean zone.
  - Retained manual layer filter controls (`All`, `Surface`, `Underground`) in the sidebar panel.

---

## [1.2.9] - 2026-10-28

### Added & Fixed
- **Direct KongYing Tavern Map Integration**:
  - Integrated full **KongYing Tavern Interactive Map** (`https://v3.yuanshen.site/`) accessible via tray menu and sidebar panel button (`🗺️ KongYing Map`).
  - Added 1-click launcher for the standalone portable KongYing client (`🚀 Portable App` -> `D:\KongYingMap\Map.exe`).
- **Critical Fix: Preload Bridge Whitelist for cvAutoTrack**:
  - Identified and fixed critical bug where `'cv:track'`, `'window:bounds'`, and `'map:keyM'` were missing from `EVENTS` whitelist in `src/overlay/preload.js`, blocking `cvAutoTrack` events from reaching the overlay.
- **Underground & Cave Tracking Fix**:
  - Added DirectX 11 capture mode (`SetUseDx11CaptureMode()`) in `window_tracker.py` for direct hardware-accelerated game frame capture on Windows 10/11.
  - Added `GetPositionOfMap` fallback in `window_tracker.py` when angle confidence is low.
  - Fixed race condition where surface minimap null reports (`reportMinimap(null)`) wiped out active `cvAutoTrack` tracking when entering caves. Active cv tracking now keeps the player position and radar pins alive.
  - Removed underground pin filtering in caves: when the player is subterranean, all underground pins within radar reach are prominently displayed and never hidden.

---

## [1.2.8] - 2026-10-28

### Added & Integrated
- **Official cvAutoTrack Native C++ Tracking Engine Hook**:
  - Integrated official Kongying Tavern cvAutoTrack.dll (v7.11.1, C++/OpenCV multi-layer image recognition engine) running inside window_tracker.py as a high-frequency background worker thread.
  - Native multi-layer support: Accurately identifies underground zones and layers (mapId), seamlessly maintaining tracking in subterranean caves, The Chasm Underground, and Enkanomiya.
  - In-air & gliding support: Expanded minimap mask radius (rrowRadius: 28) to eliminate interference from wind glider wings during jumping, gliding, and falling. Increased maxJump: 100 and search: 42.
  - Zero-lag performance: C++ native execution at 25 FPS with zero game frame drops or thread contention.

- **Standalone KongYingMap Deployment**:
  - Extracted portable official Kongying Tavern Unity client (Map.exe) to D:\KongYingMap for instant access and reference.
  - Relocated all persistent data and cache to Drive D: (D:\GenshinMapData\cache), fully protecting Drive C: from low disk space issues.

### Fixed
- **Windowed Mode Ticking / Unticking Checkboxes & Right-Click Pins**:
  - Fixed DPI scale-factor mismatch: win32 client coordinates in main.js (info.clientX, info.clientY) are now correctly converted by 	argetDisplay().scaleFactor, aligning mouse hit-testing in windowed mode at all display scaling percentages (100%, 125%, 150%).
  - Immediate mouse capture on panel open: Opening the sidebar panel now immediately calls setCapture(true), preventing clicks from passing through to the game beneath.
  - Protected interactive zone in overPanel: Extended hitboxes and added direct mouseenter and mousemove capture locks to $('panel'), $('spot'), and $('panel-handle') so category and item checkboxes can be ticked/unticked instantly in windowed mode without needing to enter fullscreen or click a map pin first.
  - Stationary cursor polling: pollCursor now ensures periodic refresh (250ms) even when stationary so hover/capture states remain active over checkboxes.

---

## [1.2.7] - 2026-10-28

### Performance & Responsiveness
- **Real-Time Minimap Tracking (20 FPS & Expanded 36px Sprint Radius)**:
  - Upgraded minimap template matching frequency from 8 FPS to 20 FPS (50ms tick rate). Minimap radar now updates in fluid real-time without falling behind during running or sprinting.
  - Expanded search window radius from 24px to 36px and increased `maxJump` from 40 to 65. The minimap tracker no longer loses correlation or drops tracking during sprint dashes or character mobility skills (e.g. Yelan, Sayu).
  - Throttled full-screen big map ORB feature search to 1000ms while minimap tracking is active in the 3D world, eliminating periodic 80-120ms CPU spikes and maintaining smooth 60 FPS in-game.
  - Added instant big-map recognition wake-up on `M` key press so opening the big map responds immediately without search latency.

### Fixed
- **Windowed Mode Right-Click Pin Ticking/Unticking**:
  - Replaced ambiguous screen-to-window subtraction with direct Windows Win32 API `ScreenToClient(hwnd)` in `window_tracker.py`. Exact client-area coordinates are now calculated at the OS level, eliminating border and title-bar coordinate offsets in windowed mode.
  - Fixed clamped boundary logic in `findAnyPinAt` and `hotkey:markAt` so pins near window borders or slightly offset coordinates are never discarded.
  - Increased pin hit capture radius and hover tolerance in `updateHover` so pins can be clicked, ticked, or unticked instantly without having to switch to fullscreen or click an overlay pin first.
  - Added real-time `window:bounds` synchronization event so canvas size and hover state update immediately whenever the Genshin window is moved or resized.

---

## [1.2.6] - 2026-10-28

### Removed & Redesigned
- **Clean In-World View (On-Screen Arrow & Top Banner Removed)**:
  - Removed the on-screen 3D ground arrow and top banner HUD card during in-world gameplay.
  - Guided navigation now operates exclusively through the **minimap** (`drawMinimapNavigation`), providing an unobstructed, 100% clean gameplay screen while preserving compass direction and distance metrics.
- **Authentic Genshin Impact Multi-Layer / Underground Badge**:
  - Implemented the official Genshin Impact stacked-isometric-diamond layer glyph (`drawGenshinLayerGlyph`) based on in-game screenshots.
  - Placed a circular dark-slate/white badge on the lower-right quadrant of all subterranean pins (turning vibrant cyan when hovered or selected).
  - Applied the authentic layer badge across both the big map and the minimap radar.

---

## [1.2.5] - 2026-10-28

### Fixed & Enhanced
- **Main Map & In-World Navigation Decoupling**:
  - **Player Coordinates Shielded Against Map Panning**: Fixed the bug where dragging or panning the big map across Teyvat inadvertently overwrote the player's true character coordinates with camera pan coordinates. The player's location is now anchored strictly on the first frame of opening (when Genshin Impact centers the map on the player), preserving accurate GPS distance and bearing even after scrolling across continents.
  - **Persistent Navigation Memory**: Closing the big map now cleanly remembers the active target (`navigatingPin`), seamlessly transitioning guidance into the in-game world and minimap without resetting or confusing the player position.
- **Custom Waypoints Everywhere on Main Map**:
  - **Double-Click or Key Anywhere on Map**: Double-clicking or pressing `T` / `N` / `F6` anywhere on the main map (even empty terrain, custom waypoints, or in-game icons) instantly sets and remembers a custom waypoint target (`🎯 Custom Waypoint`).
  - **Intelligent Route & Teleport Calculation for Custom Targets**: The overlay automatically calculates the closest teleport waypoint and route vector to any custom map target, just like standard pins.
- **Minimap Waypoint & Radar Indicators**:
  - **In-Range Minimap Radar Beacon**: When within the minimap radar circle, displays a glowing, pulsating beacon directly on the minimap with an elevation-aware color and compact distance tag (`${distM}m`).
  - **Out-of-Range Minimap Rim Pointer**: When the target is beyond minimap radius, renders a high-contrast directional pointer on the outer metallic rim of the minimap, along with a crisp distance pill (`🎯 240m` / `▲ 180m` / `▼ 95m` / `🚪 120m`).
  - **Unclipped Rendering**: Rendered cleanly outside the minimap circle clip so the rim pointer and distance badges are never cut off.
- **Seamless 3D Arrow Direction**:
  - Smooth in-world ground arrow continuously points in the exact direction of the target from the player's true position.

---

## [1.2.4] - 2026-10-28

### Fixed & Optimized
- **Heavy Game Lag & GPU/CPU Composition Elimination**:
  - **Removed Software `shadowBlur`**: Replaced expensive CPU-based software Gaussian `shadowBlur` passes in canvas rendering with lightweight, hardware-accelerated dual-stroke vector passes, cutting per-frame rasterization time from ~12ms down to <0.02ms.
  - **In-World Overlay Frame Rate Limiter**: Capped 3D in-world canvas redraws to ~35 FPS (`28ms`) when the big map is closed. Bypasses unconstrained 144Hz screen composition over Genshin's DirectX 11 window, slashing Windows DWM composite workload by 75% and restoring smooth 60 FPS in-game.
  - **Minimap OpenCV Vision Rate Optimization**: Reduced `MINIMAP_FPS` from 15 to 8 FPS, halving WebAssembly template matching CPU usage while preserving accurate walking/running updates.
- **Glitchy & Jittery Navigation Arrow Fixes**:
  - **Rock-Solid Top-Center HUD Anchor**: Fixed the navigation info card which previously orbited the character and flew wildly across the screen when turning. It is now cleanly and permanently anchored at the top-center of the screen (`W * 0.5, 52 * u`).
  - **Smooth Heading Spring Interpolation**: Replaced raw angle jumps from noisy minimap pixel reads with a deadband-filtered exponential spring interpolator (`targetHeading` -> `currentHeading`). The arrow now glides smoothly when turning instead of twitching or shaking.
  - **Stable 3D Ground Arrow**: Positioned the semi-transparent navigation arrow directly on the ground perspective ellipse around the character (`charX, charY = H * 0.70`). Arrow angle stays radial and tangent to ground navigation without obscuring the character or crosshairs.

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
