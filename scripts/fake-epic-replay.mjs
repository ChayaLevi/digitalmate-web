#!/usr/bin/env node
/**
 * A stand-in for the Epic Replay server that follows specs/001-epic-replay/contracts/http-api.md
 * from https://github.com/aharonamir/epic-replay (POST /runs, GET /runs/{id}, play-card,
 * frames, final.mp4 with Range, restyle, DELETE, GET /styles). It makes NO video: final.mp4 is a
 * small fixture. Use it to try the DigitalMate flow without FFmpeg, Chromium or paid API keys.
 *
 *   node scripts/fake-epic-replay.mjs        # listens on 127.0.0.1:8010
 */
import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.FAKE_EPIC_PORT ?? 8010);
const stepMs = Number(process.env.FAKE_EPIC_STEP_MS ?? 700);
const clip = fileURLToPath(new URL('../e2e/fixtures/clip.mp4', import.meta.url));
const frame = readFileSync(fileURLToPath(new URL('../e2e/fixtures/frame.jpg', import.meta.url)));

const STYLES = [
  { id: 'football_commentator', name: 'Football commentator', description: 'Loud, breathless, every touch a drama', default: true, sample_line: 'And it is IN!' },
  { id: 'news_reporter', name: 'News reporter', description: 'A calm bulletin read with a straight face', default: false, sample_line: 'A goal has been scored.' },
  { id: 'nature_documentary', name: 'Nature documentary', description: 'Hushed wonder at the wild', default: false, sample_line: 'Here, the striker hunts.' }
];
const NAMES = ['Checking your clip', 'Watching what happens', 'Finding the key moment', 'Is this what happened?', 'Writing the call', 'Building the slow-motion replay', 'Recording the voice', 'Mixing and finishing'];

const runs = new Map();
let seq = 0;
// one finished replay from an earlier day, for the Past replays view
runs.set('fake-past-1', { t0: Date.now() - 86_400_000, status: 'running', style: 'news_reporter', language: 'en', player: null, confirmedAt: Date.now() - 86_000_000, keepAudio: 'true' });

function pastPage() {
  const cards = [...runs.entries()]
    .filter(([id, run]) => state(id, run).status === 'done')
    .map(([id, run]) => `<a class="replay" href="/r/${id}" style="--card-accent:#fff"><span class="thumb replay-frame"><img src="/runs/${id}/frames/313.jpg" alt="" loading="lazy"><span class="sample strap"><span class="line">Free kick finds the corner</span></span></span><span class="replay-meta"><span class="dot" aria-hidden="true"></span><span class="name">${STYLES.find(x => x.id === run.style)?.name}</span><span class="data muted">4 s</span></span></a>`);
  return `<div class="past-head"><h1>Past replays</h1></div><section class="past-day"><h2>${new Date().toISOString().slice(0, 10)}</h2><div class="replays">${cards.join('')}</div></section>`;
}

function stepsOf(run) {
  const elapsed = Date.now() - run.t0;
  return NAMES.map((name, i) => {
    const n = i + 1;
    let status = 'waiting';
    if (run.status === 'stopped' && n >= 4) status = n === 4 ? 'failed' : 'waiting';
    else if (n <= 3) status = elapsed > n * stepMs ? 'done' : elapsed > (n - 1) * stepMs ? 'running' : 'waiting';
    else if (n === 4) status = run.confirmedAt ? 'done' : elapsed > 3 * stepMs ? 'waiting_user' : 'waiting';
    else if (run.confirmedAt) {
      const since = Date.now() - run.confirmedAt;
      const k = n - 4;
      status = since > k * stepMs ? 'done' : since > (k - 1) * stepMs ? 'running' : 'waiting';
    }
    return { n, name: n === 4 && status === 'done' ? 'You confirmed what happened' : name, status, duration_s: status === 'done' ? 1 : null, cost_usd: 0 };
  });
}

function state(id, run) {
  const steps = stepsOf(run);
  let status = run.status;
  if (status === 'running') {
    if (steps[3].status === 'waiting_user') status = 'waiting_play_card';
    if (steps.every(s => s.status === 'done')) status = 'done';
  }
  return {
    run_id: id, status, style: run.style, language: run.language, created_at: new Date(run.t0).toISOString(), cost_usd: 0,
    stages: [], steps, step_n: (steps.find(s => s.status !== 'done') ?? { n: 8 }).n, time_left: 'A few seconds to go.',
    message: status === 'stopped' ? 'You stopped it at the play card. Nothing was narrated.' : null,
    has_clip: true, has_video: status === 'done'
  };
}

