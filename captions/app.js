import { translateSegments, writePostKit, synthesizeSpeech, describeError } from "./ai.js";

const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const canvas = $("#preview");
const ctx = canvas.getContext("2d");

// Phones get far less memory per tab; iPhone Safari silently reloads a page that uses too much.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobi/i.test(navigator.userAgent);
// Above this size the whole-file decode risks running a phone out of memory.
const QUICK_DECODE_LIMIT = IS_MOBILE ? 60e6 : 500e6;

// Remembers heavy work in progress, so after a memory crash reload we can explain what happened.
function markBusy(task) {
  try {
    if (task) sessionStorage.setItem("reelscribe.busy", task);
    else sessionStorage.removeItem("reelscribe.busy");
  } catch {
    // Storage unavailable (private mode); recovery hint is a nice-to-have.
  }
}
function crashedTask() {
  try {
    return sessionStorage.getItem("reelscribe.busy");
  } catch {
    return null;
  }
}

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "hm", "mm", "mhm"]);
const LANGUAGES = [
  "Hindi", "Marathi", "Gujarati", "Tamil", "Telugu", "Bengali", "Kannada", "Malayalam", "Punjabi",
  "English", "Spanish", "French", "German", "Portuguese", "Italian", "Arabic", "Japanese", "Korean",
  "Chinese (Simplified)", "Indonesian", "Turkish", "Russian",
];
const PRESETS = {
  pop: { font: "Montserrat", uppercase: true, textColor: "#ffffff", hlColor: "#ffd43b" },
  karaoke: { font: "Montserrat", uppercase: true, textColor: "#ffffff", hlColor: "#3ddc97" },
  box: { font: "Montserrat", uppercase: true, textColor: "#ffffff", hlColor: "#7c5cff" },
  neon: { font: "Montserrat", uppercase: true, textColor: "#ffffff", hlColor: "#ff4fd8" },
  minimal: { font: "Inter", uppercase: false, textColor: "#ffffff", hlColor: "#ffffff" },
  bold: { font: "Anton", uppercase: true, textColor: "#ffffff", hlColor: "#ff6b3d" },
};

const state = {
  file: null,
  url: "",
  duration: 0,
  pcm: null, // 16 kHz mono samples, used for transcription and silence detection
  words: [], // { text, start, end, deleted }
  translation: null, // { language, sentences, words }
  showTranslated: true,
  silences: [],
  keywords: new Set(),
  dub: null, // { buffer, language }
  dubOn: true,
  exporting: false,
  capturing: false, // true while reading audio by playing the video
  clickMode: "seek",
  style: {
    preset: "pop", font: "Montserrat", wordsPerPage: 3, size: 72, posY: 72, uppercase: true,
    textColor: "#ffffff", hlColor: "#ffd43b", emColor: "#3ddc97", aspect: "original",
  },
  trim: { silence: false, fillers: false, minSilence: 0.5, sensitivity: 30 },
  origVol: 0.12,
};

/* ---------- Persistence (per-browser conveniences only) ---------- */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("reelscribe.settings") || "{}");
    return { claudeKey: "", elevenKey: "", voiceId: "", ...saved };
  } catch {
    return { claudeKey: "", elevenKey: "", voiceId: "" };
  }
}
function saveSettings(settings) {
  try {
    localStorage.setItem("reelscribe.settings", JSON.stringify(settings));
  } catch {
    toast("Couldn't save settings in this browser — they'll last until you close the tab.", true);
  }
}
let settings = loadSettings();

/* ---------- Small helpers ---------- */

function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
let toastTimer = 0;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), isError ? 7000 : 3500);
}
function setProgress(id, fraction) {
  const bar = $(id);
  bar.classList.toggle("on", fraction != null);
  bar.querySelector("i").style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
function normalizeWord(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
}
function isFiller(word) {
  return FILLERS.has(normalizeWord(word.text));
}

/* ---------- Ranges: what gets cut ---------- */

function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 0.02) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

let cutsCache = null;
function cuts() {
  if (cutsCache) return cutsCache;
  const ranges = [];
  if (state.trim.silence) ranges.push(...state.silences);
  for (const w of state.words) {
    if (w.deleted || (state.trim.fillers && isFiller(w))) ranges.push([w.start, w.end]);
  }
  // Drop slivers of kept video too short to be worth showing.
  const merged = mergeRanges(ranges);
  const bridged = [];
  for (const r of merged) {
    const last = bridged[bridged.length - 1];
    if (last && r[0] - last[1] < 0.12) last[1] = r[1];
    else bridged.push([...r]);
  }
  cutsCache = bridged;
  return cutsCache;
}
function keptDuration() {
  return state.duration - cuts().reduce((sum, [a, b]) => sum + (Math.min(b, state.duration) - a), 0);
}
function cutAt(t) {
  return cuts().find(([a, b]) => t >= a && t < b) || null;
}

function detectSilences() {
  const pcm = state.pcm;
  if (!pcm) return [];
  const sr = 16000;
  const hop = Math.round(sr * 0.02);
  const frames = Math.floor(pcm.length / hop);
  const db = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) sum += pcm[j] * pcm[j];
    db[i] = 10 * Math.log10(sum / hop + 1e-12);
  }
  // Threshold relative to the loud parts of this recording.
  const sorted = Array.from(db).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? -20;
  const threshold = Math.max(loud - state.trim.sensitivity, -70);
  const pad = 0.12;
  const ranges = [];
  let runStart = -1;
  for (let i = 0; i <= frames; i++) {
    const silent = i < frames && db[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const a = runStart * 0.02;
      const b = i * 0.02;
      if (b - a >= state.trim.minSilence) {
        // Keep a little breathing room, but cut all the way to the edges of the video.
        ranges.push([a === 0 ? 0 : a + pad, i === frames ? state.duration : b - pad]);
      }
      runStart = -1;
    }
  }
  return ranges.filter(([a, b]) => b - a > 0.05);
}

