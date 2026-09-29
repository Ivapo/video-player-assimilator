// The desktop gate's in-page agent (spec vpa-001 §2.12). The gate build (Cargo feature `gate`)
// runs it at document start in every page of the app; the release app does not contain it.
// window.__VPA_RUNNER is set by the shell: the runner's address, http://127.0.0.1:5181.
//
// Three jobs:
// 1. Say hello with where it runs (`location.protocol`, `__TAURI_INTERNALS__`), so the runner
//    can refuse any page that is not the app's.
// 2. Record each load (src set → metadata → data → first presented frame) and each seek
//    (`seeking` → `seeked`), in the page's clock and the epoch clock.
// 3. Poll the runner for commands and run them in the page. A seek whose `seeked` has not
//    come after 15 s is reported to the runner at once, whatever the command is doing.
(() => {
  if (window.top !== window) return;
  const R = window.__VPA_RUNNER;
  const STUCK_MS = 15000;

  const loads = [];
  const seeks = [];
  window.__vpa = { loads, seeks, timeOrigin: performance.timeOrigin };

  const ro = () => document.getElementById('readout');
  const instrument = (v) => {
    let cur = null;
    new MutationObserver(() => {
      if (!v.getAttribute('src')) return;
      cur = { src: v.getAttribute('src'), srcSet: performance.now() };
      loads.push(cur);
      const load = cur;
      v.requestVideoFrameCallback((_now, m) => {
        load.firstFrame = performance.now();
        load.firstMediaTime = m.mediaTime;
      });
      // A new file abandons a seek in flight: its `seeked` never comes (§2.3).
      for (const s of seeks) if (s.end === null) s.end = 'abandoned';
    }).observe(v, { attributes: true, attributeFilter: ['src'] });
    for (const ev of ['loadedmetadata', 'loadeddata', 'canplay', 'error']) {
      v.addEventListener(ev, () => { if (cur && cur[ev] === undefined) cur[ev] = performance.now(); });
    }
    v.addEventListener('seeking', () => {
      seeks.push({ start: Date.now(), target: v.currentTime, pending: ro()?.dataset.pending ?? null, end: null });
    });
    v.addEventListener('seeked', () => {
      const now = Date.now();
      for (const s of seeks) if (s.end === null) s.end = now;
    });
  };
  const found = document.getElementById('video');
  if (found) instrument(found);
  else new MutationObserver((_, obs) => {
    const v = document.getElementById('video');
    if (v) { obs.disconnect(); instrument(v); }
  }).observe(document, { childList: true, subtree: true });

  const post = (path, body) => fetch(R + path, { method: 'POST', body: JSON.stringify(body) });

  setInterval(() => {
    const now = Date.now();
    for (const s of seeks) {
      if (s.end === null && !s.reported && now - s.start > STUCK_MS) {
        s.reported = true;
        post('/__gate/stuck', { ...s, now, href: location.href, readout: { ...ro()?.dataset, text: ro()?.textContent } })
          .catch(() => {});
      }
    }
  }, 1000);

  addEventListener('DOMContentLoaded', async () => {
    const q = new URLSearchParams({
      protocol: location.protocol,
      tauri: String('__TAURI_INTERNALS__' in window),
      href: location.href,
      ua: navigator.userAgent,
    });
    let hello;
    try {
      hello = await (await fetch(R + '/__gate/hello?' + q)).json();
    } catch {
      return; // no runner: the app runs on its own
    }
    const id = hello.id;
    for (;;) {
      let cmd;
      try {
        cmd = await (await fetch(R + '/__gate/poll?id=' + id)).json();
      } catch {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (cmd.kind === 'stop') return;
      if (cmd.kind === 'noop') continue;
      try {
        const value = await new Function('return (async () => { const G = window.__gate; ' + cmd.body + '\n})()')();
        await post('/__gate/result?id=' + id, { seq: cmd.seq, ok: true, value: value === undefined ? null : value });
      } catch (e) {
        await post('/__gate/result?id=' + id, {
          seq: cmd.seq, ok: false, error: String((e && e.message) || e) + '\n' + String((e && e.stack) || ''),
        });
      }
    }
  });
})();
