let navigatingPin = null;
// Overlay: Marker auf der Ingame-Karte + Panel.
// Maus nur über Marker/Panel abfangen, sonst geht alles ans Spiel (ziehen, zoomen, Wegpunkte).
/* global I18n, Media, Hud */
const api = window.overlayApi;
const $ = (id) => document.getElementById(id);

const canvas = $('markers');
const ctx = canvas.getContext('2d');
const BUSY_PHASES = ['starting', 'loading', 'download', 'building'];
const ERROR_PHASES = ['error', 'capture-error'];
const MAX_DRAWN = 5000;

let settings = { language: 'en', enabledTypes: [], hideFound: false, opacity: 1, markerSize: 26, hotkeys: {}, active: true };
let data = null;
let typeIndexByKey = new Map();
let markerIndexById = new Map();
let markersByType = [];
let enabled = new Set();
let found = new Set();
let foundByType = new Uint32Array(0);
let trackerStatus = { phase: 'starting', message: '', progress: 0 };
let target = null;
let velocity = null;
let view = null;
// Spielfigur auf der Minimap (Kartenpixel), vom Tracker; null = keine Minimap-Marker
let minimap = null;
// angebotener Marker in der Nähe (Index in data.markers) und kurz die Bestätigung nach dem Markieren
let nearby = -1;
let nearbyDoneUntil = 0;
let visibility = 0;
let hover = -1;
let drawnCount = 0;
const drawnIndex = new Int32Array(MAX_DRAWN);
const drawnX = new Float32Array(MAX_DRAWN);
const drawnY = new Float32Array(MAX_DRAWN);
let panelOpen = false;
let captured = false;
let frameRequested = false;
let mouse = { x: -1, y: -1 };
let toastTimer;
let spot = null;
let spotCloseTimer;
const mediaUrls = new Map();
const MAX_MEDIA_URLS = 40;

const iconBytes = new Map();
const iconBitmaps = new Map();
const iconUrls = new Map();

// ---------- Hilfsfunktionen ----------

const tt = (key, params) => I18n.t(settings.language, key, params);

// 1 bei 1080p, 2 bei 4K: Größen skalieren mit der Höhe wie die Genshin-UI (--u in overlay.css)
const uiScale = () => innerHeight / 1080;

function applyStaticTexts() {
  document.documentElement.lang = I18n.resolve(settings.language);
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tt(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = tt(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', tt(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tt(el.dataset.i18nPlaceholder);
}

function requestDraw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(tick);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}

function setCapture(on) {
  if (on === captured) return;
  captured = on;
  api.mouse(on);
}

function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function loadIconBytes(key) {
  if (!iconBytes.has(key)) iconBytes.set(key, api.icon(key).catch(() => null));
  return iconBytes.get(key);
}

function iconBitmap(key) {
  if (iconBitmaps.has(key)) return iconBitmaps.get(key);
  iconBitmaps.set(key, null);
  loadIconBytes(key).then(async (bytes) => {
    if (!bytes || !bytes.length) return;
    iconBitmaps.set(key, await createImageBitmap(new Blob([bytes], { type: 'image/png' })));
    requestDraw();
  });
  return null;
}

async function iconUrl(key) {
  if (iconUrls.has(key)) return iconUrls.get(key);
  const bytes = await loadIconBytes(key);
  const url = bytes && bytes.length ? URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) : null;
  iconUrls.set(key, url);
  return url;
}

// ---------- Ansicht (vom Tracker) ----------

function isJump(a, b) {
  const ratio = a.sx / b.sx;
  return ratio > 1.4 || ratio < 0.7 || Math.abs(a.ox - b.ox) > 0.25 || Math.abs(a.oy - b.oy) > 0.25;
}

// Messrauschen (2-7 px pro Bild) glätten, One-Euro-Filter:
// - langsam/still → stark glätten, schnell → kaum (kein Nachziehen beim Ziehen/Zoomen)
// - gefiltert: Zoom (log) und Kartenpunkt in Bildschirmmitte, Tempo in Bildschirmpixeln/s
const FILTER_MIN_HZ = 3.5;
const FILTER_BETA = 0.3;

class OneEuro {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }

  filter(x, t, pxPerUnit) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    this.t = t;
    const alpha = (hz) => 1 / (1 + 1 / (2 * Math.PI * hz * dt));
    this.dx += alpha(1) * ((x - this.x) / dt - this.dx);
    this.x += alpha(FILTER_MIN_HZ + FILTER_BETA * Math.abs(this.dx) * pxPerUnit) * (x - this.x);
    return this.x;
  }
}

const viewFilter = { zoom: new OneEuro(), cx: new OneEuro(), cy: new OneEuro() };

// y-Maßstab getrennt halten (k = y/x):
// - Aufnahme nicht exakt im Bildschirmverhältnis, z. B. 1366×768 → 1280×720 (gerundet), k ≈ 1,0005
// - Kartenpixel um 1e6 → schon 0,05 % ergeben sonst Hunderte Pixel Versatz
function smoothView(next, t) {
  const W = innerWidth;
  const H = innerHeight;
  const s = next.sx * W;
  const k = (next.sy * H) / s;
  // Instant Zoom Anchor: If zooming, snap scale directly so pins stay 100% anchored to terrain
  if (viewFilter.zoom.x !== null) {
    const prevS = Math.exp(viewFilter.zoom.x);
    if (Math.abs(s - prevS) / Math.max(1, prevS) > 0.015) {
      viewFilter.zoom.reset();
      viewFilter.cx.reset();
      viewFilter.cy.reset();
    }
  }
  const ls = viewFilter.zoom.filter(Math.log(s), t, H / 2);
  const fs = Math.exp(ls);
  const cx = viewFilter.cx.filter((W / 2 - next.ox * W) / s, t, fs);
  const cy = viewFilter.cy.filter((H / 2 - next.oy * H) / (s * k), t, fs);
  return { ...next, sx: fs / W, sy: (fs * k) / H, ox: (W / 2 - fs * cx) / W, oy: (H / 2 - fs * k * cy) / H };
}

// Restschwankung unter STICK_PX (bei 1080p): Marker bleiben exakt stehen
const STICK_PX = 2;

