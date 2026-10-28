let navigatingPin = null;
let currentHeading = -Math.PI / 2;
let lastPlayerMapX = 0;
let lastPlayerMapY = 0;
let playerTrack = { x: 0, y: 0, lastSeen: 0, live: false, vx: 0, vy: 0, lastStepTime: 0 };
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

let captureTimer = null;
function setCapture(on, immediate = false) {
  if (on) {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = null;
    if (!captured) {
      captured = true;
      api.mouse(true);
    }
  } else {
    if (!captured) return;
    if (captureTimer) clearTimeout(captureTimer);
    if (immediate) {
      captured = false;
      api.mouse(false);
      captureTimer = null;
    } else {
      captureTimer = setTimeout(() => {
        captured = false;
        api.mouse(false);
        captureTimer = null;
      }, 40);
    }
  }
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
  animating = animating || (target ? visibility < 1 : visibility > 0) || !!navigatingPin;
  draw();
  if (animating) requestDraw();
}

function draw() {
  const W = innerWidth;
  const H = innerHeight;
  const u = uiScale();
  ctx.clearRect(0, 0, W, H);
  drawnCount = 0;
  if (!data || !view || visibility <= 0) {
    if (data && (minimap || (navigatingPin && playerTrack.lastSeen > 0)) && visibility <= 0) {
      if (minimap && settings.minimap !== false) drawMinimap();
      if (navigatingPin) drawWorldNavigationArrow(W, H, u);
    } else if (nearby >= 0) {
      setNearby(-1);
    }
    updateHover();
    return;
  }

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
  if (navigatingPin) {
    drawBigMapNavigation(W, H, u, ax, ay, bx, by);
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
  // Navigation / Waypoint Indicator on Minimap (stage-aware & elevation colored)
  if (navigatingPin && (minimap || playerTrack.lastSeen > 0)) {
    const px = minimap ? minimap.x : playerTrack.x;
    const py = minimap ? minimap.y : playerTrack.y;
    // Check if routing to cave entrance first
    let tx = navigatingPin.x;
    let ty = navigatingPin.y;
    if (navigatingPin.entrancePoint) {
      const dEnt = Math.hypot(navigatingPin.entrancePoint.x - px, navigatingPin.entrancePoint.y - py) * 15;
      const dTarget = Math.hypot(navigatingPin.x - px, navigatingPin.y - py) * 15;
      if (dEnt > 18 && dTarget > 25) {
        tx = navigatingPin.entrancePoint.x;
        ty = navigatingPin.entrancePoint.y;
      }
    }
    const dx = tx - px;
    const dy = ty - py;
    const angle = Math.atan2(dy, dx);
    const maxR = r - 12 * u;
    const ax = cx + Math.cos(angle) * maxR;
    const ay = cy + Math.sin(angle) * maxR;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.fillStyle = navigatingPin.elevation === 'up' ? '#f59e0b' : (navigatingPin.elevation === 'down' ? '#06b6d4' : '#38bdf8');
    ctx.beginPath();
    ctx.moveTo(9 * u, 0);
    ctx.lineTo(-7 * u, -5.5 * u);
    ctx.lineTo(-3.5 * u, 0);
    ctx.lineTo(-7 * u, 5.5 * u);
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


function drawNavPill(x, y, text, color, u) {
  ctx.save();
  ctx.font = `bold ${Math.round(11 * u)}px sans-serif`;
  const metrics = ctx.measureText(text);
  const pillW = metrics.width + 16 * u;
  const pillH = 22 * u;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
  ctx.strokeStyle = color || '#38bdf8';
  ctx.lineWidth = 1.2 * u;

  const r = pillH / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - pillW / 2, y - pillH / 2, pillW, pillH, r);
  else ctx.rect(x - pillW / 2, y - pillH / 2, pillW, pillH);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawNavCard(x, y, lines, color, u) {
  if (!lines || !lines.length) return;
  ctx.save();
  const paddingX = 14 * u;
  const paddingY = 8 * u;
  const lineH = 15 * u;

  let maxW = 0;
  for (const line of lines) {
    const sz = line.size ? Math.round(line.size * u) : Math.round(11 * u);
    ctx.font = `${line.bold ? 'bold ' : ''}${sz}px sans-serif`;
    const w = ctx.measureText(line.text).width;
    if (w > maxW) maxW = w;
  }

  const cardW = Math.max(140 * u, maxW + paddingX * 2);
  const cardH = lines.length * lineH + paddingY * 2;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.strokeStyle = color || '#38bdf8';
  ctx.lineWidth = 1.4 * u;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 10 * u;

  const rx = x - cardW / 2;
  const ry = y - cardH / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rx, ry, cardW, cardH, 7 * u);
  else ctx.rect(rx, ry, cardW, cardH);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sz = line.size ? Math.round(line.size * u) : Math.round(11 * u);
    ctx.font = `${line.bold ? 'bold ' : ''}${sz}px sans-serif`;
    ctx.fillStyle = line.color || '#ffffff';
    const ly = ry + paddingY + (i + 0.5) * lineH;
    ctx.fillText(line.text, x, ly);
  }
  ctx.restore();
}

function findBestTeleport(targetIdx) {
  if (!data || targetIdx < 0 || targetIdx >= data.markers.count) return null;
  const { x: mx, y: my, id: ids, underground: ug, layerId: lId } = data.markers;
  const tx = mx[targetIdx];
  const ty = my[targetIdx];
  const isTargetUg = ug && ug[targetIdx] === 1;
  const targetLayerId = lId ? lId[targetIdx] : 0;

  const teleIndices = [];
  ['o3', 'o2'].forEach(key => {
    const tIdx = typeIndexByKey.get(key);
    if (tIdx !== undefined && markersByType[tIdx]) {
      for (const i of markersByType[tIdx]) teleIndices.push(i);
    }
  });

  if (!teleIndices.length) return null;

  if (isTargetUg) {
    let bestSameLayer = -1;
    let bestSameDist = Infinity;
    for (const i of teleIndices) {
      if (ug[i] === 1 && lId[i] === targetLayerId) {
        const d = Math.hypot(mx[i] - tx, my[i] - ty);
        if (d < bestSameDist) {
          bestSameDist = d;
          bestSameLayer = i;
        }
      }
    }
    if (bestSameLayer >= 0) {
      return {
        index: bestSameLayer,
        id: ids[bestSameLayer],
        x: mx[bestSameLayer],
        y: my[bestSameLayer],
        name: data.types[data.markers.type[bestSameLayer]].name,
        dist: bestSameDist,
        sameCave: true
      };
    }

    const entIds = (data.entrances && data.entrances[ids[targetIdx]]) || [];
    if (entIds.length) {
      const entIdx = markerIndexById.get(entIds[0]);
      if (entIdx !== undefined) {
        const ex = mx[entIdx];
        const ey = my[entIdx];
        let bestEntTele = -1;
        let bestEntDist = Infinity;
        for (const i of teleIndices) {
          if (ug[i] === 0) {
            const d = Math.hypot(mx[i] - ex, my[i] - ey);
            if (d < bestEntDist) {
              bestEntDist = d;
              bestEntTele = i;
            }
          }
        }
        if (bestEntTele >= 0) {
          return {
            index: bestEntTele,
            id: ids[bestEntTele],
            x: mx[bestEntTele],
            y: my[bestEntTele],
            name: data.types[data.markers.type[bestEntTele]].name,
            dist: bestEntDist,
            entrance: true,
            entranceId: entIds[0]
          };
        }
      }
    }
  }

  let bestTele = -1;
  let bestDist = Infinity;
  for (const i of teleIndices) {
    if (!isTargetUg && ug[i] === 1) continue;
    const d = Math.hypot(mx[i] - tx, my[i] - ty);
    if (d < bestDist) {
      bestDist = d;
      bestTele = i;
    }
  }

  if (bestTele >= 0) {
    return {
      index: bestTele,
      id: ids[bestTele],
      x: mx[bestTele],
      y: my[bestTele],
      name: data.types[data.markers.type[bestTele]].name,
      dist: bestDist
    };
  }
  return null;
}

function drawWorldNavigationArrow(W, H, u) {
  if (!navigatingPin) return;

  const now = performance.now();
  let playerX = minimap ? minimap.x : playerTrack.x;
  let playerY = minimap ? minimap.y : playerTrack.y;
  const hasLock = (minimap && typeof minimap.x === 'number') || (playerTrack.lastSeen > 0 && now - playerTrack.lastSeen < 60000);

  if (!hasLock) {
    drawNavCard(W * 0.5, H * 0.65 - 45 * u, [
      { text: `🧭 Tracking: ${navigatingPin.name}`, color: '#38bdf8', bold: true },
      { text: 'Press M in game to sync GPS location', color: '#f59e0b', bold: false }
    ], '#38bdf8', u);
    return;
  }

  const isLive = minimap && playerTrack.live;
  const targetX = navigatingPin.x;
  const targetY = navigatingPin.y;

  // 1. Cave Entrance / Wall Routing Stage
  let activeTargetX = targetX;
  let activeTargetY = targetY;
  let navStage = 'direct';
  let entranceDistM = Infinity;
  const targetDistM = Math.round(Math.hypot(targetX - playerX, targetY - playerY) * 15);

  if (navigatingPin.entrancePoint) {
    const ent = navigatingPin.entrancePoint;
    entranceDistM = Math.round(Math.hypot(ent.x - playerX, ent.y - playerY) * 15);
    if (entranceDistM > 18 && targetDistM > 25) {
      navStage = 'entrance';
      activeTargetX = ent.x;
      activeTargetY = ent.y;
    } else {
      navStage = 'inside_cave';
    }
  } else if (navigatingPin.isUnderground) {
    navStage = 'underground';
  }

  const activeDistM = navStage === 'entrance' ? entranceDistM : targetDistM;
  const dx = activeTargetX - playerX;
  const dy = activeTargetY - playerY;

  const targetWorldAngle = Math.atan2(dy, dx);
  let relAngle = targetWorldAngle - currentHeading;
  while (relAngle > Math.PI) relAngle -= 2 * Math.PI;
  while (relAngle < -Math.PI) relAngle += 2 * Math.PI;

  const charX = W * 0.5;
  const charY = H * 0.65;

  ctx.save();

  // Arrival / Close Proximity (< 12m)
  if (activeDistM < 12) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 200);
    const radius = (28 + pulse * 14) * u;
    const ringColor = navigatingPin.elevation === 'up' ? '#f59e0b' : (navigatingPin.elevation === 'down' ? '#06b6d4' : '#10b981');

    ctx.save();
    ctx.translate(charX, charY);
    ctx.scale(1, 0.45);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 3 * u;
    ctx.globalAlpha = 0.6 + 0.3 * pulse;
    ctx.shadowColor = ringColor;
    ctx.shadowBlur = 15 * u;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = ringColor;
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.restore();

    let arriveTitle = `🎯 Arrived (~${activeDistM}m)`;
    let arriveSub = navigatingPin.name;
    if (navigatingPin.elevation === 'up') {
      arriveTitle = `🧗 LOOK UP! (~${activeDistM}m above)`;
      arriveSub = navigatingPin.hint || 'Target is on cliff / peak / ruins above';
    } else if (navigatingPin.elevation === 'down' || navStage === 'inside_cave' || navStage === 'underground') {
      arriveTitle = `🕳️ LOOK DOWN! (~${activeDistM}m below)`;
      arriveSub = navigatingPin.hint || 'Target is in cave / ravine / water below';
    } else if (navStage === 'entrance') {
      arriveTitle = '🚪 Cave Entrance Reached!';
      arriveSub = `Enter cave to find ${navigatingPin.name}`;
    }

    drawNavCard(charX, charY - 48 * u, [
      { text: arriveTitle, color: ringColor, bold: true },
      { text: arriveSub, color: '#e2e8f0', bold: false }
    ], ringColor, u);

    ctx.restore();
    return;
  }

  // Draw 3D-styled navigation arrow around character orbit
  const orbitX = 118 * u;
  const orbitY = 62 * u;
  const bob = Math.sin(now / 220) * (5 * u);

  const dirX = Math.sin(relAngle);
  const dirY = -Math.cos(relAngle);

  const arrowX = charX + dirX * (orbitX + bob);
  const arrowY = charY + dirY * (orbitY + bob * 0.55);
  const arrowScreenAngle = Math.atan2(dirY, dirX);

  ctx.save();
  ctx.translate(arrowX, arrowY);
  ctx.rotate(arrowScreenAngle);

  const arrowLen = 40 * u;
  const arrowW = 26 * u;

  // Visual styling based on Elevation & Cave Stage
  let mainColor = '#38bdf8';
  let glowColor = '#38bdf8';
  if (navigatingPin.elevation === 'up') {
    mainColor = '#f59e0b';
    glowColor = '#fbbf24';
  } else if (navigatingPin.elevation === 'down' || navStage === 'inside_cave' || navStage === 'entrance' || navStage === 'underground') {
    mainColor = '#06b6d4';
    glowColor = '#38bdf8';
  }

  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 14 * u;

  // Arrow gradient
  const grad = ctx.createLinearGradient(-arrowLen * 0.4, 0, arrowLen * 0.6, 0);
  grad.addColorStop(0, mainColor + '26');
  grad.addColorStop(1, mainColor + 'b3');

  ctx.fillStyle = grad;
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 2.2 * u;

  // Main Arrow Body
  ctx.beginPath();
  ctx.moveTo(arrowLen * 0.6, 0);
  ctx.lineTo(-arrowLen * 0.4, -arrowW * 0.5);
  ctx.lineTo(-arrowLen * 0.15, 0);
  ctx.lineTo(-arrowLen * 0.4, arrowW * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Forward pulsing chevron inside arrow
  const pulseOff = ((now / 600) % 1) * (arrowLen * 0.4);
  ctx.strokeStyle = mainColor;
  ctx.globalAlpha = 0.7 - (pulseOff / (arrowLen * 0.4)) * 0.5;
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.moveTo(arrowLen * 0.3 - pulseOff, 0);
  ctx.lineTo(-arrowLen * 0.6 - pulseOff, -arrowW * 0.35);
  ctx.moveTo(arrowLen * 0.3 - pulseOff, 0);
  ctx.lineTo(-arrowLen * 0.6 - pulseOff, arrowW * 0.35);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 3D Elevation Chevrons (Up / Down indicator directly on arrow)
  if (navigatingPin.elevation === 'up') {
    const climb = ((now / 500) % 1) * (6 * u);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.4 * u;
    ctx.beginPath();
    ctx.moveTo(-arrowLen * 0.1, -arrowW * 0.65 - climb);
    ctx.lineTo(arrowLen * 0.1, -arrowW * 0.95 - climb);
    ctx.lineTo(arrowLen * 0.3, -arrowW * 0.65 - climb);
    ctx.stroke();
  } else if (navigatingPin.elevation === 'down') {
    const drop = ((now / 500) % 1) * (6 * u);
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.4 * u;
    ctx.beginPath();
    ctx.moveTo(-arrowLen * 0.1, arrowW * 0.65 + drop);
    ctx.lineTo(arrowLen * 0.1, arrowW * 0.95 + drop);
    ctx.lineTo(arrowLen * 0.3, arrowW * 0.65 + drop);
    ctx.stroke();
  }

  ctx.restore();

  // Draw Informative Multi-Line Navigation Card
  const cardX = Math.max(120 * u, Math.min(W - 120 * u, arrowX));
  const cardY = Math.max(40 * u, Math.min(H - 65 * u, arrowY + 28 * u));

  const lines = [];
  if (navStage === 'entrance') {
    lines.push({ text: `🚪 STEP 1: Cave Entrance (~${activeDistM}m)`, color: '#06b6d4', bold: true });
    lines.push({ text: `↳ Target: ${navigatingPin.name} is underground`, color: '#e2e8f0', bold: false });
  } else if (navStage === 'inside_cave') {
    lines.push({ text: `🕳️ STEP 2: Inside Cave (~${activeDistM}m)`, color: '#06b6d4', bold: true });
    lines.push({ text: `🎯 ${navigatingPin.name} • ${navigatingPin.elevationLabel}`, color: '#38bdf8', bold: false });
  } else {
    const prefix = navigatingPin.elevation === 'up' ? '▲' : (navigatingPin.elevation === 'down' ? '▼' : '⚡');
    lines.push({ text: `${prefix} ${activeDistM}m • ${navigatingPin.name}`, color: mainColor, bold: true });
    lines.push({ text: navigatingPin.elevationLabel + (navigatingPin.obstacleNote ? ` • ${navigatingPin.obstacleNote}` : ''), color: '#94a3b8', bold: false });
  }

  if (navigatingPin.hint) {
    lines.push({ text: `💡 ${navigatingPin.hint}`, color: '#fef08a', bold: false, size: 10 });
  }

  if (!isLive) {
    lines.push({ text: '🧭 Estimating position (Open M to sync)', color: '#f97316', bold: false, size: 9 });
  }

  drawNavCard(cardX, cardY, lines, mainColor, u);
  ctx.restore();
}

