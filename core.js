// Captain AI Agent - mobile brain: settings, Google Gemini, WhatsApp, Facebook and all tools.
(function () {
  'use strict';
  const N = window.Android || null; // native bridge (Android app). null when opened in a normal browser.
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ================= settings =================
  const DEFAULTS = {
    geminiKey: '', geminiModel: 'gemini-flash-lite-latest', noFastModels: ['gemini-flash-lite-latest'],
    voiceGender: 'female', voiceRate: 1.2, speakReplies: true, liveMode: true, handsFree: false,
    readIncoming: true, autoReply: false, autoReplyPrompt: '', autoSend: true,
    fbPageId: '', fbToken: '', lastSeenWa: 0
  };
  const Store = {
    all() {
      try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('captain_settings') || '{}') }; }
      catch (_) { return { ...DEFAULTS }; }
    },
    get(k) { return this.all()[k]; },
    set(o) {
      const v = { ...this.all(), ...o };
      try { localStorage.setItem('captain_settings', JSON.stringify(v)); } catch (_) {}
      if (N && N.syncPrefs) { try { N.syncPrefs(JSON.stringify({ autoReply: v.autoReply, autoReplyPrompt: v.autoReplyPrompt, geminiKey: v.geminiKey })); } catch (_) {} }
      return v;
    }
  };

  // ================= native async helper =================
  let seq = 0; const cbs = {};
  window.__nativeCb = (id, v) => { const f = cbs[id]; delete cbs[id]; if (f) f(v); };
  function nativeAsync(fn, ...args) {
    return new Promise((res, rej) => {
      if (!N || !N[fn]) return rej(new Error('Yeh kaam sirf Android app mein chalta hai.'));
      const id = 'c' + (++seq) + '_' + Date.now();
      cbs[id] = res;
      try { N[fn](...args, id); } catch (e) { delete cbs[id]; rej(e); }
    });
  }
  function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function bytesToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  const utf8 = { enc: s => new TextEncoder().encode(s), dec: u => new TextDecoder().decode(u) };

  async function nativeHttp(method, url, contentType, bodyStr) {
    const r = await nativeAsync('http', method, url, contentType || '', bodyStr ? bytesToB64(utf8.enc(bodyStr)) : '');
    if (String(r).startsWith('ERR:')) { const e = new Error(String(r).slice(4)); const m = e.message.match(/^HTTP (\d+): ([\s\S]*)$/); if (m) { e.status = +m[1]; e.body = m[2]; } throw e; }
    return b64ToBytes(r);
  }

  // ================= Google Gemini =================
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  function key() {
    const k = Store.get('geminiKey');
    if (!k) { const e = new Error('Google key abhi lagi nahi. Settings mein apni free Google key daalein.'); e.code = 'NO_KEY'; throw e; }
    return k;
  }
  async function postJson(url, k, body, signal) {
    const payload = JSON.stringify(body);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k }, body: payload, signal });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ok: res.ok, data };
    } catch (e) {
      if (e.name === 'AbortError' || !N) throw e;
      // browser blocked the request (network/CORS): send it from the phone's native side instead
      try {
        const out = await nativeHttp('POST', url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(k), 'application/json', payload);
        return { status: 200, ok: true, data: JSON.parse(utf8.dec(out)) };
      } catch (e2) {
        let data = {}; try { data = JSON.parse(e2.body || '{}'); } catch (_) {}
        return { status: e2.status || 0, ok: false, data: Object.keys(data).length ? data : { error: { message: e2.message } } };
      }
    }
  }
  async function callOnce(m, k, body, signal) {
    const url = `${BASE}/${encodeURIComponent(m)}:generateContent`;
    let r = await postJson(url, k, body, signal);
    if (!r.ok && [400, 401, 403].includes(r.status)) {
      const r2 = await postJson(`${url}?key=${encodeURIComponent(k)}`, k, body, signal);
      if (r2.ok) r = r2;
    }
    if (!r.ok) {
      const msg = r.data?.error?.message || `HTTP ${r.status}`;
      const e = new Error('Google AI error: ' + msg); e.status = r.status; e.rawMessage = msg; throw e;
    }
    return r.data;
  }
  const isTemporary = e => [429, 500, 502, 503, 504].includes(e.status) || /high demand|overloaded|unavailable|try again later|resource_exhausted|rate limit|quota/i.test(e.rawMessage || '');
  const isModelProblem = e => e.status === 404 || /no longer available|not found|is not supported|deprecated|retired|update your code to use/i.test(e.rawMessage || '');
  function fastBody(body, m) {
    const gc = { ...(body.generationConfig || {}) };
    if (/gemini-3/i.test(m)) gc.thinkingConfig = { thinkingLevel: 'low' };
    else if (/2\.5-flash|flash-latest|flash-lite-latest/i.test(m)) gc.thinkingConfig = { thinkingBudget: 0 };
    else return body;
    return { ...body, generationConfig: gc };
  }
  async function call(body, { model, apiKey, timeoutMs = 60000, fast = false } = {}) {
    const preferred = model || Store.get('geminiModel') || FALLBACK_MODELS[0];
    const k = apiKey || key();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const queue = [preferred, ...FALLBACK_MODELS.filter(x => x !== preferred)];
    const tried = new Set();
    let lastErr, sawTemp = false;
    try {
      while (queue.length) {
        const m = queue.shift();
        if (tried.has(m)) continue;
        tried.add(m);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            let data;
            const nf = new Set(Store.get('noFastModels') || []);
            if (fast && !nf.has(m)) {
              try { data = await callOnce(m, k, fastBody(body, m), ctrl.signal); }
              catch (e) {
                if (e.status === 400) { nf.add(m); Store.set({ noFastModels: [...nf] }); data = await callOnce(m, k, body, ctrl.signal); }
                else throw e;
              }
            } else data = await callOnce(m, k, body, ctrl.signal);
            if (!apiKey && !model && m !== Store.get('geminiModel')) Store.set({ geminiModel: m });
            return data;
          } catch (e) {
            lastErr = e;
            if (e.name === 'AbortError') throw e;
            if (isTemporary(e)) { sawTemp = true; if (attempt === 0) { await sleep(1200); continue; } break; }
            if (!isModelProblem(e)) throw e;
            break;
          }
        }
        const sg = (lastErr && lastErr.rawMessage || '').match(/use\s+models\/([\w.\-]+)/i);
        if (sg && !tried.has(sg[1])) queue.unshift(sg[1]);
      }
      if (sawTemp) throw new Error('Google AI abhi bohot busy hai. Thori der baad dobara try karein.');
      throw lastErr;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Google AI ne waqt par jawab nahi diya. Internet check karein.');
      throw e;
    } finally { clearTimeout(t); }
  }
  const textOf = d => ((d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).filter(p => p.text).map(p => p.text).join('').trim();
  async function testKey(k) { return textOf(await call({ contents: [{ role: 'user', parts: [{ text: 'Reply with just: OK' }] }] }, { apiKey: k, timeoutMs: 45000 })); }

  // HD voice (Gemini TTS) and backup voice (Google Translate speech, fetched natively = no CORS)
  const TTS_MODELS = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'];
  const ttsDead = new Set(); let ttsWorking = null;
  async function tts(text) {
    const k = key(), male = Store.get('voiceGender') === 'male';
    const body = {
      contents: [{ role: 'user', parts: [{ text: `Say this quickly and clearly in ${male ? 'an energetic young man' : 'a bright, confident young woman'}'s voice: ` + String(text).slice(0, 900) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: male ? 'Puck' : 'Zephyr' } } } }
    };
    const list = (ttsWorking ? [ttsWorking, ...TTS_MODELS.filter(m => m !== ttsWorking)] : TTS_MODELS).filter(m => !ttsDead.has(m));
    let last;
    for (const m of list) {
      try {
        const d = await callOnce(m, k, body);
        const part = ((d.candidates && d.candidates[0].content && d.candidates[0].content.parts) || []).find(x => x.inlineData || x.inline_data);
        const id = part && (part.inlineData || part.inline_data);
        if (id && id.data) { ttsWorking = m; const rm = String(id.mimeType || '').match(/rate=(\d+)/); return { pcm: id.data, rate: rm ? +rm[1] : 24000 }; }
      } catch (e) { last = e; if (isModelProblem(e) || (e.status === 429 && /per day|limit: 0/i.test(e.rawMessage || ''))) ttsDead.add(m); }
    }
    throw last || new Error('TTS fail');
  }
  async function webTts({ text, lang }) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang || 'ur')}&q=${encodeURIComponent(String(text || '').slice(0, 200))}`;
    const bytes = await nativeHttp('GET', url);
    if (bytes.length < 200) throw new Error('Backup awaaz khaali');
    return bytesToB64(bytes);
  }

  // ================= WhatsApp (Android) =================
  function info() { try { return JSON.parse(N.info()); } catch (_) { return {}; } }
  function needAndroid() { if (!N) throw new Error('یہ کام iPhone پر Apple کی پابندی کی وجہ سے ممکن نہیں، صرف Android ایپ میں ہوتا ہے۔'); }
  function openWa(phone, text) {
    let d = String(phone).replace(/[^0-9]/g, ''); if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0') && d.length === 11) d = '92' + d.slice(1);
    window.location.href = `https://wa.me/${d}?text=${encodeURIComponent(text || '')}`;
  }
  const isPhone = s => String(s || '').replace(/[^0-9]/g, '').length >= 7;

  async function resolveTarget(to) {
    needAndroid();
    to = String(to || '').trim();
    if (!to) throw new Error('Kis ko bhejna hai? Naam ya number batayein.');
    if (isPhone(to)) return { phone: to, name: to };
    if (N.canReply(to)) return { chat: to, name: to };
    const inf = info();
    if (!inf.contacts) {
      const ok = await nativeAsync('requestPerm', 'contacts');
      if (ok !== '1') throw new Error('Contacts ki ijazat nahi mili. Naam ki jagah number batayein, ya Settings mein Contacts ki ijazat dein.');
    }
    const list = JSON.parse(N.findContacts(to) || '[]');
    if (!list.length) throw new Error(`"${to}" naam ka contact phone mein nahi mila. Number bata dein.`);
    const exact = list.find(c => c.name.toLowerCase() === to.toLowerCase()) || list[0];
    return { phone: exact.phone, name: exact.name, others: list.length > 1 ? list.map(c => c.name) : undefined };
  }

  const WA = {
    async sendMessage({ to, message }) {
      if (!message) throw new Error('Message mein kya likhna hai?');
      if (!N) { // iPhone: open the chat with the message ready; the user taps Send
        if (!isPhone(to)) throw new Error('iPhone پر کیپٹن contacts نہیں دیکھ سکتا۔ نمبر بتائیں، مثلاً 0300 1234567');
        setTimeout(() => openWa(to, message), 1500);
        return { ok: true, text: 'WhatsApp کھل رہا ہے، میسج تیار ہے۔ بس Send دبائیں۔' };
      }
      // 1) chat that messaged recently: reply right from the notification (no need to open WhatsApp)
      if (!isPhone(to) && N.canReply(to) && N.replyChat(to, message)) return { ok: true, text: `${to} ko WhatsApp par bhej diya.` };
      const t = await resolveTarget(to);
      if (t.chat && N.replyChat(t.chat, message)) return { ok: true, text: `${t.name} ko bhej diya.` };
      const auto = Store.get('autoSend') && info().autoSend;
      const r = N.openChat(t.phone, message, !!auto);
      if (r !== 'ok') throw new Error(r || 'WhatsApp nahi khul saka.');
      return { ok: true, to: t.name, text: auto ? `${t.name} ko WhatsApp par bhej diya.` : `WhatsApp mein ${t.name} ka message tayyar hai, bas Send dabayein. (Khud bhejne ke liye Settings mein "Auto Send" on karein.)` };
    },
    readMessages({ chat, limit = 10 } = {}) {
      needAndroid();
      const inf = info();
      if (!inf.notifAccess) throw new Error('WhatsApp messages parhne ke liye "Notification access" chahiye. WhatsApp screen par "Messages parhne ki ijazat" dabayein.');
      let all = JSON.parse(N.waMessages() || '[]');
      if (chat) { const c = chat.toLowerCase(); all = all.filter(m => (m.chat || '').toLowerCase().includes(c) || (m.from || '').toLowerCase().includes(c)); }
      else { const seen = Store.get('lastSeenWa') || 0; const un = all.filter(m => m.time > seen && !m.auto); all = un.length ? un : all; }
      const out = all.slice(-Math.max(1, limit)).map(m => ({ chat: m.chat, from: m.from, text: m.text, time: new Date(m.time).toLocaleString() }));
      if (!chat) Store.set({ lastSeenWa: Date.now() });
      return { ok: true, count: out.length, messages: out, note: out.length ? undefined : 'Jab se ijazat di hai tab se koi naya message nahi aaya.' };
    },
    listChats({ limit = 10, unreadOnly } = {}) {
      needAndroid();
      if (!info().notifAccess) throw new Error('Chats dekhne ke liye "Notification access" chahiye. WhatsApp screen par ijazat dein.');
      const all = JSON.parse(N.waMessages() || '[]'), seen = Store.get('lastSeenWa') || 0, map = {};
      for (const m of all) {
        const c = map[m.chat] || (map[m.chat] = { chat: m.chat, group: !!m.group, last: '', time: 0, unread: 0 });
        c.last = m.text; c.time = m.time; if (m.time > seen && !m.auto) c.unread++;
      }
      let list = Object.values(map).sort((a, b) => b.time - a.time);
      if (unreadOnly) list = list.filter(c => c.unread);
      return { ok: true, chats: list.slice(0, limit).map(c => ({ ...c, time: new Date(c.time).toLocaleString() })) };
    },
    async sendFile({ to, file, caption }) {
      const t = await resolveTarget(to);
      if (!t.phone) throw new Error(`${t.name} ka number nahi mila. Number bata dein.`);
      const auto = Store.get('autoSend') && info().autoSend;
      const r = N.shareFile(t.phone, file.uri, file.mime, caption || '', !!auto, false);
      if (r !== 'ok') throw new Error(r);
      return { ok: true, text: auto ? `${t.name} ko file bhej di.` : `WhatsApp mein file tayyar hai, Send dabayein.` };
    },
    async sendUrl({ to, url, caption }) {
      return WA.sendMessage({ to, message: (caption ? caption + '\n' : '') + url });
    },
    downloadMedia({ count = 1 } = {}) {
      needAndroid();
      const r = JSON.parse(N.copyWhatsAppMedia(Math.max(1, count | 0)) || '{}');
      if (r.error === 'allFiles') { N.openSettings('allFiles'); throw new Error('WhatsApp ki files copy karne ke liye "All files access" chahiye. Settings khul gayi hai, Captain ko allow kar ke dobara kahein.'); }
      if (r.error) throw new Error(r.error);
      return { ok: true, saved: r.files, text: `${(r.files || []).length} file(s) Download/Captain mein save ho gayin.` };
    },
    postStatus({ text, file }) {
      needAndroid();
      const r = N.shareFile('', file ? file.uri : '', file ? file.mime : 'text/plain', text || '', false, true);
      if (r !== 'ok') throw new Error(r);
      return { ok: true, text: 'WhatsApp khul gaya hai: "My status" chun kar Send dabayein.' };
    },
    async schedule({ to, message, at }) {
      needAndroid();
      const when = new Date(at).getTime();
      if (!when || isNaN(when)) throw new Error('Waqt samajh nahi aaya.');
      if (when < Date.now() - 60000) throw new Error('Yeh waqt guzar chuka hai.');
      let phone = '', chat = to;
      if (isPhone(to)) phone = to;
      else { try { const t = await resolveTarget(to); phone = t.phone || ''; chat = t.name || to; } catch (_) { if (!N.canReply(to)) throw new Error(`"${to}" ka number nahi mila.`); } }
      const id = 'sch_' + Date.now();
      const r = N.schedule(id, when, phone, chat, message);
      if (r !== 'ok') throw new Error(r);
      const inf = info();
      return { ok: true, id, when: new Date(when).toLocaleString(), text: `${new Date(when).toLocaleString()} par ${chat} ko message chala jayega.` + (inf.autoSend ? '' : ' (Auto Send off hai: waqt par notification aayegi, tap kar ke bhej dein.)') };
    },
    setAbout() {
      return { ok: false, text: 'Mobile par WhatsApp ka "About" sirf WhatsApp khud badal sakta hai: WhatsApp > Settings > apna naam > About.' };
    }
  };

  // ================= Facebook window (logged-in facebook.com, like on the computer) =================
  const FB_HOME = 'https://www.facebook.com/';
  const FB_SECTIONS = {
    home: FB_HOME, notifications: FB_HOME + 'notifications', messages: FB_HOME + 'messages/t/', watch: FB_HOME + 'watch/',
    profile: FB_HOME + 'me/', friends: FB_HOME + 'friends/requests', pages: FB_HOME + 'pages/?category=your_pages', marketplace: FB_HOME + 'marketplace/'
  };
  async function fjs(code) {
    needAndroid();
    const r = JSON.parse(await nativeAsync('fbEval', code) || '{}');
    if (!r.ok) throw new Error(r.e || 'Facebook page error');
    return r.v;
  }
  async function fbWaitLoad(timeout = 20000) {
    const end = Date.now() + timeout;
    await sleep(300);
    while (Date.now() < end && N.fbProgress() < 100) await sleep(250);
  }
  async function fbWaitFor(expr, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await fjs(`!!(${expr})`)) return true; } catch (_) {} await sleep(400); }
    return false;
  }
  async function fbGoto(url) {
    if ((N.fbUrl() || '').replace(/\/$/, '') !== url.replace(/\/$/, '')) { N.fbLoad(url); await fbWaitLoad(); }
    await sleep(1200);
  }
  async function fbLoggedIn() {
    await fbWaitLoad();
    return fjs(`!document.querySelector('input[name="email"]') && !document.querySelector('form[action*="login"]') && !!document.querySelector('[role="navigation"], [role="banner"]')`);
  }
  async function fbRequireLogin() {
    if (!(await fbLoggedIn())) {
      await fbGoto(FB_HOME);
      if (!(await fbLoggedIn())) {
        N.fbShow(true);
        throw new Error('Facebook khul gaya hai. Ek dafa apna Facebook login kar lein (yeh phone mein yaad rahega), phir mujhe dobara kahein.');
      }
    }
  }
  const fbText = (max = 5000) => fjs(`((document.querySelector('[role="main"]') || document.body).innerText || '').replace(/\\n{3,}/g, '\\n\\n')`).then(t => String(t || '').slice(0, max));
  const COMPOSER_BTN = `(() => { const re = /what's on your mind|whats on your mind|create post|create a post|आपके मन में|آپ کے ذہن میں|kya soch/i;
    const els = [...document.querySelectorAll('[role="main"] [role="button"], [role="main"] [aria-label]')];
    return els.find(e => re.test(e.getAttribute('aria-label') || '') || re.test((e.innerText || '').trim().slice(0, 60))); })()`;
  const POST_BTN = `(() => { const d = document.querySelector('[role="dialog"]'); if (!d) return null;
    const bs = [...d.querySelectorAll('[role="button"], [aria-label]')];
    return bs.find(b => /^(post|next|share|پوسٹ|पोस्ट)$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()) && b.getAttribute('aria-disabled') !== 'true'); })()`;

  async function fbAttach(file) {
    // put the file straight into Facebook's file box (works without any tapping)
    const b64 = await nativeAsync('readFile', file.uri);
    if (String(b64).startsWith('ERR:')) throw new Error(b64.slice(4));
    if (b64.length > 34 * 1024 * 1024) { N.fbSetNextFile(file.uri); N.fbShow(true); throw new Error('File bohot bari hai. Facebook window khul gayi hai: Photo/video daba kar khud chun lein, phir Post karein.'); }
    await fjs(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('[aria-label]')].find(e => /photo\\/video|photo|تصویر|फ़ोटो/i.test(e.getAttribute('aria-label'))); if (b && !d.querySelector('input[type="file"]')) b.click(); return true; })()`);
    await sleep(1200);
    const ok = await fjs(`(() => { const d = document.querySelector('[role="dialog"]') || document; const ins = d.querySelectorAll('input[type="file"]'); const inp = ins[ins.length - 1] || document.querySelector('input[type="file"]'); if (!inp) return false;
      const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const f = new File([u], ${JSON.stringify(file.name || 'upload')}, { type: ${JSON.stringify(file.mime || 'application/octet-stream')} });
      const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error('Photo/video lagane ki jagah nahi mili.');
    await sleep(3000);
  }

  const FBW = {
    async open({ section = 'home' } = {}) { if (!N) { window.open(FB_SECTIONS[section] || FB_HOME, '_blank'); return { ok: true, text: 'Facebook کھول دیا۔' }; } await fbGoto(FB_SECTIONS[section] || FB_HOME); N.fbShow(true); return { ok: true, text: `Facebook ${section} khol diya.` }; },
    async search({ query, type = 'top' }) {
      if (!query) throw new Error('Kya search karna hai?');
      const t = ['top', 'videos', 'people', 'pages', 'posts', 'groups'].includes(type) ? type : 'top';
      await fbRequireLogin();
      await fbGoto(`${FB_HOME}search/${t}/?q=${encodeURIComponent(query)}`);
      await fbWaitFor(`document.querySelector('[role="main"]')`, 10000); await sleep(1500);
      return { ok: true, results: await fbText(3000) };
    },
    async readNotifications() {
      await fbRequireLogin(); await fbGoto(FB_SECTIONS.notifications);
      await fbWaitFor(`document.querySelector('[role="main"]')`, 10000); await sleep(1500);
      return { ok: true, notifications: await fbText(3500) };
    },
    async readMessages() {
      await fbRequireLogin(); await fbGoto(FB_SECTIONS.messages);
      await fbWaitFor(`document.querySelector('[role="navigation"] a[href*="/messages/t/"], [aria-label="Chats"]')`, 12000); await sleep(1500);
      const t = await fjs(`((document.querySelector('[aria-label="Chats"]') || document.querySelector('[role="navigation"]') || document.body).innerText || '')`);
      return { ok: true, chats: String(t || '').slice(0, 3500) };
    },
    async readScreen() { await fbWaitLoad(); return { ok: true, url: N.fbUrl(), text: await fbText(5000) }; },
    async post({ text, file }) {
      if (!text && !file) throw new Error('Post mein kya likhna hai?');
      await fbRequireLogin(); await fbGoto(FB_HOME);
      if (!(await fbWaitFor(COMPOSER_BTN, 12000))) throw new Error('Facebook par "What\'s on your mind" box nahi mila.');
      await fjs(`(${COMPOSER_BTN}).click()`);
      const EDITOR = `document.querySelector('[role="dialog"] [contenteditable="true"][role="textbox"], [role="dialog"] [contenteditable="true"]')`;
      if (!(await fbWaitFor(EDITOR, 10000))) throw new Error('Post likhne ka box nahi khula.');
      await fjs(`(${EDITOR}).focus()`); await sleep(300);
      if (text) { N.fbInsertText(text); await sleep(500); }
      if (file) await fbAttach(file);
      await sleep(800);
      if (!(await fbWaitFor(POST_BTN, 30000))) { N.fbShow(true); throw new Error('"Post" ka button nahi mila. Facebook window mein khud Post daba dein.'); }
      await fjs(`(${POST_BTN}).click()`); await sleep(1500);
      if (await fjs(`!!(${POST_BTN})`)) { await fjs(`(${POST_BTN}).click()`); await sleep(1500); }
      return { ok: true, text: 'Facebook par post kar di.' };
    },
    async likeFirst() {
      await fbRequireLogin();
      const ok = await fjs(`(() => { const b = [...document.querySelectorAll('[role="main"] [aria-label="Like"][role="button"], [role="main"] [aria-label="پسند"][role="button"], [role="main"] [aria-label="पसंद करें"][role="button"]')].find(x => x.getAttribute('aria-pressed') !== 'true' && x.offsetParent);
        if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
      if (!ok) throw new Error('Is page par like karne ke liye koi post nahi mili. Pehle feed ya koi post kholein.');
      return { ok: true, text: 'Like kar diya.' };
    },
    async commentFirst({ text }) {
      if (!text) throw new Error('Comment mein kya likhna hai?');
      await fbRequireLogin();
      const ok = await fjs(`(() => { const b = [...document.querySelectorAll('[role="main"] [aria-label="Leave a comment"], [role="main"] [aria-label="Comment"]')].find(x => x.offsetParent);
        if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
      if (!ok) throw new Error('Comment karne ke liye koi post nahi mili.');
      const BOX = `[...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(e => /comment|reply|تبصرہ|टिप्पणी/i.test(e.getAttribute('aria-label') || '') && e.offsetParent)`;
      if (!(await fbWaitFor(BOX, 8000))) throw new Error('Comment box nahi khula.');
      await fjs(`(${BOX}).focus()`); await sleep(200);
      N.fbInsertText(text); await sleep(400);
      N.fbEnter(); await sleep(1200);
      return { ok: true, text: 'Comment kar diya.' };
    },
    async playFirstVideo() {
      await fbRequireLogin();
      const ok = await fjs(`(() => { const v = document.querySelector('video'); if (!v) return false; v.scrollIntoView({ block: 'center' }); v.muted = false; v.play(); return true; })()`);
      if (!ok) { await fbGoto(FB_SECTIONS.watch); await fbWaitFor(`document.querySelector('video')`, 12000); await fjs(`(() => { const v = document.querySelector('video'); v && (v.muted = false, v.play()); return true; })()`); }
      N.fbShow(true);
      return { ok: true, text: 'Video chala di.' };
    }
  };

  // ================= Facebook Page API (advanced) =================
  const GV = 'v21.0', GRAPH = `https://graph.facebook.com/${GV}`, GRAPH_VIDEO = `https://graph-video.facebook.com/${GV}`;
  function fbCreds() {
    const pageId = Store.get('fbPageId'), token = Store.get('fbToken');
    if (!pageId || !token) throw new Error('Facebook Page connect nahi hai. Settings > Facebook Page mein Page ID aur Page Access Token daalein.');
    return { pageId, token };
  }
  async function graph(method, path, params = {}, { base = GRAPH, form, token } = {}) {
    const tk = token || fbCreds().token;
    const url = new URL(`${base}/${path.replace(/^\//, '')}`);
    let body;
    if (method === 'GET' || method === 'DELETE') {
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      url.searchParams.set('access_token', tk);
    } else if (form) { form.append('access_token', tk); body = form; }
    else { const p = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v)); p.set('access_token', tk); body = p; }
    const res = await fetch(url, { method, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error('Facebook: ' + ((data.error && data.error.message) || `HTTP ${res.status}`));
    return data;
  }
  async function fileBlob(file) {
    if (file.blob) return file.blob;
    const b64 = await nativeAsync('readFile', file.uri);
    if (String(b64).startsWith('ERR:')) throw new Error(b64.slice(4));
    return new Blob([b64ToBytes(b64)], { type: file.mime || 'application/octet-stream' });
  }
  const FBP = {
    verify: (pageId, token) => graph('GET', pageId, { fields: 'id,name,fan_count,followers_count,link' }, { token }),
    async createPost({ message, link }) { const { pageId } = fbCreds(); const d = await graph('POST', `${pageId}/feed`, { message, link }); return { ok: true, id: d.id, text: 'Page par post ho gayi.' }; },
    async postPhoto({ file, caption }) { const { pageId } = fbCreds(); const f = new FormData(); f.append('source', await fileBlob(file), file.name || 'photo.jpg'); if (caption) f.append('caption', caption); const d = await graph('POST', `${pageId}/photos`, {}, { form: f }); return { ok: true, id: d.post_id || d.id, text: 'Photo Page par lag gayi.' }; },
    async postVideo({ file, description, title }) { const { pageId } = fbCreds(); const f = new FormData(); f.append('source', await fileBlob(file), file.name || 'video.mp4'); if (description) f.append('description', description); if (title) f.append('title', title); const d = await graph('POST', `${pageId}/videos`, {}, { form: f, base: GRAPH_VIDEO }); return { ok: true, id: d.id, text: 'Video upload ho gayi.' }; },
    async listPosts({ limit = 5 } = {}) { const { pageId } = fbCreds(); const d = await graph('GET', `${pageId}/posts`, { fields: 'id,message,created_time,permalink_url,likes.summary(true).limit(0),comments.summary(true).limit(0)', limit }); return { ok: true, posts: (d.data || []).map(p => ({ id: p.id, message: (p.message || '').slice(0, 200), time: p.created_time, likes: p.likes && p.likes.summary && p.likes.summary.total_count, comments: p.comments && p.comments.summary && p.comments.summary.total_count, link: p.permalink_url })) }; },
    async latestPostId() { const { pageId } = fbCreds(); const d = await graph('GET', `${pageId}/posts`, { fields: 'id', limit: 1 }); if (!d.data || !d.data[0]) throw new Error('Page par koi post nahi mili.'); return d.data[0].id; },
    async listComments({ postId, limit = 10 } = {}) { const id = postId || await FBP.latestPostId(); const d = await graph('GET', `${id}/comments`, { fields: 'id,from,message,created_time,like_count', limit, order: 'reverse_chronological' }); return { ok: true, post_id: id, comments: (d.data || []).map(c => ({ id: c.id, from: c.from && c.from.name, message: c.message, time: c.created_time, likes: c.like_count })) }; },
    async comment({ objectId, message }) { const id = objectId || await FBP.latestPostId(); const d = await graph('POST', `${id}/comments`, { message }); return { ok: true, id: d.id, text: 'Comment kar diya.' }; },
    async like({ objectId }) { const id = objectId || await FBP.latestPostId(); await graph('POST', `${id}/likes`, {}); return { ok: true, text: 'Like kar diya.' }; },
    async deletePost({ postId }) { await graph('DELETE', postId); return { ok: true, text: 'Post delete ho gayi.' }; },
    async activity({ limit = 10 } = {}) {
      const { pageId } = fbCreds(); const out = {};
      try { out.page = await graph('GET', pageId, { fields: 'name,fan_count,followers_count' }); } catch (_) {}
      try { const p = await graph('GET', `${pageId}/posts`, { fields: 'id,message,comments.limit(5).order(reverse_chronological){from,message,created_time}', limit: 3 });
        out.recent_comments = (p.data || []).flatMap(x => ((x.comments && x.comments.data) || []).map(c => ({ post: (x.message || '').slice(0, 60), from: c.from && c.from.name, message: c.message, time: c.created_time }))).slice(0, limit); } catch (e) { out.comments_error = e.message; }
      try { const conv = await graph('GET', `${pageId}/conversations`, { fields: 'id,updated_time,snippet,unread_count,participants', limit });
        out.inbox = (conv.data || []).map(c => ({ conversation_id: c.id, snippet: c.snippet, unread: c.unread_count, time: c.updated_time, with: ((c.participants && c.participants.data) || []).map(p => p.name).filter(n => n !== (out.page && out.page.name)).join(', ') })); } catch (e) { out.inbox_error = e.message; }
      return { ok: true, ...out };
    },
    async pageReplyMessage({ conversationId, message }) {
      const { pageId } = fbCreds(); const conv = await graph('GET', conversationId, { fields: 'participants' });
      const user = ((conv.participants && conv.participants.data) || []).find(p => p.id !== pageId);
      if (!user) throw new Error('Is conversation mein user nahi mila.');
      await graph('POST', `${pageId}/messages`, { recipient: JSON.stringify({ id: user.id }), message: JSON.stringify({ text: message }), messaging_type: 'RESPONSE' });
      return { ok: true, text: 'Jawab bhej diya.' };
    },
    async listVideos({ limit = 5 } = {}) { const { pageId } = fbCreds(); const d = await graph('GET', `${pageId}/videos`, { fields: 'id,title,description,created_time,permalink_url,length', limit }); return { ok: true, videos: d.data || [] }; },
    async downloadVideo({ videoId }) {
      let id = videoId;
      if (!id) { const { pageId } = fbCreds(); const v = await graph('GET', `${pageId}/videos`, { fields: 'id', limit: 1 }); if (!v.data || !v.data[0]) throw new Error('Page par koi video nahi.'); id = v.data[0].id; }
      const d = await graph('GET', id, { fields: 'source,title' });
      if (!d.source) throw new Error('Is video ka download link nahi mila.');
      const f = N.download(d.source, (d.title || 'facebook-video-' + id).replace(/[^\w\- ]/g, '_') + '.mp4');
      if (String(f).startsWith('ERR:')) throw new Error(f.slice(4));
      return { ok: true, file: f, text: 'Video download ho rahi hai: ' + f };
    }
  };

  // ================= Captain agent (tools) =================
  const S = (props, required = []) => ({ type: 'OBJECT', properties: props, required });
  const str = d => ({ type: 'STRING', description: d });
  const num = d => ({ type: 'INTEGER', description: d });
  const bool = d => ({ type: 'BOOLEAN', description: d });
  const TOOLS = [
    { name: 'whatsapp_send_message', description: 'Send a WhatsApp text message to a contact name (from the phone contacts), a chat that recently messaged, or a phone number.', parameters: S({ to: str('Contact name, chat name or phone number'), message: str('Message text') }, ['to', 'message']) },
    { name: 'whatsapp_read_messages', description: 'Read WhatsApp messages received on this phone. Without "chat": new (unread) messages. With "chat": recent messages of that chat.', parameters: S({ chat: str('Optional contact/group name'), limit: num('How many (default 10)') }) },
    { name: 'whatsapp_list_chats', description: 'List recent WhatsApp chats with new-message counts.', parameters: S({ limit: num('Number of chats'), unread_only: bool('Only chats with new messages') }) },
    { name: 'whatsapp_send_file', description: 'Send a picture, video, document or any file on WhatsApp. The user picks the file on the phone.', parameters: S({ to: str('Contact name or number'), caption: str('Optional caption') }, ['to']) },
    { name: 'whatsapp_send_from_url', description: 'Send an internet link (photo/video/file link) on WhatsApp.', parameters: S({ to: str('Contact name or number'), url: str('http(s) link'), caption: str('Optional caption') }, ['to', 'url']) },
    { name: 'whatsapp_download_media', description: 'Save the latest received WhatsApp photos/videos/files to the phone Download/Captain folder.', parameters: S({ chat: str('Optional chat name'), count: num('How many latest files (default 1)') }) },
    { name: 'whatsapp_post_status', description: 'Post a WhatsApp Status. Text only, or a photo/video the user picks (with_media true).', parameters: S({ text: str('Status text or caption'), with_media: bool('True to choose a photo/video') }) },
    { name: 'whatsapp_schedule_message', description: 'Schedule a WhatsApp message for later (events, birthdays, reminders). Works even if Captain is closed.', parameters: S({ to: str('Contact name, chat name or number'), message: str('Message text'), send_at_iso: str('Local date-time in ISO 8601, e.g. 2026-11-19T09:00:00') }, ['to', 'message', 'send_at_iso']) },
    { name: 'whatsapp_set_about', description: 'Change the WhatsApp profile "About" text.', parameters: S({ text: str('New about text') }, ['text']) },
    { name: 'fb_open', description: 'Open Facebook (the user\'s logged-in account) inside Captain at a section.', parameters: S({ section: { type: 'STRING', enum: Object.keys(FB_SECTIONS), description: 'Section' } }, ['section']) },
    { name: 'fb_post', description: 'Create a post on the user\'s own Facebook. Optional photo/video picked by the user (with_media true).', parameters: S({ text: str('Post text'), with_media: bool('Attach a photo/video') }) },
    { name: 'fb_read_notifications', description: 'Read the user\'s Facebook notifications.', parameters: S({}) },
    { name: 'fb_read_messages', description: 'Read the list of recent Messenger chats.', parameters: S({}) },
    { name: 'fb_search', description: 'Search Facebook (people, pages, videos, posts, groups) and read results.', parameters: S({ query: str('Search words'), type: { type: 'STRING', enum: ['top', 'videos', 'people', 'pages', 'posts', 'groups'], description: 'Kind' } }, ['query']) },
    { name: 'fb_read_screen', description: 'Read what is currently open in Captain\'s Facebook window.', parameters: S({}) },
    { name: 'fb_like', description: 'Like the first visible (not yet liked) post in the Facebook window.', parameters: S({}) },
    { name: 'fb_comment', description: 'Comment on the first visible post in the Facebook window.', parameters: S({ text: str('Comment text') }, ['text']) },
    { name: 'fb_play_video', description: 'Play the first video in the Facebook window (opens Facebook Watch if none).', parameters: S({}) },
    { name: 'facebook_create_post', description: 'ADVANCED (Page token only): publish a text (and optional link) post on the connected Facebook Page.', parameters: S({ message: str('Post text'), link: str('Optional link') }, ['message']) },
    { name: 'facebook_post_photo', description: 'Page API: upload a photo (user picks it) to the Facebook Page.', parameters: S({ caption: str('Caption') }) },
    { name: 'facebook_post_video', description: 'Page API: upload a video (user picks it) to the Facebook Page.', parameters: S({ description: str('Video description'), title: str('Optional title') }) },
    { name: 'facebook_list_posts', description: 'Page API: latest Page posts with likes/comments counts.', parameters: S({ limit: num('How many (default 5)') }) },
    { name: 'facebook_list_comments', description: 'Page API: comments on a Page post (latest post if post_id empty).', parameters: S({ post_id: str('Optional post id'), limit: num('How many') }) },
    { name: 'facebook_comment', description: 'Page API: comment on a Page post or reply to a comment (object_id). Latest post if empty.', parameters: S({ object_id: str('Post or comment id (optional)'), message: str('Comment text') }, ['message']) },
    { name: 'facebook_like', description: 'Page API: like a Page post or comment as the Page. Latest post if empty.', parameters: S({ object_id: str('Post or comment id (optional)') }) },
    { name: 'facebook_notifications', description: 'Page API: newest comments and inbox messages of the Page.', parameters: S({ limit: num('How many') }) },
    { name: 'facebook_reply_message', description: 'Page API: reply to a Page inbox conversation.', parameters: S({ conversation_id: str('Conversation id from facebook_notifications'), message: str('Reply text') }, ['conversation_id', 'message']) },
    { name: 'facebook_list_videos', description: 'Page API: list videos on the Page.', parameters: S({ limit: num('How many') }) },
    { name: 'facebook_download_video', description: 'Page API: download a Page video (latest if empty) to Download/Captain.', parameters: S({ video_id: str('Optional video id') }) },
    { name: 'facebook_delete_post', description: 'Page API: delete a Page post by id.', parameters: S({ post_id: str('Post id') }, ['post_id']) },
    { name: 'download_file', description: 'Download any file from an internet link to the phone Download/Captain folder.', parameters: S({ url: str('http(s) link'), file_name: str('Optional file name') }, ['url']) },
    { name: 'set_voice', description: "Change Captain's speaking voice: female (girl) or male (boy).", parameters: S({ gender: { type: 'STRING', enum: ['female', 'male'], description: 'Voice type' } }, ['gender']) },
    { name: 'open_screen', description: 'Open a screen of the Captain app, or the Facebook window.', parameters: S({ screen: { type: 'STRING', enum: ['home', 'chat', 'whatsapp', 'facebook', 'settings', 'about', 'google_key', 'facebook_website'], description: 'Screen' } }, ['screen']) }
  ];

  function toLocalIso(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
  function systemPrompt() {
    const now = new Date(), male = Store.get('voiceGender') === 'male';
    return `You are "Captain", a friendly AI assistant inside the "Captain AI Agent" Android app on the user's phone. You chat about anything and you control the user's WhatsApp and Facebook on this phone with the provided tools.
Rules:
- DEFAULT LANGUAGE IS URDU: reply in simple spoken Urdu written in Urdu script, even if the user writes Roman Urdu or Hindi. Use English only if the user clearly speaks English. Keep answers short, clear and warm; they are read aloud.
- When the user asks for a WhatsApp/Facebook action, call the right tool. Don't ask for confirmation for simple clear requests; confirm before deleting or sending to many people.
- If a tool returns an error, explain it simply and say what to do. Never invent messages or results.
- WhatsApp works through the WhatsApp app on this phone. Reading messages needs "Notification access"; automatic sending needs "Auto Send" (both on Captain's WhatsApp screen).
- Facebook: use fb_* tools (the user's own Facebook logged in inside Captain). Use facebook_* (Page API) tools only if the user talks about a Page token/Page.
- Your replies are spoken in a ${male ? 'male' : 'female (girl)'} voice. You CAN change it with set_voice; never say you can't. Speak as a ${male ? 'young, energetic guy (masculine Urdu: کرتا ہوں)' : 'young, energetic girl (feminine Urdu: کرتی ہوں، سکتی ہوں)'}: friendly, lively, confident.
- Live voice conversation: answer FAST in 1-2 short sentences unless asked for detail.
- ${N ? 'Device: Android phone.' : 'Device: iPhone (web app). On iPhone Captain can NOT read WhatsApp messages, auto-send, schedule, post status or control the Facebook website (Apple does not allow it). WhatsApp: only open a chat by phone NUMBER with the message ready (user taps Send). Facebook: only open it, or Page API tools. Say this simply if asked.'}
- Current local date-time: ${now.toLocaleString()} (ISO ${toLocalIso(now)}).`;
  }

  async function runTool(name, a, ctx) {
    const pick = async kind => { const f = await ctx.pickFile(kind); if (!f) throw new Error('Koi file select nahi ki gayi.'); return f; };
    switch (name) {
      case 'whatsapp_send_message': return WA.sendMessage({ to: a.to, message: a.message });
      case 'whatsapp_read_messages': return WA.readMessages({ chat: a.chat, limit: a.limit });
      case 'whatsapp_list_chats': return WA.listChats({ limit: a.limit, unreadOnly: a.unread_only });
      case 'whatsapp_send_file': return WA.sendFile({ to: a.to, file: await pick('*/*'), caption: a.caption });
      case 'whatsapp_send_from_url': return WA.sendUrl({ to: a.to, url: a.url, caption: a.caption });
      case 'whatsapp_download_media': return WA.downloadMedia({ count: a.count });
      case 'whatsapp_post_status': return WA.postStatus({ text: a.text, file: a.with_media ? await pick('media') : null });
      case 'whatsapp_schedule_message': { const r = await WA.schedule({ to: a.to, message: a.message, at: a.send_at_iso }); ctx.onSchedule && ctx.onSchedule(); return r; }
      case 'whatsapp_set_about': return WA.setAbout({ text: a.text });
      case 'fb_open': return FBW.open({ section: a.section });
      case 'fb_post': return FBW.post({ text: a.text, file: a.with_media ? await pick('media') : null });
      case 'fb_read_notifications': return FBW.readNotifications();
      case 'fb_read_messages': return FBW.readMessages();
      case 'fb_search': return FBW.search({ query: a.query, type: a.type });
      case 'fb_read_screen': return FBW.readScreen();
      case 'fb_like': return FBW.likeFirst();
      case 'fb_comment': return FBW.commentFirst({ text: a.text });
      case 'fb_play_video': return FBW.playFirstVideo();
      case 'facebook_create_post': return FBP.createPost({ message: a.message, link: a.link });
      case 'facebook_post_photo': return FBP.postPhoto({ file: await pick('image/*'), caption: a.caption });
      case 'facebook_post_video': return FBP.postVideo({ file: await pick('video/*'), description: a.description, title: a.title });
      case 'facebook_list_posts': return FBP.listPosts({ limit: a.limit });
      case 'facebook_list_comments': return FBP.listComments({ postId: a.post_id, limit: a.limit });
      case 'facebook_comment': return FBP.comment({ objectId: a.object_id, message: a.message });
      case 'facebook_like': return FBP.like({ objectId: a.object_id });
      case 'facebook_notifications': return FBP.activity({ limit: a.limit });
      case 'facebook_reply_message': return FBP.pageReplyMessage({ conversationId: a.conversation_id, message: a.message });
      case 'facebook_list_videos': return FBP.listVideos({ limit: a.limit });
      case 'facebook_download_video': return FBP.downloadVideo({ videoId: a.video_id });
      case 'facebook_delete_post': return FBP.deletePost({ postId: a.post_id });
      case 'download_file': { if (!N) { window.open(a.url, '_blank'); return { ok: true, text: 'Download کے لیے لنک کھول دیا۔' }; } needAndroid(); const f = N.download(a.url, a.file_name || ''); if (String(f).startsWith('ERR:')) throw new Error(f.slice(4)); return { ok: true, file: f, text: 'Download shuru: ' + f }; }
      case 'set_voice': Store.set({ voiceGender: a.gender === 'male' ? 'male' : 'female' }); ctx.ui && ctx.ui('__settings_changed'); return { ok: true, voice: a.gender, text: 'Awaaz badal di' };
      case 'open_screen': ctx.ui && ctx.ui(a.screen); return { ok: true, opened: a.screen };
      default: throw new Error('Unknown tool ' + name);
    }
  }

  let history = [];
  async function chat(userText, ctx, audio) {
    const turn = audio
      ? { role: 'user', parts: [{ text: '(The user spoke by voice. The FIRST line of your final reply must be exactly: HEARD: <the exact words the user said, Urdu in Urdu script>. Then answer on the next line. If there is no clear speech, reply only: HEARD: -)' }, { inline_data: { mime_type: 'audio/wav', data: audio } }] }
      : { role: 'user', parts: [{ text: userText }] };
    history.push(turn);
    if (history.length > 30) history = history.slice(-30);
    while (history.length && !(history[0].role === 'user' && history[0].parts[0] && history[0].parts[0].text)) history.shift();
    const actions = [];
    for (let step = 0; step < 6; step++) {
      const data = await call({
        systemInstruction: { parts: [{ text: systemPrompt() }] }, contents: history,
        tools: [{ functionDeclarations: TOOLS }], generationConfig: { temperature: 0.6, maxOutputTokens: audio ? 400 : 2048 }
      }, { fast: true });
      const content = data && data.candidates && data.candidates[0] && data.candidates[0].content;
      if (!content || !content.parts) { history.pop(); return { text: 'Maaf kijiye, jawab nahi mil saka. Dobara koshish karein.', actions }; }
      history.push({ role: 'model', parts: content.parts });
      const calls = content.parts.filter(p => p.functionCall);
      if (!calls.length) return { text: textOf(data) || 'Ho gaya.', actions };
      const responses = [];
      for (const p of calls) {
        const { name, args } = p.functionCall;
        ctx.onAction && ctx.onAction({ name, args, status: 'running' });
        let result;
        try { result = await runTool(name, args || {}, ctx); actions.push({ name, ok: true }); ctx.onAction && ctx.onAction({ name, status: 'done' }); }
        catch (e) { result = { error: e.message }; actions.push({ name, ok: false, error: e.message }); ctx.onAction && ctx.onAction({ name, status: 'error', error: e.message }); }
        const resp = { name, response: { result: JSON.parse(JSON.stringify(result === undefined ? null : result)) } };
        if (p.functionCall.id) resp.id = p.functionCall.id;
        responses.push({ functionResponse: resp });
      }
      history.push({ role: 'user', parts: responses });
    }
    return { text: 'Kaam bahut lamba ho gaya, thoda aasaan kar ke dobara batayein.', actions };
  }
  const HEARD_RE = /^\s*[*_]*\s*HEARD\s*[*_]*\s*:\s*[*_]*\s*(.*?)\s*(?:\n|$)/i;
  function splitHeard(text) {
    const m = String(text || '').match(HEARD_RE);
    if (!m) return { heard: '', text: String(text || '').trim() };
    const heard = m[1].replace(/[*_]+/g, '').replace(/^[\s"«“]+|[\s"»”]+$/g, '').replace(/^[-–—.\s]*$/, '').trim();
    return { heard, text: String(text).slice(m[0].length).trim() };
  }
  async function chatVoice(b64, ctx) {
    const r = await chat('', ctx, b64);
    const { heard, text } = splitHeard(r.text);
    for (const t of history) {
      if (t.role === 'user' && t.parts && t.parts[1] && t.parts[1].inline_data) t.parts = [{ text: heard || '(voice)' }];
      if (t.role === 'model' && t.parts) for (const p of t.parts) if (p.text && HEARD_RE.test(p.text)) p.text = splitHeard(p.text).text || '...';
    }
    const hadHeard = HEARD_RE.test(String(r.text || '')), letters = heard.replace(/[^\p{L}]/gu, '').length;
    if (!r.actions.length && ((hadHeard && letters < 2) || (!heard && !text))) return { text: '', heard: '', actions: [] };
    return { ...r, text: text || (r.actions.length ? 'Ho gaya.' : ''), heard };
  }

  function liveConfig() {
    const male = Store.get('voiceGender') === 'male';
    return {
      key: Store.get('geminiKey'), model: '', voice: male ? 'Puck' : 'Zephyr', tools: TOOLS,
      system: systemPrompt() + `
LIVE VOICE MODE:
- You are talking out loud in real time, like JARVIS: answer instantly, quick and lively, 1-2 short sentences. No long intros.
- Speak natural Pakistani Urdu (Urdu accent and words, not Hindi words), unless the user speaks English.
- After you use a tool, always say in a few words what you did.
- You cannot look up live weather/news/prices: say so in one short friendly sentence.
- If you hear only noise or nothing clear, stay silent.`
    };
  }

  // the same API shape the desktop screens used (voice.js / live.js call these)
  window.captain = {
    gemini: { tts, webTts: o => webTts(o) },
    live: { config: async () => liveConfig(), tool: (name, args) => runToolLive(name, args) }
  };
  let liveCtx = {};
  async function runToolLive(name, args) {
    liveCtx.onAction && liveCtx.onAction({ name, args, status: 'running' });
    try { const r = await runTool(name, args || {}, liveCtx); liveCtx.onAction && liveCtx.onAction({ name, status: 'done' }); return r; }
    catch (e) { liveCtx.onAction && liveCtx.onAction({ name, status: 'error', error: e.message }); return { error: e.message }; }
  }

  window.Core = {
    N, Store, sleep, nativeAsync, info, call, textOf, testKey, chat, chatVoice, reset: () => { history = []; },
    TOOLS, runTool, WA, FBW, FBP, setLiveCtx: c => { liveCtx = c || {}; }, splitHeard, systemPrompt
  };
})();
