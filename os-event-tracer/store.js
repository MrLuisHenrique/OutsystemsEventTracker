/* Panel data structure: turns the flat records into a tree. */
(function (root) {
  'use strict';

  var MAX_NODES = 40000;

  function Store() { this.reset(); }

  Store.prototype.reset = function () {
    this.nodes = new Map();
    this.roots = [];
    this.version = 0;
  };

  Store.prototype.apply = function (session, records) {
    for (var i = 0; i < records.length; i++) {
      try { this._apply(session, records[i]); } catch (e) { /* invalid record: ignore */ }
    }
    if (records.length) this.version++;
    if (this.nodes.size > MAX_NODES) this._prune();
  };

  Store.prototype._attach = function (node, parentKey) {
    var p = parentKey ? this.nodes.get(parentKey) : null;
    if (p) { p.children.push(node.key); node.parentKey = p.key; }
    else { this.roots.push(node.key); node.parentKey = null; }
  };

  Store.prototype._detach = function (node) {
    var arr;
    if (node.parentKey) { var p = this.nodes.get(node.parentKey); arr = p ? p.children : null; }
    else arr = this.roots;
    if (arr) { var i = arr.indexOf(node.key); if (i >= 0) arr.splice(i, 1); }
  };

  Store.prototype._touch = function (n) { n._v = (n._v || 0) + 1; };

  Store.prototype._apply = function (sess, r) {
    var self = this, N = this.nodes;
    function k(id) { return id == null ? null : sess + ':' + id; }
    var n;
    switch (r.t) {
      case 'thread':
        n = { type: 'thread', key: k(r.id), session: sess, ts: r.ts, tid: r.tid, name: null, children: [], errors: [] };
        N.set(n.key, n);
        this._attach(n, null);
        break;
      case 'threadName':
        n = N.get(k(r.id));
        if (!n) break;
        n.name = r.name;
        if (r.trigger) {
          var trig = N.get(k(r.trigger));
          if (trig) {
            this._detach(n);
            trig.children.push(n.key);
            n.parentKey = trig.key;
            trig.handlerKey = n.key;
            this._touch(trig);
          }
        }
        this._touch(n);
        break;
      case 'threadEnd':
        n = N.get(k(r.id));
        if (n) { n.end = r.ts; this._touch(n); }
        break;
      case 'frame':
        n = {
          type: 'frame', key: k(r.id), session: sess, ts: r.ts, name: r.name, module: r.module,
          ftype: r.type, kind: r.kind, owner: r.owner, ownerKind: r.ownerKind, ownerModule: r.ownerModule,
          before: r.before, inputs: r.inputs, bkey: r.bkey, children: [], errors: []
        };
        N.set(n.key, n);
        this._attach(n, r.parent ? k(r.parent) : k(r.thread));
        break;
      case 'node':
        n = N.get(k(r.frame));
        if (!n) break;
        (n.nodes = n.nodes || []).push({ node: r.node, label: r.label, ts: r.ts });
        if (n.nodes.length > 500) n.nodes.shift();
        this._touch(n);
        break;
      case 'end':
        n = N.get(k(r.id));
        if (!n) break;
        n.end = r.ts;
        n.after = r.after;
        n.locals = r.locals;
        if (n.before && n.after) n.changed = diffKeys(n.before, n.after);
        this._touch(n);
        break;
      case 'error':
        n = N.get(k(r.id)) || N.get(k(r.thread));
        if (n) {
          if (n.errors.indexOf(r.message) < 0) n.errors.push(r.message);
          this._touch(n);
          var root = this.rootOf(n);
          if (root && root !== n) { root.hasError = true; this._touch(root); }
        }
        break;
      case 'trigger':
        n = {
          type: 'trigger', key: k(r.id), session: sess, ts: r.ts, block: r.block, event: r.event,
          params: r.params || {}, screens: r.screens, children: [], errors: []
        };
        N.set(n.key, n);
        this._attach(n, r.parent ? k(r.parent) : k(r.thread));
        break;
      case 'server':
        n = {
          type: 'server', key: k(r.id), session: sess, ts: r.ts, name: r.name, kind: r.kind,
          url: r.url, inputs: r.inputs, children: [], errors: []
        };
        N.set(n.key, n);
        this._attach(n, r.parent ? k(r.parent) : k(r.thread));
        break;
      case 'serverEnd':
        n = N.get(k(r.id));
        if (!n) break;
        n.end = r.ts;
        n.outputs = r.outputs;
        if (r.error) { n.errors.push(r.error); var rt = this.rootOf(n); if (rt) { rt.hasError = true; this._touch(rt); } }
        this._touch(n);
        break;
      default:
        break;
    }
  };

  Store.prototype.get = function (key) { return this.nodes.get(key); };

  Store.prototype.rootOf = function (n) {
    var guard = 0;
    while (n && n.parentKey && guard++ < 1000) n = this.nodes.get(n.parentKey);
    return n;
  };

  /* Visible children: context frames (WebFlow/WebBlock/WebScreen) are transparent. */
  Store.prototype.visibleChildren = function (node) {
    var out = [], self = this;
    (function walk(n) {
      for (var i = 0; i < n.children.length; i++) {
        var c = self.nodes.get(n.children[i]);
        if (!c) continue;
        if (c.type === 'frame' && c.kind === 'context') walk(c);
        else out.push(c);
      }
    })(node);
    return out;
  };

  /* Context chain of a thread, e.g. [{name:'MainFlow',ftype:'NRFlows.WebFlow'},{name:'DataMigration',ftype:'NRNodes.WebScreen'}] */
  Store.prototype.contextChain = function (node) {
    var parts = [], cur = node, guard = 0;
    while (cur && guard++ < 10) {
      var ctx = null;
      for (var i = 0; i < cur.children.length; i++) {
        var c = this.nodes.get(cur.children[i]);
        if (c && c.type === 'frame' && c.kind === 'context') { ctx = c; break; }
      }
      if (!ctx) break;
      parts.push({ name: ctx.name, ftype: ctx.ftype, module: ctx.module });
      cur = ctx;
    }
    return parts;
  };

  /* Visible ancestors of a node (closest first), skipping context frames. */
  Store.prototype.ancestors = function (n) {
    var out = [], p = n && n.parentKey ? this.nodes.get(n.parentKey) : null, guard = 0;
    while (p && guard++ < 1000) {
      if (!(p.type === 'frame' && p.kind === 'context')) out.push(p);
      p = p.parentKey ? this.nodes.get(p.parentKey) : null;
    }
    return out;
  };

  /* Keys of every node below n (context frames included). */
  Store.prototype.descendantKeys = function (n, into) {
    into = into || new Set();
    var self = this, stack = n ? n.children.slice() : [], guard = 0;
    while (stack.length && guard++ < 50000) {
      var k = stack.pop();
      if (into.has(k)) continue;
      into.add(k);
      var c = self.nodes.get(k);
      if (c) for (var i = 0; i < c.children.length; i++) stack.push(c.children[i]);
    }
    return into;
  };

  /* The causal chain of a node: its ancestors, itself and everything it caused. */
  Store.prototype.lineage = function (n) {
    var set = new Set();
    if (!n) return set;
    set.add(n.key);
    var p = n.parentKey ? this.nodes.get(n.parentKey) : null, guard = 0;
    while (p && guard++ < 1000) { set.add(p.key); p = p.parentKey ? this.nodes.get(p.parentKey) : null; }
    this.descendantKeys(n, set);
    return set;
  };

  Store.prototype._prune = function () {
    var self = this;
    while (this.nodes.size > MAX_NODES * 0.8 && this.roots.length) {
      var key = this.roots.shift();
      (function del(k) {
        var n = self.nodes.get(k);
        if (!n) return;
        self.nodes.delete(k);
        n.children.forEach(del);
      })(key);
    }
  };

  function diffKeys(a, b) {
    var keys = {}, out = [];
    Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) out.push(k);
    });
    return out;
  }

  Store.diffKeys = diffKeys;
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
  else root.OSStore = Store;
})(this);
