// Captain AI Agent - mobile screens
(function () {
  'use strict';
  const { N, Store } = Core;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  let settings = Store.all();
  const save = o => { settings = Store.set(o); return settings; };
  const hasUrdu = t => /[؀-ۿ]/.test(t || '');

  // ---------- small UI helpers ----------
  function toast(text, kind = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + kind; d.textContent = text;
    $('#toasts').appendChild(d);
    setTimeout(() => d.remove(), kind === 'err' ? 6500 : 3500);
  }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function md(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>'); }
  function addMsg(kind, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + kind + (hasUrdu(text) ? ' rtl' : '');
    d.innerHTML = md(text);
    $('#chatLog').appendChild(d);
    scrollChat();
    return d;
  }
  function setMsg(el, t) { if (!el) return; el.innerHTML = md(t); el.classList.toggle('rtl', hasUrdu(t)); scrollChat(); }
  function scrollChat() { const p = $('.page[data-page="chat"]'); p.scrollTop = p.scrollHeight; }
  function heroSay(t) { if (!t) return; const b = $('#heroBubble'); b.textContent = t; b.scrollTop = 0; }
  function setStatus(mode, title, sub) {
    const mic = $('#micBtn');
    mic.classList.toggle('speak', mode === 'speak');
    const T = {
      idle: ['مائیک دبائیں', 'پھر بس بولیں، کیپٹن سنے گا'],
      listen: ['کیپٹن سن رہا ہے…', 'بس بولیے 😊'],
      rec: ['میں سن رہا ہوں…', 'بولیے…'],
      think: ['سوچ رہا ہوں…', 'ایک لمحہ'],
      speak: ['کیپٹن بول رہا ہے…', 'بیچ میں بول کر یا مائیک دبا کر روک سکتے ہیں'],
      connect: ['جڑ رہا ہوں…', 'گوگل Live سے رابطہ']
    }[mode] || ['', ''];
    $('#statusTitle').textContent = title || T[0];
    $('#statusSub').textContent = sub || T[1];
    const chip = $('#liveChip');
    chip.className = 'chip ' + (handsFree ? (mode === 'think' || mode === 'connect' ? 'busy' : 'on') : 'off');
    chip.querySelector('span').textContent = handsFree ? (liveOn ? 'Live' : 'On') : 'Off';
  }
  const idle = () => setStatus(handsFree ? 'listen' : 'idle');

  // ---------- navigation ----------
  let current = 'home';
  function go(page) {
    if (page === '__settings_changed') { settings = Store.all(); renderSettings(); if (liveOn) setTimeout(() => Live.refresh(), 2500); return; }
    if (page === 'google_key') { openKey(); return; }
    if (page === 'facebook_website') { N && N.fbShow(true); return; }
    if (page === 'about') page = 'settings';
    if (!$(`.page[data-page="${page}"]`)) page = 'home';
    current = page;
    $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.go === page));
    $('#inputBar').classList.toggle('hidden', !(page === 'home' || page === 'chat'));
    if (page === 'whatsapp') renderWhatsApp();
    if (page === 'settings') renderSettings();
    if (page === 'facebook') renderFacebook();
    if (page === 'chat') setTimeout(scrollChat, 30);
  }
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  window.onBackButton = () => {
    if (!$('#keySheet').classList.contains('hidden')) { closeKey(); return true; }
    if (current !== 'home') { go('home'); return true; }
    return false;
  };

  // ---------- speaking ----------
  function speak(text, after) {
    if (!text) { after && after(); return; }
    setStatus('speak');
    Voice.speak(text, {
      rate: +settings.voiceRate || 1.2,
      gender: settings.voiceGender,
      engine: settings.voiceGender === 'male' ? 'hd' : 'fast',
      onEnd: () => { idle(); after && after(); }
    });
  }

  // ---------- chat / tools ----------
  const TOOL_LABEL = {
    whatsapp_send_message: 'WhatsApp message bhej raha hoon', whatsapp_read_messages: 'WhatsApp messages parh raha hoon', whatsapp_list_chats: 'WhatsApp chats dekh raha hoon',
    whatsapp_send_file: 'File bhej raha hoon', whatsapp_send_from_url: 'Link bhej raha hoon', whatsapp_download_media: 'Files save kar raha hoon', whatsapp_post_status: 'Status laga raha hoon',
    whatsapp_schedule_message: 'Message schedule kar raha hoon', whatsapp_set_about: 'About', fb_open: 'Facebook khol raha hoon', fb_post: 'Facebook post kar raha hoon',
    fb_read_notifications: 'Notifications parh raha hoon', fb_read_messages: 'Messenger dekh raha hoon', fb_search: 'Facebook search', fb_read_screen: 'Facebook parh raha hoon',
    fb_like: 'Like kar raha hoon', fb_comment: 'Comment kar raha hoon', fb_play_video: 'Video chala raha hoon', download_file: 'Download kar raha hoon',
    set_voice: 'Awaaz badal raha hoon', open_screen: 'Screen khol raha hoon'
  };
  const ctx = {
    pickFile: kind => N ? Core.nativeAsync('pickFile', kind === 'media' ? 'media' : (kind || '*/*')).then(r => r ? JSON.parse(r) : null) : webPick(kind),
    ui: go,
    onSchedule: () => { if (current === 'whatsapp') renderWhatsApp(); },
    onAction: a => { if (a.status === 'running') addMsg('act', '⏳ ' + (TOOL_LABEL[a.name] || a.name)); else if (a.status === 'error') addMsg('act', '⚠️ ' + a.error); }
  };
  Core.setLiveCtx(ctx);
  // iPhone: a file can only be chosen by a tap, so show a button and wait for it
  function webPick(kind) {
    return new Promise(res => {
      const sh = $('#pickSheet'), inp = $('#pickInput');
      inp.value = ''; inp.accept = kind === 'media' ? 'image/*,video/*' : (kind && kind !== '*/*' ? kind : '');
      sh.classList.remove('hidden');
      const done = v => { sh.classList.add('hidden'); inp.onchange = null; $('#pickCancel').onclick = null; res(v); };
      inp.onchange = () => { const f = inp.files && inp.files[0]; done(f ? { blob: f, name: f.name, mime: f.type, size: f.size } : null); };
      $('#pickCancel').onclick = () => done(null);
    });
  }

  function localCommand(t) {
    const s = t.toLowerCase().trim();
    if (/^(google|gemini)\s*key/.test(s) || s === 'key') { openKey(); return 'Google key ka box khul gaya.'; }
    return null;
  }

  let busy = false;
  async function sendText(text) {
    text = (text || '').trim();
    if (!text) return;
    addMsg('user', text);
    if (current !== 'chat' && current !== 'home') go('chat');
    const lc = localCommand(text);
    if (lc) { addMsg('bot', lc); return; }
    if (!settings.geminiKey) { const m = 'پہلے اپنی مفت Google key لگائیں، پھر میں ہر کام کر دوں گا۔'; addMsg('bot', m); heroSay(m); openKey(); return; }
    if (liveOn && Live.connected && Live.sendText(text)) { liveUser = null; liveBot = null; return; }
    if (busy) { toast('ایک لمحہ، پچھلا کام چل رہا ہے'); return; }
    busy = true; setStatus('think');
    try {
      const r = await Core.chat(text, ctx);
      addMsg('bot', r.text); heroSay(r.text);
      if (settings.speakReplies) speak(r.text); else idle();
    } catch (e) {
      addMsg('err', e.message); toast(e.message, 'err'); idle();
      if (e.code === 'NO_KEY' || /API key|key not valid|PERMISSION_DENIED/i.test(e.message)) openKey();
    } finally { busy = false; }
  }
  $('#inputBar').addEventListener('submit', e => { e.preventDefault(); const v = $('#msgInput').value; $('#msgInput').value = ''; sendText(v); });
  $('#newChat').onclick = () => { Core.reset(); $('#chatLog').innerHTML = ''; addMsg('bot', 'نئی چیٹ شروع۔ بتائیں کیا کرنا ہے؟'); };

  // ---------- microphone: LIVE mode (like JARVIS) with classic fallback ----------
  let handsFree = false, liveOn = false, liveFailed = false, liveUser = null, liveBot = null;
  const canListen = () => handsFree && $('#keySheet').classList.contains('hidden');

  async function startLive() {
    try {
      liveOn = true; setStatus('connect');
      await Live.start({
        canListen: () => canListen() && !Voice.isAudible(),
        onReady: () => idle(),
        onUserStart: () => { $('#micBtn').classList.add('rec'); setStatus('rec'); },
        onUserText: t => { if (!liveUser) liveUser = addMsg('user', t); else setMsg(liveUser, t); },
        onSpeakStart: () => { $('#micBtn').classList.remove('rec'); setStatus('speak'); },
        onBotText: t => { if (/^\s*</.test(t)) return; if (!liveBot) liveBot = addMsg('bot', t); else setMsg(liveBot, t); heroSay(t); },
        onSpeakEnd: () => { if (handsFree) idle(); },
        onTurnDone: (u, b) => {
          if (!b || /^\s*<[^>]*>\s*$/.test(b)) { liveUser && liveUser.remove(); liveBot && liveBot.remove(); }
          liveUser = null; liveBot = null; $('#micBtn').classList.remove('rec');
        },
        onTool: (name, args) => window.captain.live.tool(name, args),
        onReconnecting: () => setStatus('connect'),
        onFail: reason => {
          liveOn = false; liveFailed = true; try { Live.stop(); } catch (_) {}
          toast('Live موڈ ابھی نہیں چلا، عام طریقہ چل رہا ہے (' + String(reason).slice(0, 70) + ')', 'err');
          handsFree = false; startHandsFree(true);
        }
      });
      return true;
    } catch (e) { liveOn = false; liveFailed = true; console.warn('Live start failed', e); return false; }
  }

  let voiceGen = 0;
  async function handleUtterance(b64) {
    const gen = ++voiceGen;
    Voice.stopSpeaking(); setStatus('think');
    try {
      const r = await Core.chatVoice(b64, ctx);
      if (gen !== voiceGen) return;
      if (!r.heard && !(r.text || '').trim()) { idle(); return; }
      if (r.heard) addMsg('user', r.heard);
      addMsg('bot', r.text); heroSay(r.text);
      if (settings.speakReplies !== false) speak(r.text); else idle();
    } catch (e) { if (gen !== voiceGen) return; addMsg('err', e.message); toast(e.message, 'err'); idle(); if (e.code === 'NO_KEY') openKey(); }
  }

  async function ensureMicPermission() {
    if (!N) return true;
    try { if (Core.info().mic) return true; return (await Core.nativeAsync('requestPerm', 'mic')) === '1'; } catch (_) { return true; }
  }

  async function startHandsFree(silent) {
    if (!settings.geminiKey) { if (!silent) { toast('پہلے Google key لگائیں', 'err'); openKey(); } return; }
    if (!(await ensureMicPermission())) { toast('مائیک کی اجازت نہیں ملی۔ Settings سے اجازت دیں۔', 'err'); return; }
    if (settings.liveMode !== false && !liveFailed && window.Live) {
      handsFree = true; $('#micBtn').classList.add('on');
      if (await startLive()) { save({ handsFree: true }); return; }
      handsFree = false;
    }
    try {
      await Voice.startAuto({
        canListen,
        onStart: () => { $('#micBtn').classList.add('rec'); setStatus('rec'); },
        onCancel: () => { $('#micBtn').classList.remove('rec'); idle(); },
        onUtterance: b64 => { $('#micBtn').classList.remove('rec'); handleUtterance(b64); }
      });
      handsFree = true; $('#micBtn').classList.add('on'); idle(); save({ handsFree: true });
    } catch (e) { handsFree = false; toast('مائیک نہیں ملا: ' + e.message, 'err'); idle(); }
  }
  function stopHandsFree() {
    handsFree = false;
    if (liveOn) { liveOn = false; try { Live.stop(); } catch (_) {} }
    Voice.stopAuto(); Voice.stopSpeaking();
    $('#micBtn').classList.remove('on', 'rec', 'speak');
    idle(); save({ handsFree: false });
  }
  $('#micBtn').onclick = () => {
    Voice.unlock && Voice.unlock(); Live.unlock && Live.unlock(); // iPhone: sound only works after a tap
    if (liveOn && Live.isSpeaking()) { Live.interrupt(); idle(); return; }
    if (Voice.isSpeaking()) { Voice.stopSpeaking(); idle(); return; }
    if (handsFree) stopHandsFree(); else startHandsFree();
  };

  // ---------- Google key ----------
  function openKey() { $('#keySheet').classList.remove('hidden'); $('#keyInput').value = ''; $('#keyMsg').textContent = ''; setTimeout(() => $('#keyInput').focus(), 150); }
  function closeKey() { $('#keySheet').classList.add('hidden'); }
  const openKeySite = () => N ? N.openUrl('https://aistudio.google.com/apikey') : window.open('https://aistudio.google.com/apikey');
  $('#keyClose').onclick = closeKey; $('#keyGet').onclick = openKeySite; $('#keyFree').onclick = openKeySite;
  $('#keyBtn').onclick = openKey;
  $('#keyRemove').onclick = () => { save({ geminiKey: '' }); if (handsFree) stopHandsFree(); renderSettings(); toast('Key ہٹا دی گئی'); };
  $('#keySave').onclick = async () => {
    const k = $('#keyInput').value.trim().replace(/\s+/g, '');
    if (k.length < 20) { $('#keyMsg').textContent = 'یہ key پوری نہیں لگتی، دوبارہ کاپی کریں۔'; return; }
    $('#keyMsg').textContent = 'جانچ رہا ہوں…'; $('#keySave').disabled = true;
    try {
      await Core.testKey(k);
      save({ geminiKey: k, geminiModel: 'gemini-flash-lite-latest' });
      closeKey(); renderSettings();
      const m = 'Google key لگ گئی! اب مائیک دبائیں اور مجھ سے بات کریں۔';
      heroSay(m); addMsg('bot', m); toast(m, 'ok'); speak(m);
    } catch (e) {
      $('#keyMsg').textContent = 'Key کام نہیں کر رہی: ' + e.message;
    } finally { $('#keySave').disabled = false; }
  };

  // ---------- settings page ----------
  function renderSettings() {
    settings = Store.all();
    const k = settings.geminiKey;
    $('#keyState').textContent = k ? '✅ Key لگی ہوئی ہے: ' + k.slice(0, 5) + '••••' + k.slice(-4) : '❌ ابھی کوئی key نہیں لگی';
    $$('#voiceSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === (settings.voiceGender || 'female')));
    $('#setLive').checked = settings.liveMode !== false;
    $('#setSpeak').checked = settings.speakReplies !== false;
    $('#setRate').value = settings.voiceRate || 1.2; $('#rateVal').textContent = (+settings.voiceRate || 1.2).toFixed(2) + 'x';
    if (!N) $('#appInfo').textContent = 'Version 1.0.0 • iPhone ویب ایپ';
    else try { const i = Core.info(); $('#appInfo').textContent = `Version ${i.version || '1.0.0'} • Android API ${i.sdk || '?'} • WhatsApp: ${i.whatsapp ? 'موجود' : 'نہیں ملا'}`; } catch (_) {}
  }
  $$('#voiceSeg button').forEach(b => b.onclick = () => { save({ voiceGender: b.dataset.v }); renderSettings(); if (liveOn) Live.refresh(); toast(b.dataset.v === 'male' ? 'لڑکے کی آواز' : 'لڑکی کی آواز', 'ok'); });
  $('#setLive').onchange = e => { save({ liveMode: e.target.checked }); liveFailed = false; if (handsFree) { stopHandsFree(); startHandsFree(true); } };
  $('#setSpeak').onchange = e => save({ speakReplies: e.target.checked });
  $('#setRate').oninput = e => { save({ voiceRate: +e.target.value }); $('#rateVal').textContent = (+e.target.value).toFixed(2) + 'x'; };
  $('#testVoice').onclick = () => speak(settings.voiceGender === 'male' ? 'السلام علیکم! میں کیپٹن ہوں، آپ کا اسسٹنٹ۔' : 'السلام علیکم! میں کیپٹن ہوں، آپ کی اسسٹنٹ۔');
  $('#appPerms').onclick = () => N && N.openSettings('app');

  // ---------- WhatsApp page ----------
  async function askPerm(p) {
    if (!N) return toast('یہ صرف Android ایپ میں چلتا ہے', 'err');
    if (p === 'contacts' || p === 'notifPerm') { await Core.nativeAsync('requestPerm', p === 'contacts' ? 'contacts' : 'notifications'); renderWhatsApp(); return; }
    N.openSettings(p);
    toast(p === 'autoSend' ? 'Accessibility میں «Captain – WhatsApp auto send» آن کریں' : p === 'notifAccess' ? 'فہرست میں «Captain AI Agent» آن کریں' : 'Captain کو اجازت دیں', 'ok');
  }
  $$('.perm').forEach(el => el.querySelector('button').onclick = () => askPerm(el.dataset.perm));
  function renderWhatsApp() {
    settings = Store.all();
    let inf = {};
    try { inf = Core.info(); } catch (_) {}
    $$('.perm').forEach(el => {
      const ok = !!inf[el.dataset.perm];
      el.classList.toggle('done', ok);
      el.querySelector('button').textContent = ok ? '✓ ہو گیا' : (el.dataset.perm === 'autoSend' ? 'آن کریں' : 'اجازت دیں');
    });
    $('#setReadIncoming').checked = settings.readIncoming !== false;
    $('#setAutoSend').checked = settings.autoSend !== false;
    $('#setAutoReply').checked = !!settings.autoReply;
    $('#setAutoReplyPrompt').value = settings.autoReplyPrompt || '';
    // messages
    let msgs = [];
    try { msgs = JSON.parse(N.waMessages() || '[]'); } catch (_) {}
    const list = $('#waList');
    list.innerHTML = msgs.length ? '' : `<p class="muted">${inf.notifAccess ? 'ابھی کوئی میسج نہیں آیا۔' : 'میسج دیکھنے کے لیے اوپر «میسج پڑھنے کی اجازت» دیں۔'}</p>`;
    msgs.slice(-20).reverse().forEach(m => {
      const d = document.createElement('div'); d.className = 'item';
      d.innerHTML = `<div class="row"><b>${esc(m.chat)}${m.group && m.from && m.from !== m.chat ? ' • ' + esc(m.from) : ''}${m.auto ? ' 🤖' : ''}</b><small>${new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div><div class="t">${esc(m.text)}</div>`;
      list.appendChild(d);
    });
    save({ lastSeenWa: Date.now() }); updateBadge();
    // schedules
    let sch = [];
    try { sch = JSON.parse(N.schedules() || '[]'); } catch (_) {}
    const sl = $('#schedList');
    if (sch.length) {
      sl.innerHTML = '';
      sch.sort((a, b) => a.at - b.at).forEach(s => {
        const d = document.createElement('div'); d.className = 'item';
        d.innerHTML = `<div class="row"><b>${esc(s.chat || s.phone)}</b><small>${new Date(s.at).toLocaleString()}</small></div><div class="t">${esc(s.text)}</div><button class="btn small ghost">منسوخ کریں</button>`;
        d.querySelector('button').onclick = () => { N.cancelSchedule(s.id); renderWhatsApp(); toast('شیڈول منسوخ'); };
        sl.appendChild(d);
      });
    }
  }
  $('#waRefresh').onclick = renderWhatsApp;
  $('#setReadIncoming').onchange = e => save({ readIncoming: e.target.checked });
  $('#setAutoSend').onchange = e => save({ autoSend: e.target.checked });
  $('#setAutoReply').onchange = e => { save({ autoReply: e.target.checked }); if (e.target.checked && !Core.info().notifAccess) { toast('AI جواب کے لیے پہلے «میسج پڑھنے کی اجازت» دیں', 'err'); } };
  $('#setAutoReplyPrompt').onchange = e => save({ autoReplyPrompt: e.target.value });

  function updateBadge() {
    let n = 0;
    try { const seen = Store.get('lastSeenWa') || 0; n = JSON.parse(N.waMessages() || '[]').filter(m => m.time > seen && !m.auto).length; } catch (_) {}
    const b = $('#waBadge'); b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n);
    $('#waTileSub').textContent = n ? `${n} نئے میسج` : 'Control & Chat';
  }
  window.onWhatsAppMessage = m => {
    if (current === 'whatsapp') renderWhatsApp(); else updateBadge();
    if (m.auto) { toast(`🤖 ${m.chat} کو جواب دیا: ${m.text}`, 'ok'); return; }
    if (settings.readIncoming !== false && !Voice.isSpeaking() && !(liveOn && Live.isSpeaking())) {
      const say = `${m.chat}${m.group && m.from && m.from !== m.chat ? ' میں ' + m.from : ''} کا واٹس ایپ میسج: ${m.text}`;
      heroSay(say); speak(say);
    }
  };
  window.onAutoSent = () => toast('✓ WhatsApp پر بھیج دیا', 'ok');

  // ---------- Facebook page ----------
  function renderFacebook() {
    settings = Store.all();
    $('#fbPageId').value = settings.fbPageId || ''; $('#fbToken').value = settings.fbToken || '';
  }
  $('#fbOpen').onclick = () => { if (!N) { window.open('https://www.facebook.com/', '_blank'); return; } N.fbLoad('https://www.facebook.com/'); N.fbShow(true); };
  $$('[data-fb]').forEach(b => b.onclick = () => Core.FBW.open({ section: b.dataset.fb }).catch(e => toast(e.message, 'err')));
  $('#fbLogout').onclick = () => { N && N.fbLogout(); toast('Facebook سے لاگ آؤٹ ہو گیا'); };
  $('#fbSave').onclick = async () => {
    const id = $('#fbPageId').value.trim(), tk = $('#fbToken').value.trim();
    if (!id || !tk) { save({ fbPageId: id, fbToken: tk }); $('#fbPageStatus').textContent = 'محفوظ'; return; }
    $('#fbPageStatus').textContent = 'جانچ رہا ہوں…';
    try { const d = await Core.FBP.verify(id, tk); save({ fbPageId: id, fbToken: tk }); $('#fbPageStatus').textContent = '✅ ' + d.name; }
    catch (e) { $('#fbPageStatus').textContent = '❌ ' + e.message; }
  };
  window.onFacebookWindow = shown => { if (!shown) idle(); };

  // ---------- lifecycle ----------
  window.onAppResume = () => { if (current === 'whatsapp') renderWhatsApp(); else updateBadge(); };

  // iPhone web app
  if (!N) {
    document.body.classList.add('web');
    document.addEventListener('touchend', function once() { Voice.unlock && Voice.unlock(); Live.unlock && Live.unlock(); document.removeEventListener('touchend', once); }, { passive: true });
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) $('#installHint').classList.remove('hidden');
    $('#installClose').onclick = () => $('#installHint').classList.add('hidden');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // first start
  renderSettings();
  idle();
  updateBadge();
  if (!settings.geminiKey) {
    setTimeout(() => { heroSay('خوش آمدید! پہلے اپنی مفت Google key لگائیں، پھر مائیک دبا کر مجھ سے بات کریں۔'); openKey(); }, 600);
  } else if (settings.handsFree) {
    setTimeout(() => startHandsFree(true), 800);
  }
  save({}); // sync settings to the background services
  addMsg('bot', 'السلام علیکم! میں کیپٹن ہوں۔ کہیں: «علی کو واٹس ایپ پر سلام بھیجو»، «میرے نئے میسج پڑھو»، «فیس بک پر پوسٹ کرو…»');
})();