// größte Verschiebung zwischen zwei Ansichten in Bildschirmpixeln (Ecken + Mitte)
function viewShift(a, b) {
  let worst = 0;
  for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
    const mx = (px - a.ox) / a.sx;
    const my = (py - a.oy) / a.sy;
    worst = Math.max(worst, Math.hypot((b.sx * mx + b.ox - px) * innerWidth, (b.sy * my + b.oy - py) * innerHeight));
  }
  return worst;
}

function holdStill(current, next) {
  return !!current && viewShift(current, next) < STICK_PX * (innerHeight / 1080);
}

// Zwischen zwei Erkennungen (ca. 70-100 ms) mit letzter Geschwindigkeit weiterrechnen,
// sonst stehen die Marker beim Ziehen/Zoomen kurz und springen dann.
const PREDICT_MAX_MS = 120;
const PREDICT_LEAD_MS = 30;

function updateVelocity(prev, next) {
  const dt = next.at - prev.at;
  if (dt <= 0 || dt > 400 || isJump(prev, next)) {
    velocity = null;
    return;
  }
  const v = {
    ls: 0,
    ox: (next.ox - prev.ox) / dt,
    oy: (next.oy - prev.oy) / dt,
  };
  velocity = velocity
    ? { ls: 0, ox: (velocity.ox + v.ox) / 2, oy: (velocity.oy + v.oy) / 2 }
    : v;
}

function predicted(now) {
  if (!velocity) return target;
  const dt = Math.min(PREDICT_MAX_MS, now - target.at + PREDICT_LEAD_MS);
  const f = Math.exp(velocity.ls * dt);
  return { sx: target.sx * f, sy: target.sy * f, ox: target.ox + velocity.ox * dt, oy: target.oy + velocity.oy * dt };
}

function tick(now) {
  frameRequested = false;
  let animating = false;
  if (target) {
    const goal = predicted(now);
    if (!view || isJump(view, goal)) {
      view = { ...goal };
    } else {
      // Weich nachziehen, damit kleine Messschwankungen nicht zittern.
      for (const k of ['sx', 'sy', 'ox', 'oy']) view[k] += (goal[k] - view[k]) * 0.5;
      const dx = Math.abs(goal.ox - view.ox) * innerWidth;
      const dy = Math.abs(goal.oy - view.oy) * innerHeight;
      animating = dx > 0.3 || dy > 0.3 || Math.abs(goal.sx / view.sx - 1) > 0.001;
    }
    if (velocity && now - target.at < PREDICT_MAX_MS) animating = true;
    visibility = Math.min(1, visibility + 0.25);
  } else {
    visibility = Math.max(0, visibility - 0.2);
  }
  animating = animating || (target ? visibility < 1 : visibility > 0);
  draw();
  if (animating) requestDraw();
}