function drawBigMapNavigation(W, H, u, ax, ay, bx, by) {
  if (!navigatingPin || !data) return;
  const half = (settings.markerSize * u) / 2;
  const targetX = ax * navigatingPin.x + bx;
  const targetY = ay * navigatingPin.y + by - half;

  // 1. Draw pulsating focal beacon and clear badge on target pin
  ctx.save();
  const pulseT = 0.5 + 0.5 * Math.sin(performance.now() / 200);
  const targetR = (settings.markerSize * u * 0.6) + 10 * u + pulseT * 6 * u;
  const targetColor = navigatingPin.elevation === 'up' ? '#f59e0b' : (navigatingPin.elevation === 'down' ? '#06b6d4' : '#38bdf8');
  ctx.strokeStyle = targetColor;
  ctx.lineWidth = 2.5 * u;
  ctx.shadowColor = targetColor;
  ctx.shadowBlur = 10 * u;
  ctx.globalAlpha = Math.min(0.95, visibility);
  ctx.beginPath();
  ctx.arc(targetX, targetY, targetR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Target name badge with Elevation
  const badgeLabel = `🎯 ${navigatingPin.name} (${navigatingPin.elevationLabel})`;
  drawNavPill(targetX, targetY - targetR - 12 * u, badgeLabel, targetColor, u);

  // 2. Cave Entrance Route & Beacon (if underground with entrance)
  let viaX = null;
  let viaY = null;
  if (navigatingPin.entrancePoint) {
    viaX = ax * navigatingPin.entrancePoint.x + bx;
    viaY = ay * navigatingPin.entrancePoint.y + by - half;

    const entOnScreen = viaX >= -40 && viaX <= W + 40 && viaY >= -40 && viaY <= H + 40;
    if (entOnScreen) {
      ctx.save();
      const pulseE = 0.5 + 0.5 * Math.sin(performance.now() / 220);
      const rE = (settings.markerSize * u * 0.55) + 8 * u + pulseE * 5 * u;
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2.4 * u;
      ctx.shadowColor = '#06b6d4';
      ctx.shadowBlur = 10 * u;
      ctx.globalAlpha = Math.min(0.95, visibility);
      ctx.beginPath();
      ctx.arc(viaX, viaY, rE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      drawNavPill(viaX, viaY - rE - 10 * u, `🚪 ${navigatingPin.entrancePoint.name}`, '#06b6d4', u);

      // Tunnel dashed route from Cave Entrance to Target Pin
      ctx.save();
      ctx.setLineDash([6 * u, 6 * u]);
      ctx.lineDashOffset = -performance.now() / 30;
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2.4 * u;
      ctx.globalAlpha = Math.min(0.85, visibility);
      ctx.beginPath();
      ctx.moveTo(viaX, viaY);
      ctx.lineTo(targetX, targetY);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 3. Teleport & Route planning
  const bestTele = findBestTeleport(navigatingPin.index);
  if (bestTele) {
    const teleX = ax * bestTele.x + bx;
    const teleY = ay * bestTele.y + by - half;
    const distM = Math.round(bestTele.dist * 15);

    const teleOnScreen = teleX >= -40 && teleX <= W + 40 && teleY >= -40 && teleY <= H + 40;
    const targetOnScreen = targetX >= -40 && targetX <= W + 40 && targetY >= -40 && targetY <= H + 40;

    let usePlayerOrigin = false;
    let originX = teleX;
    let originY = teleY;

    const pX = minimap ? minimap.x : playerTrack.x;
    const pY = minimap ? minimap.y : playerTrack.y;
    if (playerTrack.lastSeen > 0) {
      const pDistM = Math.round(Math.hypot(navigatingPin.x - pX, navigatingPin.y - pY) * 15);
      if (pDistM < distM || pDistM < 160) {
        usePlayerOrigin = true;
        originX = ax * pX + bx;
        originY = ay * pY + by - half;
      }
    }

    if (teleOnScreen && !usePlayerOrigin) {
      ctx.save();
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      const r = (settings.markerSize * u * 0.6) + 10 * u + pulse * 6 * u;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5 * u;
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 12 * u;
      ctx.globalAlpha = Math.min(0.95, visibility);
      ctx.beginPath();
      ctx.arc(teleX, teleY, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      drawNavPill(teleX, teleY - r - 12 * u, `⚡ ${bestTele.name} (~${distM}m)`, '#38bdf8', u);
    } else if (!teleOnScreen && !usePlayerOrigin && targetOnScreen) {
      const angle = Math.atan2(teleY - H / 2, teleX - W / 2);
      const edgeX = Math.max(90 * u, Math.min(W - 90 * u, W / 2 + Math.cos(angle) * (W / 2 - 50 * u)));
      const edgeY = Math.max(30 * u, Math.min(H - 30 * u, H / 2 + Math.sin(angle) * (H / 2 - 40 * u)));
      drawNavPill(edgeX, edgeY, `⚡ Warp to: ${bestTele.name} (~${distM}m)`, '#38bdf8', u);
    }

    // Connect route to Cave Entrance (if routing to cave) or Target Pin
    const routeDestX = viaX !== null ? viaX : targetX;
    const routeDestY = viaY !== null ? viaY : targetY;

    const originOnScreen = originX >= -120 && originX <= W + 120 && originY >= -120 && originY <= H + 120;
    const destOnScreen = routeDestX >= -120 && routeDestX <= W + 120 && routeDestY >= -120 && routeDestY <= H + 120;

    if (originOnScreen && destOnScreen) {
      ctx.save();
      ctx.setLineDash([10 * u, 6 * u]);
      ctx.lineDashOffset = -performance.now() / 25;
      ctx.strokeStyle = usePlayerOrigin ? '#10b981' : '#38bdf8';
      ctx.lineWidth = 2.8 * u;
      ctx.shadowColor = usePlayerOrigin ? '#10b981' : '#38bdf8';
      ctx.shadowBlur = 8 * u;
      ctx.globalAlpha = Math.min(0.85, visibility);

      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.lineTo(routeDestX, routeDestY);
      ctx.stroke();

      const dLine = Math.hypot(routeDestX - originX, routeDestY - originY);
      const numC = Math.floor(dLine / (55 * u));
      const aLine = Math.atan2(routeDestY - originY, routeDestX - originX);
      ctx.fillStyle = '#ffffff';
      for (let k = 1; k <= numC; k++) {
        const t = k / (numC + 1);
        const px = originX + (routeDestX - originX) * t;
        const py = originY + (routeDestY - originY) * t;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(aLine);
        ctx.beginPath();
        ctx.moveTo(4 * u, 0);
        ctx.lineTo(-4 * u, -3.5 * u);
        ctx.lineTo(-2 * u, 0);
        ctx.lineTo(-4 * u, 3.5 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
  }
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
    if (!el || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  if (!$('lightbox').hidden) return true;
  if (panelOpen && inside($('panel'))) return true;
  if (spot && inside($('spot'))) return true;
  return !$('panel-handle').hidden && inside($('panel-handle'));
}

function overSpot(x, y) {
  if (!spot) return false;
  const el = $('spot');
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
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
  const radius = Math.max(14, (settings.markerSize / 2 + 2) * u);
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
  // If moving out of interactive zone onto the game map, release capture IMMEDIATELY so in-game map is always clickable
  setCapture(isOverInteractive, !isOverInteractive);
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
let rightPressInfo = null;
let lastDomRightClickTime = 0;
let lastPinClickTime = 0;
let lastPinClickIndex = -1;

function findPinIndexAt(x, y) {
  if (x < 0 || y < 0 || !data || drawnCount <= 0) return -1;
  const u = uiScale();
  const radius = Math.max(38, (settings.markerSize + 16) * u);
  let best = -1;
  let bestDist = radius * radius;
  for (let k = 0; k < drawnCount; k++) {
    const dx = drawnX[k] - x;
    const dy = drawnY[k] - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = drawnIndex[k];
    }
  }
  return best;
}

function findAnyPinAt(x, y, maxDistance) {
  if (!data || !data.markers || x < 0 || y < 0) return -1;
  const u = uiScale();
  const radius = maxDistance || Math.max(38, (settings.markerSize + 16) * u);
  let best = -1;
  let bestDist = radius * radius;

  // 1. Check visible drawn pins first
  for (let k = 0; k < drawnCount; k++) {
    const dx = drawnX[k] - x;
    const dy = drawnY[k] - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = drawnIndex[k];
    }
  }
  if (best >= 0) return best;

  // 2. If no drawn pin found (e.g. marked as done and settings.hideFound is true),
  // search through enabled pins so user can UNMARK them!
  if (!view) return -1;
  const W = innerWidth;
  const H = innerHeight;
  const ax = view.sx * W;
  const bx = view.ox * W;
  const ay = view.sy * H;
  const by = view.oy * H;
  const { x: mx, y: my } = data.markers;
  const half = (settings.markerSize * u) / 2;

  for (const t of enabled) {
    const list = markersByType[t];
    if (!list) continue;
    for (let j = 0; j < list.length; j++) {
      const i = list[j];
      const px = ax * mx[i] + bx;
      const py = ay * my[i] + by - half;
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
  }
  return best;
}

function findAndMarkAt(checkX, checkY) {
  const best = findAnyPinAt(checkX, checkY);
  if (best >= 0) {
    toggleFoundMarker(best);
    return true;
  }
  return false;
}

function parsePinIntelligence(pin, res) {
  if (!res) return;
  const summary = (res.summary || '').trim();
  const comments = res.comments || [];
  const topText = comments.slice(0, 4).map(c => c.text || '').join(' ');
  const combined = (summary + ' ' + topText).toLowerCase();

  const upHits = (combined.match(/\b(top|peak|cliff|mountain|summit|roof|pillar|tree|high|above|climb|tower|floating|air|sky|ledge)\b/g) || []).length;
  const downHits = (combined.match(/\b(cave|bottom|ravine|below|tunnel|well|chasm|under|down|underneath|drop|hole|submerged|waterfall|pit)\b/g) || []).length;
  const wallHits = (combined.match(/\b(wall|destructible|breakable|barrier|rock|puzzle|gate|seal|door|blocked)\b/g) || []).length;

  if (pin.isUnderground || (pin.floorName && pin.floorName.startsWith('B'))) {
    pin.elevation = 'down';
    pin.elevationLabel = '▼ UNDERGROUND CAVE';
  } else if (pin.floorName && pin.floorName.startsWith('L')) {
    pin.elevation = 'up';
    pin.elevationLabel = '▲ UPPER TOWER / LEVEL';
  } else if (upHits > downHits && upHits >= 2) {
    pin.elevation = 'up';
    pin.elevationLabel = '▲ HIGH / CLIMB UP';
  } else if (downHits > upHits && downHits >= 2) {
    pin.elevation = 'down';
    pin.elevationLabel = '▼ LOW / IN RAVINE / PIT';
  }

  if (wallHits >= 2 && !pin.obstacleNote) {
    pin.obstacleNote = '🧱 Behind breakable rock / wall';
  }

  const candidate = summary || (comments[0] && comments[0].text) || '';
  if (candidate) {
    const clean = candidate.replace(/\s+/g, ' ').trim();
    const sentence = clean.split(/[.!\n?]/)[0].trim();
    if (sentence.length >= 6) {
      pin.hint = sentence.length > 55 ? sentence.slice(0, 52) + '...' : sentence;
    }
  }
}

function toggleNavigation(index) {
  if (index < 0 || !data || !data.markers) return;
  const id = data.markers.id[index];
  if (navigatingPin && navigatingPin.id === id) {
    navigatingPin = null;
    showToast('✕ Navigation cleared');
  } else {
    const type = data.types[data.markers.type[index]];
    const isUg = data.markers.underground && data.markers.underground[index] === 1;
    const floorName = (data.layers && data.markers.layerId) ? data.layers[data.markers.layerId[index]] : '';

    let entrancePoint = null;
    const entIds = (data.entrances && data.entrances[id]) || [];
    if (entIds.length) {
      for (const eId of entIds) {
        const eIdx = markerIndexById.get(eId);
        if (eIdx !== undefined) {
          entrancePoint = {
            id: eId,
            index: eIdx,
            x: data.markers.x[eIdx],
            y: data.markers.y[eIdx],
            name: (data.types[data.markers.type[eIdx]] && data.types[data.markers.type[eIdx]].name) || 'Cave Entrance'
          };
          break;
        }
      }
    }

    let elevation = 'level';
    let elevationLabel = '━ SURFACE LEVEL';
    if (floorName && floorName.startsWith('B')) {
      elevation = 'down';
      elevationLabel = `▼ UNDERGROUND (${floorName})`;
    } else if (floorName && floorName.startsWith('L')) {
      elevation = 'up';
      elevationLabel = `▲ UPPER LEVEL (${floorName})`;
    } else if (isUg) {
      elevation = 'down';
      elevationLabel = '▼ UNDERGROUND CAVE';
    }

    navigatingPin = {
      id,
      index,
      x: data.markers.x[index],
      y: data.markers.y[index],
      name: type ? type.name : 'Target',
      isUnderground: isUg,
      floorName,
      entrancePoint,
      elevation,
      elevationLabel,
      hint: '',
      obstacleNote: entrancePoint ? '🚪 Uses Cave Entrance' : (isUg ? '🕳️ Underground' : '')
    };
    showToast(`🧭 Tracking ${navigatingPin.name}`);

    const typeKey = type ? type.key : '';
    api.comments(typeKey, id, 1).then((res) => {
      if (navigatingPin && navigatingPin.id === id && res) {
        parsePinIntelligence(navigatingPin, res);
        requestDraw();
      }
    }).catch(() => {});
  }
  renderSpotNav();
  requestDraw();
}

window.addEventListener('dblclick', (event) => {
  if (overPanel(event.clientX, event.clientY) || (spot !== null && overSpot(event.clientX, event.clientY))) {
    return;
  }
  const targetIndex = hover >= 0 ? hover : findAnyPinAt(event.clientX, event.clientY);
  if (targetIndex >= 0) {
    event.preventDefault();
    toggleNavigation(targetIndex);
  }
});

window.addEventListener('mousedown', (event) => {
  // If clicked inside sidebar or spot popup, keep capture active and let DOM handle it
  if (overPanel(event.clientX, event.clientY)) {
    setCapture(true);
    return;
  }
  if (spot !== null && overSpot(event.clientX, event.clientY)) {
    setCapture(true);
    return;
  }

  // Clicked outside sidebar panel: close sidebar
  if (panelOpen) {
    setPanel(false);
  }
  // Clicked outside spot popup: close spot if not clicking another pin
  if (spot && hover < 0) {
    closeSpot();
    setCapture(false, true);
  }

  if (event.button === 2) {
    event.preventDefault();
    rightPressInfo = { x: event.clientX, y: event.clientY, hoverIndex: hover };
    return;
  }

  if (hover >= 0 && event.button === 0) {
    mousePressInfo = { x: event.clientX, y: event.clientY, index: hover };
  } else if (event.button === 0 && !panelOpen && !spot) {
    setCapture(false, true);
  }
});

window.addEventListener('wheel', (e) => {
  if (overPanel(e.clientX, e.clientY) || (spot !== null && overSpot(e.clientX, e.clientY))) {
    return;
  }
  // Immediately release capture so mouse wheel zooms the in-game map without delay!
  setCapture(false, true);
}, { passive: true });

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
  if (rightPressInfo) {
    const dist = Math.hypot(event.clientX - rightPressInfo.x, event.clientY - rightPressInfo.y);
    if (dist > 8) {
      rightPressInfo = null;
    }
  }
  updateHover();
});

window.addEventListener('mouseup', (event) => {
  if (overPanel(event.clientX, event.clientY) || (spot !== null && overSpot(event.clientX, event.clientY))) {
    return;
  }

  // Right-click: Toggle found / unmark marker cleanly on mouseup
  if (event.button === 2) {
    event.preventDefault();
    lastDomRightClickTime = performance.now();
    if (rightPressInfo) {
      rightPressInfo = null;
      if (hover >= 0) {
        toggleFoundMarker(hover);
      } else {
        findAndMarkAt(event.clientX, event.clientY);
      }
    }
    return;
  }

  // Left-click: Single click opens spot, Double click triggers navigation
  if (mousePressInfo && event.button === 0) {
    const idx = mousePressInfo.index;
    mousePressInfo = null;
    const now = performance.now();

    if (lastPinClickIndex === idx && (now - lastPinClickTime < 450)) {
      // Software double-click detected!
      lastPinClickTime = 0;
      lastPinClickIndex = -1;
      toggleNavigation(idx);
      return;
    }

    lastPinClickTime = now;
    lastPinClickIndex = idx;
    openSpot(idx);
  } else {
    mousePressInfo = null;
  }
});

window.addEventListener('contextmenu', (event) => {
  if (hover >= 0 || overPanel(event.clientX, event.clientY) || (spot !== null && overSpot(event.clientX, event.clientY))) {
    event.preventDefault();
  }
});

api.on('hotkey:markCurrent', () => {
  if (hover >= 0) {
    toggleFoundMarker(hover);
  } else if (spot && typeof spot.index === 'number') {
    toggleFoundMarker(spot.index, true);
  } else if (lastMarkedPinId !== null) {
    const lastIdx = markerIndexById.get(lastMarkedPinId);
    if (lastIdx !== undefined && found.has(lastMarkedPinId)) {
      toggleFoundMarker(lastIdx, true);
      lastMarkedPinId = null;
    }
  }
});

let lastToggleId = null;
let lastToggleTime = 0;
let lastMarkedPinId = null;

function toggleFoundMarker(index, force = false) {
  if (index < 0 || !data || !data.markers) return;
  const id = data.markers.id[index];
  const now = performance.now();
  if (!force && lastToggleId === id && (now - lastToggleTime < 200)) {
    return;
  }
  lastToggleId = id;
  lastToggleTime = now;

  const newState = !found.has(id);
  setFound(id, newState);
  api.toggleFound(id, newState);

  if (newState) {
    lastMarkedPinId = id;
    // Auto-remove navigation if collected
    if (navigatingPin && navigatingPin.id === id) {
      navigatingPin = null;
      renderSpotNav();
    }
  } else {
    if (lastMarkedPinId === id) lastMarkedPinId = null;
  }

  const type = data.types[data.markers.type[index]];
  const typeName = type ? type.name : 'Marker';
  showToast(newState ? `✓ Marked done: ${typeName}` : `↶ Unmarked: ${typeName}`);
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
    const t = data.markers.type[i];
    if (isFound) {
      foundByType[t] = (foundByType[t] || 0) + 1;
    } else {
      foundByType[t] = Math.max(0, (foundByType[t] || 0) - 1);
    }
    updateTypeCount(t);
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
  renderSpotTeleport(index);
  renderSpotFound();
  renderSpotNav();
  requestDraw();
  await loadSpot();
}



function renderSpotTeleport(index) {
  let teleEl = $('spot-teleport-card');
  if (!teleEl) {
    teleEl = document.createElement('div');
    teleEl.id = 'spot-teleport-card';
    teleEl.className = 'spot-teleport-card';
    const badgeEl = $('spot-layer-badge');
    if (badgeEl && badgeEl.parentNode) {
      badgeEl.parentNode.insertBefore(teleEl, badgeEl.nextSibling);
    }
  }
  const bestTele = findBestTeleport(index);
  if (!bestTele) {
    teleEl.style.display = 'none';
    return;
  }
  teleEl.style.display = 'flex';
  const distM = Math.round(bestTele.dist * 15);
  const note = bestTele.sameCave ? ' (Inside same cave)' : (bestTele.entrance ? ' (Closest to cave entrance)' : '');
  
  teleEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex:1;">
      <span style="font-size:16px;">⚡</span>
      <div style="display:flex;flex-direction:column;">
        <span style="font-weight:700;color:#38bdf8;font-size:11px;">FASTEST TELEPORT</span>
        <span style="font-size:12px;color:#f1f5f9;">${bestTele.name} (~${distM}m away${note})</span>
      </div>
    </div>
    <button id="btn-focus-teleport" type="button" class="tele-focus-btn">Focus</button>
  `;

  const btnFocus = $('btn-focus-teleport');
  if (btnFocus) {
    btnFocus.addEventListener('click', (e) => {
      e.stopPropagation();
      openSpot(bestTele.index);
      showToast(`⚡ Focused nearest teleport: ${bestTele.name}`);
    });
  }
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
  if (!open) {
    $('search').blur();
    if (!spot && hover < 0) setCapture(false);
  } else {
    setCapture(true);
  }
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
      if (event.target.closest('.cat-all')) return;
      section.classList.toggle('open');
    });
    const catAllBox = head.querySelector('.cat-all');
    catAllBox.addEventListener('change', (event) => {
      const isChecked = event.target.checked;
      for (const t of cat.types) {
        if (isChecked) enabled.add(t);
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
      box.checked = enabled.has(t);
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

const HOTKEY_DEFS = [
  { action: 'toggleOverlay', defaultKey: 'F7', name: 'Toggle Overlay', desc: 'Show or hide the entire map overlay in-game' },
  { action: 'togglePanel', defaultKey: 'F8', name: 'Toggle Sidebar', desc: 'Open or close this sidebar and categories' },
  { action: 'toggleFound', defaultKey: 'F9', name: 'Hide/Show Collected', desc: 'Toggle visibility of already collected pins' },
  { action: 'cycleOpacity', defaultKey: 'F10', name: 'Cycle Opacity', desc: 'Switch transparency between 100%, 75%, and 50%' },
  { action: 'navigateTarget', defaultKey: 'F6', name: 'Navigate/Track Pin', desc: 'Start or stop GPS tracking/arrow to hovered or selected pin' },
  { action: 'markHovered', defaultKey: 'F4', name: 'Mark/Unmark Pin', desc: 'Toggle collected status for the pin under cursor or selected pin' },
  { action: 'markNearby', defaultKey: 'Alt+E', name: 'Mark Minimap Pin', desc: 'Mark the nearest pin detected on your minimap' },
];

let activeRecordingAction = null;

function renderHotkeyEditor() {
  const container = $('hotkey-editor');
  if (!container) return;
  container.innerHTML = '';
  const currentHotkeys = settings.hotkeys || {};

  HOTKEY_DEFS.forEach((def) => {
    const row = document.createElement('div');
    row.className = 'hotkey-row';

    const info = document.createElement('div');
    info.className = 'hotkey-info';

    const title = document.createElement('div');
    title.className = 'hotkey-title';
    title.textContent = def.name;

    const desc = document.createElement('div');
    desc.className = 'hotkey-desc';
    desc.textContent = def.desc;

    info.append(title, desc);

    const btn = document.createElement('button');
    btn.className = 'hotkey-btn';
    btn.type = 'button';
    btn.dataset.action = def.action;
    const keyVal = currentHotkeys[def.action] || def.defaultKey;
    btn.textContent = keyVal;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeRecordingAction === def.action) {
        cancelRecordingHotkey();
      } else {
        startRecordingHotkey(def.action, btn);
      }
    });

    row.append(info, btn);
    container.append(row);
  });
}

function startRecordingHotkey(action, btn) {
  cancelRecordingHotkey();
  activeRecordingAction = action;
  btn.classList.add('recording');
  btn.textContent = 'Press key...';
  setCapture(true);
}

function cancelRecordingHotkey() {
  if (!activeRecordingAction) return;
  const currentHotkeys = settings.hotkeys || {};
  const btn = document.querySelector(`.hotkey-btn[data-action="${activeRecordingAction}"]`);
  if (btn) {
    btn.classList.remove('recording');
    const def = HOTKEY_DEFS.find(d => d.action === activeRecordingAction);
    btn.textContent = currentHotkeys[activeRecordingAction] || (def ? def.defaultKey : '');
  }
  activeRecordingAction = null;
}

function formatKeyToAccelerator(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;

  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');

  let key = e.key;
  if (/^F\d{1,2}$/i.test(key)) {
    key = key.toUpperCase();
  } else if (key.length === 1) {
    key = key.toUpperCase();
  } else if (key.startsWith('Arrow')) {
    key = key.replace('Arrow', '');
  } else if (key === ' ') {
    key = 'Space';
  } else if (key === 'Escape') {
    return 'Escape';
  }

  parts.push(key);
  return parts.join('+');
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
  renderHotkeyEditor();
  const hk = settings.hotkeys || {};
  $('kbd-found').textContent = hk.toggleFound || '';
  const keys = [
    hk.toggleOverlay && `${hk.toggleOverlay} ${tt('ui.key.toggleOverlay')}`,
    hk.togglePanel && `${hk.togglePanel} ${tt('ui.key.togglePanel')}`,
    hk.toggleFound && `${hk.toggleFound} ${tt('ui.key.toggleFound')}`,
    hk.cycleOpacity && `${hk.cycleOpacity} ${tt('ui.key.cycleOpacity')}`,
    hk.markNearby && `${hk.markNearby} ${tt('ui.key.markNearby')}`,
    hk.markHovered && `${hk.markHovered} Mark Hovered`,
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
  if (spot) toggleFoundMarker(spot.index, true);
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
    const isZooming = target && (Math.abs(next.sx - target.sx) / Math.max(0.0001, target.sx) > 0.003);
    if (!target || isJump(target, next) || isZooming) {
      Object.values(viewFilter).forEach((f) => f.reset());
      velocity = null;
    }
    const stamped = isZooming ? { ...next, at: now } : { ...smoothView(next, now), at: now };
    if (holdStill(target, stamped)) {
      velocity = null;
    } else {
      if (target && !isZooming) updateVelocity(target, stamped);
      else velocity = null;
      target = stamped;
    }
    if (isZooming) {
      // Instant anchor: keep pins 100% stuck to map terrain when zooming
      view = { ...stamped };
    }
    if (playerTrack.lastSeen === 0 && target && target.sx) {
      playerTrack.x = (-target.ox + 0.5) / target.sx;
      playerTrack.y = (-target.oy + 0.5) / target.sy;
      playerTrack.lastSeen = performance.now();
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
  const now = performance.now();
  if (pos && typeof pos.x === 'number') {
    const dt = playerTrack.lastStepTime > 0 ? Math.max(16, now - playerTrack.lastStepTime) : 100;
    if (playerTrack.lastSeen > 0 && dt < 1000) {
      playerTrack.vx = (pos.x - playerTrack.x) / dt;
      playerTrack.vy = (pos.y - playerTrack.y) / dt;
    } else {
      playerTrack.vx = 0;
      playerTrack.vy = 0;
    }
    playerTrack.x = pos.x;
    playerTrack.y = pos.y;
    playerTrack.scale = pos.scale;
    playerTrack.lastSeen = now;
    playerTrack.lastStepTime = now;
    playerTrack.live = true;

    if (typeof pos.angle === 'number' && Number.isFinite(pos.angle)) {
      let diff = pos.angle - currentHeading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      currentHeading += diff * 0.4;
    } else if (lastPlayerMapX && lastPlayerMapY) {
      const mdx = pos.x - lastPlayerMapX;
      const mdy = pos.y - lastPlayerMapY;
      const moveDist = Math.hypot(mdx, mdy);
      if (moveDist > 0.005) {
        const moveAngle = Math.atan2(mdy, mdx);
        let diff = moveAngle - currentHeading;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        currentHeading += diff * 0.35;
      }
    }
    lastPlayerMapX = pos.x;
    lastPlayerMapY = pos.y;
    minimap = pos;
    lastMinimapPos = pos;
    lastMinimapTime = now;
  } else if (!pos) {
    playerTrack.live = false;
    if (now - lastMinimapTime > 60000) {
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
    toggleNavigation(spot.index);
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
  if (performance.now() - lastDomRightClickTime < 300) return;
  if (hover >= 0) {
    toggleFoundMarker(hover);
    return;
  }
  const checkX = (pt && typeof pt.x === 'number') ? pt.x : mouse.x;
  const checkY = (pt && typeof pt.y === 'number') ? pt.y : mouse.y;
  findAndMarkAt(checkX, checkY);
});

api.on('hotkey:navigateTarget', () => {
  let targetIndex = -1;
  if (hover >= 0) {
    targetIndex = hover;
  } else if (spot && typeof spot.index === 'number') {
    targetIndex = spot.index;
  } else if (navigatingPin) {
    navigatingPin = null;
    renderSpotNav();
    requestDraw();
    showToast('✕ Navigation cleared');
    return;
  }
  if (targetIndex >= 0) {
    toggleNavigation(targetIndex);
  } else {
    showToast('🧭 Hover over a pin or open a pin to navigate');
  }
});


const panelEl = $('panel');
if (panelEl) {
  panelEl.addEventListener('mouseenter', () => setCapture(true));
  panelEl.addEventListener('mouseover', () => setCapture(true));
  panelEl.addEventListener('mouseleave', (e) => {
    if (hover < 0 && (!spot || !overSpot(e.clientX, e.clientY))) {
      setCapture(false);
    }
  });
}
const spotElem = $('spot');
if (spotElem) {
  spotElem.addEventListener('mouseenter', () => setCapture(true));
  spotElem.addEventListener('mouseover', () => setCapture(true));
  spotElem.addEventListener('mouseleave', (e) => {
    if (hover < 0 && (!panelOpen || !overPanel(e.clientX, e.clientY))) {
      setCapture(false);
    }
  });
}
window.addEventListener('keydown', (e) => {
  if (activeRecordingAction) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cancelRecordingHotkey();
      showToast('Hotkey recording cancelled');
      return;
    }
    const combo = formatKeyToAccelerator(e);
    if (!combo) return;

    const action = activeRecordingAction;
    const def = HOTKEY_DEFS.find(d => d.action === action);
    cancelRecordingHotkey();

    const patch = { hotkeys: { [action]: combo } };
    if (!settings.hotkeys) settings.hotkeys = {};
    settings.hotkeys[action] = combo;
    api.saveSettings(patch);
    renderHotkeyEditor();
    showToast(`✓ Hotkey set: ${def ? def.name : action} → ${combo}`);
    return;
  }

  if (e.key === 'Escape' && panelOpen) {
    setPanel(false);
    return;
  }

  // Quick navigation / mark keys when overlay is active
  if (!activeRecordingAction && document.activeElement && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    if (e.key === 't' || e.key === 'T' || e.key === 'n' || e.key === 'N') {
      const targetIndex = hover >= 0 ? hover : (spot ? spot.index : -1);
      if (targetIndex >= 0 || navigatingPin) {
        e.preventDefault();
        if (targetIndex >= 0) {
          toggleNavigation(targetIndex);
        } else if (navigatingPin) {
          navigatingPin = null;
          renderSpotNav();
          requestDraw();
          showToast('✕ Navigation cleared');
        }
      }
    }
  }
});

const btnResetHotkeys = $('reset-hotkeys');
if (btnResetHotkeys) {
  btnResetHotkeys.addEventListener('click', (e) => {
    e.stopPropagation();
    const defaults = {};
    HOTKEY_DEFS.forEach(d => { defaults[d.action] = d.defaultKey; });
    settings.hotkeys = { ...defaults };
    api.saveSettings({ hotkeys: defaults });
    renderHotkeyEditor();
    showToast('✓ Hotkeys reset to defaults');
  });
}
