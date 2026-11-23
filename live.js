// Captain LIVE mode: real-time voice conversation with Google Gemini Live (like JARVIS).
// Mic audio streams to Google continuously; Google's voice streams back while it is still thinking.
// You can interrupt it any time just by talking. WhatsApp/Facebook tools still work (run by the app).
(function () {
  const Live = { connected: false };
  const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';
  const MODELS = ['gemini-3.8-live', 'gemini-2.5-flash-native-audio-latest', 'gemini-2.5-flash-native-audio-preview-12-2025'];
  const log = (...a) => console.info('[Live]', ...a);

  let ws = null, cfg = null, cb = {}, wantOn = false, setupDone = false;
  let attempts = [], attemptIdx = 0, workingAttempt = null, resumeHandle = null, reconnectTimer = null;
  let micCtx = null, micStream = null, micSrc = null, micProc = null, noiseFloor = 0.01;
  let playCtx = null, outNode = null, nextTime = 0, sources = [];
  let inText = '', outText = '', turnT0 = 0, firstAudio = false, lastHeardAt = 0, failStreak = 0;

  // ---------------- playback (24 kHz PCM chunks, gap-free) ----------------
  function getPlay() {
    if (!playCtx) {
      playCtx = new (window.AudioContext || window.webkitAudioContext)();
      const g = playCtx.createGain(); g.gain.value = 2.2;
      const comp = playCtx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.2;
      g.connect(comp); comp.connect(playCtx.destination);
      outNode = g;
    }
    playCtx.resume().catch(() => {});
    return playCtx;
  }
  function playChunk(b64, rate = 24000) {
    const pc = getPlay();
    const bin = atob(b64), n = bin.length >> 1, f = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; f[i] = v / 32768; }
    const buf = pc.createBuffer(1, n, rate); buf.copyToChannel(f, 0);
    const s = pc.createBufferSource(); s.buffer = buf; s.connect(outNode);
    const at = Math.max(pc.currentTime + 0.02, nextTime);
    s.start(at); nextTime = at + buf.duration;
    sources.push(s);
    s.onended = () => { sources = sources.filter(x => x !== s); if (!sources.length) cb.onSpeakEnd && cb.onSpeakEnd(); };
    window.Voice && Voice.pulse && Voice.pulse();
  }
  function stopPlayback() {
    for (const s of sources) { try { s.onended = null; s.stop(); } catch (_) {} }
    sources = []; nextTime = 0;
    cb.onSpeakEnd && cb.onSpeakEnd();
  }
  Live.isSpeaking = () => sources.length > 0;
  Live.unlock = () => { try { getPlay(); } catch (_) {} };
  Live.interrupt = stopPlayback;

  // ---------------- microphone -> 16 kHz PCM stream ----------------
  function b64FromI16(i16) {
    const u = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function openMic() {
    if (micStream) return;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    micSrc = micCtx.createMediaStreamSource(micStream);
    micProc = micCtx.createScriptProcessor(2048, 1, 1);
    micProc.onaudioprocess = e => {
      if (!ws || ws.readyState !== 1 || !setupDone) return;
      if (cb.canListen && !cb.canListen()) return;
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const level = Math.sqrt(sum / d.length);
      const ratio = micCtx.sampleRate / 16000, outLen = Math.floor(d.length / ratio), pcm = new Int16Array(outLen);
      // while Captain is talking, only pass clearly louder speech (so its own voice from the speakers doesn't interrupt it)
      const gate = Live.isSpeaking() && level < Math.max(0.06, noiseFloor * 6);
      if (!Live.isSpeaking()) noiseFloor = noiseFloor * 0.98 + Math.min(level, 0.05) * 0.02;
      if (!gate) {
        for (let i = 0; i < outLen; i++) {
          const st = Math.floor(i * ratio), en = Math.min(d.length, Math.floor((i + 1) * ratio));
          let s2 = 0; for (let j = st; j < en; j++) s2 += d[j];
          const v = Math.max(-1, Math.min(1, s2 / Math.max(1, en - st)));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
      }
      try { ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromI16(pcm), mimeType: 'audio/pcm;rate=16000' } } })); } catch (_) {}
    };
    micSrc.connect(micProc); micProc.connect(micCtx.destination);
  }
  function closeMic() {
    try { micProc && micProc.disconnect(); micSrc && micSrc.disconnect(); } catch (_) {}
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (micCtx) micCtx.close().catch(() => {});
    micCtx = micStream = micSrc = micProc = null;
  }

  // ---------------- session ----------------
  function buildSetup(model, full, lang) {
    const setup = {
      model: 'models/' + model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } }
      },
      systemInstruction: { parts: [{ text: cfg.system }] },
      tools: [{ functionDeclarations: cfg.tools }],
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    };
    if (lang) setup.generationConfig.speechConfig.languageCode = 'ur-PK'; // Urdu: better listening + Pakistani accent
    if (full) {
      setup.realtimeInputConfig = { automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 450, prefixPaddingMs: 120 } };
      setup.contextWindowCompression = { slidingWindow: {} };
      setup.sessionResumption = resumeHandle ? { handle: resumeHandle } : {};
    }
    return { setup };
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const at = workingAttempt || attempts[attemptIdx];
    if (!at) { wantOn = false; cb.onFail && cb.onFail('Live se rabta nahi ho saka'); return; }
    setupDone = false;
    const t0 = performance.now();
    const sock = new WebSocket(WS_URL + encodeURIComponent(cfg.key));
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify(buildSetup(at.model, at.full, at.lang)));
    sock.onmessage = async ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch (_) { return; }
      if (sock !== ws) return;
      handle(msg, at, t0);
    };
    sock.onclose = ev => {
      if (sock !== ws) return;
      const was = setupDone;
      setupDone = false; Live.connected = false;
      log(`closed (${ev.code}) ${ev.reason || ''}`);
      if (!wantOn) return;
      if (!was && !workingAttempt) {
        attemptIdx++; // this model/setup didn't work -> try the next one
        if (attemptIdx >= attempts.length) { wantOn = false; cb.onFail && cb.onFail(ev.reason || ('code ' + ev.code)); return; }
        return connect();
      }
      if (!was) { resumeHandle = null; failStreak++; } else failStreak = 0;
      if (failStreak >= 4) { wantOn = false; cb.onFail && cb.onFail(ev.reason || ('code ' + ev.code)); return; }
      cb.onReconnecting && cb.onReconnecting();
      reconnectTimer = setTimeout(connect, 400 * (failStreak + 1));
    };
    sock.onerror = () => {};
  }

  async function handle(msg, at, t0) {
    if (msg.setupComplete) {
      setupDone = true; Live.connected = true; workingAttempt = at; failStreak = 0;
      log(`ready: ${at.model}${at.lang ? ' (Urdu)' : ''}${at.full ? '' : ' (basic)'} in ${Math.round(performance.now() - t0)} ms`);
      cb.onReady && cb.onReady(at.model);
      return;
    }
    if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) resumeHandle = msg.sessionResumptionUpdate.newHandle;
    if (msg.goAway) { log('server asked to reconnect'); try { ws.close(); } catch (_) {} return; }
    if (msg.toolCall && msg.toolCall.functionCalls) {
      const responses = [];
      for (const fc of msg.toolCall.functionCalls) {
        let result;
        try { result = await cb.onTool(fc.name, fc.args || {}); } catch (e) { result = { error: String(e && e.message || e) }; }
        responses.push({ id: fc.id, name: fc.name, response: { result: JSON.parse(JSON.stringify(result ?? null)) } });
      }
      try { ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } })); } catch (_) {}
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) { stopPlayback(); log('interrupted by user'); }
    if (sc.inputTranscription && sc.inputTranscription.text) {
      if (!inText) cb.onUserStart && cb.onUserStart();
      inText += sc.inputTranscription.text; lastHeardAt = performance.now();
      cb.onUserText && cb.onUserText(inText.trim());
    }
    if (sc.modelTurn && sc.modelTurn.parts) {
      for (const p of sc.modelTurn.parts) {
        const d = p.inlineData || p.inline_data;
        if (d && d.data) {
          if (!firstAudio) {
            firstAudio = true;
            const from = turnT0 || lastHeardAt;
            log(from ? `first sound ${Math.round(performance.now() - from)} ms after you stopped` : 'speaking');
            cb.onSpeakStart && cb.onSpeakStart();
          }
          const rm = String(d.mimeType || d.mime_type || '').match(/rate=(\d+)/);
          playChunk(d.data, rm ? +rm[1] : 24000);
        }
      }
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      outText += sc.outputTranscription.text;
      cb.onBotText && cb.onBotText(outText.trim());
    }
    if (sc.turnComplete) {
      cb.onTurnDone && cb.onTurnDone(inText.trim(), outText.trim());
      inText = ''; outText = ''; firstAudio = false; turnT0 = 0;
    }
  }

  // ---------------- public ----------------
  Live.start = async function (callbacks) {
    cb = callbacks || {};
    cfg = await window.captain.live.config();
    if (!cfg || !cfg.key) throw new Error('Google key nahi hai');
    attempts = [];
    for (const m of (cfg.model ? [cfg.model, ...MODELS.filter(x => x !== cfg.model)] : MODELS)) attempts.push({ model: m, full: true, lang: true }, { model: m, full: true }, { model: m, full: false });
    attemptIdx = 0; wantOn = true; failStreak = 0;
    await openMic();
    getPlay();
    connect();
  };
  Live.stop = function () {
    wantOn = false; clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch (_) {}
    ws = null; Live.connected = false; setupDone = false;
    stopPlayback(); closeMic();
    inText = outText = ''; firstAudio = false;
  };
  // new voice / settings: start a fresh session (keeps the mic open)
  Live.refresh = async function () {
    if (!wantOn) return;
    for (let i = 0; i < 60 && Live.isSpeaking(); i++) await new Promise(r => setTimeout(r, 250)); // let it finish the sentence
    try { cfg = await window.captain.live.config(); } catch (_) {}
    resumeHandle = null;
    try { ws && ws.close(); } catch (_) {}
  };
  Live.sendText = function (text) {
    if (!ws || ws.readyState !== 1 || !setupDone) return false;
    stopPlayback();
    turnT0 = performance.now(); firstAudio = false;
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
    return true;
  };

  window.Live = Live;
})();