function onCutsChanged() {
  cutsCache = null;
  pagesCache = null;
  if (state.trim.silence) state.silences = detectSilences();
  renderTimeline();
  renderWords();
  const removed = state.duration - keptDuration();
  $("#trimStatus").textContent = removed > 0.05
    ? `Cutting ${removed.toFixed(1)}s — new length ${fmt(keptDuration())}.`
    : "";
}

/* ---------- Caption words and pages ---------- */

function captionWords() {
  if (state.translation && state.showTranslated) {
    return state.translation.words.filter((w) => !cutAt((w.start + w.end) / 2));
  }
  return state.words.filter((w) => !w.deleted && !(state.trim.fillers && isFiller(w)));
}

function buildSentences(words) {
  const sentences = [];
  let cur = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.8 || /[.!?…。？！]$/.test(prev.text) || cur.length >= 18)) {
      sentences.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) sentences.push(cur);
  return sentences.map((ws) => ({
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    text: ws.map((w) => w.text).join(" "),
  }));
}

// Spread a translated sentence's words across the time the original sentence took.
function wordsFromSentence({ start, end, text }) {
  let tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0].length > 12) {
    // Scripts without spaces (Chinese, Japanese): show a few characters at a time.
    tokens = tokens[0].match(/.{1,4}/gu);
  }
  const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
  let t = start;
  return tokens.map((token) => {
    const dur = ((end - start) * token.length) / total;
    const w = { text: token, start: t, end: t + dur };
    t += dur;
    return w;
  });
}

let pagesCache = null;
function pages() {
  if (pagesCache) return pagesCache;
  const words = captionWords();
  const maxWords = state.style.wordsPerPage;
  const result = [];
  let cur = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= maxWords || w.start - prev.end > 0.7 || /[.!?…。？！]$/.test(prev.text) || chars > 32)) {
      result.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) result.push(cur);
  pagesCache = result.map((ws) => ({ words: ws, start: ws[0].start, end: ws[ws.length - 1].end }));
  // Let each caption linger briefly so it's readable, without overlapping the next one.
  pagesCache.forEach((p, i) => {
    const next = pagesCache[i + 1];
    p.showUntil = Math.min(p.end + 0.6, next ? next.start : Infinity);
  });
  return pagesCache;
}
function pageAt(t) {
  return pages().find((p) => t >= p.start - 0.02 && t < p.showUntil) || null;
}

/* ---------- Rendering ---------- */

