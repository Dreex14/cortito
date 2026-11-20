/* Cortito — editor de vídeo pequeñito */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MIN_SEG = 0.1;

hydrateIcons();

// ---------- Estado ----------
const S = {
  info: null,
  previewUrl: null,
  segments: [],
  selSeg: 0,
  crop: null, // {x,y,w,h} normalizado 0..1 o null
  aspect: 'free',
  audio: { track: 0, volume: 1, muted: false },
  music: null, // {path,name,url,duration,volume,start,offset,loop,fadeIn,fadeOut}
  overlays: [], // {id,path,name,url,type,x,y,w,h,ar,start,end,opacity,offset,duration}
  selOv: -1,
  tab: 'trim',
  zoom: 1,
  fmt: 'mp4',
  thumbs: [],
};
const els = {
  video: $('#video'), frame: $('#frame'), viewer: $('#viewer'), cropLayer: $('#cropLayer'), cropBox: $('#cropBox'),
  ovLayer: $('#ovLayer'), tlInner: $('#tlInner'), tlScroll: $('#tlScroll'), playhead: $('#playhead'),
};
const video = els.video;
const musicEl = new Audio();
const altAudioEl = new Audio();
let altAudioTrack = -1;

// ---------- Utilidades ----------
function fmtTime(t, cs = true) {
  if (!isFinite(t)) t = 0;
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const c = Math.floor((t % 1) * 100);
  const base = (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  return cs ? `${base}.${String(c).padStart(2, '0')}` : base;
}
function parseTime(str) {
  str = String(str).trim().replace(',', '.');
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some((p) => !isFinite(p))) return NaN;
  return parts.reduce((a, p) => a * 60 + p, 0);
}
function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
const dur = () => (S.info ? S.info.duration : 0);
const W = () => S.info.video.width;
const H = () => S.info.video.height;
const fps = () => (S.info && S.info.video.fps) || 30;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 5000 : 2600);
}
function setRangeFill(r) {
  const p = ((r.value - r.min) / (r.max - r.min)) * 100;
  r.style.setProperty('--p', p + '%');
}
$$('input[type=range]').forEach((r) => { setRangeFill(r); r.addEventListener('input', () => setRangeFill(r)); });

// Conversión de tiempo original ↔ tiempo del resultado
function srcToOut(t) {
  let acc = 0;
  for (const s of S.segments) {
    if (t >= s.end) acc += s.end - s.start;
    else { if (t > s.start) acc += t - s.start; break; }
  }
  return acc;
}
const outDuration = () => S.segments.reduce((a, s) => a + (s.end - s.start), 0);
function segIndexAt(t) {
  return S.segments.findIndex((s) => t >= s.start - 1e-3 && t < s.end - 1e-3);
}

// ---------- Historial ----------
const hist = { past: [], future: [] };
function snapshot() {
  return JSON.stringify({ segments: S.segments, crop: S.crop, aspect: S.aspect, audio: S.audio, music: S.music, overlays: S.overlays });
}
function commit() {
  hist.past.push(snapshot());
  if (hist.past.length > 150) hist.past.shift();
  hist.future = [];
  updateUndoButtons();
}
function restore(snap) {
  const d = JSON.parse(snap);
  Object.assign(S, d);
  S.selSeg = clamp(S.selSeg, 0, S.segments.length - 1);
  if (S.selOv >= S.overlays.length) S.selOv = S.overlays.length - 1;
  if (S.music) { if (musicEl.src !== S.music.url) musicEl.src = S.music.url; } else musicEl.removeAttribute('src');
  buildOverlayDom();
  renderAll();
}
function undo() {
  if (!hist.past.length) return;
  hist.future.push(snapshot());
  restore(hist.past.pop());
  updateUndoButtons();
}
function redo() {
  if (!hist.future.length) return;
  hist.past.push(snapshot());
  restore(hist.future.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !hist.past.length;
  $('#btnRedo').disabled = !hist.future.length;
}

// ---------- Carga ----------
function showLoading(text, progress = null) {
  $('#loading').classList.remove('hidden');
  $('#loadingText').textContent = text;
  $('#loadingBarWrap').classList.toggle('hidden', progress === null);
  if (progress !== null) $('#loadingBar').style.width = `${progress * 100}%`;
}
const hideLoading = () => $('#loading').classList.add('hidden');

window.api.onProgress(({ kind, value }) => {
  if (kind === 'proxy') showLoading('Preparando la vista previa…', value);
  if (kind === 'export') setExportProgress(value);
});

function canPlay(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      video.removeEventListener('loadeddata', onData);
      video.removeEventListener('error', onErr);
      clearTimeout(timer);
      resolve(ok);
    };
    const onData = () => finish(video.videoWidth > 0);
    const onErr = () => finish(false);
    video.addEventListener('loadeddata', onData);
    video.addEventListener('error', onErr);
    const timer = setTimeout(() => finish(video.videoWidth > 0), 6000);
    video.src = url;
    video.load();
  });
}

async function openVideo(path) {
  if (!path) return;
  if (exporting) return;
  try {
    showLoading('Analizando el vídeo…');
    const info = await window.api.probe(path);
    if (!info.video) throw new Error('El archivo no contiene ninguna pista de vídeo.');
    if (!info.duration) throw new Error('No se pudo leer la duración del vídeo.');
    video.pause();
    S.info = info;
    S.segments = [{ start: 0, end: info.duration }];
    S.selSeg = 0;
    S.crop = null;
    S.aspect = 'free';
    S.audio = { track: 0, volume: 1, muted: false };
    S.music = null;
    S.overlays = [];
    S.selOv = -1;
    S.zoom = 1;
    S.thumbs = [];
    hist.past = []; hist.future = [];
    updateUndoButtons();
    musicEl.pause(); musicEl.removeAttribute('src');
    altAudioEl.pause(); altAudioEl.removeAttribute('src'); altAudioTrack = -1;

    showLoading('Abriendo el vídeo…');
    let ok = await canPlay(info.url);
    S.previewUrl = info.url;
    if (!ok) {
      showLoading('Preparando la vista previa…', 0);
      const proxy = await window.api.makeProxy(path, info.duration);
      ok = await canPlay(proxy);
      S.previewUrl = proxy;
      if (!ok) throw new Error('No se pudo previsualizar este vídeo.');
      toast('Vista previa optimizada: el resultado usará el vídeo original');
    }
    hideLoading();

    $('#welcome').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#fileChip').classList.remove('hidden');
    $('#btnExport').disabled = false;
    $('#fileName').textContent = info.name;
    const v = info.video;
    $('#fileMeta').textContent = `${v.width}×${v.height} · ${Math.round(v.fps * 100) / 100} fps · ${(v.codec || '').toUpperCase()} · ${fmtSize(info.size)}`;
    $('#zoom').value = 1; setRangeFill($('#zoom'));
    buildOverlayDom();
    setupAudioPanel();
    layoutFrame();
    renderAll();
    video.currentTime = 0;
    loadThumbsAndWave();
  } catch (e) {
    hideLoading();
    toast(e.message || String(e), true);
  }
}

