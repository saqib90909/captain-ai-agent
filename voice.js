// Voice: microphone recording (auto-stop on silence), WAV encoding, waveform and loud text-to-speech.
(function () {
  const Voice = {};
  let ctx = null, analyser = null, stream = null, source = null, processor = null;
  let chunks = [], recording = false, stopResolve = null, sampleRate = 16000;
  let lastVoiceAt = 0, startedAt = 0, heardSpeech = false;
  let level = 0;

  // ---------- Waveform (always animating, reacts to mic/speaking) ----------
  const canvas = document.getElementById('wave');
  const g = canvas.getContext('2d');
  let speakingBoost = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(10, r.width * devicePixelRatio);
    canvas.height = Math.max(10, r.height * devicePixelRatio);
  }
  window.addEventListener('resize', resize);
  setTimeout(resize, 50);
  const freq = new Uint8Array(128);
  function draw(t) {
    const W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    const bars = Math.floor(W / (7 * devicePixelRatio));
    const bw = 3 * devicePixelRatio;
    const live = analyser && (recording || speaking);
    if (live) analyser.getByteFrequencyData(freq);
    for (let i = 0; i < bars; i++) {
      const x = i / (bars - 1);
      const env = Math.pow(Math.sin(Math.PI * x), 1.6); // fade at edges
      let amp;
      if (live) {
        const f = freq[Math.floor((Math.abs(x - 0.5) * 2) * 60) + 2] / 255;
        amp = 0.08 + f * 1.1;
      } else {
        const base = 0.12 + 0.1 * Math.sin(t / 400 + i * 0.6) + 0.07 * Math.sin(t / 230 + i * 1.7);
        amp = base + speakingBoost * (0.35 + 0.35 * Math.abs(Math.sin(t / 90 + i * 0.9)));
      }
      const h = Math.max(2, env * amp * H * 0.95);
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#1fb6ff'); grad.addColorStop(0.5, '#3a7bff'); grad.addColorStop(1, '#b44dff');
      g.fillStyle = grad;
      g.shadowColor = '#2f8bff'; g.shadowBlur = 8 * devicePixelRatio;
      g.fillRect(x * (W - bw), H / 2 - h / 2, bw, h);
    }
    speakingBoost *= 0.96;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // ---------- Hands-free listening ----------
  let auto = null;
  let noiseFloor = 0.01, speaking = false, speechStart = 0, preRoll = [], peak = 0;

  Voice.pulse = () => { speakingBoost = 1; };
  Voice.unlock = () => { try { getCtx(); const u = new SpeechSynthesisUtterance(''); speechSynthesis.speak(u); } catch (_) {} };
  Voice.isRecording = () => recording;
  Voice.isListening = () => !!auto;
  Voice.isHearing = () => speaking;
  Voice.level = () => level;

  async function openMic() {
    if (stream) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    sampleRate = ctx.sampleRate;
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = onAudio;
    source.connect(analyser);
    source.connect(processor);
    processor.connect(ctx.destination);
  }

  function closeMic() {
    try { processor.disconnect(); source.disconnect(); } catch (_) {}
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = source = processor = analyser = null;
  }

  function onAudio(e) {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    level = Math.sqrt(sum / d.length);
    const now = performance.now();
    if (recording && !auto) {
      chunks.push(d);
      if (level > 0.02) { lastVoiceAt = now; heardSpeech = true; }
      if ((heardSpeech && now - lastVoiceAt > 1300) || (!heardSpeech && now - startedAt > 7000) || now - startedAt > 30000) manualStop && manualStop();
      return;
    }
    if (!auto) return;
    if (!auto.canListen()) { speaking = false; recording = false; chunks = []; preRoll = []; return; }
    const bargeIn = Voice.isAudible();
    const threshold = bargeIn ? Math.max(0.07, noiseFloor * 7) : Math.max(0.018, noiseFloor * 2.8);
    if (!speaking) {
      if (!bargeIn) noiseFloor = noiseFloor * 0.97 + Math.min(level, 0.05) * 0.03;
      preRoll.push(d); if (preRoll.length > 6) preRoll.shift();
      if (level > threshold) {
        speaking = true; recording = true; speechStart = lastVoiceAt = now; peak = level;
        chunks = preRoll.slice(); preRoll = [];
        if (bargeIn) Voice.stopSpeaking();
        auto.onStart && auto.onStart();
      }
      return;
    }
    chunks.push(d);
    peak = Math.max(peak * 0.995, level);
    // voice is "still going" only if clearly above room noise AND not far below the speaker's own loudness
    // (fan / room noise stays far below the peak, so the sentence end is found even in a noisy room)
    if (level > threshold * 0.75 && level > peak * 0.22) lastVoiceAt = now;
    const silence = now - lastVoiceAt, dur = now - speechStart;
    if (silence > 500 || dur > 15000) {
      speaking = false; recording = false;
      const c = chunks; chunks = [];
      if (dur - silence > 260) auto.onUtterance(toBase64(wav(encode(c), 16000)));
      else auto.onCancel && auto.onCancel();
    }
  }

  function encode(list) {
    let len = list.reduce((a, c) => a + c.length, 0);
    const all = new Float32Array(len);
    let o = 0; for (const c of list) { all.set(c, o); o += c.length; }
    const target = 16000, ratio = sampleRate / target;
    const outLen = Math.floor(all.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const st = Math.floor(i * ratio), en = Math.min(all.length, Math.floor((i + 1) * ratio));
      let s2 = 0; for (let j = st; j < en; j++) s2 += all[j];
      const v = Math.max(-1, Math.min(1, s2 / Math.max(1, en - st)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return pcm;
  }

  Voice.startAuto = async function (opts) {
    auto = opts;
    speaking = false; chunks = []; preRoll = [];
    await openMic();
  };
  Voice.stopAuto = function () { auto = null; speaking = false; recording = false; closeMic(); };

  let manualStop = null;
  Voice.start = async function ({ onAutoStop } = {}) {
    if (recording) return;
    await openMic();
    manualStop = onAutoStop; chunks = []; heardSpeech = false;
    startedAt = lastVoiceAt = performance.now();
    recording = true;
  };
  Voice.stop = async function () {
    if (!recording || auto) return null;
    recording = false;
    const c = chunks; chunks = [];
    closeMic();
    if (!heardSpeech) return null;
    return toBase64(wav(encode(c), 16000));
  };

  function wav(pcm, rate) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }
  function toBase64(buf) {
    const bytes = new Uint8Array(buf); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ---------- Text to speech (loud & clear) ----------
  let voices = [];
  function loadVoices() { voices = speechSynthesis.getVoices(); }
  loadVoices();
  speechSynthesis.onvoiceschanged = () => { loadVoices(); Voice.onVoices && Voice.onVoices(voices); };
  Voice.voices = () => voices;

  function cleanForSpeech(t) {
    return String(t || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/https?:\/\/\S+/g, ' link ')
      .replace(/[*_#`>|~]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const FEMALE = /zira|heera|kalpana|swara|aria|jenny|hazel|susan|catherine|linda|eva|female|woman|neerja|gul/i;
  const MALE = /david|mark|ravi|hemant|guy|george|james|richard|male|asad|salman/i;
  function pickVoice(text, pref, gender = 'female') {
    if (pref) { const v = voices.find(v => v.name === pref); if (v) return v; }
    const want = gender === 'male' ? MALE : FEMALE;
    const lang = /[\u0900-\u097F]/.test(text) ? /^hi/i : /[\u0600-\u06FF]/.test(text) ? /^(ur|hi)/i : /^en/i;
    const best = voices.find(v => lang.test(v.lang) && want.test(v.name));
    if (best) return best;
    if (/[ऀ-ॿ]/.test(text)) return voices.find(v => /^hi/i.test(v.lang));
    if (/[؀-ۿ]/.test(text)) return voices.find(v => /^ur/i.test(v.lang)) || voices.find(v => /^hi/i.test(v.lang)) || voices.find(v => /^ar/i.test(v.lang));
    return voices.find(v => /en-IN/i.test(v.lang)) || voices.find(v => /en-(US|GB)/i.test(v.lang) && /natural|online/i.test(v.name))
      || voices.find(v => /en-(US|GB)/i.test(v.lang)) || voices[0];
  }

  function speakSynth(text, { voiceName, rate = 1, gender, onStart, onEnd } = {}) {
    const clean = cleanForSpeech(text);
    speechSynthesis.cancel();
    if (!clean) { onEnd && onEnd(); return; }
    // split long text into sentences (Chrome stops long utterances)
    const parts = clean.match(/[^.!?।؟\n]+[.!?।؟]?/g) || [clean];
    const v = pickVoice(clean, voiceName, gender);
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p.trim());
      if (v) { u.voice = v; u.lang = v.lang; }
      u.volume = 1; u.rate = rate; u.pitch = 1;
      if (i === 0) u.onstart = () => onStart && onStart();
      u.onboundary = () => { speakingBoost = 1; };
      if (i === parts.length - 1) { u.onend = () => onEnd && onEnd(); u.onerror = () => onEnd && onEnd(); }
      speechSynthesis.speak(u);
    });
    speakingBoost = 1;
  }

  let playCtx = null, curSrc = null, playing = false, ticket = 0, ttsBad = 0, geminiOffUntil = 0, warned = false;
  function getCtx() {
    playCtx = playCtx || new (window.AudioContext || window.webkitAudioContext)();
    playCtx.resume().catch(() => {});
    return playCtx;
  }
  function b64ToF32(b64) {
    const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; out[i] = v / 32768; }
    return out;
  }
  function b64ToBuf(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function playBuffer(buf, rate = 1) {
    return new Promise(res => {
      const pc = getCtx();
      const src = pc.createBufferSource(); src.buffer = buf;
      // Loud & clear: boost, then a compressor so the boost never cracks/distorts
      const g = pc.createGain(); g.gain.value = 2.6;
      const comp = pc.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.2;
      src.playbackRate.value = rate;
      src.connect(g); g.connect(comp); comp.connect(pc.destination);
      src.onended = () => { if (curSrc === src) curSrc = null; res(); };
      curSrc = src; src.start();
    });
  }
  // Fast speech WITHOUT thin/chipmunk voice: <audio> speeds up but keeps the pitch (preservesPitch)
  function playBlob(blob, rate) {
    return new Promise((res, rej) => {
      const pc = getCtx();
      const a = new Audio();
      const url = URL.createObjectURL(blob);
      a.src = url; a.preservesPitch = true; a.playbackRate = rate;
      let node;
      try {
        node = pc.createMediaElementSource(a);
        const g = pc.createGain(); g.gain.value = 2.6;
        const comp = pc.createDynamicsCompressor();
        comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.2;
        node.connect(g); g.connect(comp); comp.connect(pc.destination);
      } catch (_) { a.volume = 1; }
      let finished = false;
      const finish = () => { if (finished) return; finished = true; try { node && node.disconnect(); } catch (_) {} URL.revokeObjectURL(url); if (curSrc === handle) curSrc = null; res(); };
      const handle = { stop() { try { a.pause(); } catch (_) {} finish(); } };
      a.onended = finish;
      a.onerror = () => { if (finished) return; finished = true; URL.revokeObjectURL(url); if (curSrc === handle) curSrc = null; rej(new Error('audio play error')); };
      curSrc = handle;
      a.play().catch(e => { if (!finished) { finished = true; if (curSrc === handle) curSrc = null; rej(e); } });
    });
  }
  function pcmWavBlob(b64, rate) {
    const u = new Uint8Array(b64ToBuf(b64));
    const pcm = new Int16Array(u.buffer, 0, u.length >> 1);
    return new Blob([wav(pcm, rate)], { type: 'audio/wav' });
  }
  function playPcm(r, rate) { return playBlob(pcmWavBlob(r.pcm, r.rate), rate); }

  // Split text into small pieces (by sentence, then by words) so speech starts fast
  function splitText(clean, max) {
    const parts = (clean.match(/[^.!?۔؟।\n]+[.!?۔؟।]?/g) || [clean]).map(x => x.trim()).filter(Boolean);
    const out = []; let cur = '';
    const push = p => {
      if (p.length > max) { // very long sentence: cut on spaces
        let w = '';
        for (const word of p.split(/\s+/)) { if ((w + ' ' + word).trim().length > max && w) { out.push(w); w = word; } else w = (w + ' ' + word).trim(); }
        if (w) out.push(w);
        return;
      }
      out.push(p);
    };
    if (parts.length > 1) push(parts.shift()); // first sentence alone = quick start
    for (const p of parts) { if ((cur + ' ' + p).length > max && cur) { push(cur); cur = p; } else cur = (cur + ' ' + p).trim(); }
    if (cur) push(cur);
    return out;
  }
  function langOf(t) {
    if (/[ऀ-ॿ]/.test(t)) return 'hi';
    if (/[؀-ۿ]/.test(t)) return 'ur';
    return 'en';
  }

  // Plays pieces one by one; fetches the next piece while the current one plays.
  async function playPieces(pieces, fetchOne, playOne, my, opts, prog = {}) {
    prog.done = 0;
    let next = fetchOne(pieces[0]);
    for (let i = 0; i < pieces.length; i++) {
      const r = await next;
      if (my !== ticket) return false;
      if (!r) throw new Error('khaali awaaz');
      next = i + 1 < pieces.length ? fetchOne(pieces[i + 1]) : null;
      if (next) next.catch(() => {});
      if (i === 0) { opts.onStart && opts.onStart(); speakingBoost = 1; }
      await playOne(r);
      prog.done = i + 1;
      if (my !== ticket) return false;
    }
    return true;
  }

  async function geminiSpeak(pieces, opts, my, prog) {
    const api = window.captain.gemini;
    const rate = Math.min(2, Math.max(1.15, +opts.rate || 1.2));
    return playPieces(pieces, t => api.tts(t), r => { if (!r.pcm) throw new Error('tts'); return playPcm(r, rate); }, my, opts, prog);
  }
  // iPhone: play Google's speech link directly (no app needed in between)
  function playUrl(url, rate) {
    return new Promise((res, rej) => {
      const a = new Audio(); a.preload = 'auto'; a.src = url; a.preservesPitch = true; a.webkitPreservesPitch = true;
      a.playbackRate = rate;
      let finished = false;
      const handle = { stop() { try { a.pause(); } catch (_) {} done(); } };
      const done = () => { if (finished) return; finished = true; if (curSrc === handle) curSrc = null; res(); };
      a.onended = done;
      a.onerror = () => { if (finished) return; finished = true; if (curSrc === handle) curSrc = null; rej(new Error('audio error')); };
      curSrc = handle;
      a.play().catch(e => { if (!finished) { finished = true; if (curSrc === handle) curSrc = null; rej(e); } });
    });
  }
  async function webSpeak(pieces, opts, my) {
    const api = window.captain.gemini;
    const lang = langOf(pieces.join(' '));
    if (!window.Android) {
      const rate = Math.min(2, Math.max(1.3, (+opts.rate || 1.2) + 0.1));
      return playPieces(pieces, async t => `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(t)}`, u => playUrl(u, rate), my, opts);
    }
    return playPieces(pieces,
      t => api.webTts({ text: t, lang }).then(b64 => new Blob([b64ToBuf(b64)], { type: 'audio/mpeg' })),
      blob => playBlob(blob, Math.min(2, Math.max(1.35, (+opts.rate || 1.2) + 0.15))), my, opts);
  }
  function hasVoiceFor(text) {
    const l = langOf(text);
    if (l === 'en') return true;
    return voices.some(v => l === 'hi' ? /^hi/i.test(v.lang) : /^(ur|hi)/i.test(v.lang));
  }

  Voice.speak = async function (text, opts = {}) {
    const clean = cleanForSpeech(text);
    const my = ++ticket;
    speechSynthesis.cancel(); try { curSrc && curSrc.stop(); } catch (_) {}
    if (!clean) { opts.onEnd && opts.onEnd(); return; }
    const api = window.captain && window.captain.gemini;
    if (!api) return speakSynth(clean, opts);
    playing = true;
    const t0 = performance.now();
    const userStart = opts.onStart;
    const logStart = eng => () => { console.info(`[Captain voice] ${eng}: first sound after ${Math.round(performance.now() - t0)} ms`); userStart && userStart(); };
    const done = () => { playing = false; opts.onEnd && opts.onEnd(); };
    const pieces = splitText(clean, 180);
    let rest = pieces, started = false;
    const onStartOnce = eng => () => { if (started) return; started = true; logStart(eng)(); };
    // 1) Google Gemini voice (best quality)
    // HD Google voice only when chosen (it is slower and has a small free daily limit); default = instant voice
    if (api.tts && opts.engine === 'hd' && Date.now() > geminiOffUntil) {
      const prog = {};
      try {
        if (await geminiSpeak(pieces, { ...opts, onStart: onStartOnce('Google voice') }, my, prog)) { ttsBad = 0; done(); }
        return;
      } catch (e) {
        if (my !== ticket) return;
        ttsBad++;
        // quota / busy / retired model: rest Gemini voice for a while, use backup at once
        geminiOffUntil = Date.now() + (ttsBad >= 2 ? 10 * 60000 : 60000);
        console.warn('Gemini TTS failed:', e);
        rest = pieces.slice(prog.done || 0); // continue from where Google stopped, never repeat
        if (!rest.length) { done(); return; }
      }
    }
    // 2) Backup Google voice (always has Urdu)
    if (api.webTts) {
      try {
        if (await webSpeak(rest, { ...opts, onStart: onStartOnce('Backup voice') }, my)) done();
        return;
      } catch (e) {
        if (my !== ticket) return;
        console.warn('Backup TTS failed:', e);
        if (!warned) { warned = true; Voice.onTtsError && Voice.onTtsError(String(e && e.message || e)); }
      }
    }
    // 3) Windows voice (last resort; Windows usually has no Urdu voice)
    playing = false;
    if (!hasVoiceFor(clean) && !warned) { warned = true; Voice.onTtsError && Voice.onTtsError('Internet awaaz nahi mili aur Windows mein Urdu awaaz nahi hai'); }
    speakSynth(rest.join(' '), opts);
  };
  Voice.stopSpeaking = () => { ticket++; speechSynthesis.cancel(); try { curSrc && curSrc.stop(); } catch (_) {} playing = false; };
  Voice.isSpeaking = () => playing || speechSynthesis.speaking;
  Voice.isAudible = () => !!curSrc || speechSynthesis.speaking;
  setInterval(() => { if (speechSynthesis.speaking || playing) speakingBoost = Math.max(speakingBoost, 0.7); }, 120);

  window.Voice = Voice;
})();