function outputSize() {
  const vw = video.videoWidth || 1080;
  const vh = video.videoHeight || 1920;
  const fixed = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] };
  if (fixed[state.style.aspect]) return fixed[state.style.aspect];
  const scale = Math.min(1, 1920 / Math.max(vw, vh));
  return [Math.round((vw * scale) / 2) * 2, Math.round((vh * scale) / 2) * 2];
}
function resizeCanvas() {
  const [w, h] = outputSize();
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawCaptions(t) {
  const page = pageAt(t);
  if (!page) return;
  const W = canvas.width;
  const H = canvas.height;
  const st = state.style;
  const preset = st.preset;
  const px = Math.round((Math.min(W, H) * st.size) / 1000);
  const weight = st.font === "Montserrat" ? 900 : st.font === "Inter" ? 700 : 400;
  ctx.font = `${weight} ${px}px "${st.font}", "Noto Sans", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  // Extra gap so outlines and the active-word "pop" never make neighbouring words touch.
  const space = ctx.measureText(" ").width + px * 0.22;
  const tokens = page.words.map((w) => {
    const text = st.uppercase ? w.text.toUpperCase() : w.text;
    return { w, text, width: ctx.measureText(text).width };
  });

  // Wrap into lines within the safe area.
  const maxWidth = W * 0.86;
  const lines = [];
  let line = [];
  let lineWidth = 0;
  for (const tok of tokens) {
    const add = (line.length ? space : 0) + tok.width;
    if (line.length && lineWidth + add > maxWidth) {
      lines.push({ tokens: line, width: lineWidth });
      line = [];
      lineWidth = 0;
    }
    lineWidth += (line.length ? space : 0) + tok.width;
    line.push(tok);
  }
  if (line.length) lines.push({ tokens: line, width: lineWidth });

  const lineHeight = px * 1.25;
  const blockHeight = lines.length * lineHeight;
  let y = (H * st.posY) / 100 - blockHeight / 2 + lineHeight / 2;

  // Active word: the latest word that has started.
  let active = null;
  for (const tok of tokens) if (t >= tok.w.start) active = tok;

  // Page entrance animation.
  const intro = clamp((t - page.start) / 0.12, 0, 1);
  const pageScale = preset === "minimal" ? 1 : 0.85 + 0.15 * (1 - (1 - intro) ** 3);

  if (preset === "minimal") {
    const widest = Math.max(...lines.map((l) => l.width));
    ctx.fillStyle = "rgba(0,0,0,.62)";
    roundRect(W / 2 - widest / 2 - px * 0.5, y - lineHeight / 2 - px * 0.2, widest + px, blockHeight + px * 0.4, px * 0.35);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(W / 2, (H * st.posY) / 100);
  ctx.scale(pageScale, pageScale);
  ctx.translate(-W / 2, -(H * st.posY) / 100);

  for (const ln of lines) {
    let x = W / 2 - ln.width / 2;
    for (const tok of ln.tokens) {
      const isActive = tok === active;
      const spoken = t >= tok.w.start;
      const isKeyword = state.keywords.has(normalizeWord(tok.w.text));
      let color = st.textColor;
      if (isKeyword) color = st.emColor;
      if ((preset === "pop" || preset === "neon" || preset === "bold") && isActive) color = st.hlColor;
      if (preset === "karaoke" && spoken) color = st.hlColor;

      let scale = 1;
      if ((preset === "pop" || preset === "bold") && isActive) {
        const k = clamp((t - tok.w.start) / 0.1, 0, 1);
        scale = 1 + 0.12 * Math.sin(k * Math.PI * 0.5) - 0.04 * k;
      }

      const cx = x + tok.width / 2;
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(scale, scale);

      if (preset === "box" && isActive) {
        ctx.fillStyle = st.hlColor;
        roundRect(-tok.width / 2 - px * 0.18, -px * 0.62, tok.width + px * 0.36, px * 1.24, px * 0.22);
        ctx.fill();
      }
      if (preset === "neon") {
        ctx.shadowColor = isActive ? st.hlColor : "rgba(0,0,0,.8)";
        ctx.shadowBlur = px * (isActive ? 0.6 : 0.25);
      } else if (preset !== "minimal") {
        ctx.lineWidth = px * 0.18;
        ctx.strokeStyle = "rgba(0,0,0,.92)";
        ctx.strokeText(tok.text, -tok.width / 2, 0);
        ctx.shadowColor = "rgba(0,0,0,.45)";
        ctx.shadowOffsetY = px * 0.06;
        ctx.shadowBlur = px * 0.1;
      }
      ctx.fillStyle = color;
      ctx.fillText(tok.text, -tok.width / 2, 0);
      ctx.restore();
      x += tok.width + space;
    }
    y += lineHeight;
  }
  ctx.restore();
}

function drawFrame() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (video.readyState >= 2 && video.videoWidth) {
    const s = Math.max(W / video.videoWidth, H / video.videoHeight);
    const dw = video.videoWidth * s;
    const dh = video.videoHeight * s;
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  drawCaptions(video.currentTime);
}

/* ---------- Playback ---------- */

let audio = null; // { ctx, source, origGain, dubGain, speakers, recordDest }
function ensureAudio() {
  if (audio) return audio;
  const ac = new AudioContext();
  const source = ac.createMediaElementSource(video);
  const origGain = ac.createGain();
  const dubGain = ac.createGain();
  const master = ac.createGain();
  const speakers = ac.createGain();
  const recordDest = ac.createMediaStreamDestination();
  source.connect(origGain).connect(master);
  dubGain.connect(master);
  master.connect(speakers).connect(ac.destination);
  master.connect(recordDest);
  audio = { ctx: ac, source, origGain, dubGain, speakers, recordDest };
  applyMix();
  return audio;
}
function dubActive() {
  return Boolean(state.dub && state.dubOn);
}
function applyMix() {
  if (!audio) return;
  audio.origGain.gain.value = dubActive() ? state.origVol : 1;
}

let dubSource = null;
function stopDub() {
  if (dubSource) {
    try {
      dubSource.stop();
    } catch {
      // Already stopped.
    }
    dubSource.disconnect();
    dubSource = null;
  }
}
function startDub() {
  stopDub();
  if (!dubActive() || video.paused || !audio || state.capturing) return;
  dubSource = audio.ctx.createBufferSource();
  dubSource.buffer = state.dub.buffer;
  dubSource.connect(audio.dubGain);
  const offset = video.currentTime;
  if (offset < dubSource.buffer.duration) dubSource.start(0, offset);
}
video.addEventListener("playing", startDub);
video.addEventListener("pause", stopDub);
video.addEventListener("seeking", stopDub);
video.addEventListener("seeked", () => {
  if (!video.paused) startDub();
});

let endPromise = null;
function finishPlayback() {
  video.pause();
  if (endPromise) {
    endPromise.resolve();
    endPromise = null;
  }
}
video.addEventListener("ended", finishPlayback);

// Skip over cut sections while playing.
function enforceCuts() {
  if (video.paused || video.seeking || state.capturing) return;
  const cut = cutAt(video.currentTime);
  if (!cut) return;
  if (cut[1] >= state.duration - 0.05) {
    finishPlayback();
    return;
  }
  if (recorder && recorder.state === "recording") recorder.pause();
  video.currentTime = cut[1];
}
video.addEventListener("timeupdate", enforceCuts);

async function togglePlay() {
  if (!state.duration || state.exporting || state.capturing) return;
  ensureAudio();
  await audio.ctx.resume();
  if (video.paused) {
    if (video.currentTime >= state.duration - 0.05 || cutAt(video.currentTime)?.[1] >= state.duration - 0.05) {
      video.currentTime = firstKeptTime();
    }
    await video.play();
  } else {
    video.pause();
  }
}
function firstKeptTime() {
  const c = cutAt(0);
  return c ? c[1] : 0;
}
video.addEventListener("play", () => ($("#playBtn").textContent = "❚❚"));
video.addEventListener("pause", () => ($("#playBtn").textContent = "▶"));

let lastActiveWord = -1;
function tick() {
  if (state.duration) {
    enforceCuts();
    drawFrame();
    const t = video.currentTime;
    $("#head").style.left = `${(t / state.duration) * 100}%`;
    $("#time").textContent = `${fmt(t)} / ${fmt(state.duration)}`;
    highlightWord(t);
  }
  requestAnimationFrame(tick);
}

function renderTimeline() {
  const tl = $("#timeline");
  tl.querySelectorAll(".cut").forEach((el) => el.remove());
  if (!state.duration) return;
  for (const [a, b] of cuts()) {
    const el = document.createElement("div");
    el.className = "cut";
    el.style.left = `${(a / state.duration) * 100}%`;
    el.style.width = `${((Math.min(b, state.duration) - a) / state.duration) * 100}%`;
    tl.insertBefore(el, $("#head"));
  }
}
$("#timeline").addEventListener("click", (e) => {
  if (!state.duration || state.exporting || state.capturing) return;
  const rect = e.currentTarget.getBoundingClientRect();
  video.currentTime = clamp(((e.clientX - rect.left) / rect.width) * state.duration, 0, state.duration - 0.01);
});

/* ---------- Loading a video ---------- */

async function loadFile(file) {
  if (state.exporting || state.capturing) return;
  if (!file || !file.type.startsWith("video/")) {
    toast("Please choose a video file.", true);
    return;
  }
  if (state.url) URL.revokeObjectURL(state.url);
  stopDub();
  Object.assign(state, {
    file, url: URL.createObjectURL(file), duration: 0, pcm: null, words: [], translation: null,
    silences: [], keywords: new Set(), dub: null,
  });
  cutsCache = null;
  pagesCache = null;
  $("#insights").replaceChildren();
  ["#txStatus", "#trStatus", "#dubStatus", "#inStatus", "#exStatus", "#trimStatus"].forEach((id) => ($(id).textContent = ""));
  $("#exResult").replaceChildren();
  $("#showLangRow").hidden = true;
  $("#dubRow").hidden = true;

  video.src = state.url;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("This browser can't play that video format. Try MP4 or WebM."));
  }).catch((err) => {
    toast(err.message, true);
    throw err;
  });
  state.duration = video.duration;
  resizeCanvas();
  $("#viewport").classList.add("has-video");
  $("#newBtn").hidden = false;
  $("#playBtn").disabled = false;
  renderTimeline();
  renderWords();
  updateButtons();
  readAudio(file);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

// Fast path: decode the whole file at once. Some formats (e.g. iPhone .mov) or very large
// files make this fail or hang, so it never blocks anything — ensurePcm() falls back.
let audioJob = null;
function readAudio(file) {
  if (file.size > QUICK_DECODE_LIMIT) {
    // Read the audio by playback instead, when the user taps Generate captions.
    audioJob = { file, done: true, promise: Promise.resolve(null) };
    return;
  }
  $("#txStatus").textContent = "Reading audio from your video…";
  markBusy("reading");
  const job = { file, done: false, promise: null };
  job.promise = withTimeout(decodeAudio(file), Math.max(45000, state.duration * 1000))
    .then((pcm) => {
      if (state.file === file) {
        state.pcm = pcm;
        $("#txStatus").textContent = "";
        if (state.trim.silence) onCutsChanged();
      }
      return pcm;
    })
    .catch((err) => {
      console.warn("Quick audio decode failed; will read audio by playing the video instead.", err);
      if (state.file === file) $("#txStatus").textContent = "";
      return null;
    })
    .finally(() => {
      job.done = true;
      markBusy(null);
    });
  audioJob = job;
}

// Must reach captureAudioByPlayback() without awaiting when it can, so playback still counts
// as part of the user's tap (iPhone Safari blocks audio playback that starts later).
async function ensurePcm() {
  if (state.pcm) return state.pcm;
  const file = state.file;
  if (audioJob?.file === file && !audioJob.done) {
    $("#txStatus").textContent = "Reading audio from your video…";
    const pcm = await audioJob.promise;
    if (pcm) return pcm;
  }
  if (state.pcm) return state.pcm;
  if (state.file !== file) return null;
  const pcm = await captureAudioByPlayback();
  if (state.file === file) state.pcm = pcm;
  return pcm;
}

// Slow but universal path: play the video silently and record what the browser decodes.
let captureJob = null;
function captureAudioByPlayback() {
  captureJob ??= (async () => {
    const a = ensureAudio();
    const resumed = a.ctx.resume();
    const proc = a.ctx.createScriptProcessor(4096, 1, 1);
    const sink = a.ctx.createGain();
    sink.gain.value = 0;
    const chunks = [];
    proc.onaudioprocess = (e) => {
      if (!video.paused && !video.seeking) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    a.source.connect(proc);
    proc.connect(sink).connect(a.ctx.destination);
    a.speakers.gain.value = 0;
    state.capturing = true;
    updateButtons();
    setProgress("#txProgress", 0);
    const timer = setInterval(() => {
      setProgress("#txProgress", video.currentTime / state.duration);
      $("#txStatus").textContent = `Reading audio (plays the video silently)… ${fmt(video.currentTime)} / ${fmt(state.duration)}`;
    }, 250);
    try {
      video.pause();
      if (video.currentTime !== 0) video.currentTime = 0;
      const finished = new Promise((resolve, reject) => {
        video.addEventListener("ended", resolve, { once: true });
        video.addEventListener("pause", () => {
          if (!video.ended) reject(new Error("Reading the audio was interrupted — keep this tab open and try again."));
        }, { once: true });
      });
      // Samples are only kept once the seek back to the start has finished (see onaudioprocess).
      const playing = video.play();
      await resumed;
      await playing;
      await finished;
    } finally {
      clearInterval(timer);
      a.source.disconnect(proc);
      proc.disconnect();
      sink.disconnect();
      a.speakers.gain.value = 1;
      state.capturing = false;
      setProgress("#txProgress", null);
      $("#txStatus").textContent = "";
      updateButtons();
    }

    const length = chunks.reduce((n, c) => n + c.length, 0);
    if (!length) throw new Error("No audio could be read from this video.");
    const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate: a.ctx.sampleRate });
    let offset = 0;
    for (const c of chunks) {
      buffer.copyToChannel(c, 0, offset);
      offset += c.length;
    }
    const offline = new OfflineAudioContext(1, Math.ceil((length / a.ctx.sampleRate) * 16000), 16000);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    const pcm = (await offline.startRendering()).getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 1e-4) throw new Error("This video seems to have no sound.");
    return pcm;
  })().finally(() => {
    captureJob = null;
  });
  return captureJob;
}

async function decodeAudio(file) {
  const data = await file.arrayBuffer();
  const tmp = new AudioContext();
  try {
    const decoded = await tmp.decodeAudioData(data);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    tmp.close();
  }
}

/* ---------- Transcription ---------- */

let worker = null;
async function transcribe() {
  const btn = $("#transcribeBtn");
  btn.disabled = true;
  let pcm;
  try {
    pcm = await ensurePcm();
  } catch (err) {
    toast(`Couldn't read the audio: ${err.message}`, true);
    updateButtons();
    return;
  }
  if (!pcm) {
    updateButtons();
    return;
  }
  btn.disabled = true;
  markBusy("transcribing");
  worker ??= new Worker(new URL("./transcribe-worker.js", import.meta.url), { type: "module" });
  $("#txStatus").textContent = "Starting…";
  setProgress("#txProgress", 0);
  const files = new Map();

  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      const p = data.data;
      if (p.status === "progress" && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        files.forEach((f) => {
          loaded += f.loaded;
          total += f.total;
        });
        setProgress("#txProgress", loaded / total);
        $("#txStatus").textContent = `Downloading speech model… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`;
      }
    } else if (data.type === "status") {
      $("#txStatus").textContent = data.message;
      if (data.message.startsWith("Transcribing")) setProgress("#txProgress", null);
    } else if (data.type === "result") {
      setProgress("#txProgress", null);
      const words = data.chunks
        .map((c) => {
          const [start, end] = c.timestamp;
          return { text: c.text.trim(), start, end: end ?? start + 0.3, deleted: false };
        })
        .filter((w) => w.text);
      setWords(words);
      $("#txStatus").textContent = words.length ? `${words.length} words transcribed.` : "No speech found.";
      btn.disabled = false;
      btn.textContent = "Regenerate captions";
      markBusy(null);
    } else if (data.type === "error") {
      setProgress("#txProgress", null);
      $("#txStatus").textContent = "";
      toast(`Transcription failed: ${data.message}`, true);
      btn.disabled = false;
      markBusy(null);
    }
  };
  const audioCopy = pcm.slice();
  worker.postMessage(
    {
      type: "transcribe",
      audio: audioCopy,
      model: $("#model").value,
      language: $("#language").value || null,
      // The phone GPU path needs much more memory than the CPU path.
      allowGpu: !IS_MOBILE,
    },
    [audioCopy.buffer],
  );
}