async function loadThumbsAndWave() {
  const info = S.info;
  const thumbs = $('#thumbs');
  thumbs.innerHTML = '';
  thumbs.classList.add('loading');
  $('#wave').style.webkitMaskImage = 'none';
  $('#wave').style.opacity = 0;
  const count = clamp(Math.round(info.duration / 2), 10, 40);
  window.api.thumbnails(info.path, info.duration, count).then((list) => {
    if (S.info !== info) return;
    thumbs.classList.remove('loading');
    S.thumbs = list;
    thumbs.innerHTML = list.map((u) => (u ? `<img src="${u}" draggable="false" />` : '<img />')).join('');
  }).catch(() => thumbs.classList.remove('loading'));
  loadWave();
}
async function loadWave() {
  const info = S.info;
  if (!info.audio.length) return;
  try {
    const url = await window.api.waveform(info.path, S.audio.track);
    if (S.info !== info) return;
    const w = $('#wave');
    w.style.webkitMaskImage = `url("${url}")`;
    w.style.opacity = 1;
  } catch (_) { /* opcional */ }
}

// ---------- Marco del vídeo ----------
function layoutFrame() {
  if (!S.info) return;
  const box = els.viewer.getBoundingClientRect();
  const pad = 24;
  const ar = W() / H();
  let w = box.width - pad * 2;
  let h = w / ar;
  if (h > box.height - pad * 2) { h = box.height - pad * 2; w = h * ar; }
  els.frame.style.width = `${Math.max(10, w)}px`;
  els.frame.style.height = `${Math.max(10, h)}px`;
}
new ResizeObserver(() => { layoutFrame(); renderTimeline(); }).observe(els.viewer);
new ResizeObserver(() => renderTimeline()).observe(els.tlScroll);

// ---------- Pestañas ----------
function setTab(tab) {
  S.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  const btn = $(`#tabs button[data-tab="${tab}"]`);
  const ink = $('#tabInk');
  ink.style.width = `${btn.offsetWidth}px`;
  ink.style.transform = `translateX(${btn.offsetLeft - 6}px)`;
  renderCrop();
  renderOverlays();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
requestAnimationFrame(() => setTab('trim'));

// ---------- Reproducción ----------
function togglePlay() {
  if (!S.info) return;
  if (video.paused) {
    const t = video.currentTime;
    const last = S.segments[S.segments.length - 1];
    if (t >= last.end - 0.05) video.currentTime = S.segments[0].start;
    else if (segIndexAt(t) < 0) {
      const nx = S.segments.find((s) => s.start > t);
      if (nx) video.currentTime = nx.start;
    }
    video.play().catch(() => {});
  } else video.pause();
}
video.addEventListener('play', () => { $('#btnPlay').innerHTML = icon('pause'); });
video.addEventListener('pause', () => { $('#btnPlay').innerHTML = icon('play'); musicEl.pause(); altAudioEl.pause(); pauseOverlayVideos(); });

function seek(t) {
  if (!S.info) return;
  video.currentTime = clamp(t, 0, dur());
}
function step(frames) {
  video.pause();
  seek(video.currentTime + frames / fps());
}

let lastT = -1;
function tick() {
  requestAnimationFrame(tick);
  if (!S.info) return;
  const t = video.currentTime;
  if (!video.paused && !video.seeking && S.segments.length) {
    const i = segIndexAt(t);
    if (i < 0) {
      const nx = S.segments.find((s) => s.start > t);
      if (nx) video.currentTime = nx.start;
      else { video.pause(); video.currentTime = S.segments[S.segments.length - 1].end; }
    } else if (t >= S.segments[i].end - 0.03) {
      if (i + 1 < S.segments.length) video.currentTime = S.segments[i + 1].start;
      else video.pause();
    }
  }
  syncMedia(t);
  if (t !== lastT || dragging) {
    lastT = t;
    updatePlayhead(t);
    $('#tCur').textContent = fmtTime(t);
    renderOverlayVisibility(t);
  }
}
requestAnimationFrame(tick);

function syncEl(el, desired, shouldPlay) {
  if (!el.src || !isFinite(desired)) return;
  if (shouldPlay) {
    if (Math.abs(el.currentTime - desired) > 0.25) el.currentTime = desired;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - desired) > 0.04 && !el.seeking) el.currentTime = Math.max(0, desired);
  }
}

function syncMedia(t) {
  const playing = !video.paused && !video.seeking;
  const outT = srcToOut(t);
  // Audio original / pista alternativa
  const useAlt = S.audio.track !== 0 && altAudioTrack === S.audio.track;
  const vol = Math.min(1, S.audio.volume);
  video.muted = S.audio.muted || useAlt || S.audio.track !== 0;
  video.volume = vol;
  if (useAlt) {
    altAudioEl.volume = vol;
    altAudioEl.muted = S.audio.muted;
    syncEl(altAudioEl, t, playing && segIndexAt(t) >= 0);
  }
  // Música
  if (S.music && musicEl.src) {
    const m = S.music;
    const local = outT - srcToOut(m.start);
    let desired = (m.offset || 0) + local;
    let active = local >= 0;
    if (m.loop && m.duration) desired = desired % m.duration;
    else if (m.duration && desired > m.duration) active = false;
    musicEl.volume = Math.min(1, m.volume) * fadeGain(m, local);
    if (active) syncEl(musicEl, desired, playing);
    else if (!musicEl.paused) musicEl.pause();
  }
  // Vídeos superpuestos
  S.overlays.forEach((ov, i) => {
    if (ov.type !== 'video') return;
    const el = ovDom[i] && ovDom[i].media;
    if (!el) return;
    const local = outT - srcToOut(ov.start);
    const len = srcToOut(ov.end) - srcToOut(ov.start);
    const inRange = local >= 0 && local < len;
    syncEl(el, (ov.offset || 0) + clamp(local, 0, len), playing && inRange);
  });
}
function fadeGain(m, local) {
  const outLen = outDuration() - srcToOut(m.start);
  let g = 1;
  if (m.fadeIn) g *= clamp(local / Math.min(1.5, outLen / 3), 0, 1);
  if (m.fadeOut) g *= clamp((outLen - local) / Math.min(2, outLen / 3), 0, 1);
  return isFinite(g) ? g : 1;
}
function pauseOverlayVideos() {
  ovDom.forEach((d) => d && d.media && d.media.tagName === 'VIDEO' && d.media.pause());
}

