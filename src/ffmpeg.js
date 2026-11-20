// Motor de vídeo: envuelve FFmpeg / FFprobe para analizar, previsualizar y exportar.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const FFMPEG = unpacked(require('ffmpeg-static'));
const FFPROBE = unpacked(require('ffprobe-static').path);

let tempRoot = null;
function setTempRoot(dir) {
  tempRoot = dir;
  fs.mkdirSync(dir, { recursive: true });
}
function tmp(name) {
  return path.join(tempRoot, name);
}
let counter = 0;
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

function run(bin, args, { onStdout, onStderr } = {}) {
  const proc = spawn(bin, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    const s = d.toString();
    stdout += s;
    if (stdout.length > 5e6) stdout = stdout.slice(-1e6);
    onStdout && onStdout(s);
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    stderr += s;
    if (stderr.length > 2e5) stderr = stderr.slice(-1e5);
    onStderr && onStderr(s);
  });
  const promise = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(lastLines(stderr) || `FFmpeg terminó con código ${code}`);
        err.code = code;
        err.killed = proc.killed;
        reject(err);
      }
    });
  });
  return { proc, promise };
}

function lastLines(s, n = 6) {
  return s.trim().split(/\r?\n/).slice(-n).join('\n');
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

// ---------- Análisis ----------
async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]).promise;
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const fmt = j.format || {};
  let duration = parseFloat(fmt.duration);
  if (!isFinite(duration)) duration = v ? parseFloat(v.duration) : NaN;
  if (!isFinite(duration)) duration = 0;

  let video = null;
  if (v) {
    let rotation = 0;
    if (v.tags && v.tags.rotate) rotation = Number(v.tags.rotate) || 0;
    const sd = (v.side_data_list || []).find((d) => d.rotation != null);
    if (sd) rotation = Number(sd.rotation) || 0;
    const rot90 = Math.abs(rotation) % 180 === 90;
    const fpsAvg = parseRate(v.avg_frame_rate);
    const fpsR = parseRate(v.r_frame_rate);
    const fps = fpsAvg > 0 && fpsAvg < 1000 ? fpsAvg : fpsR > 0 && fpsR < 1000 ? fpsR : 30;
    video = {
      codec: v.codec_name,
      profile: v.profile,
      width: rot90 ? v.height : v.width,
      height: rot90 ? v.width : v.height,
      rotation,
      fps,
      fpsStr: v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate,
      pixFmt: v.pix_fmt,
      bitrate: Number(v.bit_rate) || 0,
      colorPrimaries: v.color_primaries,
      colorTrc: v.color_transfer,
      colorSpace: v.color_space,
      colorRange: v.color_range,
    };
  }
  return {
    path: file,
    name: path.basename(file),
    url: pathToFileURL(file).href,
    size: Number(fmt.size) || (fs.existsSync(file) ? fs.statSync(file).size : 0),
    bitrate: Number(fmt.bit_rate) || 0,
    container: fmt.format_name,
    duration,
    video,
    audio: audios.map((a, i) => ({
      index: i,
      codec: a.codec_name,
      channels: a.channels,
      layout: a.channel_layout,
      sampleRate: Number(a.sample_rate) || 0,
      bitrate: Number(a.bit_rate) || 0,
      language: (a.tags && a.tags.language) || '',
      title: (a.tags && (a.tags.title || a.tags.handler_name)) || '',
    })),
  };
}

// ---------- Miniaturas y forma de onda ----------
async function thumbnails(file, duration, count = 20) {
  const id = uid();
  const times = Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
  const results = new Array(count).fill(null);
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = next++;
      const out = tmp(`thumb_${id}_${i}.jpg`);
      try {
        await run(FFMPEG, [
          '-hide_banner', '-loglevel', 'error', '-ss', times[i].toFixed(3), '-i', file,
          '-frames:v', '1', '-vf', 'scale=-2:120', '-q:v', '5', '-y', out,
        ]).promise;
        if (fs.existsSync(out)) results[i] = pathToFileURL(out).href;
      } catch (_) { /* miniatura opcional */ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  // Rellena huecos (p. ej. al final de vídeos cortos) con la miniatura anterior.
  for (let i = 0; i < count; i++) if (!results[i]) results[i] = results[i - 1] || results.find(Boolean) || null;
  return results;
}

async function waveform(file, trackIndex = 0) {
  const out = tmp(`wave_${uid()}.png`);
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-filter_complex', `[0:a:${trackIndex}]aformat=channel_layouts=mono,showwavespic=s=2400x160:colors=white:scale=sqrt[w]`,
    '-map', '[w]', '-frames:v', '1', '-y', out,
  ]).promise;
  return pathToFileURL(out).href;
}