function send(res, code, body, type = 'application/json') {
  res.statusCode = code;
  res.setHeader('content-type', type);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const err = (res, code, c, message) => send(res, code, { error: { code: c, message } });

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function serveVideo(req, res) {
  const size = statSync(clip).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  res.setHeader('content-type', 'video/mp4');
  res.setHeader('accept-ranges', 'bytes');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    res.setHeader('content-length', end - start + 1);
    createReadStream(clip, { start, end }).pipe(res);
  } else {
    res.setHeader('content-length', size);
    createReadStream(clip).pipe(res);
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/styles' && req.method === 'GET') return send(res, 200, STYLES);
    if (p === '/past' && req.method === 'GET') return send(res, 200, pastPage(), 'text/html');
    if (p === '/runs' && req.method === 'POST') {
      const raw = (await body(req)).toString('latin1');
      const field = name => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)?.[1];
      if (field('consent') !== 'true') return err(res, 400, 'consent_required', 'Tick the consent box first.');
      if (!/name="file"/.test(raw)) return err(res, 400, 'invalid_upload', 'Choose a clip first.');
      const style = field('style') || 'football_commentator';
      if (!STYLES.some(s => s.id === style)) return err(res, 400, 'unknown_style', `No narrator called ${style}.`);
      const id = `fake-${++seq}-${Date.now().toString(36)}`;
      runs.set(id, { t0: Date.now(), status: 'running', style, language: field('language') || 'en', player: field('player_name') || null, keepAudio: field('keep_original_audio') ?? null });
      return send(res, 201, { run_id: id });
    }
    const m = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return err(res, 404, 'not_found', 'no such page');
    const run = runs.get(m[1]);
    if (!run) return err(res, 404, 'not_found', 'no such run');
    const rest = m[2];
    if (!rest && req.method === 'GET') return send(res, 200, state(m[1], run));
    if (!rest && req.method === 'DELETE') { runs.delete(m[1]); res.statusCode = 204; return res.end(); }
    if (rest === 'events') return send(res, 200, '', 'text/event-stream');
    if (rest === 'play-card' && req.method === 'GET') {
      return send(res, 200, {
        run_id: m[1], status: state(m[1], run).status, fps: 30, last_frame: 450,
        play_sheet: {
          activity: { value: 'football free kick', confidence: 0.97, source: 'model' },
          outcome_summary: { value: 'Direct free kick scored into the top-left corner.', confidence: 0.8, source: 'model' },
          actors: [{ id: 'a1', user_name: run.player, followed: true }],
          events: [
            { id: 'e6', action: 'ball enters the goal in the top-left corner', confidence: 0.8, source: 'model', t_start: 10.4 },
            { id: 'e7', action: 'goalkeeper does not dive', confidence: 0.6, source: 'model', t_start: 10.4 }
          ],
          sensitive: { flag: false, reason: null, checked: true }
        },
        climax: { frame: 313, t: 10.433, url: `/runs/${m[1]}/frames/313.jpg`, neighbours: [] },
        other_moments: [{ frame: 289, t: 9.633, reason: 'foot strikes ball' }, { frame: 340, t: 11.3, reason: 'keeper reacts' }],
        highlighted: ['climax', 'e7'], cost_estimate_usd: 0
      });
    }
    if (rest === 'play-card' && req.method === 'POST') {
      if (state(m[1], run).status !== 'waiting_play_card') return err(res, 409, 'not_waiting', 'the run is not waiting at the play card');
      const b = JSON.parse((await body(req)).toString() || '{}');
      run.lastAnswer = b;
      if (b.action === 'reject') { run.status = 'stopped'; return send(res, 200, { run_id: m[1], stopped: true }); }
      if (b.edits?.climax_frame === undefined) return err(res, 409, 'key_moment_required', 'pick the moment before confirming');
      if (b.action === 'confirm' && !(b.edits.events ?? []).some(e => e.id === 'e7')) return err(res, 409, 'check_required', 'Say whether to keep or remove the marked event.');
      run.confirmedAt = Date.now();
      return send(res, 200, { run_id: m[1], climax_frame: b.edits.climax_frame, mode: b.action === 'generic' ? 'generic' : 'specific' });
    }
    if (/^frames\/\d+\.jpg$/.test(rest ?? '')) { res.setHeader('content-type', 'image/jpeg'); return res.end(frame); }
    if (rest === 'final.mp4' || rest === 'clip.mp4') return serveVideo(req, res);
    if (rest === 'restyle' && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      if (!STYLES.some(s => s.id === b.style)) return err(res, 400, 'unknown_style', 'unknown style');
      const id = `fake-${++seq}-${Date.now().toString(36)}`;
      runs.set(id, { t0: Date.now() - 4 * stepMs, status: 'running', style: b.style, language: b.language || run.language, confirmedAt: Date.now() - 1, player: run.player });
      return send(res, 201, { run_id: id });
    }
    if (rest === 'form') return send(res, 200, { keep_original_audio: run.keepAudio, style: run.style });
    if (rest === 'last-answer') return send(res, 200, run.lastAnswer ?? null);
    return err(res, 404, 'not_found', 'no such page');
  } catch (e) {
    err(res, 500, 'stage_failed', String(e));
  }
}).listen(port, '127.0.0.1', () => console.log(`fake Epic Replay on http://127.0.0.1:${port}`));
