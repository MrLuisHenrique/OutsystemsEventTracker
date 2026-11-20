/*
 * OutSystems Event Tracer - page hook (runs in the MAIN world at document_start).
 *
 * Observes the OutSystems Reactive runtime without changing app behaviour:
 *  - window.define (AMD): wraps "*.mvc$view" modules to
 *      * swap React.createElement for a version that wraps the event handlers a
 *        parent passes to a block (props.events) -> captures Trigger Event + inputs
 *      * register live Screen/Block instances (model.variables)
 *  - OutSystemsDebugger.push/pop/setThreadStartName/handleBreakpoint/handleException
 *      -> rebuilds the action stack per "thread" (callContext.id) in modules
 *         compiled with debug information (typically dev)
 *  - Controllers compiled without debug information (typically prod): wraps the
 *    client actions (_name$Action) and lifecycle handlers directly
 *  - BaseViewController.callServerAction/callDataAction/callAggregate*
 *      -> records server calls and their duration
 *  - Block picker / highlight: maps DOM elements to blocks through React fibers
 *
 * Records are kept in an in-memory buffer; the DevTools panel reads them with
 * chrome.devtools.inspectedWindow.eval("window.__osEventTracer.drain(...)").
 */
(function () {
  'use strict';
  if (window.__osEventTracer) return;

  var VERSION = '0.6.0';
  var MAX_RECORDS = 10000;
  var MAX_DRAIN = 3000;
  var MAX_DEPTH = 5;
  var MAX_ITEMS = 30;
  var MAX_STR = 2000;
  var PENDING_TTL = 10000;

  var S = {
    session: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    seq: 0,
    nodeSeq: 0,
    records: [],
    enabled: true,
    snapshots: true,
    OS: null,
    OSView: null,
    detected: false,
    debuggerHooked: false,
    debuggerHookError: null,
    controllerHooked: false,
    defineHooked: false,
    lastTid: null,
    lastDrained: 0,
    pending: [],              // triggers waiting for their handler thread
    renderStack: [],          // views currently rendering
    triggerStack: [],         // triggers currently running (synchronously)
    synthNames: new Map(),    // tid -> thread name (lifecycle) for controllers without debug info
    kindByName: {},           // displayName -> 'screen' | 'block'
    ctrlDev: 0, ctrlProd: 0,
    dbg: {
      active: false,          // debug mode enabled by the panel (and the extension is attached)
      mode: 'step',           // 'step' | 'actions' | 'events' | 'breaks'
      breaks: {},             // 'a:<action key>' / 'e:<Block>|<Event>'
      ignoreLifecycle: true,
      ignoreLibs: true,
      step: false,            // stop at the next node
      pass: {},               // tid -> true (threads allowed to run to the end)
      paused: null,
      pauses: 0,
      lastError: null
    }
  };

  var threadsByTid = new Map();
  var threadsById = new Map();    // internal id -> open thread (for the stack)
  var nodeLabels = new Map();     // node id (handleBreakpoint) -> Service Studio label
  var views = new Map();          // View instance -> info
  var viewsById = new Map();      // info.id -> View instance
  var idOwner = new WeakMap();    // idService -> View instance (who renders a child block)
  var modelOwner = new WeakMap(); // model -> info
  var reactWrapped = new WeakMap();
  var protoAttrCache = new WeakMap();
  var viewSeq = 0;

  function now() { return performance.timeOrigin + performance.now(); }
  function nid(p) { return p + (++S.nodeSeq); }
  function emit(r) {
    r.seq = ++S.seq;
    if (r.ts === undefined) r.ts = now();
    S.records.push(r);
    if (S.records.length > MAX_RECORDS + 500) S.records.splice(0, S.records.length - MAX_RECORDS);
  }
  function hide(obj, key, val) {
    try { Object.defineProperty(obj, key, { value: val, configurable: true, writable: true, enumerable: false }); } catch (e) {}
  }
  function patch(owner, name, fn) {
    var d = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, { value: fn, writable: true, configurable: true, enumerable: d ? !!d.enumerable : false });
  }

  /* ------------------------------------------------------------------ */
  /* Serialization of OutSystems values                                  */
  /* ------------------------------------------------------------------ */
  var NAME_SUFFIX = /(Attr|Var|In|Out|Local|DataAct|Aggr)$/;
  function pretty(k) {
    var s = String(k).replace(/(InLocal|Attr|Var|In|Out|Local|DataAct|Aggr)$/, '');
    if (!s) s = String(k);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function protoAttrNames(proto) {
    var cached = protoAttrCache.get(proto);
    if (cached) return cached;
    var names = [], seen = {}, p = proto, depth = 0;
    while (p && p !== Object.prototype && depth < 10) {
      var own = Object.getOwnPropertyNames(p);
      for (var i = 0; i < own.length; i++) {
        var n = own[i];
        if (seen[n] || n.charAt(0) === '_' || n === 'constructor') continue;
        seen[n] = 1;
        var d = Object.getOwnPropertyDescriptor(p, n);
        if (d && d.get && NAME_SUFFIX.test(n)) names.push(n);
      }
      p = Object.getPrototypeOf(p); depth++;
    }
    protoAttrCache.set(proto, names);
    return names;
  }
  function attrNames(v) {
    var names = [];
    var proto = Object.getPrototypeOf(v);
    if (proto && proto !== Object.prototype) names = protoAttrNames(proto).slice();
    var own = Object.keys(v);
    for (var i = 0; i < own.length; i++) {
      var n = own[i];
      if (n.charAt(0) === '_' || names.indexOf(n) >= 0 || !NAME_SUFFIX.test(n)) continue;
      try { if (typeof v[n] === 'function') continue; } catch (e) { continue; }
      names.push(n);
    }
    return names;
  }
  function listItems(v) {
    if (Array.isArray(v)) return v;
    var len = null;
    try { len = typeof v.length === 'number' ? v.length : null; } catch (e) {}
    if (len === null) return null;
    if (typeof v.toArray === 'function') {
      try { var a = v.toArray(); if (Array.isArray(a)) return a; } catch (e) {}
    }
    var getter = typeof v.getItem === 'function' ? 'getItem' : (typeof v.get === 'function' ? 'get' : null);
    if (getter || typeof v.getCurrent === 'function') {
      var out = [], n = Math.min(len, MAX_ITEMS + 1);
      for (var i = 0; i < n; i++) {
        try { out.push(getter ? v[getter](i) : v[i]); } catch (e) { out.push('[error]'); }
      }
      out.__total = len;
      return out;
    }
    return null;
  }
  function ser(v, depth, seen) {
    depth = depth || 0; seen = seen || [];
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '\u2026' : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return String(v);
    if (t === 'function') return '[function]';
    if (t !== 'object') return String(v);
    if (seen.indexOf(v) >= 0) return '[circular]';
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (typeof Element !== 'undefined' && v instanceof Element) return '<' + v.tagName.toLowerCase() + '>';
    if (depth >= MAX_DEPTH) return '\u2026';
    seen.push(v);
    try {
      var items = listItems(v);
      if (items) {
        var total = items.__total !== undefined ? items.__total : items.length;
        var out = [], n = Math.min(items.length, MAX_ITEMS);
        for (var i = 0; i < n; i++) out.push(ser(items[i], depth + 1, seen));
        if (total > n) out.push('\u2026 +' + (total - n) + ' more items');
        return out;
      }
      var names = attrNames(v);
      if (names.length) {
        var o = {};
        for (var j = 0; j < names.length; j++) {
          var val;
          try { val = v[names[j]]; } catch (e) { val = '[error]'; }
          o[pretty(names[j])] = ser(val, depth + 1, seen);
        }
        return o;
      }
      if (typeof v.toString === 'function' && v.toString !== Object.prototype.toString) {
        var s = String(v);
        if (s !== '[object Object]') return s;
      }
      var keys = Object.keys(v).filter(function (k) { return k.charAt(0) !== '_'; }).slice(0, 40);
      var o2 = {};
      for (var k = 0; k < keys.length; k++) {
        var val2;
        try { val2 = v[keys[k]]; } catch (e) { continue; }
        if (typeof val2 === 'function') continue;
        o2[keys[k]] = ser(val2, depth + 1, seen);
      }
      return o2;
    } catch (e) {
      return '[error: ' + (e && e.message) + ']';
    } finally {
      seen.pop();
    }
  }
  function serVars(model) {
    try { return model && model.variables ? ser(model.variables, 0) : null; } catch (e) { return { error: String(e) }; }
  }
  function isHolder(v) { return v && typeof v === 'object' && 'value' in v && Object.keys(v).length <= 2; }
  function serLocals(varBag) {
    var out = {};
    try {
      Object.keys(varBag).forEach(function (k) {
        if (k === 'model' || k === 'idService' || k === 'callContext') return;
        var v = varBag[k];
        if (isHolder(v)) v = v.value;
        var s = ser(v, 1);
        if (k === 'vars' && s && typeof s === 'object' && !Array.isArray(s)) {
          Object.keys(s).forEach(function (kk) { out[kk] = s[kk]; });
        } else {
          out[pretty(k)] = s;
        }
      });
    } catch (e) {}
    return out;
  }
  function serInputs(varBag) {
    try {
      if (varBag && isHolder(varBag.vars)) {
        var s = ser(varBag.vars.value, 1);
        if (s && typeof s === 'object' && Object.keys(s).length) return s;
      }
    } catch (e) {}
    return undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Live Screens / Blocks                                                */
  /* ------------------------------------------------------------------ */
  function viewKind(inst) {
    try {
      var BV = S.OSView && S.OSView.BaseView;
      if (BV && BV.BaseWebScreen && inst instanceof BV.BaseWebScreen) return 'screen';
    } catch (e) {}
    return 'block';
  }
  function registerView(inst, View, moduleName) {
    var info = views.get(inst);
    if (!info) {
      info = { id: ++viewSeq, name: View.displayName || '?', module: moduleName, kind: viewKind(inst) };
      views.set(inst, info);
      viewsById.set(info.id, inst);
    }
    if (inst.model) modelOwner.set(inst.model, info);
    try { if (inst.idService && typeof inst.idService === 'object') idOwner.set(inst.idService, inst); } catch (e) {}
  }
  function unregisterView(inst) {
    var info = views.get(inst);
    if (info) viewsById.delete(info.id);
    views.delete(inst);
  }
  function fiberOfInstance(inst) {
    try { return inst._reactInternals || inst._reactInternalFiber || null; } catch (e) { return null; }
  }
  function parentView(inst) {
    try {
      var f = fiberOfInstance(inst);
      f = f && f.return;
      var guard = 0;
      while (f && guard++ < 2000) {
        var sn = f.stateNode;
        if (sn && sn !== inst && views.has(sn)) return sn;
        f = f.return;
      }
    } catch (e) {}
    return null;
  }
  function reactParent(inst) {
    var p = parentView(inst);
    return p ? views.get(p).id : null;
  }
  function patchView(View, defineName) {
    var proto = View.prototype;
    if (!proto || proto.__osetPatched) return;
    hide(proto, '__osetPatched', true);
    var moduleName = defineName.split('.')[0];
    try {
      var BV = S.OSView && S.OSView.BaseView;
      S.kindByName[View.displayName] = (BV && BV.BaseWebScreen && proto instanceof BV.BaseWebScreen) ? 'screen' : 'block';
    } catch (e) {}
    var origRender = proto.internalRender;
    if (typeof origRender === 'function') {
      patch(proto, 'internalRender', function () {
        try { registerView(this, View, moduleName); } catch (e) {}
        S.renderStack.push(this);
        try { return origRender.apply(this, arguments); } finally { S.renderStack.pop(); }
      });
    }
    var origUnmount = proto.componentWillUnmount;
    patch(proto, 'componentWillUnmount', function () {
      try { unregisterView(this); } catch (e) {}
      if (typeof origUnmount === 'function') return origUnmount.apply(this, arguments);
    });
  }
  function screensSnapshot() {
    var out = [];
    views.forEach(function (info, inst) {
      if (info.kind === 'screen') out.push({ name: info.name, module: info.module, vars: serVars(inst.model) });
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Events between blocks (props.events)                                 */
  /* ------------------------------------------------------------------ */
  function parseParams(fn) {
    try {
      var m = Function.prototype.toString.call(fn).match(/^[^(]*\(([^)]*)\)/);
      if (!m) return [];
      return m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    } catch (e) { return []; }
  }
  function prettyEvent(key) {
    var s = key.replace(/\$Action$/, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function isCallContext(a) {
    return a && typeof a === 'object' && typeof a.clone === 'function' && 'id' in a;
  }
  function topFrame(th) { return th && th.open.length ? th.open[th.open.length - 1] : null; }
  function prunePending() {
    var t = now();
    if (S.pending.length) S.pending = S.pending.filter(function (p) { return t - p.ts < PENDING_TTL; });
  }

  function onTrigger(child, evName, paramNames, args, parentModel) {
    if (!S.enabled && !S.dbg.active) return null;
    var tid = S.lastTid;
    for (var a = 0; a < args.length; a++) if (isCallContext(args[a])) { tid = args[a].id; break; }
    var th = tid != null ? threadsByTid.get(tid) : null;
    var parent = topFrame(th);
    // Event fired directly by another event handler (no action in between):
    // attach it to the trigger that is currently running.
    var parentTrigger = !th && S.triggerStack.length ? S.triggerStack[S.triggerStack.length - 1] : null;
    var params = {};
    var i;
    for (i = 0; i < paramNames.length; i++) {
      if (isCallContext(args[i])) continue;
      params[pretty(paramNames[i])] = ser(args[i], 0);
    }
    for (; i < args.length; i++) {
      if (isCallContext(args[i])) continue;
      params['arg' + i] = ser(args[i], 0);
    }
    var id = nid('g');
    if (S.enabled) emit({
      t: 'trigger', id: id,
      thread: th ? th.id : null, parent: parent ? parent.id : (parentTrigger || null),
      block: child, event: evName, params: params,
      screens: S.snapshots ? screensSnapshot() : undefined
    });
    prunePending();
    S.pending.push({
      id: id, ts: now(), event: evName, block: child, fromThread: th ? th.id : null, parentModel: parentModel || null,
      match: (child.replace(/\./g, '/') + ' ' + evName).toLowerCase()
    });
    maybePause('trigger', tid, { block: child, event: evName, params: params, bkey: child + '|' + evName });
    return id;
  }
  function wrapEventFn(fn, key, child, ownerView) {
    var names = parseParams(fn);
    var evName = prettyEvent(key);
    return function () {
      var tg = null;
      try {
        ensureDebuggerHook();
        tg = onTrigger(child, evName, names, arguments, ownerView && ownerView.model);
      } catch (e) {}
      if (tg) S.triggerStack.push(tg);
      try { return fn.apply(this, arguments); } finally { if (tg) S.triggerStack.pop(); }
    };
  }
  function wrapEvents(events, child, ownerView) {
    var out = {};
    Object.keys(events).forEach(function (k) {
      var fn = events[k];
      out[k] = (k === '_handleError' || typeof fn !== 'function') ? fn : wrapEventFn(fn, k, child, ownerView);
    });
    return out;
  }
  // The view that renders a child block. Placeholder content is evaluated lazily
  // (inside the layout block's render), so the render stack can point to the wrong
  // view; the idService passed in _idProps always belongs to the real owner.
  function ownerOfProps(props) {
    try {
      var svc = props._idProps && props._idProps.service;
      if (svc && idOwner.has(svc)) return idOwner.get(svc);
    } catch (e) {}
    return S.renderStack.length ? S.renderStack[S.renderStack.length - 1] : null;
  }
  function wrapReact(R) {
    if (!R || typeof R.createElement !== 'function') return R;
    var w = reactWrapped.get(R);
    if (w) return w;
    w = Object.create(R);
    w.createElement = function (type, props) {
      try {
        if ((S.enabled || S.dbg.active) && props && props.events && typeof type === 'function' && type.displayName) {
          props.events = wrapEvents(props.events, type.displayName, ownerOfProps(props));
        }
      } catch (e) {}
      return R.createElement.apply(R, arguments);
    };
    reactWrapped.set(R, w);
    return w;
  }
  // Debug-compiled handlers name their thread "<Flow>/<Block> <Event>".
  function matchPending(name) {
    var lname = String(name).toLowerCase();
    var i;
    prunePending();
    for (i = 0; i < S.pending.length; i++) {
      if (S.pending[i].match === lname) return S.pending.splice(i, 1)[0];
    }
    for (i = 0; i < S.pending.length; i++) {
      var ev = ' ' + S.pending[i].event.toLowerCase();
      if (lname.slice(-ev.length) === ev) return S.pending.splice(i, 1)[0];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* OutSystemsDebugger hook                                              */
  /* ------------------------------------------------------------------ */
  function getThread(tid, create) {
    var th = threadsByTid.get(tid);
    if (!th && create) {
      th = { id: nid('t'), tid: tid, name: null, open: [], origin: null };
      threadsByTid.set(tid, th);
      threadsById.set(th.id, th);
      emit({ t: 'thread', id: th.id, tid: String(tid) });
    }
    return th;
  }
  function topAction(th) {
    if (!th) return null;
    for (var i = th.open.length - 1; i >= 0; i--) if (th.open[i].kind === 'action') return th.open[i];
    return null;
  }
  function onPush(key, module, name, type, tid, varBag, opts) {
    S.lastTid = tid;
    if (!S.enabled && !S.dbg.active) return null;
    var th = getThread(tid, true);
    var parent = topFrame(th);
    var kind = /(WebFlow|WebBlock|WebScreen)$/.test(String(type)) ? 'context' : 'action';
    var owner = varBag && varBag.model ? modelOwner.get(varBag.model) : null;
    var prefix = opts && opts.prefix ? opts.prefix : String(key).split(':').slice(0, 2).join(':');
    var bkey = opts && opts.bkey ? opts.bkey : prefix;
    var fr = {
      id: nid('f'), prefix: prefix, varBag: varBag, kind: kind, name: name, module: module, type: type,
      owner: owner ? owner.name : null, ownerKind: owner ? owner.kind : null
    };
    th.open.push(fr);
    if (S.enabled) {
      var rec = {
        t: 'frame', id: fr.id, thread: th.id, parent: parent ? parent.id : null,
        module: module, name: name, type: type, kind: kind, bkey: bkey
      };
      if (owner) { rec.owner = owner.name; rec.ownerKind = owner.kind; rec.ownerModule = owner.module; }
      if (kind === 'action' && S.snapshots && varBag) {
        if (varBag.model) rec.before = serVars(varBag.model);
        var inp = serInputs(varBag);
        if (inp) rec.inputs = inp;
      }
      emit(rec);
    }
    if (kind === 'action') maybePause('action', tid, { bkey: bkey, label: 'Start of ' + name, synth: !!(opts && opts.synth) });
    return fr;
  }
  function onNode(nodeId, tid) {
    S.lastTid = tid;
    if (!S.dbg.active) return;
    var th = threadsByTid.get(tid);
    var f = topAction(th);
    var label = nodeLabels.get(nodeId) || null;
    if (S.enabled && f) emit({ t: 'node', frame: f.id, node: String(nodeId), label: label });
    maybePause('node', tid, { nodeId: String(nodeId), label: label });
  }
  function onPop(prefix, tid) {
    var th = threadsByTid.get(tid);
    if (!th) return;
    for (var i = th.open.length - 1; i >= 0; i--) {
      var f = th.open[i];
      if (f.prefix === prefix) {
        th.open.splice(i, 1);
        var rec = { t: 'end', id: f.id };
        if (f.kind === 'action' && S.snapshots && f.varBag) {
          if (f.varBag.model) rec.after = serVars(f.varBag.model);
          var loc = serLocals(f.varBag);
          if (Object.keys(loc).length) rec.locals = loc;
        }
        f.varBag = null;
        if (S.enabled) emit(rec);
        break;
      }
    }
    if (!th.open.length) {
      threadsByTid.delete(tid);
      threadsById.delete(th.id);
      delete S.dbg.pass[tid];
      if (S.enabled) emit({ t: 'threadEnd', id: th.id });
    }
  }
  function onThreadName(tid, name) {
    S.lastTid = tid;
    if (!S.enabled && !S.dbg.active) return;
    var th = getThread(tid, true);
    if (!th.name) {
      th.name = String(name);
      var p = matchPending(name);
      if (p) th.origin = { id: p.id, block: p.block, event: p.event, fromThread: p.fromThread };
      if (S.enabled) emit({ t: 'threadName', id: th.id, name: String(name), trigger: p ? p.id : null });
    }
  }
  function onException(ex, tid) {
    if (!S.enabled) return;
    var th = threadsByTid.get(tid);
    var f = topFrame(th);
    var msg;
    try { msg = ex && (ex.message || String(ex)); } catch (e) { msg = '[error]'; }
    emit({ t: 'error', id: f ? f.id : null, thread: th ? th.id : null, message: msg });
  }
  function wrap(obj, name, make) {
    var orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = make(orig);
  }
  function ensureDebuggerHook() {
    var d = window.OutSystemsDebugger;
    if (!d || (typeof d !== 'object' && typeof d !== 'function')) return;
    if (d.__osetHooked === S.session) return;
    try {
      wrap(d, 'push', function (orig) {
        return function (key, module, name, type, tid, varBag) {
          try { onPush(key, module, name, type, tid, varBag); } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
      wrap(d, 'pop', function (orig) {
        return function (key, tid) {
          try { onPop(String(key), tid); } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
      wrap(d, 'setThreadStartName', function (orig) {
        return function (tid, name) {
          try { onThreadName(tid, name); } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
      wrap(d, 'handleBreakpoint', function (orig) {
        return function (id, tid) {
          S.lastTid = tid;
          if (S.dbg.active) { try { onNode(id, tid); } catch (e) {} }
          return orig.apply(this, arguments);
        };
      });
      wrap(d, 'handleException', function (orig) {
        return function (ex, tid) {
          try { onException(ex, tid); } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
      hide(d, '__osetHooked', S.session);
      S.debuggerHooked = true;
      S.debuggerHookError = null;
    } catch (e) {
      S.debuggerHookError = String((e && e.message) || e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Controllers compiled without debug information (production)          */
  /* ------------------------------------------------------------------ */
  // Without OutSystemsDebugger.push/pop the stack is rebuilt by wrapping the
  // controller's own client actions (_name$Action) and lifecycle handlers.
  var LIFECYCLE_LABELS = {
    onInitializeEventHandler: 'On Initialize', onReadyEventHandler: 'On Ready',
    onRenderEventHandler: 'On Render', onDestroyEventHandler: 'On Destroy',
    onParametersChangedEventHandler: 'On Parameters Changed'
  };
  var synthSeq = 0;
  function ctrlInfoFromDefine(defineName) {
    var base = String(defineName || '').replace(/\.mvc\$controller$/, '');
    var i = base.indexOf('.');
    return { module: i > 0 ? base.slice(0, i) : base, display: i > 0 ? base.slice(i + 1) : base };
  }
  function findCtxArg(args) {
    for (var i = args.length - 1; i >= 0; i--) if (isCallContext(args[i])) return args[i];
    return null;
  }
  function actionNameOf(fn, key) {
    try {
      var m = Function.prototype.toString.call(fn).match(/ensureControllerAlive\("([^"]+)"\)/);
      if (m) return m[1];
    } catch (e) {}
    var n = key.replace(/^_/, '').replace(/\$Action$/, '');
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  // Oldest first: deferred handlers run in the order their events were triggered.
  function linkPendingByModel(model) {
    if (!model) return null;
    prunePending();
    for (var i = 0; i < S.pending.length; i++) {
      if (S.pending[i].parentModel === model) return S.pending.splice(i, 1)[0];
    }
    return null;
  }
  function takePendingById(id) {
    for (var i = 0; i < S.pending.length; i++) if (S.pending[i].id === id) return S.pending.splice(i, 1)[0];
    return null;
  }
  function synthOwner(info, model) {
    if (model && !modelOwner.has(model)) {
      modelOwner.set(model, { id: 0, name: info.display, module: info.module, kind: S.kindByName[info.display] || 'block' });
    }
    var o = model ? modelOwner.get(model) : null;
    if (o && !o.id && S.kindByName[info.display]) o.kind = S.kindByName[info.display];
    return o;
  }
  // Opens (when needed) the synthetic thread and its flow > block context frames.
  function synthThread(tid, info, model, firstAction) {
    var th = threadsByTid.get(tid);
    if (th) return th;
    th = getThread(tid, true);
    th.synth = true;
    var name = S.synthNames.get(tid), origin = null;
    S.synthNames.delete(tid);
    if (!name) {
      // Handler of a block event: link to its trigger (synchronous, or by the parent's model).
      var tg = S.triggerStack.length ? takePendingById(S.triggerStack[S.triggerStack.length - 1]) : null;
      if (!tg) tg = linkPendingByModel(model);
      if (tg) {
        origin = tg;
        name = tg.block.replace(/\./g, '/') + ' ' + tg.event;
      } else {
        name = info.display.replace(/\./g, '/') + '/' + firstAction;
      }
    }
    th.name = name;
    if (origin) th.origin = { id: origin.id, block: origin.block, event: origin.event, fromThread: origin.fromThread };
    if (S.enabled) emit({ t: 'threadName', id: th.id, name: name, trigger: origin ? origin.id : null });
    var parts = info.display.split('.');
    var kind = S.kindByName[info.display] === 'screen' ? 'NRNodes.WebScreen' : 'NRNodes.WebBlock';
    th.synthCtx = [];
    if (parts.length > 1) th.synthCtx.push(onPush('synthctx', info.module, parts[0], 'NRFlows.WebFlow', tid, null, { prefix: 'sc:' + (++synthSeq) }));
    th.synthCtx.push(onPush('synthctx', info.module, parts[parts.length - 1], kind, tid, null, { prefix: 'sc:' + (++synthSeq) }));
    return th;
  }
  function synthCloseIfDone(th) {
    if (!th || !th.synthCtx) return;
    var onlyCtx = th.open.every(function (f) { return f.kind === 'context'; });
    if (!onlyCtx) return;
    var ctx = th.synthCtx;
    th.synthCtx = null;
    for (var i = ctx.length - 1; i >= 0; i--) if (ctx[i]) onPop(ctx[i].prefix, th.tid);
  }
  function wrapSynthAction(orig, key, info) {
    var actName = actionNameOf(orig, key);
    var params = parseParams(orig).filter(function (p) { return p !== 'callContext'; });
    var bkey = 'p:' + info.module + '.' + info.display + '.' + actName;
    var w = function () {
      var ctx = findCtxArg(arguments);
      var tid = ctx ? ctx.id : ('synth-' + (++synthSeq));
      var model = null, fr = null;
      try { model = this && this.model; } catch (e) {}
      if (S.enabled || S.dbg.active) {
        try {
          synthOwner(info, model);
          synthThread(tid, info, model, actName);
          var inputs = null;
          for (var i = 0; i < params.length && i < arguments.length; i++) {
            if (isCallContext(arguments[i])) continue;
            (inputs = inputs || {})[pretty(params[i])] = arguments[i];
          }
          var varBag = { model: model };
          if (inputs) varBag.vars = { value: inputs };
          fr = onPush('synth', info.module, actName, 'NRFlows.ClientScreenActionFlow', tid, varBag,
            { prefix: 'sa:' + (++synthSeq), bkey: bkey, synth: true });
        } catch (e) { fr = null; }
      }
      var done = function () {
        if (!fr) return;
        try { onPop(fr.prefix, tid); synthCloseIfDone(threadsByTid.get(tid)); } catch (e) {}
      };
      var r;
      try { r = orig.apply(this, arguments); }
      catch (ex) { try { if (fr) onException(ex, tid); } catch (e) {} done(); throw ex; }
      if (r && typeof r.then === 'function') {
        r.then(done, function (ex) { try { if (fr) onException(ex, tid); } catch (e) {} done(); });
      } else done();
      return r;
    };
    hide(w, '__osetOrig', orig);
    return w;
  }
  function wrapSynthLifecycle(orig, key, info) {
    var label = LIFECYCLE_LABELS[key];
    return function (callContext) {
      try {
        var ctx = isCallContext(callContext) ? callContext : findCtxArg(arguments);
        if (ctx && !threadsByTid.has(ctx.id)) S.synthNames.set(ctx.id, info.display.replace(/\./g, '/') + ' ' + label);
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }
  function patchControllerClass(C, defineName) {
    var proto = C && C.prototype;
    if (!proto || proto.__osetCtrl) return;
    hide(proto, '__osetCtrl', true);
    // Compiled with debug information: the OutSystemsDebugger hook already covers it.
    if (typeof proto.pushDebuggerContext === 'function') { S.ctrlDev++; return; }
    S.ctrlProd++;
    var info = ctrlInfoFromDefine(defineName);
    Object.getOwnPropertyNames(proto).forEach(function (k) {
      if (k === 'constructor') return;
      var d = Object.getOwnPropertyDescriptor(proto, k);
      if (!d || typeof d.value !== 'function') return;
      try {
        if (/^_[A-Za-z0-9_]+\$Action$/.test(k)) patch(proto, k, wrapSynthAction(d.value, k, info));
        else if (Object.prototype.hasOwnProperty.call(LIFECYCLE_LABELS, k)) patch(proto, k, wrapSynthLifecycle(d.value, k, info));
      } catch (e) {}
    });
  }
  var currentControllerDefine = null;
  function hookControllerFactory() {
    var C = S.OS && S.OS.Controller;
    if (!C || typeof C.ControllerFactory !== 'function' || C.ControllerFactory.__osetWrapped) return;
    var Orig = C.ControllerFactory;
    var W = function (Controller) {
      try { if (currentControllerDefine) patchControllerClass(Controller, currentControllerDefine); } catch (e) {}
      return Reflect.construct(Orig, arguments);
    };
    W.prototype = Orig.prototype;
    try { Object.setPrototypeOf(W, Orig); } catch (e) {}
    hide(W, '__osetWrapped', true);
    try { C.ControllerFactory = W; } catch (e) {}
  }
  // Fallback when the ControllerFactory could not be replaced.
  function patchFromFactoryResult(res, defineName) {
    if (!res || typeof res !== 'object') return;
    Object.keys(res).forEach(function (k) {
      var v = res[k];
      if (typeof v === 'function' && v.prototype && 'dataFetchActionNames' in v.prototype) patchControllerClass(v, defineName);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Debug mode                                                           */
  /* ------------------------------------------------------------------ */
  // A pause is a synchronous XHR to PAUSE_PATH: it blocks the page until the
  // extension (chrome.debugger + Fetch) answers with the command chosen in the
  // panel. V8 never enters "paused", so DevTools does not jump to Sources.
  // A tiny probe request goes first: the payload (which contains variable
  // values) is only sent once the extension has confirmed it is intercepting,
  // so it can never reach the application server.
  var LIFECYCLE_RE = /\s(On Render|On Ready|On Initialize|On Parameters Changed|On Destroy|On After Fetch)$/i;
  var PAUSE_PATH = '/__os_event_tracer_pause__';
  function threadSkipped(th) {
    var d = S.dbg;
    if (!th) return false;
    if (d.pass[th.tid]) return true;
    if (d.ignoreLifecycle && th.name && LIFECYCLE_RE.test(th.name)) return true;
    return false;
  }
  function maybePause(kind, tid, extra) {
    var d = S.dbg;
    if (!d.active || d.paused) return;
    var th = tid != null ? threadsByTid.get(tid) : null;
    var f = topAction(th);
    var hit = false, reason = '';
    if (kind === 'node') {
      if (d.step) { hit = true; reason = 'step'; }
      else if (d.mode === 'step') { hit = true; reason = 'every step'; }
    } else if (kind === 'action') {
      if (d.breaks['a:' + extra.bkey]) { hit = true; reason = 'breakpoint'; }
      else if (d.step && extra.synth) { hit = true; reason = 'step'; }
      else if (d.mode === 'actions') { hit = true; reason = 'action entry'; }
      else if (d.mode === 'step' && extra.synth) { hit = true; reason = 'every step'; }
    } else if (kind === 'trigger') {
      if (d.breaks['e:' + extra.bkey]) { hit = true; reason = 'breakpoint'; }
      else if (d.step && th && th.synth) { hit = true; reason = 'step'; }
      else if (d.mode === 'events') { hit = true; reason = 'Trigger Event'; }
      else if (d.mode === 'step' && th && th.synth) { hit = true; reason = 'every step'; }
    }
    if (!hit) return;
    // Explicit breakpoints ignore the filters; automatic modes do not.
    if (reason !== 'breakpoint') {
      if (threadSkipped(th)) return;
      if (d.ignoreLibs && f && /^OutSystems/.test(String(f.module))) return;
    } else if (th && d.pass[th.tid]) return;
    d.step = false;
    d.pauses++;
    d.paused = buildPauseInfo(kind, reason, th, f, extra);
    try {
      var r = pauseViaXhr(d.paused);
      if (!r) {
        // Nobody answered: the panel/extension is gone. Switch debug mode off.
        applyDebugConfig({ active: false }, true);
        emit({ t: 'info', message: 'Debug mode switched off: ' + (S.dbg.lastError || 'the extension did not answer') });
      } else applyPauseAnswer(r, th);
    } finally { d.paused = null; }
  }
  function syncPost(query, body) {
    var x = new XMLHttpRequest();
    x.open('POST', location.origin + PAUSE_PATH + '?s=' + S.session + '&' + query, false);
    x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    x.send(body);
    if (x.status !== 200 || x.getResponseHeader('X-OSET') !== '1') return null;
    try { return JSON.parse(x.responseText); } catch (e) { return null; }
  }
  function pauseViaXhr(info) {
    var n = S.dbg.pauses;
    S.dbg.lastError = null;
    try {
      var probe = syncPost('probe=1&n=' + n, '');
      if (!probe || probe.cmd !== 'ready') {
        S.dbg.lastError = probe && probe.cmd === 'stop' ? 'the panel was closed' : 'the extension is not intercepting this page';
        return null;
      }
    } catch (e) {
      S.dbg.lastError = 'pause request blocked (' + ((e && e.message) || e) + ')';
      return null;
    }
    var payload;
    try {
      var recs = [];
      for (var i = S.records.length - 1; i >= 0 && S.records[i].seq > S.lastDrained; i--) recs.push(S.records[i]);
      recs.reverse();
      if (recs.length > 1500) recs = recs.slice(recs.length - 1500);
      payload = JSON.stringify({ session: S.session, info: info, records: recs });
      if (payload.length > 4000000) {
        payload = JSON.stringify({ session: S.session, info: Object.assign({}, info, { vars: { warning: 'snapshot too large' }, locals: null }), records: [] });
      }
    } catch (e) {
      payload = JSON.stringify({ session: S.session, info: { kind: info.kind, reason: info.reason, label: info.label }, records: [] });
    }
    var ans = null;
    try { ans = syncPost('n=' + n, payload); } catch (e) { S.dbg.lastError = String((e && e.message) || e); }
    if (ans && ans.lastSeq) S.lastDrained = Math.max(S.lastDrained, ans.lastSeq);
    return ans;
  }
  function applyPauseAnswer(r, th) {
    var d = S.dbg;
    if (r.config) applyDebugConfig(r.config, true);
    if (r.cmd === 'step') d.step = true;
    else if (r.cmd === 'pass') { if (th) d.pass[th.tid] = true; d.step = false; }
    else if (r.cmd === 'stop') { applyDebugConfig({ active: false }, true); }
    else d.step = false;
  }
  function frameInfo(f) {
    return { id: f.id, name: f.name, owner: f.owner, ownerKind: f.ownerKind, module: f.module, type: f.type };
  }
  function buildStack(th) {
    var out = [], guard = 0;
    while (th && guard++ < 12) {
      for (var i = th.open.length - 1; i >= 0; i--) {
        var f = th.open[i];
        if (f.kind === 'action') out.push({ t: 'frame', frame: frameInfo(f), thread: th.name });
      }
      var ctx = th.open.filter(function (x) { return x.kind === 'context'; }).map(function (x) { return x.name; });
      out.push({ t: 'thread', id: th.id, name: th.name, ctx: ctx.slice(0, 2).join(' \u203a ') });
      if (!th.origin) break;
      out.push({ t: 'trigger', id: th.origin.id, block: th.origin.block, event: th.origin.event });
      th = th.origin.fromThread ? threadsById.get(th.origin.fromThread) : null;
    }
    return out;
  }
  function buildPauseInfo(kind, reason, th, f, extra) {
    var info = {
      kind: kind, reason: reason, ts: now(),
      label: extra.label || null, nodeId: extra.nodeId || null,
      block: extra.block || null, event: extra.event || null, params: extra.params || null,
      bkey: extra.bkey || null,
      thread: th ? { id: th.id, tid: String(th.tid), name: th.name } : null,
      frame: f ? frameInfo(f) : null,
      stack: buildStack(th)
    };
    try {
      if (f && f.varBag) {
        if (f.varBag.model) info.vars = serVars(f.varBag.model);
        info.locals = serLocals(f.varBag);
      }
    } catch (e) {}
    return info;
  }

  // Node labels taken from the comments in the generated code:
  //   OutSystemsDebugger.handleBreakpoint("x:y", ...);\n// Refresh Query: AS_MigrationPlans
  //   // OriginEnvironmentId Selected?\nif((OutSystemsDebugger.handleBreakpoint("x:y", ...
  var NODE_RE = /handleBreakpoint\("([^"]+)"/g;
  function indexNodes(src) {
    if (!src || src.indexOf('handleBreakpoint(') < 0) return;
    var m;
    NODE_RE.lastIndex = 0;
    while ((m = NODE_RE.exec(src))) {
      var id = m[1];
      if (nodeLabels.has(id)) continue;
      var lineStart = src.lastIndexOf('\n', m.index) + 1;
      var line = src.slice(lineStart, m.index);
      var label = null;
      if (/if\s*\(\(\s*OutSystemsDebugger\.$/.test(line)) {
        // If node: the comment is on one of the previous lines
        var before = src.slice(Math.max(0, lineStart - 300), lineStart).split('\n');
        for (var k = before.length - 2; k >= Math.max(0, before.length - 4); k--) {
          var cm = before[k].match(/^\s*\/\/\s*([^\r\n]+)/);
          if (cm) { label = cm[1].trim(); break; }
        }
      } else {
        var endCall = src.indexOf(';', m.index);
        var rest = endCall >= 0 ? src.slice(endCall + 1, endCall + 300) : '';
        var c2 = rest.match(/^\s*\/\/\s*([^\r\n]+)/);
        var msg = rest.match(/^\s*OS\.FeedbackMessageService\.showFeedbackMessage\(\s*("(?:[^"\\]|\\.){0,60})/);
        if (c2) label = c2[1].trim();
        else if (/^\s*(OutSystemsDebugger\.handleBreakpoint|return OS\.Flow\.executeAsyncFlow)/.test(rest)) label = 'Start';
        else if (msg) { label = 'Message: ' + msg[1]; if (!/"$/.test(label) || label.length < 11) label += '"'; }
        else if (/^\s*(\}|return\b)/.test(rest)) label = 'End';
      }
      if (label) nodeLabels.set(id, label);
    }
  }
  function loadDebugConfig() {
    try {
      var raw = window.sessionStorage && window.sessionStorage.getItem('__osEventTracerDebug');
      if (raw) applyDebugConfig(JSON.parse(raw), false);
    } catch (e) {}
  }
  function applyDebugConfig(cfg, persist) {
    var d = S.dbg;
    if (!cfg) return;
    if ('active' in cfg) d.active = !!cfg.active;
    if (cfg.mode) d.mode = cfg.mode;
    if (cfg.breaks) { d.breaks = {}; cfg.breaks.forEach(function (k) { d.breaks[k] = true; }); }
    if ('ignoreLifecycle' in cfg) d.ignoreLifecycle = !!cfg.ignoreLifecycle;
    if ('ignoreLibs' in cfg) d.ignoreLibs = !!cfg.ignoreLibs;
    if (!d.active) { d.step = false; d.pass = {}; }
    if (persist) {
      try {
        window.sessionStorage.setItem('__osEventTracerDebug', JSON.stringify({
          active: d.active, mode: d.mode, breaks: Object.keys(d.breaks),
          ignoreLifecycle: d.ignoreLifecycle, ignoreLibs: d.ignoreLibs
        }));
      } catch (e) {}
    }
  }
  function debugState() {
    var d = S.dbg;
    return {
      active: d.active, mode: d.mode, breaks: Object.keys(d.breaks), ignoreLifecycle: d.ignoreLifecycle,
      ignoreLibs: d.ignoreLibs, paused: d.paused, pauses: d.pauses, nodesIndexed: nodeLabels.size
    };
  }

  /* ------------------------------------------------------------------ */
  /* Server calls                                                         */
  /* ------------------------------------------------------------------ */
  function findOwner(proto, name) {
    var p = proto, guard = 0;
    while (p && guard++ < 15) {
      if (Object.prototype.hasOwnProperty.call(p, name)) return p;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }
  function hookController() {
    if (S.controllerHooked || !S.OS || !S.OS.Controller) return;
    var base = S.OS.Controller.BaseViewController;
    if (!base || !base.prototype) return;
    S.controllerHooked = true;
    ['callServerAction', 'callDataAction', 'callAggregateWithStartIndexAndClientVars', 'callAggregateWithStartIndex', 'callAggregate'].forEach(function (m) {
      try {
        var owner = findOwner(base.prototype, m);
        if (!owner || owner['__oset_' + m]) return;
        var orig = owner[m];
        if (typeof orig !== 'function') return;
        patch(owner, m, function () {
          var rec = null;
          try { rec = onServerCall(m, arguments); } catch (e) {}
          var res = orig.apply(this, arguments);
          try {
            if (rec && res && typeof res.then === 'function') {
              res.then(function (out) { onServerEnd(rec, out, null); }, function (err) { onServerEnd(rec, null, err); });
            } else if (rec) onServerEnd(rec, res, null);
          } catch (e) {}
          return res;
        });
        hide(owner, '__oset_' + m, true);
      } catch (e) {}
    });
  }
  function onServerCall(m, args) {
    if (!S.enabled) return null;
    var ctx = null;
    for (var i = 0; i < args.length; i++) if (isCallContext(args[i])) { ctx = args[i]; break; }
    var tid = ctx ? ctx.id : S.lastTid;
    var th = tid != null ? threadsByTid.get(tid) : null;
    var parent = topFrame(th);
    var kind = m === 'callServerAction' ? 'server' : (m === 'callDataAction' ? 'dataAction' : 'aggregate');
    var rec = {
      t: 'server', id: nid('s'), thread: th ? th.id : null, parent: parent ? parent.id : null,
      name: String(args[0]), kind: kind
    };
    if (kind === 'server' && args[3] && typeof args[3] === 'object') rec.inputs = ser(args[3], 0);
    var url = null;
    for (var j = 1; j < Math.min(args.length, 4); j++) if (typeof args[j] === 'string' && args[j].indexOf('screenservices/') === 0) { url = args[j]; break; }
    if (url) rec.url = url;
    emit(rec);
    return { id: rec.id, kind: kind };
  }
  function onServerEnd(rec, out, err) {
    var r = { t: 'serverEnd', id: rec.id };
    if (err) r.error = String(err && (err.message || err));
    else if (rec.kind === 'server' && S.snapshots) r.outputs = ser(out, 0);
    emit(r);
  }

  /* ------------------------------------------------------------------ */
  /* define (AMD) hook                                                    */
  /* ------------------------------------------------------------------ */
  function onRuntime(Main) {
    if (S.OS || !Main) return;
    S.OS = Main.Internal || null;
    if (!S.OS) return;
    S.detected = true;
    emit({ t: 'info', message: 'OutSystems runtime detected' });
    hookController();
    hookControllerFactory();
  }
  function wrapFactory(name, deps, factory) {
    var isView = /\.mvc\$view$/.test(name);
    var isCtrl = /\.mvc\$controller$/.test(name);
    var iMain = deps.indexOf('OutSystems/ClientRuntime/Main');
    var iReact = deps.indexOf('react');
    var iOSView = deps.indexOf('OutSystems/ReactView/Main');
    if (iMain < 0 && !isView) return null;
    if (/controller/.test(name)) {
      try { indexNodes(Function.prototype.toString.call(factory)); } catch (e) {}
    }
    return function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (iMain >= 0 && !S.OS) onRuntime(args[iMain]);
        if (iOSView >= 0 && args[iOSView] && !S.OSView) S.OSView = args[iOSView];
        ensureDebuggerHook();
        if (isView && iReact >= 0) args[iReact] = wrapReact(args[iReact]);
      } catch (e) {}
      var prevCtrl = currentControllerDefine;
      if (isCtrl) currentControllerDefine = name;
      var result;
      try { result = factory.apply(this, args); } finally { if (isCtrl) currentControllerDefine = prevCtrl; }
      try { if (isView && typeof result === 'function') patchView(result, name); } catch (e) {}
      try { if (isCtrl) patchFromFactoryResult(result, name); } catch (e) {}
      return result;
    };
  }
  function wrapDefine(d) {
    if (typeof d !== 'function' || d.__osetWrapper) return d;
    var w = function (name, deps, factory) {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof name === 'string' && Array.isArray(deps) && typeof factory === 'function') {
          var f2 = wrapFactory(name, deps, factory);
          if (f2) args[2] = f2;
        }
      } catch (e) {}
      return d.apply(this, args);
    };
    try { Object.keys(d).forEach(function (k) { w[k] = d[k]; }); } catch (e) {}
    if (d.amd !== undefined) w.amd = d.amd;
    hide(w, '__osetWrapper', true);
    hide(w, '__osetOriginal', d);
    S.defineHooked = true;
    return w;
  }
  var currentDefine;
  function installDefineTrap() {
    try {
      currentDefine = wrapDefine(window.define);
      Object.defineProperty(window, 'define', {
        configurable: true,
        enumerable: true,
        get: function () { return currentDefine; },
        set: function (v) { currentDefine = wrapDefine(v); }
      });
    } catch (e) {}
  }
  installDefineTrap();
  loadDebugConfig();

  // Safety net: re-install the hooks if window.define is redefined with
  // defineProperty or OutSystemsDebugger is replaced.
  setInterval(function () {
    try {
      var d = Object.getOwnPropertyDescriptor(window, 'define');
      if (d && 'value' in d && typeof d.value === 'function' && !d.value.__osetWrapper) installDefineTrap();
      if (S.detected) { ensureDebuggerHook(); hookController(); }
    } catch (e) {}
  }, 1000);

  /* ------------------------------------------------------------------ */
  /* DOM <-> block mapping, highlight and picker                          */
  /* ------------------------------------------------------------------ */
  function fiberOfElement(el) {
    try {
      var ks = Object.keys(el);
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].indexOf('__reactFiber$') === 0 || ks[i].indexOf('__reactInternalInstance$') === 0) return el[ks[i]];
      }
    } catch (e) {}
    return null;
  }
  function viewForElement(el) {
    var guard = 0;
    while (el && guard++ < 500) {
      if (el.nodeType === 1) {
        var f = fiberOfElement(el), g = 0;
        while (f && g++ < 5000) {
          if (f.stateNode && views.has(f.stateNode)) return f.stateNode;
          f = f.return;
        }
        if (fiberOfElement(el)) return null;
      }
      el = el.parentNode || (el.host && el.host.nodeType === 1 ? el.host : null);
    }
    return null;
  }
  function hostElementOf(inst) {
    var top = fiberOfInstance(inst);
    if (!top) return null;
    var f = top.child, guard = 0;
    while (f && guard++ < 5000) {
      if (f.stateNode && f.stateNode.nodeType === 1) return f.stateNode;
      if (f.child) { f = f.child; continue; }
      while (f && f !== top && !f.sibling) f = f.return;
      if (!f || f === top) return null;
      f = f.sibling;
    }
    return null;
  }
  function viewChain(inst) {
    var out = [], p = inst, guard = 0;
    while (p && guard++ < 100) {
      var info = views.get(p);
      if (info) out.push({ id: info.id, name: info.name, kind: info.kind });
      p = parentView(p);
    }
    return out;
  }
  // OutSystems widget ids look like "b13-b5-b8-b6-b1-PickUp": keep the widget name.
  function widgetName(el) {
    var guard = 0;
    while (el && el.nodeType === 1 && guard++ < 30) {
      var id = el.id || '';
      if (id) {
        var n = id.replace(/^(?:b\d+-)+/, '').replace(/^\$b\d+$/, '');
        if (n && /[A-Za-z]/.test(n) && !/^l\d+(-\d+)*$/.test(n)) return n;
      }
      el = el.parentElement;
    }
    return null;
  }
  function describeElement(el) {
    var inst = viewForElement(el);
    if (!inst) return null;
    var info = views.get(inst);
    return { id: info.id, name: info.name, module: info.module, kind: info.kind, chain: viewChain(inst), widget: widgetName(el) };
  }

  var overlay = null;
  function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    var host = document.createElement('div');
    host.setAttribute('data-os-event-tracer', 'overlay');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML =
      '<style>' +
      '.box{position:fixed;pointer-events:none;box-sizing:border-box;display:none}' +
      '.blk{border:2px solid #1a73e8;background:rgba(26,115,232,.13)}' +
      '.el{border:1px dashed #e8710a;background:rgba(232,113,10,.08)}' +
      '.lbl{position:fixed;pointer-events:none;display:none;max-width:520px;font:11px/1.4 system-ui,sans-serif;' +
      'background:#202124;color:#fff;border-radius:4px;padding:4px 7px;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lbl b{color:#8ab4f8}.lbl i{color:#fdd663;font-style:normal}.lbl span{color:#bdc1c6}' +
      '</style><div class="box blk"></div><div class="box el"></div><div class="lbl"></div>';
    (document.documentElement || document.body).appendChild(host);
    overlay = { host: host, blk: root.querySelector('.blk'), el: root.querySelector('.el'), lbl: root.querySelector('.lbl') };
    return overlay;
  }
  function placeBox(box, el) {
    if (!el || !el.getBoundingClientRect) { box.style.display = 'none'; return null; }
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) { box.style.display = 'none'; return null; }
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    return r;
  }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function showLabel(o, rect, html) {
    if (!rect) { o.lbl.style.display = 'none'; return; }
    o.lbl.innerHTML = html;
    o.lbl.style.display = 'block';
    var top = rect.top - 26;
    if (top < 2) top = Math.min(window.innerHeight - 26, rect.bottom + 4);
    o.lbl.style.top = top + 'px';
    o.lbl.style.left = Math.max(2, Math.min(rect.left, window.innerWidth - 320)) + 'px';
  }
  function hideOverlay() {
    if (!overlay) return;
    overlay.blk.style.display = 'none'; overlay.el.style.display = 'none'; overlay.lbl.style.display = 'none';
  }
  function blockLabel(inst, el) {
    var info = views.get(inst);
    var chain = viewChain(inst).slice(1, 4).map(function (c) { return c.name.split('.').pop(); }).reverse();
    var w = el ? widgetName(el) : null;
    return (chain.length ? '<span>' + escHtml(chain.join(' \u203a ')) + ' \u203a </span>' : '') +
      '<b>' + escHtml(info.name) + '</b> <span>' + escHtml(info.kind) + '</span>' + (w ? ' <i>' + escHtml(w) + '</i>' : '');
  }

  var highlightId = null;
  function highlight(id) {
    var inst = viewsById.get(id);
    if (!inst) { hideOverlay(); return false; }
    highlightId = id;
    var o = ensureOverlay(), el = hostElementOf(inst);
    o.el.style.display = 'none';
    var r = placeBox(o.blk, el);
    showLabel(o, r, blockLabel(inst, null));
    return !!r;
  }
  function unhighlight() { highlightId = null; if (!picker.active) hideOverlay(); }
  function reveal(id) {
    var inst = viewsById.get(id);
    var el = inst && hostElementOf(inst);
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
    var o = ensureOverlay();
    setTimeout(function () {
      o.el.style.display = 'none';
      var r = placeBox(o.blk, el);
      showLabel(o, r, blockLabel(inst, null));
      setTimeout(function () { if (highlightId !== id && !picker.active) hideOverlay(); }, 1500);
    }, 60);
    return true;
  }

  var picker = { active: false, seq: 0, last: null, hoverEl: null };
  var PICK_BLOCK = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'touchstart', 'touchend', 'auxclick'];
  function onPickMove(e) {
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    picker.hoverEl = t;
    var o = ensureOverlay();
    var inst = viewForElement(t);
    var re = placeBox(o.el, t);
    if (!inst) { o.blk.style.display = 'none'; showLabel(o, re, '<span>No OutSystems block here</span>'); return; }
    var r = placeBox(o.blk, hostElementOf(inst) || t);
    showLabel(o, r || re, blockLabel(inst, t));
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  function onPickClick(e) {
    swallow(e);
    var t = (e.target && e.target.nodeType === 1) ? e.target : picker.hoverEl;
    var d = t ? describeElement(t) : null;
    picker.last = d ? Object.assign({ seq: picker.seq + 1 }, d) : { seq: picker.seq + 1, id: null };
    picker.seq++;
    stopPicker();
  }
  function onPickKey(e) {
    if (e.key === 'Escape') { swallow(e); stopPicker(); }
  }
  function onPickScroll() { if (picker.hoverEl) onPickMove({ target: picker.hoverEl }); }
  function startPicker() {
    if (picker.active) return true;
    picker.active = true;
    ensureOverlay();
    window.addEventListener('mousemove', onPickMove, true);
    window.addEventListener('click', onPickClick, true);
    window.addEventListener('keydown', onPickKey, true);
    window.addEventListener('scroll', onPickScroll, true);
    PICK_BLOCK.forEach(function (ev) { window.addEventListener(ev, swallow, true); });
    try { document.documentElement.style.cursor = 'crosshair'; } catch (e) {}
    return true;
  }
  function stopPicker() {
    if (!picker.active) return true;
    picker.active = false;
    window.removeEventListener('mousemove', onPickMove, true);
    window.removeEventListener('click', onPickClick, true);
    window.removeEventListener('keydown', onPickKey, true);
    window.removeEventListener('scroll', onPickScroll, true);
    PICK_BLOCK.forEach(function (ev) { window.removeEventListener(ev, swallow, true); });
    try { document.documentElement.style.cursor = ''; } catch (e) {}
    picker.hoverEl = null;
    hideOverlay();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* API used by the DevTools panel                                       */
  /* ------------------------------------------------------------------ */
  function status() {
    return {
      version: VERSION,
      detected: S.detected, defineHooked: S.defineHooked,
      debuggerHooked: S.debuggerHooked, debuggerHookError: S.debuggerHookError,
      controllerHooked: S.controllerHooked, enabled: S.enabled, snapshots: S.snapshots,
      ctrlDev: S.ctrlDev, ctrlProd: S.ctrlProd,
      views: views.size, records: S.records.length, url: location.href,
      picker: { active: picker.active, seq: picker.seq, last: picker.last }
    };
  }
  var api = {
    version: VERSION,
    drain: function (after, session) {
      after = session === S.session ? (after | 0) : 0;
      var i = S.records.length;
      while (i > 0 && S.records[i - 1].seq > after) i--;
      var recs = S.records.slice(i, i + MAX_DRAIN);
      if (recs.length) S.lastDrained = Math.max(S.lastDrained, recs[recs.length - 1].seq);
      return JSON.stringify({ session: S.session, status: status(), records: recs, more: S.records.length - i > MAX_DRAIN });
    },
    live: function () {
      var arr = [];
      views.forEach(function (info, inst) {
        arr.push({ id: info.id, name: info.name, module: info.module, kind: info.kind, parent: reactParent(inst), vars: serVars(inst.model) });
      });
      return JSON.stringify(arr);
    },
    clear: function () { S.records.length = 0; return true; },
    setEnabled: function (b) { S.enabled = !!b; return S.enabled; },
    setSnapshots: function (b) { S.snapshots = !!b; return S.snapshots; },
    status: function () { return JSON.stringify(status()); },
    highlight: function (id) { return highlight(id); },
    unhighlight: function () { unhighlight(); return true; },
    reveal: function (id) { return reveal(id); },
    fromElement: function (el) { return JSON.stringify(el && el.nodeType === 1 ? describeElement(el) : null); },
    picker: {
      start: startPicker,
      stop: stopPicker,
      state: function () { return JSON.stringify({ active: picker.active, seq: picker.seq, last: picker.last }); }
    },
    debug: {
      configure: function (cfg) { applyDebugConfig(cfg, true); return JSON.stringify(debugState()); },
      state: function () { return JSON.stringify(debugState()); },
      nodeLabel: function (id) { return nodeLabels.get(id) || null; }
    }
  };
  try {
    Object.defineProperty(window, '__osEventTracer', { value: api, configurable: false, enumerable: false, writable: false });
  } catch (e) { window.__osEventTracer = api; }
})();