// ---------- Línea de tiempo ----------
const PAD = 14;
function tlWidth() { return els.tlInner.clientWidth - PAD * 2; }
const tToPx = (t) => PAD + (t / dur()) * tlWidth();
const pct = (t) => `${(t / dur()) * 100}%`;
function pxToT(clientX) {
  const r = els.tlInner.getBoundingClientRect();
  return clamp(((clientX - r.left - PAD) / tlWidth()) * dur(), 0, dur());
}

function renderTimeline() {
  if (!S.info) return;
  els.tlInner.style.width = `${S.zoom * 100}%`;
  renderRuler();
  renderSegments();
  renderMusicTrack();
  renderLayerTracks();
  updatePlayhead(video.currentTime);
}

function renderRuler() {
  const ruler = $('#ruler');
  const w = tlWidth();
  const d = dur();
  const pxPerSec = w / d;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const major = steps.find((s) => s * pxPerSec >= 80) || 3600;
  const minor = major / 5;
  let html = '';
  for (let k = 0; k * minor <= d + 1e-6; k++) {
    const t = Math.round(k * minor * 1000) / 1000;
    const isMajor = k % 5 === 0;
    const x = tToPx(t);
    html += `<div class="tk${isMajor ? ' major' : ''}" style="left:${x}px"></div>`;
    if (isMajor) html += `<div class="lb" style="left:${x}px">${fmtTime(t, major < 1)}</div>`;
  }
  ruler.innerHTML = html;
}

function gapsList() {
  const gaps = [];
  let cur = 0;
  for (const s of S.segments) {
    if (s.start > cur + 1e-3) gaps.push([cur, s.start]);
    cur = s.end;
  }
  if (cur < dur() - 1e-3) gaps.push([cur, dur()]);
  return gaps;
}

function renderSegments() {
  const segWrap = $('#segments');
  segWrap.innerHTML = S.segments.map((s, i) => `
    <div class="seg${i === S.selSeg ? ' sel' : ''}" data-i="${i}" style="left:${pct(s.start)};width:${pct(s.end - s.start)}">
      <div class="hd l" data-i="${i}" data-side="l"></div>
      <div class="hd r" data-i="${i}" data-side="r"></div>
      ${S.segments.length > 1 || s.end - s.start < dur() - 0.01 ? `<span class="tag">${fmtTime(s.end - s.start)}</span>` : ''}
    </div>`).join('');
  const gapHtml = gapsList().map(([a, b]) => `<div class="gap" style="left:${pct(a)};width:${pct(b - a)}"></div>`).join('');
  $('#gapsV').innerHTML = gapHtml;
  $('#gapsA').innerHTML = gapHtml;
  $('#outDur').innerHTML = `Resultado <b>${fmtTime(outDuration())}</b>`;
  $('#tDur').textContent = fmtTime(dur());
  renderSegList();
}

function renderSegList() {
  const list = $('#segList');
  list.innerHTML = `<div class="label" style="font-size:11.5px;color:var(--muted);font-weight:600;margin:0 0 6px 4px">Tramos que se conservan</div>` +
    S.segments.map((s, i) => `
    <div class="seg-item${i === S.selSeg ? ' sel' : ''}" data-i="${i}">
      <span class="num">${i + 1}</span>
      <span class="rng">${fmtTime(s.start)} – ${fmtTime(s.end)}</span>
      <span class="len">${fmtTime(s.end - s.start)}</span>
    </div>`).join('');
  $$('.seg-item', list).forEach((el) => el.addEventListener('click', () => {
    S.selSeg = +el.dataset.i;
    seek(S.segments[S.selSeg].start);
    renderSegments();
  }));
  $('#btnDelSeg').disabled = S.segments.length <= 1;
}

function updatePlayhead(t) {
  if (!S.info) return;
  els.playhead.style.left = `${tToPx(t)}px`;
}

// Interacción con la línea de tiempo
let dragging = null;
els.tlInner.addEventListener('pointerdown', (e) => {
  if (!S.info || e.button !== 0) return;
  const hd = e.target.closest('.hd');
  const seg = e.target.closest('.seg');
  const clip = e.target.closest('.clip');
  if (hd) return startSegHandleDrag(e, +hd.dataset.i, hd.dataset.side);
  if (clip) return startClipDrag(e, clip);
  if (seg) { S.selSeg = +seg.dataset.i; renderSegments(); }
  // Arrastrar para buscar
  video.pause();
  const move = (ev) => seek(pxToT(ev.clientX));
  move(e);
  dragging = 'scrub';
  capture(e, move);
});

function capture(e, move, up) {
  const target = e.target;
  try { target.setPointerCapture(e.pointerId); } catch (_) { /* nada */ }
  const onMove = (ev) => move(ev);
  const onUp = (ev) => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onUp);
    dragging = null;
    up && up(ev);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onUp);
  e.preventDefault();
  e.stopPropagation();
}

function snapTime(t, exclude = null) {
  const thresh = (8 / tlWidth()) * dur();
  const cands = [0, dur(), video.currentTime];
  S.segments.forEach((s) => { if (s !== exclude) cands.push(s.start, s.end); });
  for (const c of cands) if (Math.abs(c - t) < thresh) return c;
  return t;
}

function startSegHandleDrag(e, i, side) {
  commit();
  video.pause();
  S.selSeg = i;
  dragging = 'seg';
  const seg = S.segments[i];
  const prevEnd = i > 0 ? S.segments[i - 1].end : 0;
  const nextStart = i < S.segments.length - 1 ? S.segments[i + 1].start : dur();
  capture(e, (ev) => {
    let t = snapTime(pxToT(ev.clientX), seg);
    if (side === 'l') { seg.start = clamp(t, prevEnd, seg.end - MIN_SEG); seek(seg.start); }
    else { seg.end = clamp(t, seg.start + MIN_SEG, nextStart); seek(seg.end - 0.001); }
    renderSegments();
  }, () => renderAll());
}

function startClipDrag(e, clip) {
  const kind = clip.dataset.kind;
  const edge = e.target.closest('.cr');
  commit();
  const startT = pxToT(e.clientX);
  if (kind === 'music') {
    const m = S.music;
    const orig = m.start;
    capture(e, (ev) => {
      m.start = clamp(snapTime(orig + pxToT(ev.clientX) - startT), 0, dur() - 0.1);
      renderMusicTrack();
      renderMusicPanel();
    });
    return;
  }
  const i = +clip.dataset.i;
  const ov = S.overlays[i];
  selectOverlay(i);
  const o0 = { start: ov.start, end: ov.end };
  capture(e, (ev) => {
    const dt = pxToT(ev.clientX) - startT;
    if (edge && edge.classList.contains('l')) ov.start = clamp(snapTime(o0.start + dt), 0, ov.end - MIN_SEG);
    else if (edge) {
      ov.end = clamp(snapTime(o0.end + dt), ov.start + MIN_SEG, dur());
    } else {
      const len = o0.end - o0.start;
      ov.start = clamp(snapTime(o0.start + dt), 0, dur() - len);
      ov.end = ov.start + len;
    }
    renderLayerTracks();
    renderLayerList();
  });
}