function setWords(words) {
  state.words = words;
  state.translation = null;
  state.dub = null;
  state.keywords = new Set();
  $("#showLangRow").hidden = true;
  $("#dubRow").hidden = true;
  applyMix();
  stopDub();
  onCutsChanged();
  updateButtons();
}

function parseSubtitles(text) {
  const toSec = (s) => {
    const m = s.trim().replace(",", ".").match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
    return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
  };
  const words = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split("-->").map((s) => toSec(s.split(/\s/).filter(Boolean)[0] || s));
    const body = lines.slice(idx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!body || Number.isNaN(a) || Number.isNaN(b)) continue;
    for (const w of wordsFromSentence({ start: a, end: b, text: body })) words.push({ ...w, deleted: false });
  }
  return words;
}

/* ---------- Transcript editor ---------- */

function renderWords() {
  const box = $("#words");
  lastActiveWord = -1;
  if (!state.words.length) {
    box.innerHTML = '<div class="empty">Generate captions to edit the transcript.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  state.words.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "w";
    if (w.deleted) span.classList.add("deleted");
    if (isFiller(w)) span.classList.add("filler");
    if (isFiller(w) && state.trim.fillers) span.classList.add("cut");
    span.dataset.i = i;
    span.textContent = w.text;
    frag.append(span, " ");
  });
  box.replaceChildren(frag);
}

