// The runner's side of the agent's command channel (spec vpa-001 §2.12): plain HTTP on
// 127.0.0.1. One current page at a time, the newest to say hello; an older page is told to
// stop. From Spike 2's spike/channel.ts, with the hello's `where` and the stuck-seek report.
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Hello {
  protocol: string;
  tauri: boolean;
  href: string;
  ua: string;
}

type Cmd = { seq: number; kind: 'run'; body: string };
type Result = { ok: boolean; value?: unknown; error?: string };

let current = 0;
let nextId = 1;
let seq = 1;
const queue: Cmd[] = [];
let waiting: ServerResponse | null = null;
const results = new Map<number, (r: Result) => void>();
let helloWaiters: ((h: Hello) => void)[] = [];

const json = (res: ServerResponse, v: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(v));
};
const flush = () => {
  if (waiting && queue.length) {
    const w = waiting;
    waiting = null;
    json(w, queue.shift());
  }
};
const body = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });

export const channel = {
  /** Called on every hello, before anyone waiting for it; throwing is not caught. */
  onHello: (_h: Hello) => {},
  /** Called when the agent reports a seek whose `seeked` has not come after 15 s. */
  onStuck: (_report: unknown) => {},

  handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '', 'http://x');
    // The app's page (tauri://localhost) calls from another origin.
    res.setHeader('access-control-allow-origin', '*');
    const id = Number(url.searchParams.get('id'));
    switch (url.pathname) {
      case '/__gate/hello': {
        const q = url.searchParams;
        const h: Hello = { protocol: q.get('protocol') ?? '', tauri: q.get('tauri') === 'true', href: q.get('href') ?? '', ua: q.get('ua') ?? '' };
        current = nextId++;
        if (waiting) {
          json(waiting, { kind: 'stop' });
          waiting = null;
        }
        channel.onHello(h);
        const ws = helloWaiters;
        helloWaiters = [];
        ws.forEach((w) => w(h));
        return json(res, { id: current });
      }
      case '/__gate/poll': {
        if (id !== current) return json(res, { kind: 'stop' });
        if (waiting) json(waiting, { kind: 'noop' });
        waiting = res;
        const t = setTimeout(() => {
          if (waiting === res) {
            waiting = null;
            json(res, { kind: 'noop' });
          }
        }, 20000);
        res.on('close', () => clearTimeout(t));
        return flush();
      }
      case '/__gate/result':
        return void body(req).then((s) => {
          const r = JSON.parse(s);
          results.get(r.seq)?.(r);
          results.delete(r.seq);
          res.end();
        });
      case '/__gate/stuck':
        return void body(req).then((s) => {
          res.end();
          channel.onStuck(JSON.parse(s));
        });
    }
    res.statusCode = 404;
    res.end();
  },

  /** Resolves with the next page to say hello. */
  nextHello: () => new Promise<Hello>((r) => helloWaiters.push(r)),

  /** Runs `body` as an async function in the current page, `G` bound to window.__gate. */
  send(body: string, timeout = 300_000): Promise<unknown> {
    const c: Cmd = { seq: seq++, kind: 'run', body };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('channel timeout: ' + body.slice(0, 80))), timeout);
      results.set(c.seq, (r) => {
        clearTimeout(t);
        if (r.ok) resolve(r.value);
        else reject(new Error(r.error));
      });
      queue.push(c);
      flush();
    });
  },
};