function renderMusicTrack() {
  const tr = $('#musicTrack');
  const has = !!S.music;
  tr.classList.toggle('hidden', !has);
  $('#lblMusic').classList.toggle('hidden', !has);
  if (!has) { tr.innerHTML = ''; return; }
  const m = S.music;
  // Hasta dónde llega la música, en tiempo original
  const mOut = srcToOut(m.start);
  const playable = m.loop ? Infinity : Math.max(0, m.duration - (m.offset || 0));
  const outEnd = Math.min(outDuration(), mOut + playable);
  let srcEnd = dur();
  // Busca el instante del original que corresponde a outEnd
  let acc = 0;
  for (const s of S.segments) {
    const len = s.end - s.start;
    if (acc + len >= outEnd) { srcEnd = s.start + (outEnd - acc); break; }
    acc += len;
  }
  const start = Math.min(m.start, srcEnd);
  tr.innerHTML = `<div class="clip music-clip" data-kind="music" style="left:${pct(start)};width:${pct(Math.max(0, srcEnd - start))}">${icon('music')}<span>${escapeHtml(m.name)}</span></div>`;
}

function renderLayerTracks() {
  const wrap = $('#layerTracks');
  $('#lblLayers').classList.toggle('hidden', !S.overlays.length);
  wrap.innerHTML = S.overlays.map((ov, i) => `
    <div class="lane"><div class="clip layer-clip${i === S.selOv ? ' sel' : ''}" data-kind="layer" data-i="${i}" style="left:${pct(ov.start)};width:${pct(ov.end - ov.start)}">
      <div class="cr l"></div>${icon(ov.type === 'image' ? 'image' : 'film')}<span>${escapeHtml(ov.name)}</span><div class="cr r"></div>
    </div></div>`).join('');
  const lbl = $('#lblLayers');
  lbl.style.height = `${Math.max(1, S.overlays.length) * 26}px`;
}

// Zoom
function setZoom(z, anchorClientX = null) {
  const old = S.zoom;
  S.zoom = clamp(z, 1, 20);
  const sc = els.tlScroll;
  const r = sc.getBoundingClientRect();
  const ax = anchorClientX === null ? r.width / 2 : anchorClientX - r.left;
  const frac = (sc.scrollLeft + ax) / (sc.scrollWidth || 1);
  $('#zoom').value = S.zoom; setRangeFill($('#zoom'));
  renderTimeline();
  sc.scrollLeft = frac * sc.scrollWidth - ax;
  if (old === S.zoom) return;
}
$('#zoom').addEventListener('input', (e) => setZoom(+e.target.value));
$('#btnZoomIn').addEventListener('click', () => setZoom(S.zoom * 1.5));
$('#btnZoomOut').addEventListener('click', () => setZoom(S.zoom / 1.5));
els.tlScroll.addEventListener('wheel', (e) => {
  if (!S.info) return;
  if (e.ctrlKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX); }
  else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && S.zoom > 1) { e.preventDefault(); els.tlScroll.scrollLeft += e.deltaY; }
}, { passive: false });

// ---------- Operaciones de corte ----------
function split() {
  const t = video.currentTime;
  const i = segIndexAt(t);
  if (i < 0) return toast('Coloca el cabezal dentro de un tramo para dividir');
  const s = S.segments[i];
  if (t - s.start < MIN_SEG || s.end - t < MIN_SEG) return toast('Demasiado cerca del borde del tramo');
  commit();
  S.segments.splice(i, 1, { start: s.start, end: t }, { start: t, end: s.end });
  S.selSeg = i + 1;
  renderAll();
  toast('Tramo dividido · arrastra los bordes o quita el que sobre');
}
function deleteSeg() {
  if (S.segments.length <= 1) return toast('Tiene que quedar al menos un tramo');
  commit();
  S.segments.splice(S.selSeg, 1);
  S.selSeg = clamp(S.selSeg, 0, S.segments.length - 1);
  renderAll();
}
function setIn() {
  const t = video.currentTime;
  let i = segIndexAt(t);
  if (i < 0) i = S.selSeg;
  const s = S.segments[i];
  const prevEnd = i > 0 ? S.segments[i - 1].end : 0;
  if (t >= s.end - MIN_SEG) return toast('El inicio debe estar antes del final del tramo');
  commit();
  s.start = clamp(t, prevEnd, s.end - MIN_SEG);
  S.selSeg = i;
  renderAll();
}
function setOut() {
  const t = video.currentTime;
  let i = segIndexAt(t);
  if (i < 0) i = S.selSeg;
  const s = S.segments[i];
  const nextStart = i < S.segments.length - 1 ? S.segments[i + 1].start : dur();
  if (t <= s.start + MIN_SEG) return toast('El final debe estar después del inicio del tramo');
  commit();
  s.end = clamp(t, s.start + MIN_SEG, nextStart);
  S.selSeg = i;
  renderAll();
}
$('#btnSplit').addEventListener('click', split);
$('#btnDelSeg').addEventListener('click', deleteSeg);
$('#btnSetIn').addEventListener('click', setIn);
$('#btnSetOut').addEventListener('click', setOut);
$('#btnResetTrim').addEventListener('click', () => { commit(); S.segments = [{ start: 0, end: dur() }]; S.selSeg = 0; renderAll(); });