function highlightWord(t) {
  if (!state.words.length) return;
  let idx = -1;
  for (let i = 0; i < state.words.length; i++) {
    if (state.words[i].start <= t) idx = i;
    else break;
  }
  if (idx === lastActiveWord) return;
  const box = $("#words");
  box.querySelector(".w.active")?.classList.remove("active");
  const el = box.querySelector(`.w[data-i="${idx}"]`);
  if (el && state.words[idx].end + 0.3 > t) el.classList.add("active");
  lastActiveWord = idx;
}

$("#words").addEventListener("click", (e) => {
  const el = e.target.closest(".w");
  if (!el || el.isContentEditable) return;
  const w = state.words[Number(el.dataset.i)];
  if (state.clickMode === "seek") {
    if (!state.exporting) video.currentTime = w.start;
  } else if (state.clickMode === "cut") {
    w.deleted = !w.deleted;
    onCutsChanged();
  } else {
    el.contentEditable = "true";
    el.focus();
    getSelection().selectAllChildren(el);
    const finish = () => {
      el.contentEditable = "false";
      const text = el.textContent.trim();
      if (text) w.text = text;
      else w.deleted = true;
      onCutsChanged();
    };
    el.addEventListener("blur", finish, { once: true });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        el.blur();
      }
    });
  }
});

