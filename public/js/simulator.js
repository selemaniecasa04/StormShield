// Weather impact visualiser: an illustrative scene driven by the current hazard picture.
// It is an illustration of the data, not a camera view.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SKY = {
  storm: ['#1d2530', '#3a4452'], hail: ['#232a33', '#47505c'], flood: ['#2c3640', '#56606b'], wind: ['#4d5b66', '#8a98a3'],
  heat: ['#d9893d', '#f3d29a'], air: ['#8f7d63', '#c7b79a'], cold: ['#6f8fa8', '#c9d8e3'], calm: ['#4f8fc0', '#b8d9ef'], night: ['#0c1424', '#22314a'], none: ['#5d6872', '#8c969e'],
};

export class Simulator {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.mode = 'none'; this.params = {}; this.parts = []; this.t = 0; this.flash = 0; this.running = false;
    this.visible = true;
    new ResizeObserver(() => this.resize()).observe(canvas);
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.kick(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => this.kick());
    this.resize();
  }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.c.width = this.w * dpr; this.c.height = this.h * dpr; this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed(); this.draw();
  }
  /** mode: storm|hail|flood|wind|heat|air|cold|calm|none ; params: { rain, gust, windDir, aqi, apparent, uv, river, isDay } */
  set(mode, params) {
    const changed = mode !== this.mode;
    this.mode = mode; this.params = params || {};
    if (changed) this.seed();
    this.kick();
  }
  seed() {
    const n = { storm: 220, hail: 140, flood: 260, wind: 70, air: 60, heat: 24, cold: 60 }[this.mode] || 0;
    const intensity = Math.min(1, (this.params.rain || 0) / 25 + 0.25);
    this.parts = Array.from({ length: Math.round(n * (this.mode === 'flood' || this.mode === 'storm' ? intensity + 0.3 : 1)) }, () => ({ x: Math.random() * this.w, y: Math.random() * this.h, v: 0.5 + Math.random(), s: Math.random() }));
  }
  kick() {
    const want = this.visible && !document.hidden && !reduced() && this.mode !== 'none';
    if (want && !this.running) { this.running = true; const loop = () => { if (!this.running) return; this.t++; this.draw(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
    if (!want) { this.running = false; this.draw(); }
  }
  draw() {
    const { ctx, w, h } = this; if (!w) return;
    const p = this.params; const mode = this.mode;
    const sky = SKY[!p.isDay && (mode === 'calm' || mode === 'none') ? 'night' : mode] || SKY.none;
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    // Sun / heat glow
    if (mode === 'heat' || (mode === 'calm' && p.isDay)) {
      const pulse = mode === 'heat' ? 1 + Math.sin(this.t / 30) * 0.05 : 1;
      const rg = ctx.createRadialGradient(w * 0.8, h * 0.25, 4, w * 0.8, h * 0.25, h * 0.6 * pulse);
      rg.addColorStop(0, mode === 'heat' ? 'rgba(255,240,200,0.95)' : 'rgba(255,250,225,0.9)'); rg.addColorStop(0.15, mode === 'heat' ? 'rgba(255,190,90,0.6)' : 'rgba(255,240,200,0.3)'); rg.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
    }
    // Clouds
    if (['storm', 'hail', 'flood', 'wind', 'cold'].includes(mode)) {
      ctx.fillStyle = mode === 'storm' || mode === 'hail' ? 'rgba(15,20,28,0.65)' : 'rgba(60,70,80,0.45)';
      for (let i = 0; i < 6; i++) { const cx = ((i * w) / 5 + this.t * (mode === 'wind' ? 1.2 : 0.2)) % (w + 160) - 80; ctx.beginPath(); ctx.ellipse(cx, h * 0.12 + (i % 2) * 14, 110, 34, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    // Lightning
    if (mode === 'storm' || mode === 'hail') {
      if (!reduced() && Math.random() < 0.012) this.flash = 8;
      if (this.flash > 0) {
        ctx.fillStyle = `rgba(230,236,255,${this.flash / 20})`; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,240,0.95)'; ctx.lineWidth = 2; ctx.beginPath();
        let x = w * (0.3 + Math.random() * 0.4), y = h * 0.15; ctx.moveTo(x, y);
        while (y < h * 0.7) { x += (Math.random() - 0.5) * 30; y += 14 + Math.random() * 12; ctx.lineTo(x, y); }
        ctx.stroke(); this.flash--;
      }
    }
    // Ground and skyline
    const groundY = h * 0.78;
    const water = mode === 'flood' ? Math.min(0.85, 0.25 + (p.river || 1) * 0.06 + (p.rain || 0) / 80) : 0;
    ctx.fillStyle = mode === 'heat' ? '#7a5a3a' : '#2d3a33';
    ctx.fillRect(0, groundY, w, h - groundY);
    ctx.fillStyle = mode === 'heat' ? 'rgba(80,50,30,0.85)' : 'rgba(20,26,32,0.85)';
    const bw = Math.max(26, w / 16);
    for (let i = 0; i < w / bw; i++) { const bh = 30 + ((i * 37) % 70); ctx.fillRect(i * bw + 4, groundY - bh, bw - 8, bh); }
    // Tree that bends with wind
    const bend = Math.min(1, (p.gust || 0) / 110) * (mode === 'wind' || mode === 'storm' ? 1 : 0.3);
    const sway = bend * 26 + Math.sin(this.t / 6) * bend * 8;
    ctx.strokeStyle = '#2a1e14'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(w * 0.15, groundY); ctx.quadraticCurveTo(w * 0.15, groundY - 40, w * 0.15 + sway, groundY - 70); ctx.stroke();
    ctx.fillStyle = mode === 'heat' ? '#7d7a3a' : '#2f5b3a'; ctx.beginPath(); ctx.ellipse(w * 0.15 + sway * 1.2, groundY - 85, 30, 26, sway / 60, 0, Math.PI * 2); ctx.fill();

    // Floodwater
    if (water) {
      const wy = groundY - (h * 0.35) * water;
      ctx.fillStyle = 'rgba(70,110,140,0.75)'; ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 12) ctx.lineTo(x, wy + Math.sin((x + this.t * 2) / 25) * 4);
      ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(w * 0.55, groundY - 18); ctx.lineTo(w * 0.95, groundY - 18); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.font = '600 11px system-ui, sans-serif'; ctx.fillText('30 cm: cars can float', w * 0.56, groundY - 24);
    }
    // Particles
    const angle = mode === 'wind' || mode === 'storm' ? Math.min(0.7, (p.gust || 0) / 140) : 0.1;
    for (const q of this.parts) {
      if (mode === 'storm' || mode === 'flood') {
        ctx.strokeStyle = 'rgba(190,210,230,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - angle * 14, q.y + 14); ctx.stroke();
        q.y += 9 * q.v; q.x -= angle * 9 * q.v;
      } else if (mode === 'hail') {
        ctx.fillStyle = 'rgba(240,248,255,0.9)'; ctx.beginPath(); ctx.arc(q.x, q.y, 1.5 + q.s * 2, 0, Math.PI * 2); ctx.fill(); q.y += 7 * q.v; q.x -= angle * 4;
      } else if (mode === 'cold') {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(q.x, q.y, 1 + q.s * 1.5, 0, Math.PI * 2); ctx.fill(); q.y += 1.4 * q.v; q.x += Math.sin((this.t + q.s * 100) / 20) * 0.5;
      } else if (mode === 'wind') {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + 30 + q.s * 30, q.y + 2); ctx.stroke(); q.x += 8 * q.v * (0.5 + (p.gust || 40) / 80);
      } else if (mode === 'air') {
        ctx.fillStyle = `rgba(120,100,80,${0.08 + q.s * 0.08})`; ctx.beginPath(); ctx.arc(q.x, q.y, 20 + q.s * 40, 0, Math.PI * 2); ctx.fill(); q.x += 0.3 * q.v;
      } else if (mode === 'heat') {
        ctx.strokeStyle = 'rgba(255,230,190,0.25)'; ctx.lineWidth = 2; ctx.beginPath();
        for (let y = 0; y < 40; y += 4) ctx.lineTo(q.x + Math.sin((y + this.t) / 5) * 3, groundY - y - q.s * 40);
        ctx.stroke();
      }
      if (q.y > h) { q.y = -10; q.x = Math.random() * (w + 100); }
      if (q.x > w + 80) { q.x = -80; q.y = Math.random() * h; }
      if (q.x < -100) q.x = w + 20;
    }
    // Haze overlay
    if (mode === 'air') { ctx.fillStyle = `rgba(150,125,95,${Math.min(0.55, (p.aqi || 100) / 500)})`; ctx.fillRect(0, 0, w, h); }
    if (mode === 'none') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, w, h);
    }
  }
}

/** Choose the scene from the assessment's dominant hazard. */
export function sceneFor(assessment) {
  if (!assessment || assessment.level === 'UNKNOWN') return 'none';
  const order = ['storm', 'hail', 'flood', 'wind', 'heat', 'cold', 'air', 'visibility'];
  const top = assessment.hazards.find((h) => order.includes(h.id) && h.severity >= 0.15);
  if (!top) return 'calm';
  return top.id === 'visibility' ? 'air' : top.id;
}
