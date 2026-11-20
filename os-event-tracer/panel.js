/* DevTools panel "OS Events" */
(function () {
  'use strict';

  var store = new OSStore();
  var raw = [];                 // raw records (for export)
  var session = null;
  var lastSeq = 0;
  var recording = true;
  var inflight = false;
  var selectedKey = null;
  var detailsFor = null;
  var openState = new Map();    // tree view: key -> open?
  var renderQueued = false;
  var separators = [];          // [{at: rootIndex, text}]
  var mode = 'chain';
  var collapsedCards = new Set();
  var focus = null;             // { key, hide } - follow one causal chain
  var hoverKey = null;
  var flowHits = [];            // keys of matching steps, in display order
  var flowHitKey = null;        // current match (Enter / F3)
  var MAX_CARDS = 100;
  var pick = { init: false, seen: 0 };

  var $ = function (id) { return document.getElementById(id); };
  var treeEl = $('tree'), detailsEl = $('details'), chainEl = $('chain'), leftCol = $('leftCol');
  var dbg = {
    on: false, attached: false, paused: false, info: null,
    mode: 'step', breaks: new Map(), ignLife: true, ignLibs: true,
    port: null, renderedFor: null
  };

  /* ---------- theme ---------- */
  try { if (chrome.devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark'); } catch (e) {}

  /* ---------- talking to the page ---------- */
  function evalPage(expr, cb) {
    cb = cb || function () {};
    // While paused the page is blocked inside a synchronous request: eval would hang.
    if (dbg.paused) { cb(null, 'paused'); return; }
    chrome.devtools.inspectedWindow.eval(expr, function (res, exc) {
      if (exc) { cb(null, exc); return; }
      cb(res, null);
    });
  }
  var API = 'window.__osEventTracer';

  function poll() {
    if (inflight || dbg.paused) return;
    inflight = true;
    var expr = API + ' ? ' + API + '.drain(' + lastSeq + ',' + JSON.stringify(session || '') + ') : "null"';
    evalPage(expr, function (res, exc) {
      inflight = false;
      if (exc || !res || res === 'null') { setStatus(null); return; }
      var data;
      try { data = JSON.parse(res); } catch (e) { return; }
      applyDrain(data);
    });
  }
  function applyDrain(data) {
    if (data.session !== session) {
      if (session !== null && $('preserve').checked) {
        separators.push({ at: store.roots.length, text: 'Page reloaded — ' + ((data.status && data.status.url) || '') });
      } else if (session !== null) {
        resetAll();
      }
      if (session !== null) onPageChanged();
      session = data.session;
      lastSeq = 0;
      pick.init = false;
      if (dbg.on) syncDebug();
    }
    var since = lastSeq;
    var recs = (data.records || []).filter(function (r) { return r.seq > since; });
    if (recs.length) {
      for (var i = 0; i < recs.length; i++) raw.push(recs[i]);
      if (raw.length > 60000) raw.splice(0, raw.length - 50000);
      store.apply(session, recs);
      lastSeq = recs[recs.length - 1].seq;
      queueRender();
    }
    if (data.status) onStatus(data.status);
    if (data.more) setTimeout(poll, 0);
  }
  setInterval(poll, 400);
  poll();
  try { chrome.devtools.network.onNavigated.addListener(function () { setTimeout(poll, 300); }); } catch (e) {}

  function onPageChanged() {
    live.data = null; live.toggled.clear(); live.allVars.clear(); live.userOpen.clear();
    $('btnPick').classList.remove('on');
    if (dbg.paused) {
      // The page reloaded while paused: the held request is gone.
      dbg.paused = false; dbg.info = null;
      if (dbg.port) dbg.port.postMessage({ cmd: 'reset' });
      updateDbgUI();
    }
  }

  function onStatus(st) {
    setStatus(st);
    var p = st.picker;
    if (!p) return;
    $('btnPick').classList.toggle('on', !!p.active);
    if (!pick.init) { pick.init = true; pick.seen = p.seq; return; }
    if (p.seq > pick.seen) {
      pick.seen = p.seq;
      if (p.last && p.last.id) showPicked(p.last, true);
      else flashStatus('No OutSystems block under that point.');
    }
  }

  var statusFlash = null, statusFlashTimer = null;
  function flashStatus(text) {
    statusFlash = text;
    clearTimeout(statusFlashTimer);
    statusFlashTimer = setTimeout(function () { statusFlash = null; setStatus(lastStatus); }, 3500);
    setStatus(lastStatus);
  }
  var lastStatus = null;
  function setStatus(st) {
    lastStatus = st;
    var el = $('status');
    if (statusFlash) { el.innerHTML = '<span class="warn">' + esc(statusFlash) + '</span>'; return; }
    if (!st) {
      el.innerHTML = '<span class="bad">Tracer not found on this page.</span> If you just installed or reloaded the extension, reload the page (F5).';
      return;
    }
    var parts = [];
    parts.push(st.detected ? '<span class="ok">● OutSystems detected</span>' : '<span class="bad">○ OutSystems runtime not detected (yet)</span>');
    parts.push('debugger hook: ' + (st.debuggerHooked ? '<span class="ok">ok</span>' : (st.debuggerHookError ? '<span class="bad">' + esc(st.debuggerHookError) + '</span>' : '—')));
    parts.push('server hook: ' + (st.controllerHooked ? '<span class="ok">ok</span>' : '—'));
    parts.push('live screens/blocks: ' + st.views);
    if (st.ctrlDev || st.ctrlProd) {
      parts.push('modules: ' + st.ctrlDev + ' with debug info / ' + st.ctrlProd + ' without' +
        (st.ctrlProd ? ' <span title="In modules compiled without debug information the flow is rebuilt at action level (no individual nodes inside each action).">ⓘ</span>' : ''));
    }
    parts.push('steps: ' + store.nodes.size);
    el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }

  function resetAll() {
    store.reset();
    raw = [];
    separators = [];
    selectedKey = null;
    detailsFor = null;
    focus = null;
    hoverKey = null;
    flowHitKey = null;
    openState.clear();
    collapsedCards.clear();
    detailsEl.innerHTML = '<div class="empty">Select a step on the left to see its inputs, variables and changes.</div>';
    queueRender();
  }

  /* ---------- toolbar ---------- */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x.dataset.tab === name); });
    $('viewFlow').classList.toggle('hidden', name !== 'flow');
    $('viewLive').classList.toggle('hidden', name !== 'live');
    document.body.classList.toggle('on-live', name === 'live');
    if (name === 'live') refreshLive();
    else queueRender();
  }
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });
  $('btnRecord').addEventListener('click', function () {
    recording = !recording;
    this.classList.toggle('on', recording);
    this.textContent = recording ? '● Record' : '❚❚ Paused';
    evalPage(API + ' && ' + API + '.setEnabled(' + recording + ')');
  });
  $('btnClear').addEventListener('click', function () {
    evalPage(API + ' && ' + API + '.clear()');
    resetAll();
  });
  $('btnExport').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: raw }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'os-events-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $('snapshots').addEventListener('change', function () {
    evalPage(API + ' && ' + API + '.setSnapshots(' + this.checked + ')');
  });
  var filterTimer = null;
  $('filter').addEventListener('input', function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () { flowHitKey = null; queueRender(); }, 150);
  });
  $('filter').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); gotoFlowHit(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape' && this.value) { this.value = ''; flowHitKey = null; queueRender(); }
  });
  ['filterValues', 'hideLifecycle', 'hideFetch', 'onlyEvents'].forEach(function (id) {
    $(id).addEventListener('change', function () { flowHitKey = null; queueRender(); });
  });
  $('btnPick').addEventListener('click', function () {
    var on = this.classList.contains('on');
    evalPage(API + ' ? ' + API + '.picker.' + (on ? 'stop' : 'start') + '() : null', function (res, exc) {
      if (exc || res === null) { flashStatus(exc === 'paused' ? 'The page is paused by debug mode.' : 'Tracer not found on this page.'); return; }
      $('btnPick').classList.toggle('on', !on);
      if (!on) flashStatus('Click a block in the page (Esc to cancel).');
    });
  });

  /* resize */
  (function () {
    var rz = $('resizer'), dragging = false;
    rz.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var pct = Math.max(20, Math.min(85, e.clientX / window.innerWidth * 100));
      leftCol.style.flexBasis = pct + '%';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
  })();

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Escapes text and wraps every occurrence of q in <mark>.
  function mark(text, q) {
    text = String(text == null ? '' : text);
    if (!q) return esc(text);
    var low = text.toLowerCase(), out = '', i = 0, j;
    while ((j = low.indexOf(q, i)) >= 0) {
      out += esc(text.slice(i, j)) + '<mark>' + esc(text.slice(j, j + q.length)) + '</mark>';
      i = j + q.length;
    }
    return out + esc(text.slice(i));
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n, l) { return String(n).padStart(l || 2, '0'); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }
  function fmtDur(n) {
    if (n.end == null) return '<span class="pending">…</span>';
    var ms = n.end - n.ts;
    return ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms';
  }
  function short(v, max) {
    max = max || 40;
    var s;
    if (v === null || v === undefined) s = 'null';
    else if (typeof v === 'string') s = JSON.stringify(v);
    else if (Array.isArray(v)) s = 'List(' + v.length + ')';
    else if (typeof v === 'object') s = '{' + Object.keys(v).slice(0, 3).join(', ') + (Object.keys(v).length > 3 ? ', …' : '') + '}';
    else s = String(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  var LIFECYCLE = /\s(On Render|On Ready|On Initialize|On Parameters Changed|On Destroy|On After Fetch)$/i;
  var FETCH_TYPES = /(DataScreenActionFlow|WebScreenDataSet)$/;
  function typeLabel(ftype) {
    if (!ftype) return '';
    if (/ClientScreenActionFlow$/.test(ftype)) return 'action';
    if (/DataScreenActionFlow$/.test(ftype)) return 'data action';
    if (/WebScreenDataSet$/.test(ftype)) return 'aggregate';
    if (/ClientActionFlow$/.test(ftype)) return 'module action';
    if (/WebFlow$/.test(ftype)) return 'flow';
    if (/WebBlock$/.test(ftype)) return 'block';
    if (/WebScreen$/.test(ftype)) return 'screen';
    return ftype.replace(/^NR(Flows|Nodes)\./, '');
  }
  function serverLabel(kind) {
    return kind === 'server' ? 'server action' : kind === 'dataAction' ? 'data action request' : 'aggregate request';
  }
  function blockOf(n) {
    if (n.type === 'trigger') return n.block;
    if (n.type === 'frame') return n.owner || null;
    if (n.type === 'thread') { var ch = store.contextChain(n); return ch.length ? ch.map(function (c) { return c.name; }).join('.') : null; }
    return null;
  }

  /* ---------- flow search ---------- */
  function flowQuery() { return $('filter').value.trim().toLowerCase(); }
  // Collects keys (and values when asked) of a serialized value, depth-limited.
  function collectText(v, out, values, depth) {
    if (out.length > 3000 || depth > 7 || v == null) return;
    if (typeof v !== 'object') { if (values) out.push(String(v)); return; }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) collectText(v[i], out, values, depth + 1); return; }
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      out.push(k);
      collectText(v[k], out, values, depth + 1);
    }
  }
  function searchText(n, values) {
    var stamp = (n._v || 0) + (values ? 'v' : 'k');
    if (n._st && n._st.stamp === stamp) return n._st.text;
    var parts = [n.name, n.owner, n.block, n.event, n.module, n.url, n.tid];
    if (n.type === 'thread') store.contextChain(n).forEach(function (c) { parts.push(c.name); });
    [n.inputs, n.params, n.before, n.after, n.locals, n.outputs].forEach(function (o) { if (o) collectText(o, parts, values, 0); });
    if (n.errors) parts = parts.concat(n.errors);
    var text = parts.filter(function (x) { return x != null && x !== ''; }).join('\n').toLowerCase();
    n._st = { stamp: stamp, text: text };
    return text;
  }
  var pass = null; // per-render memo
  function nodeHit(n) {
    if (!pass.q) return false;
    if (pass.hit.has(n.key)) return pass.hit.get(n.key);
    var r = searchText(n, pass.values).indexOf(pass.q) >= 0;
    pass.hit.set(n.key, r);
    return r;
  }
  function subtreeHit(n, depth) {
    if (!pass.q) return true;
    if (pass.sub.has(n.key)) return pass.sub.get(n.key);
    var r = nodeHit(n);
    if (!r && (depth || 0) < 60) {
      for (var i = 0; i < n.children.length && !r; i++) {
        var c = store.get(n.children[i]);
        if (c && subtreeHit(c, (depth || 0) + 1)) r = true;
      }
    }
    pass.sub.set(n.key, r);
    return r;
  }

  /* ---------- filters ---------- */
  function rootInfo(n) {
    if (n._rootInfo && n._rootInfo.v === store.version) return n._rootInfo;
    var vis = store.visibleChildren(n);
    var first = vis[0];
    var info = {
      v: store.version,
      lifecycle: n.type === 'thread' && LIFECYCLE.test(n.name || ''),
      fetch: n.type === 'thread' && !!first && first.type === 'frame' && FETCH_TYPES.test(first.ftype || ''),
      hasTrigger: hasTrigger(n, 0)
    };
    n._rootInfo = info;
    return info;
  }
  function hasTrigger(n, depth) {
    if (depth > 40) return false;
    if (n.type === 'trigger') return true;
    for (var i = 0; i < n.children.length; i++) {
      var c = store.get(n.children[i]);
      if (c && hasTrigger(c, depth + 1)) return true;
    }
    return false;
  }
  function rootVisible(n) {
    var info = rootInfo(n);
    if ($('onlyEvents').checked && !info.hasTrigger) return false;
    if ($('hideLifecycle').checked && info.lifecycle && !info.hasTrigger) return false;
    if ($('hideFetch').checked && info.fetch) return false;
    if (pass.q && !subtreeHit(n, 0)) return false;
    return true;
  }
  // Roots to display, newest first. In focus mode only the focused chain.
  function visibleRoots() {
    var out = [], more = 0;
    if (focus) {
      var fn = store.get(focus.key);
      var r = fn && store.rootOf(fn);
      if (r) return { roots: [r], more: 0, seps: [] };
      focus = null;
    }
    var seps = [], sepIdx = separators.length - 1;
    for (var i = store.roots.length - 1; i >= 0; i--) {
      while (sepIdx >= 0 && separators[sepIdx].at > i) { seps.push({ before: out.length, text: separators[sepIdx].text }); sepIdx--; }
      var n = store.get(store.roots[i]);
      if (!n || (mode === 'chain' && n.type !== 'thread' && n.type !== 'trigger') || !rootVisible(n)) continue;
      if (out.length >= MAX_CARDS) { more++; continue; }
      out.push(n);
    }
    return { roots: out, more: more, seps: seps };
  }

  /* ---------- focus (follow one causal chain) ---------- */
  function relatedSet() { return focus ? store.lineage(store.get(focus.key)) : null; }
  function setFocus(key) {
    var n = key && store.get(key);
    if (!n) { focus = null; } else {
      focus = { key: key, hide: focus ? focus.hide : true };
      selectedKey = key;
      collapsedCards.delete(store.rootOf(n).key);
      store.ancestors(n).forEach(function (a) { openState.set(a.key, true); });
    }
    detailsFor = null;
    queueRender();
  }
  function renderFocusBar() {
    var bar = $('focusBar');
    if (!focus) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    var n = store.get(focus.key);
    if (!n) { bar.classList.add('hidden'); return; }
    var rel = relatedSet(), count = 0;
    rel.forEach(function (k) { var x = store.get(k); if (x && !(x.type === 'frame' && x.kind === 'context')) count++; });
    var anc = store.ancestors(n).reverse();
    bar.classList.remove('hidden');
    bar.innerHTML = '<span class="ftitle">🎯 Following</span> ' +
      anc.map(function (a) { return '<span class="link" data-focus="' + esc(a.key) + '">' + esc(labelOf(a)) + '</span>'; }).join(' › ') +
      (anc.length ? ' › ' : '') + '<b>' + esc(labelOf(n)) + '</b>' +
      ' <span class="hint">· ' + count + ' related steps</span>' +
      ' <label class="chk"><input type="checkbox" id="focusHide"' + (focus.hide ? ' checked' : '') + '> hide unrelated steps</label>' +
      ' <button class="tool small" id="focusExit" title="Esc">✕ Stop following</button>';
    $('focusHide').addEventListener('change', function () { focus.hide = this.checked; queueRender(); });
    $('focusExit').addEventListener('click', function () { setFocus(null); });
  }
  $('focusBar').addEventListener('click', function (e) {
    var f = e.target.closest('[data-focus]');
    if (f) setFocus(f.dataset.focus);
  });

  /* ---------- render scheduling ---------- */
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; render(); });
  }
  function render() {
    if ($('viewFlow').classList.contains('hidden')) return;
    pass = { q: flowQuery(), values: $('filterValues').checked, hit: new Map(), sub: new Map() };
    renderFocusBar();
    if (mode === 'chain') renderChain(); else renderTree();
    collectFlowHits();
    afterRender();
  }
  function afterRender() {
    markPaused();
    reapplyHover();
    if (dbg.paused) { renderPause(); return; }
    if (selectedKey) {
      var sel = store.get(selectedKey);
      if (sel && detailsFor !== selectedKey + ':' + (sel._v || 0)) renderDetails(sel);
    }
  }
  function container() { return mode === 'chain' ? chainEl : treeEl; }
  function collectFlowHits() {
    var c = container();
    flowHits = [];
    if (pass.q) {
      c.querySelectorAll('.hit[data-key]').forEach(function (el) { flowHits.push(el.dataset.key); });
    }
    var idx = flowHitKey ? flowHits.indexOf(flowHitKey) : -1;
    var cnt = $('filterCount');
    if (!pass.q) cnt.textContent = '';
    else if (!flowHits.length) cnt.textContent = 'no matches';
    else cnt.textContent = (idx >= 0 ? (idx + 1) + '/' : '') + flowHits.length + (flowHits.length === 1 ? ' match' : ' matches');
    c.querySelectorAll('.curhit').forEach(function (el) { el.classList.remove('curhit'); });
    if (idx >= 0) {
      var el = c.querySelector('[data-key="' + cssEsc(flowHitKey) + '"]');
      if (el) el.classList.add('curhit');
    }
  }
  function gotoFlowHit(dir) {
    if (!flowHits.length) return;
    var idx = flowHitKey ? flowHits.indexOf(flowHitKey) : -1;
    idx = idx < 0 ? (dir > 0 ? 0 : flowHits.length - 1) : (idx + dir + flowHits.length) % flowHits.length;
    flowHitKey = flowHits[idx];
    selectNode(flowHitKey, true);
  }

  /* ---------- tree view ---------- */
  function isOpen(n, depth) {
    if (pass.q && n.type !== 'server' && subtreeHit(n, 0) && !nodeHitOnly(n)) return true;
    if (openState.has(n.key)) return openState.get(n.key);
    if (n.type === 'thread' && depth === 0) {
      var info = rootInfo(n);
      return info.hasTrigger || (!info.lifecycle && !info.fetch);
    }
    return true;
  }
  // True when the node matches but none of its descendants do (no need to open it).
  function nodeHitOnly(n) {
    if (!nodeHit(n)) return false;
    for (var i = 0; i < n.children.length; i++) {
      var c = store.get(n.children[i]);
      if (c && subtreeHit(c, 1)) return false;
    }
    return true;
  }
  function rowClasses(n, rel) {
    var cls = [];
    if (n.key === selectedKey) cls.push('sel');
    if (n.errors && n.errors.length) cls.push('err');
    if (pass.q && nodeHit(n)) cls.push('hit');
    if (rel && !rel.has(n.key)) cls.push('dim');
    if (focus && n.key === focus.key) cls.push('focused');
    return cls;
  }
  function rowHtml(n, depth, rel) {
    var vis = store.visibleChildren(n);
    if (rel && focus.hide) vis = vis.filter(function (c) { return rel.has(c.key); });
    var open = isOpen(n, depth);
    var cls = ['row', n.type].concat(rowClasses(n, rel));
    if (depth === 0) cls.push('root');
    var tg = vis.length ? (open ? '▾' : '▸') : '';
    var q = pass.q;
    var h = '<div class="' + cls.join(' ') + '" data-key="' + esc(n.key) + '" data-depth="' + depth + '" style="padding-left:' + (4 + depth * 14) + 'px">';
    h += '<span class="tg">' + tg + '</span>';
    if (n.type === 'thread') {
      var chain = store.contextChain(n);
      h += '<span class="ic th">⟶</span>';
      h += '<span class="nm">' + mark(n.name || '(thread ' + n.tid + ')', q) + '</span>';
      if (chain.length) h += '<span class="ctx">in ' + mark(chain.map(function (c) { return c.name; }).join(' › '), q) + '</span>';
      if (n.hasError) h += '<span class="badge err">error</span>';
      h += '<span class="meta">' + (depth === 0 ? fmtTime(n.ts) + ' · ' : '') + fmtDur(n) + '</span>';
    } else if (n.type === 'frame') {
      h += '<span class="ic act">●</span>';
      h += '<span class="nm">' + mark(n.name, q) + '</span>';
      if (n.owner) h += '<span class="own">' + mark(n.owner, q) + '</span>';
      h += '<span class="tag">' + esc(typeLabel(n.ftype)) + '</span>';
      if (n.changed && n.changed.length) h += '<span class="badge chg" title="' + esc(n.changed.join(', ')) + '">Δ ' + n.changed.length + '</span>';
      if (n.errors.length) h += '<span class="badge err">error</span>';
      h += '<span class="meta">' + fmtDur(n) + '</span>';
    } else if (n.type === 'trigger') {
      var ps = Object.keys(n.params || {}).map(function (k) { return k + '=' + short(n.params[k], 24); });
      h += '<span class="ic ev">⚡</span>';
      h += '<span class="nm">Trigger ' + mark(n.event, q) + '</span>';
      h += '<span class="own">from ' + mark(n.block, q) + '</span>';
      if (ps.length) h += '<span class="params">(' + esc(ps.join(', ')) + ')</span>';
      if (!n.handlerKey) h += '<span class="tag" title="No handler thread was found in the parent">no handler</span>';
    } else if (n.type === 'server') {
      h += '<span class="ic srv">⇅</span>';
      h += '<span class="nm">' + mark(n.name, q) + '</span>';
      h += '<span class="tag">' + esc(serverLabel(n.kind)) + '</span>';
      if (n.errors.length) h += '<span class="badge err">error</span>';
      h += '<span class="meta">' + fmtDur(n) + '</span>';
    }
    h += '</div>';
    if (open && vis.length) {
      for (var i = 0; i < vis.length; i++) h += rowHtml(vis[i], depth + 1, rel);
    }
    return h;
  }
  function renderTree() {
    var scrollTop = treeEl.scrollTop;
    var vr = visibleRoots(), rel = relatedSet(), html = [];
    vr.roots.forEach(function (n, i) {
      vr.seps.forEach(function (s) { if (s.before === i) html.push('<div class="sepline">' + esc(s.text) + '</div>'); });
      html.push(rowHtml(n, 0, rel));
    });
    if (vr.more) html.push('<div class="sepline">' + vr.more + ' older flows not shown — use search to find them.</div>');
    if (!html.length) html.push(emptyFlowsHtml());
    treeEl.innerHTML = html.join('');
    treeEl.scrollTop = scrollTop;
  }
  function emptyFlowsHtml() {
    if (pass.q) return '<div class="empty">Nothing matches “' + esc(pass.q) + '”.' + (pass.values ? '' : ' Tick <b>values</b> to also search variable values.') + '</div>';
    return '<div class="empty">No flows yet. Use the app (click a button, open a popup…) and its flow shows up here.' +
      ($('onlyEvents').checked ? ' Untick <b>Only block events</b> to also see interactions without a Trigger Event.' : '') + '</div>';
  }
  treeEl.addEventListener('click', function (e) {
    var row = e.target.closest('.row');
    if (!row) return;
    var key = row.dataset.key, n = store.get(key);
    if (!n) return;
    if (e.target.classList.contains('tg')) {
      openState.set(key, !isOpen(n, +row.dataset.depth));
      queueRender();
      return;
    }
    selectNode(key);
  });

  /* ---------- chain view (sequence diagram) ---------- */
  document.querySelectorAll('.segb').forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.dataset.mode;
      document.querySelectorAll('.segb').forEach(function (x) { x.classList.toggle('active', x === b); });
      treeEl.classList.toggle('hidden', mode !== 'tree');
      chainEl.classList.toggle('hidden', mode !== 'chain');
      queueRender();
    });
  });
  // Screen/block a thread runs in, from its context frames.
  function threadParticipant(th) {
    var ch = store.contextChain(th);
    if (!ch.length) {
      var fa = store.visibleChildren(th).filter(function (x) { return x.type === 'frame' && x.owner; })[0];
      if (fa) { var pp = participantFromDisplay(fa.owner); pp.kind = fa.ownerKind === 'screen' ? 'screen' : 'block'; return pp; }
      return { id: th.name || ('thread ' + th.tid), name: th.name || 'thread', flow: '', kind: 'block' };
    }
    var last = ch[ch.length - 1];
    var flow = ch.length > 1 ? ch[0].name : '';
    return { id: (flow ? flow + '.' : '') + last.name, name: last.name, flow: flow, kind: /WebScreen$/.test(last.ftype || '') ? 'screen' : 'block' };
  }
  function participantFromDisplay(display) {
    var i = display.lastIndexOf('.');
    return { id: display, name: i >= 0 ? display.slice(i + 1) : display, flow: i >= 0 ? display.slice(0, i) : '', kind: 'block' };
  }
  // Short origin label: "Custom_zprivate/PopUpLayout_Close/Link OnClick" -> "Link OnClick"
  function originLabel(th, p) {
    var name = th.name || '';
    var last = name.split('/').pop();
    if (p && p.name && last.indexOf(p.name + ' ') === 0) last = last.slice(p.name.length + 1);
    return last || name || 'start';
  }
  function buildSequence(root, rel) {
    var parts = [], index = {}, rows = [];
    var hideOthers = rel && focus && focus.hide;
    function part(p) {
      if (!(p.id in index)) { index[p.id] = parts.length; parts.push(p); }
      else if (p.kind === 'screen') parts[index[p.id]].kind = 'screen';
      return index[p.id];
    }
    function keep(c) { return !hideOthers || rel.has(c.key); }
    function walkThread(th, isRoot) {
      var p = threadParticipant(th);
      var col = part(p);
      if (isRoot) rows.push({ t: 'origin', col: col, node: th, label: originLabel(th, p) });
      walkChildren(th, col, 0);
    }
    function walkChildren(node, col, depth) {
      store.visibleChildren(node).forEach(function (c) {
        if (!keep(c)) return;
        if (c.type === 'frame') {
          rows.push({ t: 'action', col: col, node: c, depth: depth });
          walkChildren(c, col, depth + 1);
        } else if (c.type === 'server') {
          rows.push({ t: 'server', col: col, node: c, depth: depth });
        } else if (c.type === 'trigger') {
          var from = part(participantFromDisplay(c.block));
          var h = c.handlerKey ? store.get(c.handlerKey) : null;
          var to = h ? part(threadParticipant(h)) : null;
          if (to === null) {
            // No handler with actions: if the parent forwarded another event right away, that is the target.
            var fwd = store.visibleChildren(c).filter(function (x) { return x.type === 'trigger'; })[0];
            if (fwd) to = part(participantFromDisplay(fwd.block));
          }
          rows.push({ t: 'event', from: from, to: to, node: c });
          walkChildren(c, to !== null ? to : from, 0);
        } else if (c.type === 'thread') {
          walkThread(c, false);
        }
      });
    }
    if (root.type === 'thread') walkThread(root, true);
    else walkChildren({ children: [root.key] }, 0, 0);
    return { parts: parts, rows: rows };
  }
  function isPrim(v) { return v === null || v === undefined || typeof v !== 'object'; }
  function diffSummary(n) {
    if (!n.changed || !n.changed.length) return '';
    var items = n.changed.slice(0, 3).map(function (k) {
      var b = n.before ? n.before[k] : undefined, a = n.after ? n.after[k] : undefined;
      if (isPrim(b) && isPrim(a)) return '<span class="chgv">' + mark(k, pass.q) + ': ' + esc(short(b, 18)) + ' → ' + esc(short(a, 18)) + '</span>';
      return '<span class="chgv">' + mark(k, pass.q) + ' changed</span>';
    });
    if (n.changed.length > 3) items.push('+' + (n.changed.length - 3));
    return items.join(' ');
  }
  function paramsSummary(params) {
    var ks = Object.keys(params || {});
    if (!ks.length) return '';
    return '(' + ks.map(function (k) { return k + ' = ' + short(params[k], 22); }).join(', ') + ')';
  }
  function seqHtml(seq, rel) {
    var N = seq.parts.length, R = seq.rows.length, q = pass.q;
    var h = '<div class="seq" style="grid-template-columns:repeat(' + N + ', minmax(170px, 1fr))">';
    seq.parts.forEach(function (p, i) {
      h += '<div class="phead" style="grid-column:' + (i + 1) + '" title="' + esc(p.id) + '">' +
        '<span class="pk ' + p.kind + '">' + p.kind + '</span>' +
        '<span class="pn">' + mark(p.name, q) + '</span>' +
        '<span class="pf">' + esc(p.flow || ' ') + '</span></div>';
      h += '<div class="lifeline" style="grid-column:' + (i + 1) + ';grid-row:2 / span ' + Math.max(R, 1) + '"></div>';
    });
    seq.rows.forEach(function (r, ri) {
      var row = ri + 2, n = r.node, extra = rowClasses(n, rel);
      var cls = extra.length ? ' ' + extra.join(' ') : '';
      if (r.t === 'origin') {
        h += '<div class="scell" style="grid-column:' + (r.col + 1) + ';grid-row:' + row + '">' +
          '<div class="pill origin' + cls + '" data-key="' + esc(n.key) + '" title="' + esc(n.name || '') + '">' +
          '<div class="pt">▶ <b>' + mark(r.label, q) + '</b></div></div></div>';
      } else if (r.t === 'action') {
        var ds = diffSummary(n);
        var inp = n.inputs ? paramsSummary(n.inputs) : '';
        h += '<div class="scell" style="grid-column:' + (r.col + 1) + ';grid-row:' + row + '">' +
          '<div class="pill act' + (r.depth ? ' sub' : '') + cls + '" data-key="' + esc(n.key) + '" title="' + esc(typeLabel(n.ftype) + (n.owner ? ' in ' + n.owner : '')) + '">' +
          '<div class="pt">' + (r.depth ? '↳ ' : '● ') + '<b>' + mark(n.name, q) + '</b>' + (inp ? '<span class="pd">' + esc(inp) + '</span>' : '') +
          '<span class="dur">' + fmtDur(n) + '</span></div>' +
          (ds ? '<div class="pd">' + ds + '</div>' : '') +
          (n.errors && n.errors.length ? '<div class="pd">⚠ ' + esc(n.errors[0]) + '</div>' : '') +
          '</div></div>';
      } else if (r.t === 'server') {
        h += '<div class="scell" style="grid-column:' + (r.col + 1) + ';grid-row:' + row + '">' +
          '<div class="pill srv' + cls + '" data-key="' + esc(n.key) + '">' +
          '<div class="pt">⇅ <b>' + mark(n.name, q) + '</b><span class="dur">' + fmtDur(n) + '</span></div>' +
          '<div class="pd">' + esc(serverLabel(n.kind)) + '</div></div></div>';
      } else if (r.t === 'event') {
        var unhandled = r.to === null || r.to === r.from;
        var lo = unhandled ? r.from : Math.min(r.from, r.to), hi = unhandled ? r.from : Math.max(r.from, r.to);
        var span = hi - lo + 1;
        var dir = unhandled || r.to > r.from ? 'ltr' : 'rtl';
        var half = 50 / span;
        var lineStyle = unhandled ? 'left:50%;right:10%' : 'left:' + half + '%;right:' + half + '%';
        var args = paramsSummary(n.params);
        h += '<div class="evt ' + dir + (unhandled ? ' unhandled' : '') + cls + '" data-key="' + esc(n.key) + '" ' +
          'style="grid-column:' + (lo + 1) + ' / span ' + span + ';grid-row:' + row + '" title="' + esc(n.event + ' ' + args + ' — from ' + n.block) + '">' +
          '<div class="lbl"><span class="ev">⚡ ' + mark(n.event, q) + '</span> <span class="args">' + esc(args) + '</span>' +
          (unhandled ? ' <span class="args">— no handler</span>' : '') + '</div>' +
          '<div class="line" style="' + lineStyle + '"></div></div>';
      }
    });
    return h + '</div>';
  }
  function renderChain() {
    var scrollTop = chainEl.scrollTop;
    var vr = visibleRoots(), rel = relatedSet(), html = [];
    var selRoot = selectedKey && store.get(selectedKey) ? store.rootOf(store.get(selectedKey)) : null;
    vr.roots.forEach(function (n, i) {
      vr.seps.forEach(function (s) { if (s.before === i) html.push('<div class="sepline">' + esc(s.text) + '</div>'); });
      var seq = buildSequence(n, rel);
      var nev = seq.rows.filter(function (r) { return r.t === 'event'; }).length;
      // Search results and the focused chain are always expanded.
      var collapsed = collapsedCards.has(n.key) && !focus && !(pass.q && subtreeHit(n, 0));
      var path = seq.parts.map(function (p) { return p.name; }).join(' → ');
      html.push(
        '<div class="flow-card' + (collapsed ? ' collapsed' : '') + (selRoot === n ? ' sel-root' : '') + '" data-root="' + esc(n.key) + '">' +
        '<div class="flow-head" data-card="' + esc(n.key) + '">' +
        '<span class="tgl">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="when">' + fmtTime(n.ts) + '</span>' +
        '<span class="what">' + mark(n.type === 'trigger' ? '\u26a1 ' + n.event + ' (' + n.block + ')' : (n.name || '(thread)'), pass.q) + '</span>' +
        (nev ? '<span class="hops">' + nev + ' event' + (nev > 1 ? 's' : '') + ' · ' + esc(path) + '</span>' : '') +
        (n.hasError ? '<span class="badge err">error</span>' : '') +
        '<span class="meta">' + fmtDur(n) + '</span></div>' +
        (collapsed ? '' : seqHtml(seq, rel)) +
        '</div>');
    });
    if (vr.more) html.push('<div class="sepline">' + vr.more + ' older flows not shown — use search to find them.</div>');
    if (!html.length) html.push(emptyFlowsHtml());
    chainEl.innerHTML = html.join('');
    chainEl.scrollTop = scrollTop;
  }
  chainEl.addEventListener('click', function (e) {
    var head = e.target.closest('[data-card]');
    if (head) {
      var k = head.dataset.card;
      if (e.target.classList.contains('tgl') || e.target === head) {
        if (collapsedCards.has(k)) collapsedCards.delete(k); else collapsedCards.add(k);
        queueRender();
      } else selectNode(k);
      return;
    }
    var el = e.target.closest('[data-key]');
    if (el) selectNode(el.dataset.key);
  });
  [chainEl, treeEl].forEach(function (c) {
    c.addEventListener('dblclick', function (e) {
      var el = e.target.closest('[data-key]');
      if (el) { e.preventDefault(); setFocus(focus && focus.key === el.dataset.key ? null : el.dataset.key); }
    });
    c.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[data-key]');
      var k = el ? el.dataset.key : null;
      if (k !== hoverKey) { hoverKey = k; applyHover(); }
    });
    c.addEventListener('mouseleave', function () { hoverKey = null; applyHover(); });
    c.addEventListener('keydown', onFlowKey);
  });

  /* Hover: highlight everything the hovered step belongs to (cause and effects). */
  function applyHover() {
    var c = container();
    c.querySelectorAll('.hovering').forEach(function (x) { x.classList.remove('hovering'); });
    c.querySelectorAll('.hl').forEach(function (x) { x.classList.remove('hl'); });
    if (!hoverKey) return;
    var n = store.get(hoverKey);
    if (!n) return;
    var scope = mode === 'chain' ? c.querySelector('[data-root="' + cssEsc(store.rootOf(n).key) + '"]') : c;
    if (!scope) return;
    var rel = store.lineage(n);
    scope.classList.add('hovering');
    scope.querySelectorAll('[data-key]').forEach(function (x) { if (rel.has(x.dataset.key)) x.classList.add('hl'); });
  }
  function reapplyHover() { if (hoverKey) applyHover(); }

  /* Keyboard: ↑/↓ move between steps, ← cause, → first effect, F focus, Esc stop following. */
  function stepElements() {
    return Array.prototype.slice.call(container().querySelectorAll('[data-key]')).filter(function (el) { return !el.classList.contains('dim'); });
  }
  function onFlowKey(e) {
    var els = stepElements();
    var keys = els.map(function (el) { return el.dataset.key; });
    var idx = selectedKey ? keys.indexOf(selectedKey) : -1;
    var n = selectedKey ? store.get(selectedKey) : null;
    if (e.key === 'ArrowDown') { if (keys.length) selectNode(keys[Math.min(keys.length - 1, idx + 1)], true); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { if (keys.length) selectNode(keys[Math.max(0, idx - 1)], true); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && n) {
      if (mode === 'tree' && isOpen(n, 1) && store.visibleChildren(n).length && openState.get(n.key) !== false) { openState.set(n.key, false); queueRender(); }
      else { var cause = store.ancestors(n).filter(function (a) { return keys.indexOf(a.key) >= 0; })[0]; if (cause) selectNode(cause.key, true); }
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && n) {
      if (mode === 'tree' && openState.get(n.key) === false) { openState.set(n.key, true); queueRender(); }
      else {
        var desc = store.descendantKeys(n);
        var eff = keys.filter(function (k, i) { return i > idx && desc.has(k); })[0];
        if (eff) selectNode(eff, true);
      }
      e.preventDefault();
    } else if ((e.key === 'f' || e.key === 'F') && selectedKey) { setFocus(focus && focus.key === selectedKey ? null : selectedKey); e.preventDefault(); }
    else if (e.key === 'Escape' && focus) { setFocus(null); e.preventDefault(); }
  }

  function selectNode(key, scroll) {
    var n = store.get(key);
    if (!n) return;
    selectedKey = key;
    store.ancestors(n).forEach(function (a) { openState.set(a.key, true); });
    collapsedCards.delete(store.rootOf(n).key);
    detailsFor = null;
    queueRender();
    if (scroll) requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var el = container().querySelector('[data-key="' + cssEsc(key) + '"]');
        if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    });
  }

  /* ---------- value rendering (expandable JSON tree with search marks) ---------- */
  var SEP = '\u0001';
  function valueHtml(v, ctx, path) {
    var q = ctx && ctx.q;
    if (v === null || v === undefined) return '<code class="v v-null">null</code>';
    if (typeof v === 'string') return '<code class="v v-str">' + (ctx && ctx.values ? mark(JSON.stringify(v), q) : esc(JSON.stringify(v))) + '</code>';
    if (typeof v === 'number') return '<code class="v v-num">' + (ctx && ctx.values ? mark(String(v), q) : v) + '</code>';
    if (typeof v === 'boolean') return '<code class="v v-bool">' + (ctx && ctx.values ? mark(String(v), q) : v) + '</code>';
    var isArr = Array.isArray(v), keys = isArr ? v.map(function (_, i) { return String(i); }) : Object.keys(v);
    if (!keys.length) return '<code class="v v-null">' + (isArr ? '[]' : '{}') + '</code>';
    var open = (ctx && ctx.open && ctx.open.has(path)) || (ctx && ctx.userOpen && ctx.userOpen.has(ctx.scope + SEP + path));
    var h = '<details class="jt" data-path="' + esc(path) + '"' + (open ? ' open' : '') + '><summary><span class="pv">' + esc(short(v, 70)) + '</span></summary><div class="jt-body">';
    keys.forEach(function (k) {
      var child = v[k];
      h += '<div class="jt-row"><span class="jk">' + (isArr ? '<span class="v-null">' + esc(k) + '</span>' : mark(k, q)) + '</span>' +
        '<span class="jv">' + valueHtml(child, ctx, path + SEP + k) + '</span></div>';
    });
    return h + '</div></details>';
  }
  function varsTable(before, after, onlyChanged, ctx, keysFilter) {
    if (!before && !after) return '<div class="sub">No variables.</div>';
    var keys = {};
    Object.keys(before || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(after || {}).forEach(function (k) { keys[k] = 1; });
    var list = Object.keys(keys);
    if (keysFilter) list = list.filter(function (k) { return keysFilter.has(k); });
    if (!list.length) return '<div class="sub">No variables.</div>';
    var two = before && after, q = ctx && ctx.q;
    var h = '<table class="vars"><tr><th>Name</th>' + (two ? '<th>Before</th><th>After</th>' : '<th>Value</th>') + '</tr>';
    var rows = 0;
    list.forEach(function (k) {
      var b = before ? before[k] : undefined, a = after ? after[k] : undefined;
      var chg = two && JSON.stringify(b) !== JSON.stringify(a);
      if (onlyChanged && two && !chg) return;
      rows++;
      h += '<tr class="' + (chg ? 'chg' : '') + '"><td class="k">' + mark(k, q) + '</td>';
      if (two) h += '<td>' + valueHtml(b, ctx, k) + '</td><td>' + (chg ? valueHtml(a, ctx, k + SEP + 'after') : '<span class="v-null">=</span>') + '</td>';
      else h += '<td>' + valueHtml((before || after)[k], ctx, k) + '</td>';
      h += '</tr>';
    });
    if (!rows) return '<div class="sub">No variable changed.</div>';
    return h + '</table>';
  }

  /* ---------- details ---------- */
  function kv(pairs) {
    return '<div class="kv">' + pairs.filter(function (p) { return p[1] != null && p[1] !== ''; }).map(function (p) {
      return '<span class="k">' + esc(p[0]) + '</span><span>' + p[1] + '</span>';
    }).join('') + '</div>';
  }
  function errorsHtml(n) {
    if (!n.errors || !n.errors.length) return '';
    return '<h3>Errors</h3>' + n.errors.map(function (e) { return '<div class="errbox">' + esc(e) + '</div>'; }).join('');
  }
  function linkTo(key, text) { return '<span class="link" data-goto="' + esc(key) + '">' + esc(text) + '</span>'; }
  function labelOf(n) {
    if (n.type === 'thread') return '⟶ ' + (n.name || 'thread');
    if (n.type === 'trigger') return '⚡ ' + n.event;
    if (n.type === 'server') return '⇅ ' + n.name;
    return n.name + (n.owner ? ' (' + n.owner.split('.').pop() + ')' : '');
  }
  function actionsHtml(n) {
    var following = focus && focus.key === n.key;
    var b = blockOf(n);
    return '<div class="dactions">' +
      '<button class="tool small" data-act="focus" title="Show only this step, what caused it and what it caused (double-click or F)">' + (following ? '✕ Stop following' : '🎯 Follow this chain') + '</button>' +
      (b ? '<button class="tool small" data-act="filter" data-v="' + esc(b) + '" title="Show only flows that involve this block">Filter by ' + esc(b.split('.').pop()) + '</button>' +
        '<button class="tool small" data-act="live" data-v="' + esc(b) + '" title="Open the current variables of this block">Live variables</button>' : '') +
      '</div>';
  }
  var onlyChangedPref = false;
  function renderDetails(n) {
    detailsFor = n.key + ':' + (n._v || 0);
    var h = '';
    var anc = store.ancestors(n).reverse();
    if (anc.length) h += '<div class="sub crumbline">' + anc.map(function (a) { return linkTo(a.key, labelOf(a)); }).join(' › ') + '</div>';
    var ctx = { q: null, values: false };
    if (n.type === 'frame') {
      h += '<h2>● ' + esc(n.name) + (n.bkey ? bpButton('a:' + n.bkey, n.name + (n.owner ? ' (' + n.owner.split('.').pop() + ')' : '')) : '') + '</h2>';
      h += actionsHtml(n);
      h += kv([
        ['Type', esc(typeLabel(n.ftype))],
        ['Owner', n.owner ? esc(n.owner) + ' <span class="hint">(' + (n.ownerKind === 'screen' ? 'screen' : 'block') + ', ' + esc(n.ownerModule || n.module) + ')</span>' : esc(n.module)],
        ['Start', fmtTime(n.ts)],
        ['Duration', fmtDur(n)]
      ]);
      if (n.inputs) h += '<h3>Action inputs</h3>' + varsTable(n.inputs, null, false, ctx);
      if (n.before || n.after) {
        h += '<h3>' + (n.ownerKind === 'screen' ? 'Screen' : 'Block') + ' variables' +
          ' <label class="hint"><input type="checkbox" id="onlyChg"' + (onlyChangedPref ? ' checked' : '') + '> changes only</label></h3>';
        h += varsTable(n.before, n.after, onlyChangedPref, ctx);
      }
      if (n.locals) h += '<h3>Locals / results (at the end)</h3>' + varsTable(n.locals, null, false, ctx);
      if (n.nodes && n.nodes.length) h += '<h3>Nodes executed <span class="hint">(recorded in debug mode)</span></h3>' + nodesHtml(n.nodes, null);
      h += errorsHtml(n);
    } else if (n.type === 'trigger') {
      h += '<h2>⚡ Trigger ' + esc(n.event) + bpButton('e:' + n.block + '|' + n.event, '⚡ ' + n.event + ' (' + n.block.split('.').pop() + ')') + '</h2>';
      h += actionsHtml(n);
      var handler = n.handlerKey ? store.get(n.handlerKey) : null;
      var parentChain = handler ? store.contextChain(handler).map(function (c) { return c.name; }).join(' › ') : '';
      h += kv([
        ['From block', esc(n.block)],
        ['Handled in', handler ? linkTo(handler.key, parentChain || handler.name || 'handler') : '<span class="hint">no handler found (the parent may not handle this event)</span>'],
        ['When', fmtTime(n.ts)]
      ]);
      h += '<h3>Event inputs</h3>' + (Object.keys(n.params || {}).length ? varsTable(n.params, null, false, ctx) : '<div class="sub">This event has no inputs.</div>');
      if (n.screens && n.screens.length) {
        n.screens.forEach(function (s) {
          h += '<h3>Screen ' + esc(s.name) + ' variables <span class="hint">when the event fired</span></h3>' + varsTable(s.vars, null, false, ctx);
        });
      }
    } else if (n.type === 'thread') {
      h += '<h2>⟶ ' + esc(n.name || 'thread ' + n.tid) + '</h2>';
      h += actionsHtml(n);
      var chain = store.contextChain(n);
      var trig = n.parentKey ? store.get(n.parentKey) : null;
      h += kv([
        ['Runs in', esc(chain.map(function (c) { return c.name + ' (' + typeLabel(c.ftype) + ')'; }).join(' › '))],
        ['Caused by', trig && trig.type === 'trigger' ? linkTo(trig.key, '⚡ ' + trig.event + ' from ' + trig.block) : 'user interaction / lifecycle'],
        ['Start', fmtTime(n.ts)],
        ['Duration', fmtDur(n)]
      ]);
      var acts = [];
      (function walk(x, d) {
        store.visibleChildren(x).forEach(function (c) { acts.push({ n: c, d: d }); if (d < 6) walk(c, d + 1); });
      })(n, 0);
      if (acts.length) {
        h += '<h3>Steps</h3><div>' + acts.map(function (a) {
          return '<div style="padding-left:' + (a.d * 14) + 'px">' + linkTo(a.n.key, labelOf(a.n)) + '</div>';
        }).join('') + '</div>';
      }
      h += errorsHtml(n);
    } else if (n.type === 'server') {
      h += '<h2>⇅ ' + esc(n.name) + '</h2>';
      h += actionsHtml(n);
      h += kv([
        ['Type', esc(serverLabel(n.kind))],
        ['Endpoint', n.url ? '<code>' + esc(n.url) + '</code>' : ''],
        ['Start', fmtTime(n.ts)],
        ['Duration', fmtDur(n)]
      ]);
      if (n.inputs) h += '<h3>Inputs sent</h3>' + varsTable(n.inputs, null, false, ctx);
      if (n.outputs !== undefined && n.outputs !== null) {
        h += '<h3>Response</h3>' + (typeof n.outputs === 'object' && !Array.isArray(n.outputs) ? varsTable(n.outputs, null, false, ctx) : valueHtml(n.outputs, ctx, 'out'));
      }
      if (n.kind !== 'server') h += '<div class="sub">The result is stored in the data action/aggregate variable — see the screen/block in "Live variables".</div>';
      h += errorsHtml(n);
    }
    detailsEl.innerHTML = h;
    wireBpButtons();
    var oc = $('onlyChg');
    if (oc) oc.addEventListener('change', function () { onlyChangedPref = this.checked; renderDetails(n); });
  }
  detailsEl.addEventListener('click', function (e) {
    var g = e.target.closest('[data-goto]');
    if (g) { selectNode(g.dataset.goto, true); return; }
    var a = e.target.closest('[data-act]');
    if (!a || !selectedKey) return;
    if (a.dataset.act === 'focus') setFocus(focus && focus.key === selectedKey ? null : selectedKey);
    else if (a.dataset.act === 'filter') { $('filter').value = a.dataset.v; flowHitKey = null; queueRender(); }
    else if (a.dataset.act === 'live') { live.filterTo(a.dataset.v); }
  });

  /* ================================================================== */
  /* Live variables                                                       */
  /* ================================================================== */
  var live = {
    data: null,
    toggled: new Map(),   // view id -> expanded? (user choice)
    allVars: new Set(),   // view ids where "show all variables" was clicked
    userOpen: new Set(),  // scope + path of JSON nodes opened by the user
    revealId: null,
    picked: null,
    hits: [], cursor: -1,
    hlId: null,
    filterTo: function (blockName) {
      $('liveFilter').value = blockName;
      live.cursor = -1;
      showTab('live');
    }
  };
  var liveTree = $('liveTree');
  var liveTimer = null, liveFilterTimer = null;

  function refreshLive(cb) {
    evalPage(API + ' ? ' + API + '.live() : "null"', function (res, exc) {
      if (exc === 'paused') { liveTree.innerHTML = '<div class="empty">The page is paused by debug mode. The current values are in the pause panel (Flow tab).</div>'; return; }
      if (exc || !res || res === 'null') { liveTree.innerHTML = '<div class="empty">Tracer not found on this page.</div>'; return; }
      try { live.data = JSON.parse(res); } catch (e) { return; }
      renderLive();
      if (cb) cb();
    });
  }
  // Finds the matches inside a block's variables.
  // Returns { count, top: Set(top-level var names with matches), open: Set(paths to expand), keyHit: Set(top keys whose name matches) }
  function matchVars(vars, q, values) {
    var res = { count: 0, top: new Set(), open: new Set(), keyHit: new Set() };
    if (!vars || !q) return res;
    function walk(v, path, top, depth) {
      if (depth > 8 || v == null || typeof v !== 'object') return false;
      var any = false;
      var keys = Array.isArray(v) ? v.map(function (_, i) { return String(i); }) : Object.keys(v);
      keys.forEach(function (k) {
        var child = v[k], p = path + SEP + k, hit = false;
        if (!Array.isArray(v) && k.toLowerCase().indexOf(q) >= 0) { hit = true; res.count++; }
        if (values && child !== null && typeof child !== 'object' && String(child).toLowerCase().indexOf(q) >= 0) { hit = true; res.count++; }
        if (walk(child, p, top, depth + 1)) hit = true;
        if (hit) any = true;
      });
      if (any) res.open.add(path);
      return any;
    }
    Object.keys(vars).forEach(function (k) {
      var v = vars[k], hit = false;
      if (k.toLowerCase().indexOf(q) >= 0) { hit = true; res.count++; res.keyHit.add(k); }
      if (values && v !== null && typeof v !== 'object' && String(v).toLowerCase().indexOf(q) >= 0) { hit = true; res.count++; }
      if (walk(v, k, k, 1)) hit = true;
      if (hit) res.top.add(k);
    });
    return res;
  }
  function renderLive() {
    var arr = live.data;
    if (!arr) { liveTree.innerHTML = '<div class="empty">Loading…</div>'; return; }
    var scrollTop = liveTree.scrollTop;
    var q = $('liveFilter').value.trim().toLowerCase(), values = $('liveValues').checked;
    var byId = {}, kids = {}, roots = [];
    arr.forEach(function (v) { byId[v.id] = v; });
    arr.forEach(function (v) {
      if (v.parent && byId[v.parent]) (kids[v.parent] = kids[v.parent] || []).push(v);
      else roots.push(v);
    });
    var order = function (a, b) { return (a.kind === 'screen' ? 0 : 1) - (b.kind === 'screen' ? 0 : 1) || a.id - b.id; };
    roots.sort(order);
    Object.keys(kids).forEach(function (k) { kids[k].sort(order); });
    // revealed (picked) block: open its ancestors
    var forceOpen = new Set();
    if (live.revealId && byId[live.revealId]) {
      var p = byId[live.revealId], guard = 0;
      while (p && guard++ < 100) { forceOpen.add(p.id); p = p.parent ? byId[p.parent] : null; }
    }
    var info = {}, blocks = 0, total = 0;
    function analyse(v) {
      if (info[v.id]) return info[v.id];
      var blockHit = !!q && ((v.name || '') + ' ' + (v.module || '')).toLowerCase().indexOf(q) >= 0;
      var vm = q ? matchVars(v.vars, q, values) : null;
      var childShown = false;
      (kids[v.id] || []).forEach(function (c) { if (analyse(c).shown) childShown = true; });
      var self = blockHit || (vm && vm.count > 0);
      var r = { blockHit: blockHit, vm: vm, self: self, shown: !q || self || childShown || forceOpen.has(v.id) };
      if (q && self) { blocks++; total += (blockHit ? 1 : 0) + (vm ? vm.count : 0); }
      info[v.id] = r;
      return r;
    }
    roots.forEach(analyse);
    function expanded(v, a) {
      if (forceOpen.has(v.id)) return true;
      if (live.toggled.has(v.id)) return live.toggled.get(v.id);
      if (q) return a.shown;
      // Screens open by default, and so do wrappers without variables (layouts, cards…),
      // so the blocks inside them are visible straight away.
      return v.kind === 'screen' || !v.vars || !Object.keys(v.vars).length;
    }
    function node(v) {
      var a = info[v.id];
      if (!a || !a.shown) return '';
      var open = expanded(v, a);
      var nvars = v.vars ? Object.keys(v.vars).length : 0;
      var kidsHtml = (kids[v.id] || []).map(node).join('');
      var cls = 'lhead' + (live.revealId === v.id ? ' picked' : '') + (q && !a.self ? ' ctxonly' : '');
      var h = '<div class="lnode" data-id="' + v.id + '">' +
        '<div class="' + cls + '" data-id="' + v.id + '">' +
        '<span class="tg">' + (nvars || kidsHtml ? (open ? '▾' : '▸') : '') + '</span>' +
        '<span class="kind ' + v.kind + '">' + v.kind + '</span>' +
        '<b class="lname">' + mark(v.name, q) + '</b> <span class="hint">' + mark(v.module, q) + ' · ' + nvars + ' var' + (nvars === 1 ? '' : 's') + '</span>' +
        (q && a.vm && a.vm.count ? '<span class="badge hitb">' + a.vm.count + ' match' + (a.vm.count > 1 ? 'es' : '') + '</span>' : '') +
        '<span class="lacts">' +
        '<button class="tool small" data-la="reveal" title="Scroll the page to this block and highlight it">⌖ Show in page</button>' +
        '<button class="tool small" data-la="flow" title="Show the flows that involve this block">⚡ Flows</button>' +
        '</span></div>';
      if (open) {
        h += '<div class="lbody">';
        if (nvars) {
          var filter = null;
          if (q && !a.blockHit && !live.allVars.has(v.id) && a.vm) filter = a.vm.top;
          var ctx = { q: q, values: values, open: a.vm ? a.vm.open : null, userOpen: live.userOpen, scope: String(v.id) };
          if (!filter || filter.size) h += '<div class="live-vars" data-scope="' + v.id + '">' + varsTable(v.vars, null, false, ctx, filter) + '</div>';
          if (filter && filter.size < nvars) h += '<div class="more"><span class="link" data-allvars="' + v.id + '">Show all ' + nvars + ' variables</span></div>';
        } else if (!kidsHtml) h += '<div class="sub live-vars">No variables or inputs.</div>';
        if (kidsHtml) h += '<div class="lkids">' + kidsHtml + '</div>';
        h += '</div>';
      }
      return h + '</div>';
    }
    var html = roots.map(node).join('');
    if (!html) html = q ? '<div class="empty">No block or variable matches “' + esc(q) + '”.' + (values ? '' : ' Tick <b>values</b> to also search the values.') + '</div>'
      : '<div class="empty">No screen or block registered yet. Reload the page with the extension enabled.</div>';
    liveTree.innerHTML = html;
    liveTree.scrollTop = scrollTop;
    // matches
    live.hits = Array.prototype.slice.call(liveTree.querySelectorAll('mark'));
    $('liveCount').textContent = q ? (total ? total + ' match' + (total > 1 ? 'es' : '') + ' in ' + blocks + ' block' + (blocks > 1 ? 's' : '') : 'no matches') : '';
    if (live.cursor >= live.hits.length) live.cursor = -1;
    // reveal picked block
    if (live.revealId) {
      var el = liveTree.querySelector('.lhead[data-id="' + live.revealId + '"]');
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
      live.revealId = null;
    }
    renderCrumbs();
  }
  function gotoLiveHit(dir) {
    if (!live.hits.length) return;
    if (live.cursor >= 0 && live.hits[live.cursor]) live.hits[live.cursor].classList.remove('cur');
    live.cursor = live.cursor < 0 ? (dir > 0 ? 0 : live.hits.length - 1) : (live.cursor + dir + live.hits.length) % live.hits.length;
    var m = live.hits[live.cursor];
    var d = m.closest('details');
    while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center' });
    $('liveCount').textContent = (live.cursor + 1) + '/' + live.hits.length + ' matches';
  }
  function renderCrumbs() {
    var c = $('liveCrumbs'), p = live.picked;
    if (!p) { c.classList.add('hidden'); return; }
    c.classList.remove('hidden');
    var chain = (p.chain || []).slice().reverse();
    c.innerHTML = '<span class="hint">Picked:</span> ' + chain.map(function (x) {
      return '<span class="link" data-crumb="' + x.id + '">' + esc(x.name.split('.').pop()) + '</span>';
    }).join(' › ') + (p.widget ? ' <span class="hint">· widget</span> <code>' + esc(p.widget) + '</code>' : '') +
      ' <span class="link close" data-crumb-close="1" title="Hide">✕</span>';
  }
  function showPicked(p, switchTab) {
    live.picked = p;
    live.revealId = p.id;
    if (statusFlash) { statusFlash = null; clearTimeout(statusFlashTimer); setStatus(lastStatus); }
    live.toggled.set(p.id, true);
    if ($('liveFilter').value) { $('liveFilter').value = ''; }
    if (switchTab) showTab('live');
    else if (!$('viewLive').classList.contains('hidden')) refreshLive();
  }
  $('liveCrumbs').addEventListener('click', function (e) {
    var x = e.target.closest('[data-crumb]');
    if (x) { live.revealId = +x.dataset.crumb; live.toggled.set(live.revealId, true); renderLive(); evalPage(API + ' && ' + API + '.reveal(' + (+x.dataset.crumb) + ')'); return; }
    if (e.target.closest('[data-crumb-close]')) { live.picked = null; renderCrumbs(); }
  });
  liveTree.addEventListener('click', function (e) {
    var la = e.target.closest('[data-la]');
    if (la) {
      var id = +la.closest('.lhead').dataset.id;
      var v = (live.data || []).filter(function (x) { return x.id === id; })[0];
      if (la.dataset.la === 'reveal') evalPage(API + ' && ' + API + '.reveal(' + id + ')', function (r) { if (r === false) flashStatus('This block has no visible element in the page.'); });
      else if (la.dataset.la === 'flow' && v) { $('filter').value = v.name; flowHitKey = null; showTab('flow'); }
      return;
    }
    var all = e.target.closest('[data-allvars]');
    if (all) { live.allVars.add(+all.dataset.allvars); renderLive(); return; }
    var head = e.target.closest('.lhead');
    if (head) {
      var hid = +head.dataset.id;
      var isOpenNow = !!head.parentElement.querySelector(':scope > .lbody');
      live.toggled.set(hid, !isOpenNow);
      renderLive();
    }
  });
  // remember JSON nodes opened by the user across refreshes
  liveTree.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d.classList || !d.classList.contains('jt')) return;
    var scopeEl = d.closest('[data-scope]');
    if (!scopeEl) return;
    var key = scopeEl.dataset.scope + SEP + d.dataset.path;
    if (d.open) live.userOpen.add(key); else live.userOpen.delete(key);
  }, true);
  // hovering a block highlights it in the page
  liveTree.addEventListener('mouseover', function (e) {
    var head = e.target.closest('.lhead');
    var id = head ? +head.dataset.id : null;
    if (id === live.hlId) return;
    live.hlId = id;
    evalPage(API + ' && ' + (id ? API + '.highlight(' + id + ')' : API + '.unhighlight()'));
  });
  liveTree.addEventListener('mouseleave', function () {
    if (live.hlId) { live.hlId = null; evalPage(API + ' && ' + API + '.unhighlight()'); }
  });
  $('btnLiveRefresh').addEventListener('click', function () { refreshLive(); });
  $('liveFilter').addEventListener('input', function () {
    clearTimeout(liveFilterTimer);
    liveFilterTimer = setTimeout(function () { live.cursor = -1; live.toggled.clear(); renderLive(); }, 120);
  });
  $('liveFilter').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); gotoLiveHit(e.shiftKey ? -1 : 1); }
  });
  $('livePrev').addEventListener('click', function () { gotoLiveHit(-1); });
  $('liveNext').addEventListener('click', function () { gotoLiveHit(1); });
  $('liveValues').addEventListener('change', function () { live.cursor = -1; renderLive(); });
  $('liveAuto').addEventListener('change', function () {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (this.checked) liveTimer = setInterval(function () {
      if (!$('viewLive').classList.contains('hidden') && !liveTree.matches(':hover')) refreshLive();
    }, 2000);
  });
  // Elements panel selection -> block
  try {
    chrome.devtools.panels.elements.onSelectionChanged.addListener(function () {
      if (!$('liveSync').checked) return;
      evalPage(API + ' ? ' + API + '.fromElement($0) : "null"', function (res, exc) {
        if (exc || !res || res === 'null') return;
        var d; try { d = JSON.parse(res); } catch (e) { return; }
        if (d && d.id) showPicked(d, false);
      });
    });
  } catch (e) {}

  /* ================================================================== */
  /* Debug mode                                                           */
  /* ================================================================== */
  var dbgEls = {
    bar: $('dbgBar'), state: $('dbgState'), mode: $('dbgMode'), ignLife: $('dbgIgnLife'), ignLibs: $('dbgIgnLibs'),
    step: $('dbgStep'), pass: $('dbgPass'), cont: $('dbgCont'), stop: $('dbgStop'), breaks: $('dbgBreaks'), toggle: $('btnDebug')
  };
  function connectBg() {
    try { dbg.port = chrome.runtime.connect({ name: 'oset-panel' }); } catch (e) { dbg.port = null; return; }
    dbg.port.onMessage.addListener(onBgMsg);
    dbg.port.onDisconnect.addListener(function () {
      dbg.port = null; dbg.attached = false;
      if (dbg.paused) { dbg.paused = false; dbg.info = null; }
      updateDbgUI();
      setTimeout(connectBg, 1000);
    });
    dbg.port.postMessage({ cmd: 'hello', tabId: chrome.devtools.inspectedWindow.tabId });
  }
  connectBg();
  setInterval(function () { if (dbg.port) try { dbg.port.postMessage({ cmd: 'ping' }); } catch (e) {} }, 20000);

  function onBgMsg(msg) {
    switch (msg.ev) {
      case 'state':
        dbg.attached = !!msg.attached;
        if (dbg.on && !dbg.attached) dbg.port.postMessage({ cmd: 'attach' });
        if (msg.xhrPaused && !dbg.on) {
          // A pause is held but this panel did not start debug mode: release it.
          dbg.port.postMessage({ cmd: 'answer', response: { cmd: 'stop', config: { active: false } } });
        }
        break;
      case 'attached':
        dbg.attached = true;
        syncDebug();
        break;
      case 'detached':
        dbg.attached = false; dbg.paused = false; dbg.info = null;
        if (msg.reason !== 'panel' && dbg.on) {
          // e.g. the user clicked "Cancel" on Chrome's yellow "is debugging this browser" bar
          dbg.on = false;
          syncDebug();
          flashState('Debugger detached (' + (msg.reason || '?') + ')');
        }
        queueRender();
        break;
      case 'xhrPaused':
        onXhrPause(msg.data);
        break;
      case 'xhrResumed':
        dbg.paused = false; dbg.info = null; dbg.renderedFor = null;
        detailsFor = null;
        queueRender();
        setTimeout(function () { syncDebug(); poll(); }, 50);
        break;
      case 'error':
        flashState('Error: ' + msg.message);
        if (msg.cmd === 'attach') { dbg.on = false; }
        break;
    }
    updateDbgUI();
  }
  function onXhrPause(data) {
    // Apply the records first: if this pause comes from a freshly reloaded page, the session
    // change must not be mistaken for "the page reloaded while paused" (which drops the pause).
    if (data && data.session) applyDrain({ session: data.session, records: data.records || [] });
    dbg.paused = true;
    dbg.info = data && data.info ? data.info : null;
    dbg.renderedFor = null;
    if (dbg.info && dbg.info.frame && session) {
      var k = session + ':' + dbg.info.frame.id;
      if (store.get(k)) selectNode(k, true);
    }
    if ($('viewFlow').classList.contains('hidden')) showTab('flow');
    updateDbgUI();
    queueRender();
  }
  function cfgObject() {
    return { active: dbg.on && dbg.attached, mode: dbg.mode, breaks: Array.from(dbg.breaks.keys()), ignoreLifecycle: dbg.ignLife, ignoreLibs: dbg.ignLibs };
  }
  function syncDebug(cb) {
    if (dbg.paused) { updateDbgUI(); if (cb) cb(); return; }
    evalPage(API + ' && ' + API + '.debug.configure(' + JSON.stringify(cfgObject()) + ')', function () {
      updateDbgUI();
      if (cb) cb();
    });
  }
  function startDebug(modeOverride) {
    if (modeOverride) { dbg.mode = modeOverride; dbgEls.mode.value = modeOverride; }
    dbg.on = true;
    dbgEls.bar.classList.remove('hidden');
    if (!dbg.port) connectBg();
    if (dbg.attached) syncDebug();
    else if (dbg.port) dbg.port.postMessage({ cmd: 'attach' });
    updateDbgUI();
  }
  function stopDebug() {
    dbg.on = false;
    if (dbg.paused && dbg.port) {
      dbg.port.postMessage({ cmd: 'answer', response: { cmd: 'stop', config: cfgObject(), lastSeq: lastSeq } });
      dbg.port.postMessage({ cmd: 'detach' });
      updateDbgUI();
      return;
    }
    syncDebug(function () { if (dbg.port) dbg.port.postMessage({ cmd: 'detach' }); });
    updateDbgUI();
  }
  function resumeWith(cmd) {
    if (!dbg.paused || !dbg.port) return;
    dbg.port.postMessage({ cmd: 'answer', response: { cmd: cmd, config: cfgObject(), lastSeq: lastSeq } });
  }
  dbgEls.toggle.addEventListener('click', function () {
    if (dbg.on) { stopDebug(); dbgEls.bar.classList.add('hidden'); }
    else startDebug();
  });
  dbgEls.stop.addEventListener('click', function () { stopDebug(); });
  dbgEls.step.addEventListener('click', function () { resumeWith('step'); });
  dbgEls.pass.addEventListener('click', function () { resumeWith('pass'); });
  dbgEls.cont.addEventListener('click', function () { resumeWith('cont'); });
  dbgEls.mode.addEventListener('change', function () { dbg.mode = this.value; if (dbg.on) syncDebug(); });
  dbgEls.ignLife.addEventListener('change', function () { dbg.ignLife = this.checked; if (dbg.on) syncDebug(); });
  dbgEls.ignLibs.addEventListener('change', function () { dbg.ignLibs = this.checked; if (dbg.on) syncDebug(); });
  document.addEventListener('keydown', function (e) {
    if (!dbg.paused) return;
    if (e.key === 'F10') { resumeWith('step'); e.preventDefault(); }
    else if (e.key === 'F9') { resumeWith('pass'); e.preventDefault(); }
    else if (e.key === 'F8') { resumeWith('cont'); e.preventDefault(); }
  });

  var flashTimer = null, flashMsg = null;
  function flashState(text) {
    flashMsg = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flashMsg = null; updateDbgUI(); }, 4000);
    updateDbgUI();
  }
  function updateDbgUI() {
    var st = dbgEls.state;
    st.className = 'dbgstate';
    if (flashMsg) st.textContent = flashMsg;
    else if (!dbg.on) st.textContent = '○ off';
    else if (!dbg.attached) st.textContent = '… attaching';
    else if (dbg.paused) { st.textContent = '⏸ paused'; st.classList.add('paused'); }
    else { st.textContent = '● running — waiting'; st.classList.add('running'); }
    dbgEls.bar.classList.toggle('paused', dbg.paused);
    dbgEls.toggle.classList.toggle('on', dbg.on);
    dbgEls.step.disabled = !dbg.paused;
    dbgEls.pass.disabled = !(dbg.paused && dbg.info && dbg.info.thread);
    dbgEls.cont.disabled = !dbg.paused;
    var chips = [];
    dbg.breaks.forEach(function (label, key) {
      chips.push('<span class="bpchip" title="' + esc(key) + '">● ' + esc(label) + ' <b data-bp-del="' + esc(key) + '">×</b></span>');
    });
    dbgEls.breaks.innerHTML = chips.length ? 'Breakpoints: ' + chips.join('') : '<span class="hint">No breakpoints — add them from the details of an action or event.</span>';
  }
  dbgEls.breaks.addEventListener('click', function (e) {
    var b = e.target.closest('[data-bp-del]');
    if (!b) return;
    dbg.breaks.delete(b.dataset.bpDel);
    if (dbg.on) syncDebug();
    detailsFor = null; dbg.renderedFor = null;
    updateDbgUI(); queueRender();
  });
  function bpButton(key, label) {
    var on = dbg.breaks.has(key);
    return ' <button class="tool bpbtn' + (on ? ' on' : '') + '" data-bp="' + esc(key) + '" data-bp-label="' + esc(label) + '">' +
      (on ? '● Breakpoint on' : '○ Breakpoint') + '</button>';
  }
  function wireBpButtons() {
    detailsEl.querySelectorAll('[data-bp]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.bp;
        if (dbg.breaks.has(k)) dbg.breaks.delete(k);
        else dbg.breaks.set(k, b.dataset.bpLabel);
        if (dbg.breaks.size && !dbg.on) startDebug('breaks');
        else if (dbg.on) syncDebug();
        detailsFor = null; dbg.renderedFor = null;
        updateDbgUI(); queueRender();
      });
    });
  }
  function nodesHtml(nodes, currentId) {
    return '<div class="nodes">' + nodes.map(function (x, i) {
      var cur = currentId && x.node === currentId && i === nodes.length - 1;
      return '<div class="' + (cur ? 'cur' : '') + '">' + (cur ? '▶ ' : (i + 1) + '. ') + esc(x.label || ('node ' + x.node.split(':').pop())) + '</div>';
    }).join('') + '</div>';
  }
  var KIND_LABEL = { node: 'Step', action: 'Action entry', trigger: 'Trigger Event' };
  function renderPause() {
    var info = dbg.info;
    var stamp = info ? info.ts : 'none';
    if (dbg.renderedFor === stamp) return;
    dbg.renderedFor = stamp;
    detailsFor = null;
    var h = '';
    if (!info) {
      detailsEl.innerHTML = '<div class="pausebox"><div class="where">⏸ Paused</div><div class="why">Loading…</div></div>';
      return;
    }
    var where = info.kind === 'trigger' ? '⚡ Trigger ' + info.event
      : (info.label || (info.kind === 'action' ? 'Start of ' + (info.frame && info.frame.name) : 'node ' + (info.nodeId || '').split(':').pop()));
    h += '<div class="pausebox"><div class="where">⏸ ' + esc(where) + '</div>' +
      '<div class="why">' + esc(KIND_LABEL[info.kind] || info.kind) + ' · paused by: ' + esc(info.reason) +
      (info.thread ? ' · thread: ' + esc(info.thread.name || info.thread.tid) : '') +
      ' · <kbd>F10</kbd> next step · <kbd>F9</kbd> run thread · <kbd>F8</kbd> continue</div></div>';
    h += kv([
      ['Action', info.frame ? esc(info.frame.name) + (info.frame.owner ? ' <span class="hint">(' + esc(info.frame.owner) + ')</span>' : '') : ''],
      ['Event block', info.block ? esc(info.block) : '']
    ]);
    var ctx = { q: null, values: false };
    if (info.kind === 'trigger') {
      h += '<h3>Event inputs</h3>' + (info.params && Object.keys(info.params).length ? varsTable(info.params, null, false, ctx) : '<div class="sub">No inputs.</div>');
    }
    if (info.frame && session) {
      var fn = store.get(session + ':' + info.frame.id);
      if (fn && fn.nodes && fn.nodes.length) h += '<h3>Steps in this action</h3>' + nodesHtml(fn.nodes, info.nodeId);
    }
    if (info.stack && info.stack.length) {
      h += '<h3>Stack <span class="hint">(most recent first, back to the origin)</span></h3><div class="stack">' + info.stack.map(function (s) {
        if (s.t === 'frame') return '<div class="st-frame">● ' + esc(s.frame.name) + (s.frame.owner ? ' <span class="hint">' + esc(s.frame.owner) + '</span>' : '') + '</div>';
        if (s.t === 'thread') return '<div class="st-thread">⟶ ' + esc(s.name || 'thread') + (s.ctx ? ' · ' + esc(s.ctx) : '') + '</div>';
        return '<div class="st-trigger">⚡ triggered by ' + esc(s.event) + ' from ' + esc(s.block) + '</div>';
      }).join('') + '</div>';
    }
    if (info.vars) {
      var ownerKind = info.frame && info.frame.ownerKind === 'screen' ? 'Screen' : 'Block';
      h += '<h3>' + ownerKind + ' variables <span class="hint">current values at this point</span></h3>' + varsTable(info.vars, null, false, ctx);
    }
    if (info.locals && Object.keys(info.locals).length) h += '<h3>Action locals</h3>' + varsTable(info.locals, null, false, ctx);
    if (info.kind === 'action' && info.bkey) {
      h += '<div style="margin-top:12px">' + bpButton('a:' + info.bkey, info.frame ? info.frame.name : info.bkey) + '</div>';
    }
    detailsEl.innerHTML = h;
    wireBpButtons();
  }
  function markPaused() {
    if (!dbg.paused || !dbg.info || !dbg.info.frame || !session) return;
    var k = session + ':' + dbg.info.frame.id;
    document.querySelectorAll('[data-key="' + cssEsc(k) + '"]').forEach(function (el) { el.classList.add('paused-here'); });
  }

  updateDbgUI();
})();