$("#clickMode").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.clickMode = btn.dataset.mode;
  $("#clickMode").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  $("#modeHint").textContent = {
    seek: "Click a word to jump to it.",
    cut: "Click words to cut them from the video. Click again to restore.",
    edit: "Click a word to fix its spelling. Press Enter to save.",
  }[state.clickMode];
});

/* ---------- AI features ---------- */

function requireKey(name, label) {
  if (settings[name]) return true;
  toast(`Add your ${label} key in Settings first.`, true);
  $("#settings").showModal();
  return false;
}

async function translate() {
  if (!requireKey("claudeKey", "Anthropic")) return;
  const language = $("#targetLang").value;
  const btn = $("#translateBtn");
  btn.disabled = true;
  $("#trStatus").textContent = `Translating into ${language}…`;
  try {
    const source = buildSentences(state.words.filter((w) => !w.deleted && !isFiller(w)));
    const sentences = await translateSegments({ apiKey: settings.claudeKey, segments: source, language });
    state.translation = { language, sentences, words: sentences.flatMap(wordsFromSentence) };
    state.showTranslated = true;
    state.dub = null;
    applyMix();
    stopDub();
    $("#dubRow").hidden = true;
    pagesCache = null;
    $("#showLangRow").hidden = false;
    $("#captionLang").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === "translated")));
    $("#trStatus").textContent = `Captions translated into ${language}.`;
  } catch (err) {
    $("#trStatus").textContent = "";
    toast(`Translation failed: ${describeError(err)}`, true);
  } finally {
    btn.disabled = false;
    updateButtons();
  }
}

async function postKit() {
  if (!requireKey("claudeKey", "Anthropic")) return;
  const btn = $("#insightsBtn");
  btn.disabled = true;
  $("#inStatus").textContent = "Writing…";
  try {
    const transcript = state.words.filter((w) => !w.deleted).map((w) => w.text).join(" ");
    const kit = await writePostKit({ apiKey: settings.claudeKey, transcript });
    state.keywords = new Set(kit.keywords.map((k) => normalizeWord(k)).filter(Boolean));
    renderPostKit(kit);
    $("#inStatus").textContent = state.keywords.size ? "Keywords are now highlighted in your captions." : "";
  } catch (err) {
    $("#inStatus").textContent = "";
    toast(`Couldn't write the post kit: ${describeError(err)}`, true);
  } finally {
    btn.disabled = false;
    updateButtons();
  }
}

function renderPostKit(kit) {
  const box = $("#insights");
  box.replaceChildren();
  const card = (title, text) => {
    const c = document.createElement("div");
    c.className = "card";
    const h = document.createElement("h4");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = text;
    const copy = document.createElement("button");
    copy.className = "btn small";
    copy.textContent = "Copy";
    copy.onclick = () => navigator.clipboard.writeText(text).then(() => toast("Copied."));
    c.append(h, p, copy);
    box.append(c);
    return c;
  };
  card("Title", kit.title);
  card("Hook for the first 3 seconds", kit.hook);
  card("Description", kit.description);
  const tags = kit.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const tagCard = card("Hashtags", tags);
  tagCard.querySelector("p").remove();
  const list = document.createElement("div");
  list.className = "tags";
  list.style.marginBottom = "8px";
  kit.hashtags.forEach((h) => {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = `#${h.replace(/^#/, "")}`;
    list.append(t);
  });
  tagCard.insertBefore(list, tagCard.querySelector("button"));
}

async function createDub() {
  if (!requireKey("elevenKey", "ElevenLabs")) return;
  const btn = $("#dubBtn");
  btn.disabled = true;
  const voiceId = settings.voiceId || "21m00Tcm4TlvDq8ikWAM";
  const sentences = state.translation
    ? state.translation.sentences
    : buildSentences(state.words.filter((w) => !w.deleted && !isFiller(w)));
  const { ctx: ac } = ensureAudio();
  const clips = new Array(sentences.length);
  let done = 0;
  setProgress("#dubProgress", 0);
  $("#dubStatus").textContent = `Generating voice… 0 / ${sentences.length}`;

  try {
    let next = 0;
    const workerCount = Math.min(3, sentences.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (next < sentences.length) {
          const i = next++;
          const mp3 = await synthesizeSpeech({ apiKey: settings.elevenKey, voiceId, text: sentences[i].text });
          clips[i] = await ac.decodeAudioData(mp3);
          done++;
          setProgress("#dubProgress", done / sentences.length);
          $("#dubStatus").textContent = `Generating voice… ${done} / ${sentences.length}`;
        }
      }),
    );

    // Lay every clip onto one track that lines up with the source video.
    const rate = 32000;
    const offline = new OfflineAudioContext(1, Math.ceil(state.duration * rate), rate);
    let squeezed = 0;
    sentences.forEach((s, i) => {
      const clip = clips[i];
      const slotEnd = sentences[i + 1] ? sentences[i + 1].start : state.duration;
      const slot = Math.max(0.2, slotEnd - s.start);
      const speed = clamp(clip.duration / slot, 1, 1.35);
      if (speed > 1.01) squeezed++;
      const src = offline.createBufferSource();
      src.buffer = clip;
      src.playbackRate.value = speed;
      src.connect(offline.destination);
      src.start(s.start);
    });
    state.dub = { buffer: await offline.startRendering(), language: state.translation?.language ?? "original" };
    state.dubOn = true;
    $("#dubOn").checked = true;
    $("#dubRow").hidden = false;
    applyMix();
    if (!video.paused) startDub();
    $("#dubStatus").textContent =
      `Dub ready${state.translation ? ` (${state.translation.language})` : ""}.` +
      (squeezed ? ` ${squeezed} line(s) sped up slightly to fit.` : "");
  } catch (err) {
    $("#dubStatus").textContent = "";
    toast(`Dubbing failed: ${describeError(err)}`, true);
  } finally {
    setProgress("#dubProgress", null);
    btn.disabled = false;
    updateButtons();
  }
}