function draw() {
  const W = innerWidth;
  const H = innerHeight;
  ctx.clearRect(0, 0, W, H);
  drawnCount = 0;
  if (!data || !view || visibility <= 0) {
    if (data && minimap && settings.minimap !== false && visibility <= 0) drawMinimap();
    else if (nearby >= 0) setNearby(-1);
    updateHover();
    return;
  }

  const u = uiScale();
  const size = settings.markerSize * u;
  const half = size / 2;
  // keine Marker über den Knöpfen der Ingame-Karte (verdecken sie, fangen Klicks ab)
  const hud = Hud.rects(W, H);
  const underHud = (x, y) => hud.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const { x: mx, y: my, id: ids, underground: ug, layerId: lId } = data.markers;
  const ax = view.sx * W;
  const bx = view.ox * W;
  const ay = view.sy * H;
  const by = view.oy * H;
  const baseAlpha = settings.opacity * visibility;
  const activeLayer = settings.layerFilter || 'all';

  // Symbole sind Stecknadeln wie im Spiel: Spitze (unten Mitte) sitzt auf der Markerposition.
  // (x, y) = Spitze, cy = Symbolmitte
  for (const t of enabled) {
    const list = markersByType[t];
    if (!list) continue;
    const icon = iconBitmap(data.types[t].key);
    for (let k = 0; k < list.length && drawnCount < MAX_DRAWN; k++) {
      const i = list[k];
      const isUg = ug && ug[i] === 1;
      if (activeLayer === 'surface' && isUg) continue;
      if (activeLayer === 'underground' && !isUg) continue;

      const x = ax * mx[i] + bx;
      const y = ay * my[i] + by;
      if (x < -half || y < 0 || x > W + half || y > H + size) continue;
      const isFound = found.has(ids[i]);
      if (isFound && settings.hideFound) continue;
      const cy = y - half;
      if (underHud(x, cy)) continue;

      ctx.globalAlpha = baseAlpha * (isFound ? 0.35 : 1);
      if (icon) {
        // ganze Pixel: kein Flimmern der Kanten bei Bruchteil-Bewegungen
        ctx.drawImage(icon, Math.round(x - half), Math.round(y - size), Math.round(size), Math.round(size));
      } else {
        ctx.fillStyle = isUg ? '#38bdf8' : '#d3bc8e';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, half * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
      if (isUg) {
        const floorName = (data.layers && lId) ? data.layers[lId[i]] : 'Underground';
        drawUndergroundBadge(x, y, half, size, u, floorName);
      }
      if (isFound) drawCheck(x + half * 0.5, cy - half * 0.5, Math.max(6 * u, size * 0.28));

      drawnIndex[drawnCount] = i;
      drawnX[drawnCount] = x;
      drawnY[drawnCount] = cy;
      drawnCount++;
    }
  }
  ctx.globalAlpha = 1;
  updateHover();
  if (hover >= 0) {
    const x = ax * mx[hover] + bx;
    const cy = ay * my[hover] + by - half;
    ctx.strokeStyle = '#ffe6b2';
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.arc(x, cy, half + 3 * u, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (spot) {
    const x = ax * mx[spot.index] + bx;
    const cy = ay * my[spot.index] + by - half;
    ctx.globalAlpha = visibility;
    ctx.strokeStyle = '#d3bc8e';
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.arc(x, cy, half + 6 * u, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// Minimap (Weltansicht): Marker im Kreis oben links, kleiner, ohne Klicks.
// Geometrie wie MinimapCore.GEOMETRY bei 1080p, skaliert mit der Höhe; Zoom (scale) meldet der Tracker.
const MINIMAP = { cx: 168, cy: 125, radius: 98, iconScale: 0.6 };

function drawMinimap() {
  const u = uiScale();
  const cx = MINIMAP.cx * u;
  const cy = MINIMAP.cy * u;
  const r = MINIMAP.radius * u;
  const s = minimap.scale * u;
  const size = Math.max(10, settings.markerSize * u * MINIMAP.iconScale);
  const half = size / 2;
  // Kartenpixel-Radius, in dem Marker überhaupt in den Kreis fallen können
  const reach = (r * 2.8) / s; // Extended radar range for minimap
  // „in der Nähe“: Kartenpixel (z13) zwischen Spielfigur und Marker, einstellbar (nearbyRadius)
  const near = settings.nearbyRadius || 7;
  const { x: mx, y: my, id: ids, underground: ug } = data.markers;
  const activeLayer = settings.layerFilter || 'all';
  let closest = -1;
  let closestD = Infinity;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  for (const t of enabled) {
    const list = markersByType[t];
    if (!list) continue;
    const type = data.types[t];
    const icon = iconBitmap(data.types[t].key);
    for (const i of list) {
      const isUg = ug && ug[i] === 1;
      if (activeLayer === 'surface' && isUg) continue;
      if (activeLayer === 'underground' && !isUg) continue;

      const dx = mx[i] - minimap.x;
      const dy = my[i] - minimap.y;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const isFound = found.has(ids[i]);
      if (isFound && settings.hideFound) continue;
      const x = cx + dx * s;
      const y = cy + dy * s;
      const d = Math.hypot(dx, dy);
      const distPx = d * s;
      const isOculus = type && (type.name.toLowerCase().includes('oculus') || type.name.toLowerCase().includes('oculi') || type.name.toLowerCase().includes('chest'));

      if (distPx > r) {
        // Outside circular minimap: if it's an oculus or chest, draw indicator on edge of minimap!
        if (isOculus && !isFound) {
          const angle = Math.atan2(dy, dx);
          const edgeX = cx + Math.cos(angle) * (r - 8 * u);
          const edgeY = cy + Math.sin(angle) * (r - 8 * u);
          ctx.save();
          ctx.globalAlpha = 0.9;
          if (icon) {
            const miniSize = Math.max(14, size * 0.8);
            ctx.drawImage(icon, Math.round(edgeX - miniSize / 2), Math.round(edgeY - miniSize / 2), Math.round(miniSize), Math.round(miniSize));
          } else {
            ctx.fillStyle = '#60a5fa';
            ctx.beginPath();
            ctx.arc(edgeX, edgeY, 5 * u, 0, Math.PI * 2);
            ctx.fill();
          }
          if (isUg) {
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.moveTo(edgeX - 4 * u, edgeY + 6 * u);
            ctx.lineTo(edgeX + 4 * u, edgeY + 6 * u);
            ctx.lineTo(edgeX, edgeY + 10 * u);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        }
        continue;
      }

      if (!isFound && d <= near && (closest < 0 || d < closestD)) {
        closest = i;
        closestD = d;
      }
      ctx.globalAlpha = settings.opacity * (isFound ? 0.35 : 1);
      if (icon) ctx.drawImage(icon, Math.round(x - half), Math.round(y - size), Math.round(size), Math.round(size));
      else {
        ctx.fillStyle = isUg ? '#38bdf8' : '#d3bc8e';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, half * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
      if (isUg) {
        ctx.save();
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.moveTo(x - 3 * u, y + 1 * u);
        ctx.lineTo(x + 3 * u, y + 1 * u);
        ctx.lineTo(x, y + 5 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }
  // Marker in der Nähe: pulsierender Ring um das Symbol
  if (closest >= 0) {
    const x = cx + (mx[closest] - minimap.x) * s;
    const y = cy + (my[closest] - minimap.y) * s - half;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    ctx.strokeStyle = '#ffe6b2';
    ctx.globalAlpha = 0.55 + 0.45 * pulse;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.arc(x, y, half + (3 + 2 * pulse) * u, 0, Math.PI * 2);
    ctx.stroke();
    requestDraw();
  }
  // Navigation / Waypoint Indicator on Minimap
  if (navigatingPin && minimap) {
    const dx = navigatingPin.x - minimap.x;
    const dy = navigatingPin.y - minimap.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const maxR = r - 12 * u;
    const ax = cx + Math.cos(angle) * maxR;
    const ay = cy + Math.sin(angle) * maxR;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(8 * u, 0);
    ctx.lineTo(-8 * u, -6 * u);
    ctx.lineTo(-4 * u, 0);
    ctx.lineTo(-8 * u, 6 * u);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  setNearby(closest);
}

// Hinweis rechts neben der Minimap + Nähe-Taste im Hauptprozess (nur solange etwas angeboten wird)
function setNearby(index) {
  if (index === nearby) return;
  nearby = index;
  api.nearby(index >= 0 ? data.markers.id[index] : null);
  renderNearby();
}

function renderNearby() {
  const el = $('nearby');
  const done = performance.now() < nearbyDoneUntil;
  el.classList.toggle('done', done);
  if (nearby < 0 && !done) {
    el.hidden = true;
    return;
  }
  if (nearby >= 0) {
    const type = data.types[data.markers.type[nearby]];
    $('nearby-name').textContent = tt('ui.nearby', { name: type.name });
    iconUrl(type.key).then((url) => { if (url) $('nearby-icon').src = url; });
  }
  $('nearby-action').textContent = done ? `✓ ${tt('ui.nearbyDone')}` : tt('ui.nearbyAction', { key: (settings.hotkeys || {}).markNearby || 'Alt+E' });
  el.hidden = false;
}

function drawCheck(x, y, r) {
  ctx.globalAlpha = Math.min(1, settings.opacity * visibility);
  ctx.fillStyle = '#3f9d57';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, r * 0.3);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.45, y);
  ctx.lineTo(x - r * 0.1, y + r * 0.4);
  ctx.lineTo(x + r * 0.5, y - r * 0.35);
  ctx.stroke();
}

function drawUndergroundBadge(x, y, half, size, u, floorName) {
  const isFloor = floorName && floorName !== 'Underground' && floorName !== 'Surface';
  const text = isFloor ? floorName : '▼';
  const h = Math.max(10 * u, size * 0.42);
  const w = isFloor ? Math.max(18 * u, size * 0.72) : Math.max(12 * u, size * 0.48);
  const bx = x + half * 0.45;
  const by = y - half * 0.35;
  const r = h / 2;

  ctx.save();
  ctx.globalAlpha = Math.min(1, (settings.opacity || 1) * (visibility || 1));
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = Math.max(1, 1.2 * u);

  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx - w / 2, by - h / 2, w, h, r);
  } else {
    ctx.rect(bx - w / 2, by - h / 2, w, h);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#38bdf8';
  ctx.font = `bold ${Math.round(h * 0.75)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx, by + (isFloor ? 0.5 * u : 0));
  ctx.restore();
}

// ---------- Maus ----------

function overPanel(x, y) {
  const inside = (el) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  // Lightbox deckt alles ab, Klick irgendwo schließt sie.
  if (!$('lightbox').hidden) return true;
  if (panelOpen && inside($('panel'))) return true;
  if (spot && inside($('spot'))) return true;
  return !$('panel-handle').hidden && inside($('panel-handle'));
}

function renderHandle() {
  const show = !!target && !panelOpen;
  const handle = $('panel-handle');
  if (handle.hidden === !show) return;
  handle.hidden = !show;
  updateHover();
}

function updateHover() {
  const u = uiScale();
  // Pin hit radius matching the icon size so empty map dragging is effortless
  const radius = Math.max(16, (settings.markerSize / 2 + 5) * u);
  let best = -1;
  let bestDist = radius * radius;
  if (mouse.x >= 0 && !overPanel(mouse.x, mouse.y)) {
    for (let k = 0; k < drawnCount; k++) {
      const dx = drawnX[k] - mouse.x;
      const dy = drawnY[k] - mouse.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = drawnIndex[k];
      }
    }
  }
  if (best !== hover) {
    hover = best;
    requestDraw();
  }
  // Capture mouse when hovering over a pin (so it can be selected/right-clicked), over panel, or modal
  const isOverInteractive = (hover >= 0) || overPanel(mouse.x, mouse.y) || (spot !== null && overSpot(mouse.x, mouse.y));
  setCapture(isOverInteractive);
  renderTooltip();
}

function renderTooltip() {
  const el = $('tooltip');
  if (hover < 0 || !data) {
    el.hidden = true;
    return;
  }
  const type = data.types[data.markers.type[hover]];
  const isFound = found.has(data.markers.id[hover]);
  const isUg = data.markers.underground && data.markers.underground[hover] === 1;
  const floorName = (data.layers && data.markers.layerId) ? data.layers[data.markers.layerId[hover]] : 'Underground';
  const layerLabel = isUg ? ` • 🕳️ Underground (${floorName})` : ` • ☀️ Surface`;
  $('tooltip-name').textContent = type.name + layerLabel;
  $('tooltip-hint').textContent = tt(isFound ? 'ui.tipFound' : 'ui.tipOpen');
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const u = uiScale();
  el.style.left = `${Math.min(mouse.x + 16 * u, innerWidth - r.width - 8 * u)}px`;
  el.style.top = `${Math.min(mouse.y + 16 * u, innerHeight - r.height - 8 * u)}px`;
}

window.addEventListener('mousemove', (event) => {
  mouse = { x: event.clientX, y: event.clientY };
  updateHover();
});

window.addEventListener('mouseleave', () => {
  mouse = { x: -1, y: -1 };
  updateHover();
});

// Gepollte Cursorposition aus main.js: Ist Genshin vorne, kommen keine Mausevents an.
api.on('cursor', (point) => {
  const inside = point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight;
  mouse = inside ? point : { x: -1, y: -1 };
  updateHover();
});

let mousePressInfo = null;

window.addEventListener('mousedown', (event) => {
  if (overPanel(event.clientX, event.clientY)) return;
  if (spot !== null && overSpot(event.clientX, event.clientY)) return;

  if (hover >= 0) {
    if (event.button === 2) {
      // Right-click on pin: mark as collected / found
      event.preventDefault();
      toggleFoundMarker(hover);
      return;
    }
    if (event.button === 0) {
      // Left-click on pin: record start position to distinguish click vs drag
      mousePressInfo = { x: event.clientX, y: event.clientY, index: hover };
    }
  } else {
    // Click on empty map: immediately release capture so game pans freely
    if (event.button === 0) {
      setCapture(false);
    }
  }
});

window.addEventListener('mousemove', (event) => {
  mouse = { x: event.clientX, y: event.clientY };
  if (mousePressInfo) {
    const dist = Math.hypot(event.clientX - mousePressInfo.x, event.clientY - mousePressInfo.y);
    if (dist > 5) {
      // User is dragging map! Release capture so the game receives the drag
      mousePressInfo = null;
      setCapture(false);
    }
  }
  updateHover();
});

window.addEventListener('mouseup', (event) => {
  if (mousePressInfo && event.button === 0) {
    const idx = mousePressInfo.index;
    mousePressInfo = null;
    openSpot(idx);
  } else {
    mousePressInfo = null;
  }
});

window.addEventListener('contextmenu', (event) => {
  if (hover >= 0 || overPanel(event.clientX, event.clientY)) {
    event.preventDefault();
  }
});

let lastToggleId = null;
let lastToggleTime = 0;

function toggleFoundMarker(index) {
  if (index < 0 || !data || !data.markers) return;
  const id = data.markers.id[index];
  const now = performance.now();
  if (lastToggleId === id && (now - lastToggleTime < 400)) {
    return;
  }
  lastToggleId = id;
  lastToggleTime = now;

  const newState = !found.has(id);
  setFound(id, newState);
  api.toggleFound(id);

  // Auto-remove navigation if collected
  if (newState && navigatingPin && navigatingPin.id === id) {
    navigatingPin = null;
    renderSpotNav();
  }

  const type = data.types[data.markers.type[index]];
  showToast(newState ? `✓ Marked found: ${type ? type.name : 'Marker'}` : `↶ Unmarked: ${type ? type.name : 'Marker'}`);
}

// ---------- Gefunden ----------

function recountFound() {
  if (!data) return;
  foundByType = new Uint32Array(data.types.length);
  for (const id of found) {
    const i = markerIndexById.get(id);
    if (i !== undefined) foundByType[data.markers.type[i]]++;
  }
}

function setFound(id, isFound) {
  if (found.has(id) === isFound) return;
  if (isFound) found.add(id);
  else found.delete(id);
  const i = markerIndexById.get(id);
  if (i !== undefined) {
    foundByType[data.markers.type[i]] += isFound ? 1 : -1;
    updateTypeCount(data.markers.type[i]);
  }
  if (spot && data.markers.id[spot.index] === id) renderSpotFound();
  requestDraw();
}

// ---------- Fundort-Karte ----------

// Auswahl wie beim Import (shared/media.js) → genau diese Fotos liegen auf dem eigenen Server
function spotMedia(items) {
  const votesOf = (item) => item.votes;
  const media = Media.topPhotos(items, (item) => item.image, votesOf).map((item) => ({ image: item.image, votes: item.votes }));
  const video = Media.topVideo(items, (item) => item.text, votesOf);
  if (video) media.push(video.link);
  return media;
}

async function openSpot(index) {
  clearTimeout(spotCloseTimer);
  closeLightbox();
  spot = { index, media: [], summary: '', loading: false, error: false };
  const type = data.types[data.markers.type[index]];
  $('spot-name').textContent = type.name;
  $('spot-icon').removeAttribute('src');
  iconUrl(type.key).then((url) => {
    if (url && spot && spot.index === index) $('spot-icon').src = url;
  });
  $('spot').classList.add('open');
  $('spot-body').scrollTop = 0;
  renderSpotLayerBadge(index);
  renderSpotFound();
  renderSpotNav();
  requestDraw();
  await loadSpot();
}


function renderSpotLayerBadge(index) {
  const badgeEl = $('spot-layer-badge');
  if (!badgeEl || !data) return;
  const isUg = data.markers.underground && data.markers.underground[index] === 1;
  const floorName = (data.layers && data.markers.layerId) ? data.layers[data.markers.layerId[index]] : 'Underground';
  const markerId = data.markers.id[index];
  const entIds = (data.entrances && data.entrances[markerId]) || [];

  if (isUg) {
    badgeEl.className = 'spot-layer-badge underground';
    let entHtml = '';
    if (entIds.length) {
      entHtml = `
        <div class="entrances">
          <span>🚪 Cave Entrance:</span>
          ${entIds.map((eid) => `<button class="entrance-btn" data-eid="${eid}" type="button">Entrance #${eid}</button>`).join(' ')}
        </div>
      `;
    }
    badgeEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
        <span>🕳️ <strong>Underground (Subterranean)</strong></span>
        <span style="background:rgba(56,189,248,0.3);padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">Floor: ${floorName}</span>
      </div>
      ${entHtml}
    `;
    badgeEl.querySelectorAll('.entrance-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetEid = Number(btn.dataset.eid);
        const entIdx = markerIndexById.get(targetEid);
        if (entIdx !== undefined) {
          openSpot(entIdx);
          showToast(`Navigating to Cave Entrance #${targetEid}`);
        } else {
          showToast(`Cave Entrance #${targetEid} not indexed`);
        }
      });
    });
  } else {
    badgeEl.className = 'spot-layer-badge surface';
    badgeEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
        <span>☀️ <strong>Surface (Above Ground)</strong></span>
        <span style="opacity:0.8;font-size:11px;">Open World</span>
      </div>
    `;
  }
}

function closeSpot() {
  clearTimeout(spotCloseTimer);
  closeLightbox();
  spot = null;
  $('spot').classList.remove('open');
  updateHover();
  requestDraw();
}

async function loadSpot() {
  const current = spot;
  if (!current || current.loading) return;
  current.loading = true;
  current.error = false;
  renderSpot();
  const typeKey = data.types[data.markers.type[current.index]].key;
  const result = await api.comments(typeKey, data.markers.id[current.index], 1).catch(() => null);
  if (spot !== current) return; // inzwischen ein anderer Marker gewählt
  current.loading = false;
  if (!result || result.error) {
    current.error = true;
  } else {
    current.summary = result.summary;
    current.media = spotMedia(result.comments);
  }
  renderSpot();
}

function renderSpotFound() {
  if (!spot) return;
  const isFound = found.has(data.markers.id[spot.index]);
  const button = $('spot-found');
  button.textContent = tt(isFound ? 'spot.markOpen' : 'spot.markFound');
  button.classList.toggle('done', isFound);
}

function spotNote(text, buttonText, onClick) {
  const note = document.createElement('div');
  note.className = 'spot-note';
  note.textContent = text;
  if (buttonText) {
    const button = document.createElement('button');
    button.className = 'gi-btn small';
    button.type = 'button';
    button.textContent = buttonText;
    button.addEventListener('click', onClick);
    note.append(document.createElement('br'), button);
  }
  return note;
}

function renderSpot() {
  const body = $('spot-body');
  body.textContent = '';
  if (!spot) return;
  const s = spot;
  if (s.loading) {
    body.append(mediaTile(null));
    return;
  }
  if (s.error) {
    body.append(spotNote(tt('spot.failed'), tt('spot.retry'), loadSpot));
    return;
  }
  if (s.media.length) {
    const media = document.createElement('div');
    media.className = 'media';
    for (const item of s.media) media.append(mediaTile(item));
    body.append(media);
  } else {
    body.append(spotNote(tt('spot.none')));
  }
  if (s.summary) {
    const summary = document.createElement('div');
    summary.className = 'summary';
    const label = document.createElement('small');
    label.textContent = tt('spot.summary');
    const text = document.createElement('p');
    text.textContent = s.summary;
    summary.append(label, text);
    summary.addEventListener('click', () => summary.classList.toggle('expanded'));
    body.append(summary);
  }
}

// ohne item: Platzhalter während des Ladens
function mediaTile(item) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'media-tile loading';
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('load', () => tile.classList.remove('loading'));
  tile.append(img);
  if (!item) {
    tile.disabled = true;
    return tile;
  }
  const badge = document.createElement('span');
  badge.className = 'media-badge';
  if (item.videoId) {
    tile.classList.add('video');
    tile.title = tt('spot.video');
    const play = document.createElement('span');
    play.className = 'play';
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15L19.5 12z"/></svg>';
    badge.textContent = 'YouTube';
    tile.append(play);
    tile.addEventListener('click', () => api.openLink(item.url));
    loadMediaImage(tile, img, `yt:${item.videoId}`, () => api.videoThumb(item.videoId));
  } else {
    tile.title = tt('spot.enlarge');
    if (item.votes > 0) {
      badge.textContent = `▲ ${item.votes}`;
      badge.title = tt('spot.votes', { n: item.votes });
    }
    tile.addEventListener('click', () => {
      if (img.src) openLightbox(img.src);
    });
    loadMediaImage(tile, img, item.image, () => api.commentImage(item.image));
  }
  tile.append(badge);
  return tile;
}

async function loadMediaImage(tile, img, key, fetchBytes) {
  let url = mediaUrls.get(key);
  if (!url) {
    const bytes = await fetchBytes().catch(() => null);
    if (!bytes || !bytes.length) {
      tile.remove();
      return;
    }
    url = URL.createObjectURL(new Blob([bytes]));
    mediaUrls.set(key, url);
    if (mediaUrls.size > MAX_MEDIA_URLS) {
      const [oldKey, oldUrl] = mediaUrls.entries().next().value;
      mediaUrls.delete(oldKey);
      URL.revokeObjectURL(oldUrl);
    }
  }
  img.src = url;
}

function openLightbox(url) {
  $('lightbox-img').src = url;
  $('lightbox').hidden = false;
  updateHover();
}

function closeLightbox() {
  if ($('lightbox').hidden) return;
  $('lightbox').hidden = true;
  $('lightbox-img').removeAttribute('src');
  updateHover();
}

// ---------- Panel ----------

function setPanel(open) {
  panelOpen = open;
  $('panel').classList.toggle('open', open);
  if (!open) $('search').blur();
  // Außerhalb der Karte hält Genshin den Mauszeiger fest, ans Panel nur mit Alt.
  if (open && !target) showToast(tt('ui.altHint'));
  renderHandle();
  updateHover();
}

function typeLabel(t) {
  return `${foundByType[t] || 0}/${data.types[t].count}`;
}

function updateTypeCount(t) {
  for (const el of document.querySelectorAll(`.type-row[data-type="${t}"] .count`)) el.textContent = typeLabel(t);
}

function updateCategoryHeads() {
  for (const cat of document.querySelectorAll('.cat')) {
    const types = cat.dataset.types.split(',').map(Number);
    const on = types.filter((t) => enabled.has(t)).length;
    cat.querySelector('.cat-count').textContent = `${on}/${types.length}`;
    const all = cat.querySelector('.cat-all');
    all.checked = on === types.length;
    all.indeterminate = on > 0 && on < types.length;
  }
  for (const box of document.querySelectorAll('.type-row input')) box.checked = enabled.has(Number(box.dataset.type));
  $('enabled-count').textContent = tt('ui.enabledCount', { n: enabled.size });
}

function saveEnabled() {
  api.saveSettings({ enabledTypes: [...enabled].map((t) => data.types[t].key) });
  updateCategoryHeads();
  requestDraw();
}

const iconObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    iconObserver.unobserve(img);
    iconUrl(img.dataset.key).then((url) => { if (url) img.src = url; });
  }
}, { root: document.querySelector('#panel .panel-scroll') });

function buildPanel() {
  const root = $('categories');
  root.textContent = '';
  data.categories.forEach((cat, index) => {
    const section = document.createElement('section');
    section.className = index === 0 ? 'cat open' : 'cat';
    section.dataset.types = cat.types.join(',');

    const head = document.createElement('div');
    head.className = 'cat-head';
    head.innerHTML = '<span class="diamond"></span><span class="cat-title"></span><span class="cat-count"></span><input class="cat-all" type="checkbox">';
    head.querySelector('.cat-title').textContent = cat.title;
    head.querySelector('.cat-all').title = tt('ui.categoryToggle');
    head.addEventListener('click', (event) => {
      if (event.target.classList.contains('cat-all')) return;
      section.classList.toggle('open');
    });
    head.querySelector('.cat-all').addEventListener('change', (event) => {
      for (const t of cat.types) {
        if (event.target.checked) enabled.add(t);
        else enabled.delete(t);
      }
      saveEnabled();
    });

    const list = document.createElement('div');
    list.className = 'cat-list';
    for (const t of cat.types) {
      const type = data.types[t];
      const row = document.createElement('label');
      row.className = 'pill type-row';
      row.dataset.type = t;
      row.dataset.name = type.name.toLowerCase();
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.type = t;
      box.addEventListener('change', () => {
        if (box.checked) enabled.add(t);
        else enabled.delete(t);
        saveEnabled();
      });
      const img = document.createElement('img');
      img.alt = '';
      img.dataset.key = type.key;
      iconObserver.observe(img);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = type.name;
      const count = document.createElement('span');
      count.className = 'count value-box';
      count.textContent = typeLabel(t);
      row.append(img, name, count, box);
      list.append(row);
    }
    section.append(head, list);
    root.append(section);
  });
  updateCategoryHeads();
  applySearch();
}

function applySearch() {
  const query = $('search').value.trim().toLowerCase();
  let any = false;
  for (const section of document.querySelectorAll('.cat')) {
    let matches = 0;
    for (const row of section.querySelectorAll('.type-row')) {
      const hit = !query || row.dataset.name.includes(query);
      row.hidden = !hit;
      if (hit) matches++;
    }
    section.hidden = query && matches === 0;
    if (query && matches) section.classList.add('open');
    any = any || matches > 0;
  }
  let empty = $('categories').querySelector('.empty');
  if (!any && query) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      $('categories').append(empty);
    }
    empty.textContent = tt('ui.noResults', { query: $('search').value.trim() });
  } else if (empty) {
    empty.remove();
  }
}

function renderStatus() {
  const phase = trackerStatus.phase;
  let state = 'search';
  let text = tt('ui.searching');
  if (BUSY_PHASES.includes(phase)) {
    state = 'busy';
    text = trackerStatus.message;
  } else if (ERROR_PHASES.includes(phase)) {
    state = 'error';
    text = trackerStatus.message;
  } else if (target) {
    state = 'locked';
    text = tt('ui.locked');
  } else if (phase === 'paused') {
    text = trackerStatus.message;
  }
  $('status').dataset.state = state;
  $('status-text').textContent = text;

  // Vorbereitung/Fehler auch bei geschlossenem Panel zeigen
  const hud = $('hud');
  hud.hidden = !(state === 'busy' || state === 'error');
  $('hud-text').textContent = text;
  $('hud-progress').style.width = `${Math.round((trackerStatus.progress || 0) * 100)}%`;
}

function renderSettings() {
  $('hide-found').checked = settings.hideFound;
  $('show-captures').checked = !!settings.showInCaptures;
  $('minimap').checked = settings.minimap !== false;
  $('opacity').value = Math.round(settings.opacity * 100);
  $('opacity-value').textContent = `${Math.round(settings.opacity * 100)} %`;
  $('size').value = settings.markerSize;
  $('size-value').textContent = `${settings.markerSize} px`;
  updateRangeFill($('opacity'));
  updateRangeFill($('size'));
  const hk = settings.hotkeys || {};
  $('kbd-found').textContent = hk.toggleFound || '';
  const keys = [
    hk.toggleOverlay && `${hk.toggleOverlay} ${tt('ui.key.toggleOverlay')}`,
    hk.togglePanel && `${hk.togglePanel} ${tt('ui.key.togglePanel')}`,
    hk.toggleFound && `${hk.toggleFound} ${tt('ui.key.toggleFound')}`,
    hk.cycleOpacity && `${hk.cycleOpacity} ${tt('ui.key.cycleOpacity')}`,
    hk.markNearby && `${hk.markNearby} ${tt('ui.key.markNearby')}`,
  ].filter(Boolean).join(' · ');
  const errors = settings.hotkeyErrors || [];
  $('keys').textContent = errors.length ? `${keys} – ${tt('ui.keysUnavailable', { keys: errors.join(', ') })}` : keys;
  $('keys').classList.toggle('error', errors.length > 0);
}

function renderDataInfo() {
  if (!data) return;
  const locale = I18n.locale(settings.language);
  const when = new Date(data.updatedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  $('data-info').textContent = tt('ui.dataInfo', { count: data.markers.count.toLocaleString(locale), date: when });
}

// ---------- Bedienelemente ----------

$('close-panel').addEventListener('click', () => setPanel(false));
$('panel-handle').addEventListener('click', () => setPanel(true));
$('close-spot').addEventListener('click', closeSpot);
$('lightbox').addEventListener('click', closeLightbox);
$('spot-found').addEventListener('click', () => {
  if (spot) toggleFoundMarker(spot.index);
});
$('none').addEventListener('click', () => {
  enabled.clear();
  saveEnabled();
});
$('refresh').addEventListener('click', () => {
  $('data-info').textContent = tt('ui.loadingData');
  api.refreshData();
});
$('hide-found').addEventListener('change', (event) => api.saveSettings({ hideFound: event.target.checked }));
$('show-captures').addEventListener('change', (event) => api.saveSettings({ showInCaptures: event.target.checked }));
$('minimap').addEventListener('change', (event) => api.saveSettings({ minimap: event.target.checked }));
// --fill: Regler links vom Griff hell, rechts dunkel (overlay.css)
function updateRangeFill(input) {
  const share = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty('--fill', `${Math.round(share * 100)}%`);
}

$('opacity').addEventListener('input', (event) => {
  settings.opacity = Number(event.target.value) / 100;
  $('opacity-value').textContent = `${event.target.value} %`;
  updateRangeFill(event.target);
  api.saveSettings({ opacity: settings.opacity });
  requestDraw();
});
$('size').addEventListener('input', (event) => {
  settings.markerSize = Number(event.target.value);
  $('size-value').textContent = `${event.target.value} px`;
  updateRangeFill(event.target);
  api.saveSettings({ markerSize: settings.markerSize });
  requestDraw();
});

// Fokus dem Spiel nur nehmen, solange im Suchfeld getippt wird.
const search = $('search');
search.addEventListener('mousedown', () => {
  api.keyboard(true);
  setTimeout(() => search.focus(), 30);
});
search.addEventListener('blur', () => api.keyboard(false));
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Enter') search.blur();
});
search.addEventListener('input', applySearch);

// ---------- Nachrichten vom Hauptprozess ----------

api.on('settings', (next) => {
  const languageChanged = next.language !== settings.language;
  settings = next;
  if (languageChanged) {
    applyStaticTexts();
    renderStatus();
    renderDataInfo();
    renderSpot();
    renderSpotFound();
  }
  if (data) {
    enabled = new Set(settings.enabledTypes.map((k) => typeIndexByKey.get(k)).filter((t) => t !== undefined));
    updateCategoryHeads();
  }
  renderSettings();
  requestDraw();
});

api.on('data:markers', (payload) => {
  // Neue Daten → andere Indizes, offene Fundort-Karte schließen
  if (spot) closeSpot();
  data = payload;
  typeIndexByKey = new Map(data.types.map((t, i) => [t.key, i]));
  markerIndexById = new Map();
  const buckets = data.types.map(() => []);
  for (let i = 0; i < data.markers.count; i++) {
    buckets[data.markers.type[i]].push(i);
    markerIndexById.set(data.markers.id[i], i);
  }
  markersByType = buckets.map((b) => Int32Array.from(b));
  enabled = new Set(settings.enabledTypes.map((k) => typeIndexByKey.get(k)).filter((t) => t !== undefined));
  recountFound();
  buildPanel();
  renderDataInfo();
  requestDraw();
});

api.on('found:all', (ids) => {
  found = new Set(ids.map(Number));
  recountFound();
  if (data) for (let t = 0; t < data.types.length; t++) updateTypeCount(t);
  requestDraw();
});

api.on('found:changed', ({ id, found: isFound }) => setFound(id, isFound));

api.on('tracker:status', (next) => {
  trackerStatus = next;
  renderStatus();
});

api.on('view', (next) => {
  const wasLocked = !!target;
  if (next.locked) {
    const now = performance.now();
    if (!target || isJump(target, next)) Object.values(viewFilter).forEach((f) => f.reset());
    const stamped = { ...smoothView(next, now), at: now };
    if (holdStill(target, stamped)) {
      velocity = null;
    } else {
      if (target) updateVelocity(target, stamped);
      else velocity = null;
      target = stamped;
    }
  } else {
    target = null;
    velocity = null;
  }
  if (wasLocked !== !!target) {
    renderStatus();
    renderHandle();
    // Verzögert: beim schnellen Ziehen geht die Karte oft nur kurz verloren
    clearTimeout(spotCloseTimer);
    if (!target && spot) {
      spotCloseTimer = setTimeout(() => {
        if (!target) closeSpot();
      }, 1500);
    }
  }
  requestDraw();
});

let lastMinimapTime = 0;
let lastMinimapPos = null;

api.on('minimap', (pos) => {
  if (pos && typeof pos.x === 'number') {
    minimap = pos;
    lastMinimapPos = pos;
    lastMinimapTime = performance.now();
  } else if (!pos) {
    if (performance.now() - lastMinimapTime > 3500) {
      minimap = null;
    }
  }
  requestDraw();
});
api.on('nearby:done', () => {
  nearbyDoneUntil = performance.now() + 1500;
  renderNearby();
  setTimeout(renderNearby, 1600);
});
api.on('notice', showToast);
api.on('panel:toggle', () => setPanel(!panelOpen));

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
applyStaticTexts();
renderSettings();
renderStatus();


// ---------- Navigation & Hotkeys ----------

function renderSpotNav() {
  const btn = $('spot-nav');
  if (!btn || !spot || !data) return;
  const id = data.markers.id[spot.index];
  const isNav = navigatingPin && navigatingPin.id === id;
  btn.textContent = isNav ? '❌ Untrack' : '📍 Track';
  btn.style.background = isNav ? '#dc2626' : '#2563eb';
}

const btnNav = $('spot-nav');
if (btnNav) {
  btnNav.addEventListener('click', () => {
    if (!spot || !data) return;
    const id = data.markers.id[spot.index];
    if (navigatingPin && navigatingPin.id === id) {
      navigatingPin = null;
      showToast('❌ Navigation cleared');
    } else {
      const type = data.types[data.markers.type[spot.index]];
      navigatingPin = {
        id,
        index: spot.index,
        x: data.markers.x[spot.index],
        y: data.markers.y[spot.index],
        name: type ? type.name : 'Target'
      };
      showToast(`📍 Tracking ${navigatingPin.name} on Minimap`);
    }
    renderSpotNav();
    requestDraw();
  });
}


function updateLayerFilterUI() {
  const filter = settings.layerFilter || 'all';
  ['all', 'surface', 'underground'].forEach((type) => {
    const btn = $(`layer-filter-${type}`);
    if (!btn) return;
    const isActive = filter === type;
    btn.classList.toggle('active', isActive);
    if (isActive) {
      btn.style.borderColor = '#38bdf8';
      btn.style.background = 'rgba(56,189,248,0.22)';
      btn.style.color = '#38bdf8';
    } else {
      btn.style.borderColor = 'rgba(255,255,255,0.15)';
      btn.style.background = 'transparent';
      btn.style.color = '#94a3b8';
    }
  });
}

const layerBar = $('layer-filter-bar');
if (layerBar) {
  layerBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.layer-btn');
    if (!btn) return;
    const selected = btn.dataset.layer;
    if (settings.layerFilter === selected) return;
    settings.layerFilter = selected;
    api.saveSettings({ layerFilter: selected });
    updateLayerFilterUI();
    requestDraw();
    showToast(`Layer filter: ${selected.charAt(0).toUpperCase() + selected.slice(1)}`);
  });
}
updateLayerFilterUI();

const btnSyncChrome = $('btn-sync-chrome');
if (btnSyncChrome) {
  btnSyncChrome.addEventListener('click', () => {
    api.openLink('http://127.0.0.1:48762/sync');
  });
}

api.on('map:keyM', () => {
  if (target) {
    target = null;
    velocity = null;
    visibility = 0;
    requestDraw();
  }
});

api.on('hotkey:markAt', (pt) => {
  if (hover >= 0) {
    toggleFoundMarker(hover);
    return;
  }
  const checkX = (pt && typeof pt.x === 'number') ? pt.x : mouse.x;
  const checkY = (pt && typeof pt.y === 'number') ? pt.y : mouse.y;
  if (checkX >= 0 && checkY >= 0 && data && drawnCount > 0) {
    const u = uiScale();
    const radius = Math.max(35, (settings.markerSize + 15) * u);
    let best = -1;
    let bestDist = radius * radius;
    for (let k = 0; k < drawnCount; k++) {
      const dx = drawnX[k] - checkX;
      const dy = drawnY[k] - checkY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = drawnIndex[k];
      }
    }
    if (best >= 0) {
      toggleFoundMarker(best);
      return;
    }
  }
});


let panelLeaveTimer = null;
const panelEl = $('panel');
if (panelEl) {
  panelEl.addEventListener('mouseleave', () => {
    if (panelOpen) {
      panelLeaveTimer = setTimeout(() => {
        if (panelOpen && !overPanel(mouse.x, mouse.y)) {
          setPanel(false);
        }
      }, 1200);
    }
  });
  panelEl.addEventListener('mouseenter', () => {
    if (panelLeaveTimer) {
      clearTimeout(panelLeaveTimer);
      panelLeaveTimer = null;
    }
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelOpen) {
    setPanel(false);
  }
});
