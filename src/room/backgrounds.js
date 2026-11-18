/**
 * Backgrounds for the dance screen, behind the dancers.
 *
 *   camera  the live camera (no background; you see yourself)
 *   photo   the room photo snapped at the start (RoomModel's clean plate)
 *   solid   one colour
 *   stars, club, sky, street   scenes drawn here in code, so there are no
 *           image licences to mind and nothing to download
 *
 * A scene is painted once into the plate canvas (like the room photo), at
 * the camera's size, from a fixed seed: the same picture every time.
 */
export const BACKGROUNDS = ['camera', 'photo', 'solid', 'stars', 'club', 'sky', 'street'];
export const BACKGROUND_NAMES = {
  camera: 'Live camera',
  photo: 'Room photo',
  solid: 'Solid colour',
  stars: 'Stars',
  club: 'Foggy club',
  sky: 'Sky',
  street: 'City street',
};
export const SCENES = ['stars', 'club', 'sky', 'street'];

/** Small seeded random numbers (mulberry32), so a scene never changes. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const vgrad = (ctx, h, stops) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [at, c] of stops) g.addColorStop(at, c);
  return g;
};

/** A soft round glow: colour at the centre fading to nothing. */
function glow(ctx, x, y, r, color, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

function stars(ctx, w, h) {
  const r = rng(7);
  const u = Math.min(w, h);
  ctx.fillStyle = vgrad(ctx, h, [[0, '#02030a'], [0.6, '#070b1e'], [1, '#0d0820']]);
  ctx.fillRect(0, 0, w, h);
  // Faint nebulae.
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, w * 0.28, h * 0.32, u * 0.55, 'rgba(110,60,200,0.5)', 0.35);
  glow(ctx, w * 0.75, h * 0.6, u * 0.5, 'rgba(30,120,180,0.5)', 0.3);
  glow(ctx, w * 0.55, h * 0.2, u * 0.35, 'rgba(200,60,140,0.4)', 0.2);
  // A band of the Milky Way: dense small stars along a diagonal.
  const n = Math.round((w * h) / 900);
  for (let i = 0; i < n; i++) {
    let x = r() * w, y = r() * h;
    if (i % 3 === 0) {
      const t = r();
      x = t * w;
      y = h * (0.85 - 0.7 * t) + (r() + r() + r() - 1.5) * u * 0.12;
    }
    const s = r() ** 3 * u * 0.004 + 0.4;
    ctx.globalAlpha = 0.3 + r() * 0.7;
    ctx.fillStyle = ['#ffffff', '#cfe0ff', '#ffe9c9', '#dcd0ff'][Math.floor(r() * 4)];
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // A few bright ones with a glow and a cross.
  for (let i = 0; i < 9; i++) {
    const x = r() * w, y = r() * h, s = u * (0.006 + r() * 0.006);
    glow(ctx, x, y, s * 5, 'rgba(200,220,255,0.6)', 0.6);
    ctx.strokeStyle = 'rgba(230,240,255,0.5)';
    ctx.lineWidth = Math.max(1, s * 0.25);
    ctx.beginPath();
    ctx.moveTo(x - s * 4, y); ctx.lineTo(x + s * 4, y);
    ctx.moveTo(x, y - s * 4); ctx.lineTo(x, y + s * 4);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function club(ctx, w, h) {
  const r = rng(11);
  const u = Math.min(w, h);
  ctx.fillStyle = vgrad(ctx, h, [[0, '#07020d'], [0.6, '#12061f'], [1, '#05020a']]);
  ctx.fillRect(0, 0, w, h);
  const floorY = h * 0.68;
  // Dance floor: tiles in perspective, a few lit.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, floorY, w, h - floorY);
  ctx.clip();
  const cols = 14, rows = 7, vx = w / 2;
  const at = (c, rr) => {
    const t = rr / rows;
    const y = floorY + (h - floorY) * t ** 1.6;
    const spread = 0.35 + 0.65 * t ** 1.6;
    return { x: vx + (c / cols - 0.5) * w * 2.2 * spread, y };
  };
  const tileColors = ['#ff2d95', '#7a3cff', '#00c8ff', '#ffb000'];
  for (let rr = 0; rr < rows; rr++) {
    for (let c = 0; c < cols; c++) {
      const a = at(c, rr), b = at(c + 1, rr), d = at(c, rr + 1), e = at(c + 1, rr + 1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.lineTo(d.x, d.y);
      ctx.closePath();
      const lit = r() < 0.22;
      ctx.fillStyle = lit ? tileColors[Math.floor(r() * 4)] : '#140a20';
      ctx.globalAlpha = lit ? 0.35 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(160,120,255,0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
  // Spotlights from the ceiling, added light on light.
  ctx.globalCompositeOperation = 'lighter';
  const beams = [
    [0.12, '255,45,149'], [0.32, '0,200,255'], [0.5, '160,90,255'], [0.68, '255,176,0'], [0.88, '0,255,170'],
  ];
  for (const [fx, rgb] of beams) {
    const x0 = w * fx;
    const x1 = x0 + (r() - 0.5) * w * 0.7;
    const half = u * (0.07 + r() * 0.06);
    const g = ctx.createLinearGradient(x0, 0, x1, floorY);
    g.addColorStop(0, `rgba(${rgb},0.55)`);
    g.addColorStop(1, `rgba(${rgb},0.04)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0 - u * 0.008, 0);
    ctx.lineTo(x0 + u * 0.008, 0);
    ctx.lineTo(x1 + half, floorY);
    ctx.lineTo(x1 - half, floorY);
    ctx.closePath();
    ctx.fill();
    glow(ctx, x1, floorY + u * 0.02, half * 1.6, `rgba(${rgb},0.6)`, 0.5);
    glow(ctx, x0, 0, u * 0.05, `rgba(${rgb},0.9)`, 0.9);
  }
  ctx.globalCompositeOperation = 'source-over';
  // Fog: big soft white clouds, thicker low down.
  for (let i = 0; i < 110; i++) {
    const y = h * (0.35 + r() * 0.6);
    glow(ctx, r() * w, y, u * (0.15 + r() * 0.3), 'rgba(200,190,230,0.5)', 0.05 + 0.07 * (y / h));
  }
}

function sky(ctx, w, h) {
  const r = rng(23);
  const u = Math.min(w, h);
  // Dusk: deep blue above, warm at the horizon; the dancers stay readable.
  ctx.fillStyle = vgrad(ctx, h, [[0, '#071330'], [0.5, '#22336e'], [0.8, '#5e2f63'], [1, '#a34a3c']]);
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w * 0.7, h * 0.97, u * 0.5, 'rgba(255,170,90,0.8)', 0.45);
  // Clouds: clusters of soft puffs, lit pink from below.
  for (let c = 0; c < 9; c++) {
    const cx = r() * w * 1.2 - w * 0.1;
    const cy = h * (0.15 + r() * 0.6);
    const size = u * (0.08 + r() * 0.1);
    // Lit warm from below, cool on top: a few puffs in two layers.
    const below = cy / h > 0.5;
    for (let p = 0; p < 22; p++) {
      const px = cx + (r() - 0.5) * size * 5;
      const py = cy + (r() - 0.5) * size * 0.7;
      const pr = size * (0.35 + r() * 0.45);
      glow(ctx, px, py + pr * 0.25, pr, below ? 'rgba(255,140,120,0.7)' : 'rgba(150,140,200,0.7)', 0.3);
      glow(ctx, px, py - pr * 0.2, pr * 0.8, below ? 'rgba(120,70,120,0.8)' : 'rgba(60,70,130,0.8)', 0.35);
    }
  }
  // The first stars, high up.
  for (let i = 0; i < 60; i++) {
    ctx.globalAlpha = 0.25 + r() * 0.5;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r() * w, r() * h * 0.3, 0.5 + r() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function street(ctx, w, h) {
  const r = rng(31);
  const u = Math.min(w, h);
  const horizon = h * 0.62;
  ctx.fillStyle = vgrad(ctx, horizon, [[0, '#050814'], [0.7, '#1a1838'], [1, '#4a2a4a']]);
  ctx.fillRect(0, 0, w, horizon);
  glow(ctx, w / 2, horizon, u * 0.8, 'rgba(255,140,80,0.5)', 0.35);
  // Two rows of buildings, the far one dimmer; windows lit at random.
  for (const [far, base, color] of [[true, horizon, '#141428'], [false, horizon + u * 0.02, '#0b0b18']]) {
    let x = -r() * u * 0.1;
    while (x < w) {
      const bw = u * (far ? 0.07 + r() * 0.08 : 0.12 + r() * 0.12);
      const bh = h * (far ? 0.15 + r() * 0.3 : 0.12 + r() * 0.38);
      ctx.fillStyle = color;
      ctx.fillRect(x, base - bh, bw, bh + 1);
      const ws = u * (far ? 0.008 : 0.013);
      for (let wy = base - bh + ws * 1.5; wy < base - ws * 2; wy += ws * 2.2) {
        for (let wx = x + ws; wx < x + bw - ws * 1.5; wx += ws * 1.9) {
          if (r() < (far ? 0.25 : 0.32)) {
            ctx.fillStyle = ['#ffd27a', '#ffe9b0', '#9fd6ff', '#ffb36b'][Math.floor(r() * 4)];
            ctx.globalAlpha = far ? 0.45 : 0.8;
            ctx.fillRect(wx, wy, ws, ws * 1.2);
            ctx.globalAlpha = 1;
          }
        }
      }
      x += bw + (far ? 0 : u * r() * 0.02);
    }
  }
  // The street: dark, wet, in perspective.
  ctx.fillStyle = vgrad(ctx, h, [[0, '#0e0d1a'], [1, '#1c1a2c']]);
  ctx.fillRect(0, horizon + u * 0.02, w, h);
  const top = horizon + u * 0.02;
  ctx.strokeStyle = 'rgba(255,220,140,0.55)';
  ctx.lineWidth = Math.max(1, u * 0.006);
  ctx.setLineDash([u * 0.05, u * 0.05]);
  ctx.beginPath();
  ctx.moveTo(w / 2, top);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(180,180,220,0.25)';
  ctx.beginPath();
  ctx.moveTo(w * 0.42, top); ctx.lineTo(-w * 0.3, h);
  ctx.moveTo(w * 0.58, top); ctx.lineTo(w * 1.3, h);
  ctx.stroke();
  // Street lights, with their reflections on the wet road.
  ctx.globalCompositeOperation = 'lighter';
  for (const fx of [0.08, 0.3, 0.7, 0.92]) {
    const x = w * fx, y = horizon - h * 0.18 * (Math.abs(fx - 0.5) * 2);
    ctx.strokeStyle = '#26243a';
    ctx.lineWidth = Math.max(2, u * 0.008);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, top + h * 0.12 * Math.abs(fx - 0.5) * 2);
    ctx.stroke();
    glow(ctx, x, y, u * 0.12, 'rgba(255,190,90,0.8)', 0.8);
    glow(ctx, x, top + (h - top) * 0.5, u * 0.14, 'rgba(255,170,80,0.5)', 0.25);
  }
  // Neon, here and there in the far windows.
  for (let i = 0; i < 6; i++) {
    glow(ctx, r() * w, horizon - h * (0.05 + r() * 0.25), u * 0.05, ['rgba(255,45,149,0.8)', 'rgba(0,200,255,0.8)'][i % 2], 0.5);
  }
  ctx.globalCompositeOperation = 'source-over';
}

const PAINTERS = { stars, club, sky, street };

/**
 * Paint a background into the canvas (resized to w × h). `photo` is the
 * room's clean plate, used for 'photo'; 'camera' leaves the canvas alone
 * (the live feed is drawn on the stage instead).
 */
export function paintBackground(canvas, kind, { w, h, color = '#000000', photo = null } = {}) {
  if (kind === 'camera') return;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (kind === 'photo' && photo) {
    ctx.drawImage(photo, 0, 0, w, h);
  } else if (PAINTERS[kind]) {
    PAINTERS[kind](ctx, w, h);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
  }
}
