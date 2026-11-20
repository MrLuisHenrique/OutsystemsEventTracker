/*
 * Service worker: attaches to the inspected tab with chrome.debugger for debug mode.
 *
 * A pause is a synchronous XHR from the page (src/inject.js) to
 * /__os_event_tracer_pause__, held here with Fetch.requestPaused until the panel
 * chooses Next step / Run thread / Continue / Exit. V8 never pauses, so DevTools
 * does not jump to the Sources panel.
 *
 * Every pause starts with an empty "probe" request that is answered immediately:
 * the page only sends the pause payload (which contains variable values) after
 * the probe was answered by this extension, so it never reaches the app server.
 */
'use strict';

const ports = new Map();     // tabId -> panel port
const attached = new Set();  // tabIds with the debugger attached
const held = new Map();      // tabId -> requestId of the pause request being held
const PAUSE_PATTERN = '*/__os_event_tracer_pause__*';

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromB64(b) {
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}
function notify(tabId, msg) {
  const p = ports.get(tabId);
  if (p) { try { p.postMessage(msg); } catch (e) { /* port closed */ } }
}
function fulfill(tabId, requestId, response) {
  return send(tabId, 'Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-OSET', value: '1' },
      { name: 'Cache-Control', value: 'no-store' }
    ],
    body: b64(JSON.stringify(response || { cmd: 'cont' }))
  });
}
async function answerPause(tabId, response) {
  const requestId = held.get(tabId);
  if (!requestId) return false;
  held.delete(tabId);
  try {
    await fulfill(tabId, requestId, response);
  } catch (e) {
    // The request no longer exists (page reloaded or navigated away while paused).
  }
  notify(tabId, { ev: 'xhrResumed' });
  return true;
}
async function attach(tabId) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
  }
  await send(tabId, 'Fetch.enable', { patterns: [{ urlPattern: PAUSE_PATTERN, requestStage: 'Request' }] });
}
async function detach(tabId) {
  if (!attached.has(tabId)) return;
  try { await answerPause(tabId, { cmd: 'stop', config: { active: false } }); } catch (e) {}
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  attached.delete(tabId);
  held.delete(tabId);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'oset-panel') return;
  let tabId = null;

  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg.cmd) {
        case 'hello':
          tabId = msg.tabId;
          ports.set(tabId, port);
          port.postMessage({ ev: 'state', attached: attached.has(tabId), xhrPaused: held.has(tabId) });
          break;
        case 'ping':
          break;
        case 'attach':
          await attach(tabId);
          port.postMessage({ ev: 'attached' });
          break;
        case 'detach':
          await detach(tabId);
          port.postMessage({ ev: 'detached', reason: 'panel' });
          break;
        case 'answer':
          await answerPause(tabId, msg.response);
          break;
        case 'reset':
          // Panel noticed the page reloaded while paused: drop the stale request.
          if (held.has(tabId)) {
            const id = held.get(tabId);
            held.delete(tabId);
            try { await send(tabId, 'Fetch.failRequest', { requestId: id, errorReason: 'Aborted' }); } catch (e) {}
          }
          break;
        default:
          break;
      }
    } catch (e) {
      port.postMessage({ ev: 'error', id: msg.id, cmd: msg.cmd, message: String((e && e.message) || e) });
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId == null) return;
    if (ports.get(tabId) === port) ports.delete(tabId);
    // Panel closed: never leave the page stuck in a pause.
    detach(tabId);
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (method !== 'Fetch.requestPaused') return;
  const req = params.request || {};
  if (req.url.indexOf('/__os_event_tracer_pause__') < 0) {
    send(tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    return;
  }
  const panelOpen = !!ports.get(tabId);
  if (/[?&]probe=1(&|$)/.test(req.url)) {
    fulfill(tabId, params.requestId, { cmd: panelOpen ? 'ready' : 'stop', config: panelOpen ? undefined : { active: false } }).catch(() => {});
    return;
  }
  if (!panelOpen) {
    fulfill(tabId, params.requestId, { cmd: 'stop', config: { active: false } }).catch(() => {});
    return;
  }
  let body = req.postData;
  if (!body && req.postDataEntries) {
    try { body = req.postDataEntries.map((e) => (e.bytes ? fromB64(e.bytes) : '')).join(''); } catch (e) { body = null; }
  }
  let data = null;
  try { data = JSON.parse(body); } catch (e) {}
  // A previous pause still held means the page went away without answering it.
  if (held.has(tabId)) {
    const stale = held.get(tabId);
    send(tabId, 'Fetch.failRequest', { requestId: stale, errorReason: 'Aborted' }).catch(() => {});
  }
  held.set(tabId, params.requestId);
  notify(tabId, { ev: 'xhrPaused', data });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  attached.delete(source.tabId);
  held.delete(source.tabId);
  notify(source.tabId, { ev: 'detached', reason });
});