// Extrae una pista de audio concreta para poder previsualizarla.
async function extractAudio(file, trackIndex) {
  const out = tmp(`audio_${uid()}.m4a`);
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${trackIndex}`, '-vn',
    '-c:a', 'aac', '-b:a', '192k', '-y', out,
  ]).promise;
  return pathToFileURL(out).href;
}

let proxyJob = null;
// Copia ligera en H.264 para previsualizar formatos que Chromium no reproduce.
async function makeProxy(file, duration, onProgress) {
  const out = tmp(`proxy_${uid()}.mp4`);
  const job = run(FFMPEG, [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', out,
  ], { onStdout: progressParser(duration, onProgress) });
  proxyJob = job;
  try {
    await job.promise;
  } finally {
    proxyJob = null;
  }
  return pathToFileURL(out).href;
}

function progressParser(total, cb) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^out_time_(us|ms)=(\d+)/);
      if (m && total > 0) cb && cb(Math.min(1, Number(m[2]) / 1e6 / total));
    }
  };
}

// ---------- Exportación ----------
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const f3 = (n) => Number(n).toFixed(3);

const MP4_VIDEO = ['h264', 'hevc', 'mpeg4', 'av1', 'vp9'];
const MP4_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus', 'flac'];
const MOV_VIDEO = [...MP4_VIDEO, 'prores', 'mjpeg', 'dnxhd'];
const MOV_AUDIO = [...MP4_AUDIO, 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_s24be'];

function containerOf(outPath) {
  const ext = path.extname(outPath).slice(1).toLowerCase();
  return ext === 'mov' ? 'mov' : ext === 'mkv' ? 'mkv' : 'mp4';
}

// ¿Se puede exportar copiando los flujos tal cual (calidad idéntica)?
function copyAnalysis(job, container = 'mp4') {
  const reasons = [];
  if (job.crop) reasons.push('recorte de encuadre');
  if (job.overlays && job.overlays.length) reasons.push('capas de imagen/vídeo');
  if (job.music) reasons.push('audio añadido');
  if (!job.audio.muted && Math.abs(job.audio.volume - 1) > 0.001) reasons.push('cambio de volumen');
  const vc = job.info.video.codec;
  const okVideo = container === 'mkv' || (container === 'mov' ? MOV_VIDEO : MP4_VIDEO).includes(vc);
  if (!okVideo) reasons.push(`el códec ${vc} no cabe en .${container}`);
  const a = job.info.audio[job.audio.track];
  const audioNeedsEncode = !!a && !job.audio.muted && container !== 'mkv' &&
    !(container === 'mov' ? MOV_AUDIO : MP4_AUDIO).includes(a.codec);
  return { possible: reasons.length === 0, reasons, audioNeedsEncode };
}

function pickEncoder(job) {
  const src = job.info.video;
  let codec = job.settings.codec; // same | h264 | h265
  if (codec === 'same') codec = src.codec === 'hevc' ? 'h265' : 'h264';
  const q = job.settings.quality === 'auto' || job.settings.quality === 'original' ? 'max' : job.settings.quality;
  const crf = { max: { h264: 14, h265: 16 }, high: { h264: 18, h265: 21 }, light: { h264: 23, h265: 26 } }[q][codec];
  const preset = q === 'max' ? 'slow' : 'medium';
  const tenBit = /10|12/.test(src.pixFmt || '');
  const args = [];
  if (codec === 'h265') {
    args.push('-c:v', 'libx265', '-preset', preset, '-crf', String(crf), '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p',
      '-x265-params', 'log-level=error');
    if (containerOf(job.outPath) !== 'mkv') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p');
  }
  const ok = (v) => v && v !== 'unknown' && v !== 'reserved';
  if (ok(src.colorPrimaries)) args.push('-color_primaries', src.colorPrimaries);
  if (ok(src.colorTrc)) args.push('-color_trc', src.colorTrc);
  if (ok(src.colorSpace)) args.push('-colorspace', src.colorSpace);
  if (ok(src.colorRange)) args.push('-color_range', src.colorRange);
  return { args, codec, crf, preset };
}

// Convierte tiempo del vídeo original a tiempo del vídeo exportado.
function srcToOut(segments, t) {
  let acc = 0;
  for (const s of segments) {
    if (t >= s.end) acc += s.end - s.start;
    else {
      if (t > s.start) acc += t - s.start;
      break;
    }
  }
  return acc;
}

let current = null; // exportación en curso

async function exportVideo(job, onProgress) {
  const container = containerOf(job.outPath);
  const segments = job.segments.filter((s) => s.end - s.start > 0.01);
  const outDur = segments.reduce((a, s) => a + (s.end - s.start), 0);
  if (!segments.length || outDur <= 0) throw new Error('No hay ningún tramo que exportar.');
  const analysis = copyAnalysis(job, container);
  const wantCopy = job.settings.quality === 'original' || job.settings.quality === 'auto';
  const state = { cancelled: false, proc: null, outPath: job.outPath };
  current = state;
  try {
    if (wantCopy && analysis.possible) {
      await exportCopy(job, segments, outDur, container, analysis, state, onProgress);
      return { mode: 'copy', outPath: job.outPath };
    }
    await exportEncode(job, segments, outDur, container, state, onProgress);
    return { mode: 'encode', outPath: job.outPath };
  } catch (e) {
    try { fs.existsSync(job.outPath) && fs.unlinkSync(job.outPath); } catch (_) { /* nada */ }
    if (state.cancelled) {
      const err = new Error('Exportación cancelada');
      err.cancelled = true;
      throw err;
    }
    throw e;
  } finally {
    current = null;
  }
}

function cancelExport() {
  if (current) {
    current.cancelled = true;
    if (current.proc) current.proc.kill('SIGKILL');
  }
  if (proxyJob) proxyJob.proc.kill('SIGKILL');
}

function commonOut(container) {
  const a = ['-map_metadata', '0'];
  if (container !== 'mkv') a.push('-movflags', '+faststart');
  return a;
}

async function exportCopy(job, segments, outDur, container, analysis, state, onProgress) {
  const ext = path.extname(job.outPath) || '.mp4';
  const audioMaps = job.audio.muted || !job.info.audio.length ? ['-an'] : ['-map', `0:a:${job.audio.track}`];
  const audioCodec = analysis.audioNeedsEncode ? ['-c:a', 'aac', '-b:a', '320k'] : [];
  const parts = [];
  let done = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const len = s.end - s.start;
    const out = segments.length === 1 ? job.outPath : tmp(`part_${uid()}${ext}`);
    const { proc, promise } = run(FFMPEG, [
      '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
      '-ss', f3(s.start), '-i', job.input, '-t', f3(len),
      '-map', '0:v:0', ...audioMaps, '-c', 'copy', ...audioCodec,
      '-avoid_negative_ts', 'make_zero', ...commonOut(container), out,
    ], { onStdout: progressParser(len, (p) => onProgress((done + p * len) / outDur)) });
    state.proc = proc;
    await promise;
    done += len;
    parts.push(out);
  }
  if (segments.length > 1) {
    const list = tmp(`concat_${uid()}.txt`);
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const { proc, promise } = run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-i', job.input, '-map', '0', '-map_metadata', '1', '-c', 'copy',
      ...(container !== 'mkv' ? ['-movflags', '+faststart'] : []), job.outPath,
    ]);
    state.proc = proc;
    await promise;
    parts.forEach((p) => fs.rmSync(p, { force: true }));
    fs.rmSync(list, { force: true });
  }
  onProgress(1);
}

async function exportEncode(job, segments, outDur, container, state, onProgress) {
  const info = job.info;
  const W = info.video.width;
  const H = info.video.height;
  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y'];
  const filters = [];
  const track = job.audio.track;
  const useOrig = !job.audio.muted && info.audio.length > 0;
  const single = segments.length === 1;

  // Entradas: cada tramo se abre por separado con búsqueda precisa (rápido y exacto).
  segments.forEach((s) => args.push('-ss', f3(s.start), '-t', f3(s.end - s.start), '-i', job.input));
  let nextInput = segments.length;

  // Vídeo: unir tramos
  let base;
  if (single) {
    filters.push('[0:v:0]setpts=PTS-STARTPTS[vcat]');
  } else {
    const ins = segments.map((_, i) => {
      filters.push(`[${i}:v:0]setpts=PTS-STARTPTS[v${i}]`);
      if (useOrig) filters.push(`[${i}:a:${track}]asetpts=PTS-STARTPTS[a${i}]`);
      return useOrig ? `[v${i}][a${i}]` : `[v${i}]`;
    }).join('');
    filters.push(`${ins}concat=n=${segments.length}:v=1:a=${useOrig ? 1 : 0}${useOrig ? '[vcat][acat]' : '[vcat]'}`);
  }
  base = 'vcat';

  // Capas (en coordenadas del fotograma original, antes del recorte)
  (job.overlays || []).forEach((ov, j) => {
    const oStart = srcToOut(segments, ov.start);
    const oEnd = srcToOut(segments, ov.end);
    const len = oEnd - oStart;
    if (len <= 0.01) return;
    const idx = nextInput++;
    if (ov.type === 'image') {
      args.push('-loop', '1', '-framerate', info.video.fpsStr || '30', '-t', f3(len), '-i', ov.path);
    } else {
      args.push('-ss', f3(ov.offset || 0), '-t', f3(len), '-i', ov.path);
    }
    const w = even(ov.w * W);
    const h = even(ov.h * H);
    const x = Math.round(ov.x * W);
    const y = Math.round(ov.y * H);
    const alpha = Math.max(0, Math.min(1, ov.opacity ?? 1));
    filters.push(`[${idx}:v:0]scale=${w}:${h},format=rgba,colorchannelmixer=aa=${alpha.toFixed(3)},setpts=PTS-STARTPTS+${f3(oStart)}/TB[ov${j}]`);
    filters.push(`[${base}][ov${j}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${f3(oStart)},${f3(oEnd)})'[b${j}]`);
    base = `b${j}`;
  });

  // Recorte de encuadre
  if (job.crop) {
    const cw = Math.min(even(job.crop.w * W), W - (W % 2));
    const ch = Math.min(even(job.crop.h * H), H - (H % 2));
    const cx = Math.max(0, Math.min(W - cw, Math.round(job.crop.x * W)));
    const cy = Math.max(0, Math.min(H - ch, Math.round(job.crop.y * H)));
    filters.push(`[${base}]crop=${cw}:${ch}:${cx}:${cy}[vcrop]`);
    base = 'vcrop';
  } else if (W % 2 || H % 2) {
    filters.push(`[${base}]crop=${W - (W % 2)}:${H - (H % 2)}:0:0[veven]`);
    base = 'veven';
  }

  // Audio
  let audioMap = null;
  let audioCopy = false;
  const vol = job.audio.volume;
  let origLabel = null;
  if (useOrig) {
    const needsFilter = Math.abs(vol - 1) > 0.001 || job.music;
    if (single && !needsFilter) {
      audioMap = `0:a:${track}`;
      // Copiamos el audio tal cual si el contenedor lo admite (calidad idéntica).
      const a = info.audio[track];
      audioCopy = container === 'mkv' || (container === 'mov' ? MOV_AUDIO : MP4_AUDIO).includes(a.codec);
    } else {
      origLabel = single ? `0:a:${track}` : 'acat';
      if (Math.abs(vol - 1) > 0.001) {
        filters.push(`[${origLabel}]volume=${vol.toFixed(3)}[avol]`);
        origLabel = 'avol';
      }
    }
  }
  if (job.music) {
    const m = job.music;
    const idx = nextInput++;
    if (m.loop) args.push('-stream_loop', '-1');
    args.push('-ss', f3(m.offset || 0), '-i', m.path);
    const mStart = srcToOut(segments, m.start);
    const avail = m.loop ? Infinity : Math.max(0, (m.duration || Infinity) - (m.offset || 0));
    const mLen = Math.max(0.05, Math.min(outDur - mStart, avail));
    const chain = [`atrim=duration=${f3(mLen)}`, 'asetpts=PTS-STARTPTS'];
    if (m.fadeIn) chain.push(`afade=t=in:st=0:d=${f3(Math.min(1.5, mLen / 3))}`);
    if (m.fadeOut) chain.push(`afade=t=out:st=${f3(Math.max(0, mLen - Math.min(2, mLen / 3)))}:d=${f3(Math.min(2, mLen / 3))}`);
    chain.push(`volume=${(m.volume ?? 1).toFixed(3)}`);
    if (mStart > 0.001) chain.push(`adelay=${Math.round(mStart * 1000)}:all=1`);
    filters.push(`[${idx}:a:0]${chain.join(',')}[amus]`);
    if (origLabel) {
      filters.push(`[${origLabel}][amus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
    } else {
      filters.push('[amus]apad[aout]');
    }
    audioMap = '[aout]';
  } else if (origLabel) {
    if (origLabel === 'acat' || origLabel === 'avol') audioMap = `[${origLabel}]`;
    else { filters.push(`[${origLabel}]anull[aout]`); audioMap = '[aout]'; }
  }

  const enc = pickEncoder(job);
  args.push('-filter_complex', filters.join(';'), '-map', `[${base}]`);
  if (audioMap) {
    args.push('-map', audioMap);
    if (audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '320k');
  } else {
    args.push('-an');
  }
  args.push(...enc.args, '-map_metadata', '0', '-t', f3(outDur));
  if (container !== 'mkv') args.push('-movflags', '+faststart');
  args.push(job.outPath);

  const { proc, promise } = run(FFMPEG, args, { onStdout: progressParser(outDur, onProgress) });
  state.proc = proc;
  await promise;
  onProgress(1);
}

module.exports = {
  setTempRoot, probe, thumbnails, waveform, extractAudio, makeProxy, exportVideo, cancelExport, copyAnalysis,
  containerOf, FFMPEG,
};