/* ---------- Export ---------- */

let recorder = null;
function pickMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

async function exportVideo() {
  if (!window.MediaRecorder || !canvas.captureStream) {
    toast("This browser can't record video. Try Chrome, Edge or Safari.", true);
    return;
  }
  const kept = keptDuration();
  if (kept < 0.2) {
    toast("Everything is cut — nothing to export.", true);
    return;
  }
  const { ctx: ac, recordDest } = ensureAudio();
  await ac.resume();
  video.pause();
  state.exporting = true;
  updateButtons();
  $("#exResult").replaceChildren();
  setProgress("#exProgress", 0);
  $("#exStatus").textContent = "Recording your edit…";

  const mimeType = pickMimeType();
  let recordedType = mimeType;
  const stream = canvas.captureStream(30);
  recordDest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Number($("#quality").value), audioBitsPerSecond: 160000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));

  // Resume recording only once the frame after a skipped cut has been drawn.
  const onSeeked = () => requestAnimationFrame(() => {
    if (recorder?.state === "paused") recorder.resume();
  });
  video.addEventListener("seeked", onSeeked);

  let progressTimer = 0;
  try {
    video.currentTime = firstKeptTime();
    await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    drawFrame();
    const ended = new Promise((resolve) => (endPromise = { resolve }));
    recorder.start(250);
    recordedType = recorder.mimeType || mimeType;
    const startedAt = performance.now();
    let pausedFor = 0;
    let pauseStart = 0;
    recorder.onpause = () => (pauseStart = performance.now());
    recorder.onresume = () => (pausedFor += performance.now() - pauseStart);
    progressTimer = setInterval(() => {
      const recorded = (performance.now() - startedAt - pausedFor) / 1000;
      setProgress("#exProgress", clamp(recorded / kept, 0, 1));
      $("#exStatus").textContent = `Recording your edit… ${fmt(recorded)} / ${fmt(kept)}`;
    }, 250);
    await video.play();
    await ended;
    recorder.stop();
    await stopped;
  } catch (err) {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    toast(`Export failed: ${err.message}`, true);
    return;
  } finally {
    clearInterval(progressTimer);
    video.removeEventListener("seeked", onSeeked);
    endPromise = null;
    recorder = null;
    state.exporting = false;
    setProgress("#exProgress", null);
    updateButtons();
  }

  const type = (mimeType || "video/webm").split(";")[0];
  const blob = new Blob(chunks, { type });
  const ext = type === "video/mp4" ? "mp4" : "webm";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `reelscribe-${Date.now()}.${ext}`;
  link.className = "btn primary block";
  link.textContent = `Download ${ext.toUpperCase()} (${(blob.size / 1e6).toFixed(1)} MB)`;
  $("#exResult").replaceChildren(link);
  $("#exStatus").textContent = "Done.";
  const note = ext === "webm"
    ? "This browser records WebM. YouTube accepts it; for Instagram or TikTok, export from Safari or recent Chrome, which record MP4."
    : /avc1|h264/i.test(recordedType) || !/codecs/i.test(recordedType)
      ? ""
      : "This browser saved MP4 without the H.264 codec, which Instagram may reject. Chrome or Safari on a computer export H.264.";
  if (note) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = note;
    $("#exResult").append(p);
  }
}

function downloadSrt() {
  const ts = (t) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  // Subtitle times follow the edited video, so shift each caption back by the cuts before it.
  const shift = (t) => t - cuts().reduce((sum, [a, b]) => sum + (b <= t ? b - a : a < t ? t - a : 0), 0);
  const srt = pages()
    .map((p, i) => `${i + 1}\n${ts(shift(p.start))} --> ${ts(shift(p.showUntil))}\n${p.words.map((w) => w.text).join(" ")}\n`)
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([srt], { type: "text/plain" }));
  a.download = "captions.srt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Controls ---------- */

function updateButtons() {
  const hasVideo = Boolean(state.duration);
  const hasWords = state.words.length > 0;
  const busy = state.exporting || state.capturing;
  $("#transcribeBtn").disabled = !hasVideo || busy;
  $("#translateBtn").disabled = !hasWords || busy;
  $("#insightsBtn").disabled = !hasWords || busy;
  $("#dubBtn").disabled = !hasWords || busy;
  $("#exportBtn").disabled = !hasVideo || busy;
  $("#srtBtn").disabled = !hasWords;
  $("#playBtn").disabled = !hasVideo || busy;
  $("#aiKeyNotice").hidden = Boolean(settings.claudeKey && settings.elevenKey);
}

