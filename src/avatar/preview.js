/**
 * Figure styles side by side (doc/figure-styles.html): the same made-up
 * dancer drawn as each of FIGURE_STYLES, big and — like a guest or the DJ
 * at the booth — small. Not part of the app. Rebuild the page after
 * changing how figures are drawn:
 *
 *   npx esbuild src/avatar/preview.js --bundle --format=iife --minify > /tmp/preview.js
 *   then replace the script in doc/figure-styles.html with it
 */
import { StickFigureAvatar, FIGURE_STYLES, FIGURE_NAMES } from './stickFigure.js';
import { demoPose } from './demoDancer.js';

const W = 360, H = 480;
const state = { glow: true, light: false, torso: '1d', playing: true };
const stages = FIGURE_STYLES.map((style) => {
  const fig = document.createElement('figure');
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const cap = document.createElement('figcaption');
  cap.textContent = FIGURE_NAMES[style];
  fig.append(canvas, cap);
  document.getElementById('stages').append(fig);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return {
    ctx,
    you: new StickFigureAvatar({ style }),
    guest: new StickFigureAvatar({ style, color: '#7dffb0', glow: '#c2ffdc', glowStyle: 'none', alpha: 0.9 }),
    far: new StickFigureAvatar({ style, color: '#fff37d', glow: '#fffac2', glowStyle: 'none', alpha: 0.9 }),
  };
});

let t = 0, last = performance.now();
function draw(now) {
  requestAnimationFrame(draw);
  if (state.playing) t += Math.min(100, now - last);
  last = now;
  const view = { width: W, height: H };
  for (const s of stages) {
    const { ctx } = s;
    // A stand-in for the room photo: dark, or a bright room.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (state.light) { g.addColorStop(0, '#cfc8bd'); g.addColorStop(0.62, '#b9b1a4'); g.addColorStop(0.63, '#8d7f6c'); g.addColorStop(1, '#75695a'); }
    else { g.addColorStop(0, '#15131f'); g.addColorStop(0.62, '#1b1828'); g.addColorStop(0.63, '#221d2e'); g.addColorStop(1, '#17141f'); }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const a of [s.you, s.guest, s.far]) a.torso = state.torso;
    s.you.glowStyle = state.glow ? 'blur' : 'none';
    // Back to front: the DJ at the booth, a guest behind you, you.
    s.far.render(ctx, demoPose(t + 900, { cx: 0.5, cy: 0.3, size: 0.08 }), view);
    s.guest.render(ctx, demoPose(t + 2100, { cx: 0.27, cy: 0.5, size: 0.15 }), view);
    s.you.render(ctx, demoPose(t, { cx: 0.64, cy: 0.58, size: 0.2 }), view);
  }
}
requestAnimationFrame(draw);

const toggle = (id, key, on, off, labels) => {
  const b = document.getElementById(id);
  const show = () => { b.textContent = labels[state[key] === on ? 0 : 1]; b.setAttribute('aria-pressed', String(state[key] === on)); };
  b.addEventListener('click', () => { state[key] = state[key] === on ? off : on; show(); });
  show();
};
toggle('t-glow', 'glow', true, false, ['Your glow: on', 'Your glow: off']);
toggle('t-room', 'light', true, false, ['Room: bright', 'Room: dark']);
toggle('t-torso', 'torso', '2d', '1d', ['Torso: 2D', 'Torso: 1D']);
toggle('t-play', 'playing', true, false, ['Pause', 'Play']);