// ---------- Encuadre ----------
const fullCrop = () => ({ x: 0, y: 0, w: 1, h: 1 });
const isFull = (c) => !c || (c.x < 1e-4 && c.y < 1e-4 && c.w > 0.9999 && c.h > 0.9999);
function aspectRatio() {
  // Proporción normalizada (ancho/alto en coordenadas 0..1)
  if (S.aspect === 'free') return null;
  if (S.aspect === 'orig') return 1;
  const [a, b] = S.aspect.split(':').map(Number);
  return (a / b) * (H() / W());
}
function fitAspect() {
  const r = aspectRatio();
  if (!r) return;
  const c = S.crop && !isFull(S.crop) ? S.crop : fullCrop();
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  let w = 1;
  let h = w / r;
  if (h > 1) { h = 1; w = h * r; }
  S.crop = { w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
}
$$('#aspectChips button').forEach((b) => b.addEventListener('click', () => {
  commit();
  S.aspect = b.dataset.ar;
  if (S.aspect !== 'free') fitAspect();
  else if (!S.crop) S.crop = fullCrop();
  renderCrop();
}));
$('#btnCropCenter').addEventListener('click', () => {
  if (!S.crop) return;
  commit();
  S.crop.x = (1 - S.crop.w) / 2;
  S.crop.y = (1 - S.crop.h) / 2;
  renderCrop();
});
$('#btnCropReset').addEventListener('click', () => { commit(); S.crop = null; S.aspect = 'free'; renderCrop(); });

function renderCrop() {
  if (!S.info) return;
  const active = S.tab === 'crop';
  const c = S.crop || fullCrop();
  const layer = els.cropLayer;
  layer.classList.toggle('active', active);
  layer.classList.toggle('none', isFull(S.crop));
  Object.assign(els.cropBox.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
  const ow = isFull(S.crop) ? W() : even(c.w * W());
  const oh = isFull(S.crop) ? H() : even(c.h * H());
  $('#cropSize').textContent = `${ow} × ${oh}`;
  $('#cropSrcRes').textContent = `${W()} × ${H()}`;
  $('#cropOutRes').textContent = `${ow} × ${oh}`;
  $$('#aspectChips button').forEach((b) => b.classList.toggle('active', b.dataset.ar === S.aspect));
  updateQualityNote();
}

els.cropLayer.addEventListener('pointerdown', (e) => {
  if (S.tab !== 'crop' || e.button !== 0) return;
  const handle = e.target.closest('[data-h]');
  const inBox = e.target.closest('#cropBox');
  const mode = handle ? handle.dataset.h : inBox ? 'move' : null;
  if (!mode) return;
  commit();
  if (!S.crop) S.crop = fullCrop();
  const fr = els.frame.getBoundingClientRect();
  const start = { ...S.crop };
  const x0 = e.clientX;
  const y0 = e.clientY;
  els.cropLayer.classList.add('dragging');
  capture(e, (ev) => {
    const dx = (ev.clientX - x0) / fr.width;
    const dy = (ev.clientY - y0) / fr.height;
    S.crop = cropDrag(mode, start, dx, dy, aspectRatio());
    renderCrop();
  }, () => {
    els.cropLayer.classList.remove('dragging');
    if (isFull(S.crop) && S.aspect === 'free') S.crop = null;
    renderCrop();
  });
});

function cropDrag(mode, s, dx, dy, ratio) {
  const minW = 32 / W();
  const minH = 32 / H();
  if (mode === 'move') return { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
  let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
  if (mode.includes('w')) l = clamp(l + dx, 0, r - minW);
  if (mode.includes('e')) r = clamp(r + dx, l + minW, 1);
  if (mode.includes('n')) t = clamp(t + dy, 0, b - minH);
  if (mode.includes('s')) b = clamp(b + dy, t + minH, 1);
  if (!ratio) return { x: l, y: t, w: r - l, h: b - t };
  // Proporción fija: ancla en el lado/esquina contrario
  const sx = mode.includes('e') ? 1 : mode.includes('w') ? -1 : 0;
  const sy = mode.includes('s') ? 1 : mode.includes('n') ? -1 : 0;
  const ax = sx > 0 ? s.x : sx < 0 ? s.x + s.w : s.x + s.w / 2;
  const ay = sy > 0 ? s.y : sy < 0 ? s.y + s.h : s.y + s.h / 2;
  let nw = r - l;
  let nh = b - t;
  if (sx && sy) { if (nw / nh > ratio) nh = nw / ratio; else nw = nh * ratio; }
  else if (sx) nh = nw / ratio;
  else nw = nh * ratio;
  const maxW = sx > 0 ? 1 - ax : sx < 0 ? ax : 2 * Math.min(ax, 1 - ax);
  const maxH = sy > 0 ? 1 - ay : sy < 0 ? ay : 2 * Math.min(ay, 1 - ay);
  nw = Math.min(nw, maxW, maxH * ratio);
  nw = Math.max(nw, minW);
  nh = nw / ratio;
  const x = sx > 0 ? ax : sx < 0 ? ax - nw : ax - nw / 2;
  const y = sy > 0 ? ay : sy < 0 ? ay - nh : ay - nh / 2;
  return { x: clamp(x, 0, 1 - nw), y: clamp(y, 0, 1 - nh), w: nw, h: nh };
}

// ---------- Audio ----------
function setupAudioPanel() {
  const info = S.info;
  const has = info.audio.length > 0;
  $('#noAudioHint').hidden = has;
  $('#btnMute').disabled = !has;
  $('#volOrig').disabled = !has;
  $('#trackField').classList.toggle('hidden', info.audio.length < 2);
  $('#trackSelect').innerHTML = info.audio.map((a, i) => {
    const lang = a.language && a.language !== 'und' ? ` · ${a.language.toUpperCase()}` : '';
    const ch = a.channels === 1 ? 'mono' : a.channels === 2 ? 'estéreo' : `${a.channels} canales`;
    return `<option value="${i}">Pista ${i + 1} · ${(a.codec || '').toUpperCase()} · ${ch}${lang}${a.title ? ' · ' + escapeHtml(a.title) : ''}</option>`;
  }).join('');
  $('#audioTrack').classList.toggle('none', !has);
  renderAudioPanel();
}
function renderAudioPanel() {
  if (!S.info) return;
  const a = S.audio;
  $('#btnMute').classList.toggle('on', a.muted);
  $('#btnMute').innerHTML = icon(a.muted ? 'volumeX' : 'volume');
  $('#volOrig').value = Math.round(a.volume * 100); setRangeFill($('#volOrig'));
  $('#volOrigVal').textContent = a.muted ? 'Mudo' : `${Math.round(a.volume * 100)}%`;
  $('#trackSelect').value = a.track;
  $('#audioTrack').classList.toggle('muted', a.muted);
  renderMusicPanel();
  updateQualityNote();
}
$('#btnMute').addEventListener('click', () => { commit(); S.audio.muted = !S.audio.muted; renderAudioPanel(); });
$('#volOrig').addEventListener('pointerdown', () => commit());
$('#volOrig').addEventListener('input', (e) => { S.audio.volume = e.target.value / 100; if (S.audio.volume > 0) S.audio.muted = false; renderAudioPanel(); });
$('#trackSelect').addEventListener('change', async (e) => {
  commit();
  S.audio.track = +e.target.value;
  renderAudioPanel();
  loadWave();
  if (S.audio.track !== 0) {
    try {
      showLoading('Preparando la pista de audio…');
      altAudioEl.src = await window.api.extractAudio(S.info.path, S.audio.track);
      altAudioTrack = S.audio.track;
    } catch (err) { toast('No se pudo previsualizar esa pista', true); }
    hideLoading();
  }
});

async function addMusic(path) {
  if (!path || !S.info) return;
  try {
    showLoading('Cargando audio…');
    const info = await window.api.probe(path);
    if (!info.audio.length) throw new Error('Ese archivo no tiene audio.');
    commit();
    S.music = {
      path, name: info.name, url: info.url, duration: info.duration, volume: 1,
      start: segIndexAt(video.currentTime) >= 0 ? video.currentTime : S.segments[0].start,
      offset: 0, loop: false, fadeIn: false, fadeOut: true,
    };
    if (S.music.start >= dur() - 0.2) S.music.start = S.segments[0].start;
    musicEl.src = info.url;
    hideLoading();
    renderAll();
    setTab('audio');
    toast('Audio añadido · arrástralo en la línea de tiempo para moverlo');
  } catch (e) {
    hideLoading();
    toast(e.message, true);
  }
}
function renderMusicPanel() {
  const m = S.music;
  $('#musicCard').classList.toggle('hidden', !m);
  $('#btnAddMusic').classList.toggle('hidden', !!m);
  if (!m) return;
  $('#musicName').textContent = m.name;
  $('#musicMeta').textContent = `Duración ${fmtTime(m.duration, false)}`;
  $('#volMusic').value = Math.round(m.volume * 100); setRangeFill($('#volMusic'));
  $('#volMusicVal').textContent = `${Math.round(m.volume * 100)}%`;
  if (document.activeElement !== $('#musicStart')) $('#musicStart').value = fmtTime(m.start);
  if (document.activeElement !== $('#musicOffset')) $('#musicOffset').value = fmtTime(m.offset);
  $('#musicLoop').checked = m.loop;
  $('#musicFadeIn').checked = m.fadeIn;
  $('#musicFadeOut').checked = m.fadeOut;
  $('#btnReplaceAudio').classList.toggle('hidden', S.audio.muted || !S.info.audio.length);
}
$('#btnAddMusic').addEventListener('click', async () => addMusic(await window.api.openMediaDialog('audio')));
$('#btnDelMusic').addEventListener('click', () => { commit(); S.music = null; musicEl.pause(); musicEl.removeAttribute('src'); renderAll(); });
$('#volMusic').addEventListener('pointerdown', () => commit());
$('#volMusic').addEventListener('input', (e) => { S.music.volume = e.target.value / 100; renderMusicPanel(); });
$('#btnMusicHere').addEventListener('click', () => { commit(); S.music.start = video.currentTime; renderAll(); });
$('#musicStart').addEventListener('change', (e) => {
  const t = parseTime(e.target.value);
  if (isFinite(t)) { commit(); S.music.start = clamp(t, 0, dur()); }
  renderAll();
});
$('#musicOffset').addEventListener('change', (e) => {
  const t = parseTime(e.target.value);
  if (isFinite(t)) { commit(); S.music.offset = clamp(t, 0, Math.max(0, S.music.duration - 0.1)); }
  renderAll();
});
['Loop', 'FadeIn', 'FadeOut'].forEach((k) => $(`#music${k}`).addEventListener('change', (e) => {
  commit();
  S.music[k[0].toLowerCase() + k.slice(1)] = e.target.checked;
  renderAll();
}));
$('#btnReplaceAudio').addEventListener('click', () => { commit(); S.audio.muted = true; renderAudioPanel(); toast('Audio original silenciado'); });

// ---------- Capas ----------
let ovDom = [];
let ovIdCounter = 1;
async function addLayer(path) {
  if (!path || !S.info) return;
  try {
    showLoading('Cargando capa…');
    const kind = await window.api.mediaKind(path);
    const info = await window.api.probe(path);
    if (!info.video) throw new Error('Ese archivo no es una imagen ni un vídeo.');
    const ar = info.video.height / info.video.width; // alto/ancho en píxeles
    const type = kind === 'image' ? 'image' : 'video';
    // Tamaño inicial: 40% del ancho del vídeo, limitado al alto
    let w = 0.4;
    let h = (w * W() * ar) / H();
    if (h > 0.8) { h = 0.8; w = (h * H()) / ar / W(); }
    const t0 = segIndexAt(video.currentTime) >= 0 ? video.currentTime : S.segments[0].start;
    let end = Math.min(dur(), t0 + (type === 'image' ? 5 : info.duration));
    if (end - t0 < MIN_SEG) end = Math.min(dur(), t0 + 1);
    commit();
    S.overlays.push({
      id: ovIdCounter++, path, name: info.name, url: info.url, type, ar,
      x: (1 - w) / 2, y: (1 - h) / 2, w, h, start: t0, end, opacity: 1, offset: 0, duration: info.duration,
    });
    S.selOv = S.overlays.length - 1;
    hideLoading();
    buildOverlayDom();
    renderAll();
    setTab('layers');
    toast('Capa añadida · arrástrala sobre el vídeo para colocarla');
  } catch (e) {
    hideLoading();
    toast(e.message, true);
  }
}
$('#btnAddLayer').addEventListener('click', async () => addLayer(await window.api.openMediaDialog('layer')));

function buildOverlayDom() {
  els.ovLayer.innerHTML = '';
  ovDom = S.overlays.map((ov, i) => {
    const el = document.createElement('div');
    el.className = 'ov';
    el.dataset.i = i;
    const media = document.createElement(ov.type === 'image' ? 'img' : 'video');
    media.src = ov.url;
    if (ov.type === 'video') { media.muted = true; media.preload = 'auto'; }
    media.draggable = false;
    el.appendChild(media);
    const rs = document.createElement('div');
    rs.className = 'rs';
    el.appendChild(rs);
    els.ovLayer.appendChild(el);
    return { el, media };
  });
}
function renderOverlays() {
  els.ovLayer.classList.toggle('active', S.tab === 'layers');
  S.overlays.forEach((ov, i) => {
    const d = ovDom[i];
    if (!d) return;
    Object.assign(d.el.style, { left: `${ov.x * 100}%`, top: `${ov.y * 100}%`, width: `${ov.w * 100}%`, height: `${ov.h * 100}%`, opacity: ov.opacity });
    d.el.classList.toggle('sel', i === S.selOv && S.tab === 'layers');
  });
  renderOverlayVisibility(video.currentTime);
}
function renderOverlayVisibility(t) {
  const outT = srcToOut(t);
  const inGap = segIndexAt(t) < 0;
  S.overlays.forEach((ov, i) => {
    const d = ovDom[i];
    if (!d) return;
    const a = srcToOut(ov.start);
    const b = srcToOut(ov.end);
    const visible = !inGap && outT >= a && outT < b;
    const ghost = !visible && S.tab === 'layers' && i === S.selOv;
    d.el.style.display = visible || ghost ? '' : 'none';
    d.el.classList.toggle('ghost', ghost);
  });
}
function selectOverlay(i) {
  S.selOv = i;
  renderOverlays();
  renderLayerTracks();
  renderLayerList();
}
els.ovLayer.addEventListener('pointerdown', (e) => {
  if (S.tab !== 'layers' || e.button !== 0) return;
  const el = e.target.closest('.ov');
  if (!el) return;
  const i = +el.dataset.i;
  selectOverlay(i);
  const ov = S.overlays[i];
  const resize = e.target.classList.contains('rs');
  commit();
  const fr = els.frame.getBoundingClientRect();
  const s = { ...ov };
  const x0 = e.clientX;
  const y0 = e.clientY;
  capture(e, (ev) => {
    const dx = (ev.clientX - x0) / fr.width;
    const dy = (ev.clientY - y0) / fr.height;
    if (resize) {
      // Mantiene la proporción de la imagen
      const k = W() / H();
      let w = Math.max(0.03, s.w + Math.max(dx, (dy * 1) / (s.ar * k)));
      ov.w = w;
      ov.h = w * s.ar * k;
    } else {
      // Imán a bordes y centro
      let x = s.x + dx;
      let y = s.y + dy;
      const sn = 0.012;
      for (const tx of [0, 1 - s.w, (1 - s.w) / 2]) if (Math.abs(x - tx) < sn) x = tx;
      for (const ty of [0, 1 - s.h, (1 - s.h) / 2]) if (Math.abs(y - ty) < sn) y = ty;
      ov.x = x;
      ov.y = y;
    }
    renderOverlays();
  }, () => renderLayerList());
});

function renderLayerList() {
  const list = $('#layerList');
  list.innerHTML = S.overlays.map((ov, i) => `
    <div class="card${i === S.selOv ? ' sel' : ''}" data-i="${i}">
      <div class="media-head" style="margin-bottom:6px">
        <div class="media-ico">${ov.type === 'image' ? `<img src="${ov.url}" />` : icon('film')}</div>
        <div class="media-txt"><b>${escapeHtml(ov.name)}</b>
          <div class="times"><span>${ov.type === 'image' ? 'Imagen' : 'Vídeo'}</span><span>${fmtTime(ov.start)} → ${fmtTime(ov.end)}</span></div></div>
        <button class="icon-btn" data-act="del" title="Quitar capa">${icon('trash')}</button>
      </div>
      <div class="vol-row"><span style="font-size:11.5px;color:var(--muted);width:62px">Opacidad</span>
        <input type="range" min="5" max="100" value="${Math.round(ov.opacity * 100)}" data-act="op" style="--p:${Math.round(((ov.opacity * 100 - 5) / 95) * 100)}%" />
        <span class="val">${Math.round(ov.opacity * 100)}%</span></div>
      <div class="tools">
        <button class="mini" data-act="in">Inicio en cabezal</button>
        <button class="mini" data-act="out">Fin en cabezal</button>
        <button class="mini" data-act="center">Centrar</button>
        <button class="mini" data-act="fill">Pantalla completa</button>
        <button class="mini" data-act="all">Todo el vídeo</button>
      </div>
    </div>`).join('') || '<p class="hint">Todavía no hay capas. Puedes añadir un logo, una foto o un vídeo pequeño encima (como una ventana).</p>';
  $$('.card', list).forEach((card) => {
    const i = +card.dataset.i;
    card.addEventListener('pointerdown', (e) => { if (!e.target.closest('[data-act]') && S.selOv !== i) selectOverlay(i); });
    card.querySelectorAll('[data-act]').forEach((b) => {
      const act = b.dataset.act;
      if (act === 'op') {
        b.addEventListener('pointerdown', () => commit());
        b.addEventListener('input', () => {
          S.overlays[i].opacity = b.value / 100;
          setRangeFill(b);
          b.nextElementSibling.textContent = `${b.value}%`;
          renderOverlays();
        });
        return;
      }
      b.addEventListener('click', () => layerAction(i, act));
    });
  });
}
function layerAction(i, act) {
  const ov = S.overlays[i];
  const t = video.currentTime;
  commit();
  if (act === 'del') {
    S.overlays.splice(i, 1);
    S.selOv = Math.min(S.selOv, S.overlays.length - 1);
    buildOverlayDom();
  } else if (act === 'in') {
    if (t >= ov.end - MIN_SEG) { const len = ov.end - ov.start; ov.start = t; ov.end = Math.min(dur(), t + len); } else ov.start = t;
  } else if (act === 'out') {
    if (t <= ov.start + MIN_SEG) return toast('El fin debe ir después del inicio de la capa');
    ov.end = t;
  } else if (act === 'center') {
    ov.x = (1 - ov.w) / 2; ov.y = (1 - ov.h) / 2;
  } else if (act === 'fill') {
    // Encaja en el área visible (respetando el recorte)
    const c = S.crop || fullCrop();
    const k = W() / H();
    let w = c.w;
    let h = w * ov.ar * k;
    if (h > c.h) { h = c.h; w = h / (ov.ar * k); }
    Object.assign(ov, { w, h, x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2 });
  } else if (act === 'all') {
    ov.start = S.segments[0].start; ov.end = S.segments[S.segments.length - 1].end;
  }
  renderAll();
}

// ---------- Exportar ----------
$$('#fmtCtl button').forEach((b) => b.addEventListener('click', () => {
  S.fmt = b.dataset.fmt;
  $$('#fmtCtl button').forEach((x) => x.classList.toggle('active', x === b));
  updateQualityNote();
}));
$('#qualitySelect').addEventListener('change', updateQualityNote);
$('#btnAdv').addEventListener('click', () => {
  const f = $('#codecField');
  f.classList.toggle('hidden');
  $('#btnAdv').classList.toggle('on', !f.classList.contains('hidden'));
});
$('#codecSelect').addEventListener('change', updateQualityNote);

function buildJob(outPath = '') {
  const c = isFull(S.crop) ? null : S.crop;
  return {
    input: S.info.path,
    outPath,
    info: S.info,
    segments: S.segments.map((s) => ({ start: s.start, end: s.end })),
    crop: c,
    audio: { ...S.audio },
    music: S.music ? { ...S.music } : null,
    overlays: S.overlays.map((o) => ({ ...o })),
    settings: { quality: $('#qualitySelect').value, codec: $('#codecSelect').value },
  };
}

let noteSeq = 0;
async function updateQualityNote() {
  if (!S.info) return;
  const seq = ++noteSeq;
  const job = buildJob();
  const q = job.settings.quality;
  const an = await window.api.analyzeExport(job, S.fmt);
  if (seq !== noteSeq) return;
  const note = $('#qNote');
  let html;
  let warn = false;
  const codecSel = $('#codecSelect');
  codecSel.disabled = (q === 'auto' && an.possible) || q === 'original';
  if (q === 'auto' || q === 'original') {
    if (an.possible) {
      html = `<b style="color:var(--text)">Calidad idéntica al original.</b> Se copia el vídeo sin recodificar (muy rápido). Los cortes se ajustan al fotograma clave más cercano.`;
    } else if (q === 'original') {
      warn = true;
      html = `No se puede copiar sin recodificar por: ${an.reasons.join(', ')}. Se usará calidad máxima.`;
    } else {
      html = `Por ${an.reasons.join(', ')} hay que recodificar: se usará calidad <b style="color:var(--text)">máxima</b> (visualmente idéntica) con cortes exactos.`;
    }
  } else {
    const t = { max: 'Visualmente idéntica al original, cortes exactos.', high: 'Muy buena calidad con menos peso.', light: 'Archivo pequeño, ideal para mensajería.' }[q];
    html = t;
  }
  if (S.info.video.codec === 'hevc' && codecSel.value === 'h264' && /10/.test(S.info.video.pixFmt || '')) {
    warn = true;
    html += ' El original es HDR/10 bits: con H.265 se conserva mejor.';
  }
  note.className = 'q-note' + (warn ? ' warn' : '');
  note.innerHTML = icon(warn ? 'alert' : 'sparkles') + `<span>${html}</span>`;
}

let exporting = false;
let exportStart = 0;
async function startExport() {
  if (!S.info || exporting) return;
  video.pause();
  let outPath;
  try {
    outPath = await window.api.saveDialog(S.info.path, S.fmt);
  } catch (e) {
    return toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
  if (!outPath) return;
  exporting = true;
  exportStart = Date.now();
  const modal = $('#exportModal');
  modal.classList.remove('hidden');
  $('#ring').className = 'ring';
  $('#exTitle').textContent = 'Exportando…';
  $('#exSub').textContent = 'Preparando…';
  $('#exActions').innerHTML = '<button class="btn ghost" id="btnCancelExport">Cancelar</button>';
  $('#btnCancelExport').addEventListener('click', () => window.api.cancelExport());
  setExportProgress(0);
  const res = await window.api.exportVideo(buildJob(outPath));
  exporting = false;
  const ring = $('#ring');
  if (res.ok) {
    ring.classList.add('done');
    $('#ringProg').style.strokeDashoffset = 0;
    $('#ringTxt').innerHTML = icon('check');
    $('#exTitle').textContent = '¡Vídeo listo!';
    $('#exSub').textContent = `${fmtSize(res.size)} · ${res.mode === 'copy' ? 'calidad original (sin recodificar)' : 'calidad máxima'} · ${Math.max(1, Math.round(res.seconds))} s`;
    $('#exActions').innerHTML = `
      <button class="btn ghost" id="exClose">Cerrar</button>
      <button class="btn ghost" id="exFolder">${icon('folder')}Mostrar en carpeta</button>
      <button class="btn primary" id="exOpen">${icon('play')}Ver vídeo</button>`;
    $('#exFolder').addEventListener('click', () => window.api.showInFolder(outPath));
    $('#exOpen').addEventListener('click', () => window.api.openPath(outPath));
  } else if (res.cancelled) {
    modal.classList.add('hidden');
    toast('Exportación cancelada');
    return;
  } else {
    ring.classList.add('fail');
    $('#ringTxt').innerHTML = icon('alert');
    $('#exTitle').textContent = 'No se pudo exportar';
    $('#exSub').innerHTML = `<div class="err-box">${escapeHtml(res.error || '')}</div>`;
    $('#exActions').innerHTML = '<button class="btn ghost" id="exClose">Cerrar</button>';
  }
  $('#exClose').addEventListener('click', () => modal.classList.add('hidden'));
}
function setExportProgress(p) {
  const C = 326.7;
  $('#ringProg').style.strokeDashoffset = C * (1 - p);
  $('#ringTxt').textContent = `${Math.floor(p * 100)}%`;
  if (p > 0.02 && p < 1) {
    const el = (Date.now() - exportStart) / 1000;
    const left = (el / p) * (1 - p);
    $('#exSub').textContent = `Quedan unos ${left > 90 ? Math.round(left / 60) + ' min' : Math.max(1, Math.round(left)) + ' s'}`;
  }
}
$('#btnExport').addEventListener('click', startExport);

// ---------- Render general ----------
function renderAll() {
  if (!S.info) return;
  renderTimeline();
  renderCrop();
  renderOverlays();
  renderAudioPanel();
  renderLayerList();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Botones y atajos ----------
$('#btnOpen').addEventListener('click', async () => openVideo(await window.api.openVideoDialog()));
$('#btnOpenBig').addEventListener('click', async (e) => { e.stopPropagation(); openVideo(await window.api.openVideoDialog()); });
$('#dropZone').addEventListener('click', async () => openVideo(await window.api.openVideoDialog()));
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnPrev').addEventListener('click', () => step(-1));
$('#btnNext').addEventListener('click', () => step(1));
$('#btnStart').addEventListener('click', () => { video.pause(); seek(S.segments[0] ? S.segments[0].start : 0); });
$('#btnEnd').addEventListener('click', () => { video.pause(); seek(S.segments.length ? S.segments[S.segments.length - 1].end - 0.001 : dur()); });
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
video.addEventListener('click', togglePlay);

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type === 'text') return;
  if (tag === 'select') return;
  if (!$('#exportModal').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'o') { e.preventDefault(); $('#btnOpen').click(); return; }
  if (!S.info) return;
  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && k === 'e') { e.preventDefault(); startExport(); return; }
  if (e.ctrlKey) return;
  switch (k) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'arrowleft': e.preventDefault(); e.shiftKey ? (video.pause(), seek(video.currentTime - 1)) : step(-1); break;
    case 'arrowright': e.preventDefault(); e.shiftKey ? (video.pause(), seek(video.currentTime + 1)) : step(1); break;
    case 's': split(); break;
    case 'delete': case 'backspace':
      if (S.tab === 'layers' && S.selOv >= 0) layerAction(S.selOv, 'del'); else deleteSeg();
      break;
    case 'i': setIn(); break;
    case 'o': setOut(); break;
    case 'm': if (S.info.audio.length) $('#btnMute').click(); break;
    case 'home': $('#btnStart').click(); break;
    case 'end': $('#btnEnd').click(); break;
    case '1': setTab('trim'); break;
    case '2': setTab('crop'); break;
    case '3': setTab('audio'); break;
    case '4': setTab('layers'); break;
    default:
  }
});

window.api.onOpenFile((p) => openVideo(p));

// ---------- Arrastrar y soltar ----------
let dragDepth = 0;
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUD_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('#dragHintText').textContent = S.info ? 'Vídeo: abrir · Foto: capa · Audio: música' : 'Suelta para abrir el vídeo';
  $('#dragHint').classList.remove('hidden');
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dragHint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dragHint').classList.add('hidden');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = window.api.pathForFile(f);
  if (!S.info) return openVideo(p);
  if (IMG_RE.test(p)) addLayer(p);
  else if (AUD_RE.test(p)) addMusic(p);
  else if (e.shiftKey) addLayer(p);
  else openVideo(p);
});