function bindStyle(id, key, parse = (v) => v) {
  $(id).addEventListener("input", (e) => {
    const el = e.target;
    state.style[key] = parse(el.type === "checkbox" ? el.checked : el.value);
    if (key === "wordsPerPage") {
      $("#wppVal").textContent = state.style.wordsPerPage;
      pagesCache = null;
    }
    if (key === "aspect") resizeCanvas();
    if (key === "font") document.fonts.load(`900 40px "${state.style.font}"`);
  });
}
bindStyle("#font", "font");
bindStyle("#wordsPerPage", "wordsPerPage", Number);
bindStyle("#size", "size", Number);
bindStyle("#posY", "posY", Number);
bindStyle("#textColor", "textColor");
bindStyle("#hlColor", "hlColor");
bindStyle("#emColor", "emColor");
bindStyle("#uppercase", "uppercase");
bindStyle("#aspect", "aspect");

$("#presets").addEventListener("click", (e) => {
  const btn = e.target.closest(".preset");
  if (!btn) return;
  const name = btn.dataset.preset;
  Object.assign(state.style, PRESETS[name], { preset: name });
  $("#presets").querySelectorAll(".preset").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  $("#font").value = state.style.font;
  $("#uppercase").checked = state.style.uppercase;
  $("#textColor").value = state.style.textColor;
  $("#hlColor").value = state.style.hlColor;
  document.fonts.load(`900 40px "${state.style.font}"`);
});

$("#cutSilence").addEventListener("change", async (e) => {
  state.trim.silence = e.target.checked;
  if (state.trim.silence && !state.pcm && state.duration) {
    try {
      await ensurePcm();
    } catch (err) {
      toast(`Couldn't read the audio: ${err.message}`, true);
      e.target.checked = false;
      state.trim.silence = false;
    }
  }
  onCutsChanged();
});
$("#cutFillers").addEventListener("change", (e) => {
  state.trim.fillers = e.target.checked;
  onCutsChanged();
});
$("#minSilence").addEventListener("change", (e) => {
  state.trim.minSilence = Number(e.target.value);
  onCutsChanged();
});
$("#minSilence").addEventListener("input", (e) => ($("#minSilVal").textContent = `${Number(e.target.value).toFixed(1)}s`));
$("#silenceSens").addEventListener("change", (e) => {
  state.trim.sensitivity = Number(e.target.value);
  onCutsChanged();
});

$("#captionLang").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.showTranslated = btn.dataset.lang === "translated";
  $("#captionLang").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  pagesCache = null;
});
$("#dubOn").addEventListener("change", (e) => {
  state.dubOn = e.target.checked;
  applyMix();
  if (state.dubOn && !video.paused) startDub();
  else stopDub();
});
$("#origVol").addEventListener("input", (e) => {
  state.origVol = Number(e.target.value) / 100;
  applyMix();
});

for (const lang of LANGUAGES) $("#targetLang").add(new Option(lang, lang));

document.querySelector(".tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
});

// File input and drag-and-drop.
$("#fileInput").addEventListener("change", (e) => loadFile(e.target.files[0]).catch(() => {}));
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault();
  dz.classList.add("drag");
}));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("drag")));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]).catch(() => {});
});
$("#newBtn").addEventListener("click", () => {
  if (state.exporting || state.capturing) return;
  $("#fileInput").value = "";
  $("#fileInput").click();
});
$("#srtInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const words = parseSubtitles(await file.text());
  e.target.value = "";
  if (!words.length) {
    toast("No captions found in that file.", true);
    return;
  }
  setWords(words);
  $("#txStatus").textContent = `Imported ${words.length} words.`;
});

$("#playBtn").addEventListener("click", togglePlay);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.target.closest("input, textarea, select, [contenteditable='true'], button")) {
    e.preventDefault();
    togglePlay();
  }
});
$("#transcribeBtn").addEventListener("click", transcribe);
$("#translateBtn").addEventListener("click", translate);
$("#insightsBtn").addEventListener("click", postKit);
$("#dubBtn").addEventListener("click", createDub);
$("#exportBtn").addEventListener("click", exportVideo);
$("#srtBtn").addEventListener("click", downloadSrt);

// Settings dialog.
const dialog = $("#settings");
function openSettings() {
  $("#claudeKey").value = settings.claudeKey;
  $("#elevenKey").value = settings.elevenKey;
  $("#voiceId").value = settings.voiceId;
  dialog.showModal();
}
$("#settingsBtn").addEventListener("click", openSettings);
document.querySelector("[data-open-settings]").addEventListener("click", (e) => {
  e.preventDefault();
  openSettings();
});
dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "save") return;
  settings = {
    claudeKey: $("#claudeKey").value.trim(),
    elevenKey: $("#elevenKey").value.trim(),
    voiceId: $("#voiceId").value.trim(),
  };
  saveSettings(settings);
  updateButtons();
  toast("Settings saved.");
});

window.addEventListener("beforeunload", (e) => {
  if (state.exporting) e.preventDefault();
});

if (IS_MOBILE) {
  $("#model").value = "Xenova/whisper-tiny";
  $("#modelHint").hidden = false;
}
const crashed = crashedTask();
if (crashed) {
  markBusy(null);
  $("#crashNotice").hidden = false;
  if (IS_MOBILE) $("#model").value = "Xenova/whisper-tiny";
}

document.fonts.load('900 40px "Montserrat"');
updateButtons();
requestAnimationFrame(tick);
