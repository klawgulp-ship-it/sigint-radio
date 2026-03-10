import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import crypto from 'crypto';
import { Readable } from 'stream';
import { PRIORITY_STATIONS } from './stations.js';
import { getWorkingUrl, refreshAllStreams, getStreamStatus } from './streamFinder.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── CONFIG ───────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

// ─── TRANSLATION + THREAT ASSESSMENT PROMPT ──────────────────
const TRANSLATION_PROMPT = `You are a real-time radio translation engine for a global signals intelligence and early warning platform.

INPUT: Raw transcription text + detected source language + station metadata.

OUTPUT: Respond with ONLY valid JSON, no markdown, no preamble:
{
  "source_lang": "detected language name",
  "confidence": 0.0-1.0,
  "translation": "English translation",
  "transliteration": "romanized version if non-Latin script, otherwise null",
  "context_notes": "cultural/political/regional context",
  "domain": "news|military|emergency|civilian|religious|propaganda|broadcast|weather|sports|unknown",
  "sentiment": "neutral|urgent|positive|negative|inflammatory",
  "key_entities": ["names", "locations", "organizations"],
  "dialect_notes": "dialect or regional speech patterns if notable",
  "threat_level": 0,
  "alert_triggers": []
}

RULES:
- ACCURACY FIRST. Preserve exact meaning, tone, urgency.
- Flag military/emergency with [PRIORITY] prefix in translation.
- Note code words or euphemisms in context_notes.
- Mark unintelligible sections with [INAUDIBLE].
- Preserve numbers, dates, coordinates exactly.
- Transliterate proper nouns.
- Explain idioms that don't translate directly.

THREAT ASSESSMENT (threat_level 0-10, alert_triggers = reasons):
- 0-2: Routine news, weather, music, sports, normal broadcast
- 3-4: Political tension, diplomatic disputes, protests, sanctions talk
- 5-6: Military exercises announced, border tensions, emergency preparedness
- 7-8: Active military operations, troop mobilization, weapons systems mentioned, emergency declarations, conflict escalation
- 9-10: Imminent attack warnings, specific targets named, coordinates given, nuclear/chemical/biological references, mass casualty events
Be CONSERVATIVE — only score 7+ when content genuinely indicates military/emergency activity.
alert_triggers must list the specific phrases or concepts that caused the elevated score.`;

// ─── LANGUAGE HINTS FOR WHISPER ──────────────────────────────
const LANG_HINTS = {
  Farsi: 'fa', Turkish: 'tr', Arabic: 'ar', Hebrew: 'he', Ukrainian: 'uk',
  Russian: 'ru', Korean: 'ko', Japanese: 'ja', Mandarin: 'zh', Hindi: 'hi',
  Urdu: 'ur', Swahili: 'sw', Portuguese: 'pt', Spanish: 'es', French: 'fr',
  German: 'de', Thai: 'th', Vietnamese: 'vi', Polish: 'pl', Dutch: 'nl',
  Italian: 'it', Swedish: 'sv', Norwegian: 'no', Finnish: 'fi', Romanian: 'ro',
  Greek: 'el', Czech: 'cs', Bengali: 'bn', Burmese: 'my', Amharic: 'am',
};

// ─── DATABASE INIT ────────────────────────────────────────────
async function initDB() {
  if (!pool) { console.log('[DB] No DATABASE_URL — running without persistence'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id SERIAL PRIMARY KEY,
        audio_hash VARCHAR(64),
        station_id VARCHAR(50) NOT NULL,
        station_name VARCHAR(200),
        country VARCHAR(100),
        source_lang VARCHAR(50) NOT NULL,
        transcription TEXT NOT NULL,
        translation JSONB,
        confidence FLOAT,
        domain VARCHAR(50),
        threat_level INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS translation_pairs (
        id SERIAL PRIMARY KEY,
        source_lang VARCHAR(50) NOT NULL,
        source_text TEXT NOT NULL,
        target_text TEXT NOT NULL,
        confidence FLOAT NOT NULL,
        domain VARCHAR(50),
        station_id VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        transcription_id INTEGER,
        station_id VARCHAR(50) NOT NULL,
        station_name VARCHAR(200),
        country VARCHAR(100),
        threat_level INTEGER NOT NULL,
        alert_triggers JSONB NOT NULL DEFAULT '[]',
        transcription_text TEXT,
        translation_text TEXT,
        translation_data JSONB,
        acknowledged BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Add threat_level column if missing (for existing DBs)
    await pool.query(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS threat_level INTEGER DEFAULT 0`).catch(() => {});
    console.log('[DB] Schema ready (with alerts table)');
  } catch (err) {
    console.error('[DB] Init error:', err.message);
  }
}

// ─── WEBSOCKET ────────────────────────────────────────────────
const broadcast = (data) => {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
};

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

// ═══════════════════════════════════════════════════════════════
// ALERT SYSTEM — detect, store, notify
// ═══════════════════════════════════════════════════════════════
async function processAlert({ threat_level, alert_triggers, station_id, station_name,
                              country, transcription_text, translation_data, transcription_id }) {
  if (!threat_level || threat_level < 7) return null;

  const alert = {
    station_id, station_name, country, threat_level,
    alert_triggers: alert_triggers || [],
    transcription_text,
    translation_text: translation_data?.translation,
    translation_data,
    created_at: new Date().toISOString(),
  };

  console.log(`\n🚨 [ALERT] THREAT LEVEL ${threat_level}/10 — ${station_name} (${country})`);
  console.log(`   Triggers: ${(alert_triggers || []).join(', ')}`);
  console.log(`   Text: ${(translation_data?.translation || transcription_text || '').slice(0, 200)}\n`);

  // Store in DB
  let alertId = null;
  if (pool) {
    try {
      const r = await pool.query(`
        INSERT INTO alerts (transcription_id, station_id, station_name, country,
          threat_level, alert_triggers, transcription_text, translation_text, translation_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [transcription_id || null, station_id, station_name, country, threat_level,
          JSON.stringify(alert_triggers || []), transcription_text,
          translation_data?.translation, JSON.stringify(translation_data)]);
      alertId = r.rows[0].id;
    } catch (e) { console.error('[ALERT] DB error:', e.message); }
  }

  // Broadcast to all connected frontends
  broadcast({ type: 'alert', alert: { ...alert, id: alertId } });

  // Webhook notification
  if (WEBHOOK_URL) {
    fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...alert, id: alertId }),
    }).catch(e => console.error('[WEBHOOK] Error:', e.message));
  }

  // Telegram notification
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const msg = `🚨 THREAT LEVEL ${threat_level}/10\n` +
      `📡 ${station_name} (${country})\n` +
      `⚠️ ${(alert_triggers || []).join(', ')}\n\n` +
      `${(translation_data?.translation || transcription_text || '').slice(0, 500)}`;
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg }),
    }).catch(e => console.error('[TELEGRAM] Error:', e.message));
  }

  return { ...alert, id: alertId };
}

// ═══════════════════════════════════════════════════════════════
// SHARED PIPELINE — capture → transcribe → translate → alert
// Used by both HTTP route and auto-monitor
// ═══════════════════════════════════════════════════════════════
async function runPipelineInternal({ url, station_id, station_name, country, freq, lang, duration = 15 }) {
  // Step 1: Capture audio
  console.log(`[PIPELINE] Capturing ${duration}s from ${station_name || url}...`);
  const controller = new AbortController();
  const captureTimeout = setTimeout(() => controller.abort(), (duration + 10) * 1000);
  const chunks = [];
  const startTime = Date.now();

  const upstream = await fetch(url, {
    signal: controller.signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  });

  if (!upstream.ok) {
    clearTimeout(captureTimeout);
    throw new Error(`Stream error: ${upstream.status}`);
  }

  const reader = upstream.body.getReader();
  while (Date.now() - startTime < duration * 1000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  try { reader.cancel(); } catch(e) {}
  controller.abort();
  clearTimeout(captureTimeout);

  const audioBuffer = Buffer.concat(chunks);
  if (audioBuffer.length < 1000) {
    return { success: false, error: 'Audio capture too small — stream may be silent or unavailable' };
  }

  // Step 2: Transcribe with Groq Whisper
  const boundary = '----FB' + crypto.randomBytes(8).toString('hex');
  const ct = upstream.headers.get('content-type') || 'audio/mpeg';
  const ext = ct.includes('wav') ? 'wav' : ct.includes('ogg') ? 'ogg' : 'mp3';
  const whisperLang = LANG_HINTS[lang] || null;

  const formStart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${ct}\r\n\r\n`, 'utf-8');
  const formEnd = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo` +
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json` +
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0` +
    (whisperLang ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${whisperLang}` : '') +
    `\r\n--${boundary}--\r\n`, 'utf-8');

  console.log(`[PIPELINE] Whisper: sending ${(audioBuffer.length / 1024).toFixed(1)}KB...`);
  const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat([formStart, audioBuffer, formEnd]),
  });

  if (!whisperRes.ok) {
    const errText = await whisperRes.text();
    return { success: false, error: `Whisper error: ${whisperRes.status}`, details: errText };
  }

  const whisperResult = await whisperRes.json();
  const text = (whisperResult.text || '').trim();

  if (!text || text.length < 3) {
    return { success: false, error: 'No speech detected in audio chunk' };
  }

  console.log(`[PIPELINE] Whisper result (${whisperResult.language}): "${text.slice(0, 80)}..."`);

  // Step 3: Translate with Claude (skip if English)
  let translation = null;
  const detectedLang = whisperResult.language || lang;
  const isEnglish = detectedLang === 'en' || detectedLang === 'English' || lang === 'English';

  if (!isEnglish && ANTHROPIC_API_KEY) {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: TRANSLATION_PROMPT,
      messages: [{
        role: 'user',
        content: `Translate this radio transcription:\n\nSOURCE LANGUAGE: ${detectedLang}\nSTATION: ${station_name || 'Unknown'} (${country || 'Unknown'})\nFREQUENCY: ${freq || 'Unknown'}\n\nTRANSCRIPTION:\n${text}`,
      }],
    });

    const raw = msg.content[0]?.text || '';
    try {
      translation = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      translation = { translation: raw, confidence: 0.5, domain: 'unknown', sentiment: 'neutral', key_entities: [], threat_level: 0, alert_triggers: [] };
    }

    console.log(`[PIPELINE] Claude: → "${(translation.translation || '').slice(0, 60)}..." [${translation.domain}] threat:${translation.threat_level || 0}`);
  } else if (isEnglish) {
    // For English, still assess threat level
    translation = { translation: text, source_lang: 'English', confidence: 1.0, domain: 'broadcast', sentiment: 'neutral', threat_level: 0, alert_triggers: [] };
  }

  // Step 4: Store in DB
  const audioHash = crypto.createHash('sha256').update(audioBuffer).digest('hex').slice(0, 16);
  let transcriptionId = null;

  if (pool) {
    try {
      const dbResult = await pool.query(`
        INSERT INTO transcriptions (audio_hash, station_id, station_name, country, source_lang, transcription, translation, confidence, domain, threat_level)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
      `, [audioHash, station_id, station_name, country, detectedLang, text,
          translation ? JSON.stringify(translation) : null,
          translation?.confidence || null, translation?.domain || null,
          translation?.threat_level || 0]);
      transcriptionId = dbResult.rows[0].id;

      if (translation?.confidence > 0.8 && translation?.translation) {
        await pool.query(`
          INSERT INTO translation_pairs (source_lang, source_text, target_text, confidence, domain, station_id)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [detectedLang, text, translation.translation, translation.confidence, translation.domain, station_id]);
      }
    } catch (dbErr) {
      console.error('[DB] Error:', dbErr.message);
    }
  }

  // Step 5: Check for threats and alert
  await processAlert({
    threat_level: translation?.threat_level || 0,
    alert_triggers: translation?.alert_triggers || [],
    station_id, station_name, country,
    transcription_text: text,
    translation_data: translation,
    transcription_id: transcriptionId,
  });

  // Step 6: Broadcast + return
  const result = {
    success: true,
    audio_hash: audioHash,
    audio_size: audioBuffer.length,
    transcription: { text, language: detectedLang, duration: whisperResult.duration },
    translation,
    threat_level: translation?.threat_level || 0,
    station: { id: station_id, name: station_name, country, freq },
    timestamp: new Date().toISOString(),
  };

  broadcast({ type: 'pipeline_result', ...result });
  return result;
}

// ═══════════════════════════════════════════════════════════════
// ROUTE: CORS AUDIO PROXY
// ═══════════════════════════════════════════════════════════════
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': new URL(url).origin + '/',
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    const ct = upstream.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache');

    const isM3U8 = url.endsWith('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegURL');
    if (isM3U8) {
      const text = await upstream.text();
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const selfBase = `${req.protocol}://${req.get('host')}/api/proxy?url=`;
      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const segUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
        return selfBase + encodeURIComponent(segUrl);
      }).join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Transfer-Encoding', 'chunked');

    const reader = upstream.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(value);
        }
      } catch (e) {}
      finally { if (!res.writableEnded) res.end(); }
    };
    req.on('close', () => { try { reader.cancel(); } catch(e){} });
    pump();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: AUDIO CAPTURE
// ═══════════════════════════════════════════════════════════════
app.post('/api/capture', async (req, res) => {
  const { url, duration = 15 } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const controller = new AbortController();
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = duration * 16000 * 2;
    const upstream = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (SIGINT Radio Capture)' } });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    const reader = upstream.body.getReader();
    const startTime = Date.now();
    while (Date.now() - startTime < duration * 1000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
      if (totalBytes > maxBytes * 2) break;
    }
    try { reader.cancel(); } catch(e) {}
    controller.abort();
    const audioBuffer = Buffer.concat(chunks);
    res.json({ success: true, size: audioBuffer.length, duration, base64: audioBuffer.toString('base64'), contentType: upstream.headers.get('content-type') || 'audio/mpeg' });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: GROQ WHISPER TRANSCRIPTION
// ═══════════════════════════════════════════════════════════════
app.post('/api/transcribe', async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  try {
    const { audio_base64, content_type = 'audio/mpeg', language = null } = req.body;
    if (!audio_base64) return res.status(400).json({ error: 'Missing audio_base64' });
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
    const ext = content_type.includes('wav') ? 'wav' : content_type.includes('ogg') ? 'ogg' : 'mp3';
    const bodyStart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${content_type}\r\n\r\n`, 'utf-8');
    const bodyEnd = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0` +
      (language ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}` : '') +
      `\r\n--${boundary}--\r\n`, 'utf-8');
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([bodyStart, audioBuffer, bodyEnd]),
    });
    if (!response.ok) { const errText = await response.text(); return res.status(response.status).json({ error: `Groq API error: ${response.status}`, details: errText }); }
    const result = await response.json();
    res.json({ success: true, text: result.text, language: result.language, duration: result.duration, segments: result.segments || [] });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: CLAUDE TRANSLATION (standalone)
// ═══════════════════════════════════════════════════════════════
app.post('/api/translate', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const { text, source_lang, station_name, country, freq } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: TRANSLATION_PROMPT,
      messages: [{ role: 'user', content: `Translate this radio transcription:\n\nSOURCE LANGUAGE: ${source_lang || 'auto-detect'}\nSTATION: ${station_name || 'Unknown'} (${country || 'Unknown'})\nFREQUENCY: ${freq || 'Unknown'}\n\nTRANSCRIPTION:\n${text}` }],
    });

    const raw = msg.content[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { parsed = { source_lang: source_lang || 'unknown', confidence: 0.5, translation: raw, domain: 'unknown', sentiment: 'neutral', key_entities: [], threat_level: 0, alert_triggers: [] }; }

    // Store + alert
    if (pool) {
      try {
        const dbResult = await pool.query(`
          INSERT INTO transcriptions (station_id, station_name, country, source_lang, transcription, translation, confidence, domain, threat_level)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
        `, [req.body.station_id || 'unknown', station_name, country, parsed.source_lang || source_lang, text, JSON.stringify(parsed), parsed.confidence, parsed.domain, parsed.threat_level || 0]);

        await processAlert({
          threat_level: parsed.threat_level || 0, alert_triggers: parsed.alert_triggers || [],
          station_id: req.body.station_id, station_name, country,
          transcription_text: text, translation_data: parsed, transcription_id: dbResult.rows[0].id,
        });

        if (parsed.confidence > 0.8 && parsed.translation) {
          await pool.query(`INSERT INTO translation_pairs (source_lang, source_text, target_text, confidence, domain, station_id) VALUES ($1,$2,$3,$4,$5,$6)`,
            [parsed.source_lang || source_lang, text, parsed.translation, parsed.confidence, parsed.domain, req.body.station_id]);
        }
      } catch (dbErr) { console.error('[DB] Store error:', dbErr.message); }
    }

    broadcast({ type: 'translation', data: parsed, original: text, station: station_name });
    res.json({ success: true, ...parsed });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: FULL PIPELINE (HTTP trigger)
// ═══════════════════════════════════════════════════════════════
app.post('/api/pipeline', async (req, res) => {
  const { url, station_id, station_name, country, freq, lang, duration = 15 } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  try {
    // Use stream discovery if station_id is provided
    const streamUrl = station_id ? (await getWorkingUrl(station_id, [url])) || url : url;
    const result = await runPipelineInternal({ url: streamUrl, station_id, station_name, country, freq, lang, duration });
    res.json(result);
  } catch (err) {
    console.error('[PIPELINE] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTO-MONITOR — background station scanning
// ═══════════════════════════════════════════════════════════════
const monitorState = new Map();
let monitorInterval = null;

async function scanStation(station) {
  monitorState.set(station.id, { ...(monitorState.get(station.id) || {}), status: 'scanning', lastScanStart: new Date().toISOString() });
  broadcast({ type: 'monitor_update', station_id: station.id, state: monitorState.get(station.id) });

  try {
    // Use dynamic stream discovery — tries cached URL, fallbacks, then RadioBrowser
    const streamUrl = await getWorkingUrl(station.id, [station.url]);
    if (!streamUrl) {
      throw new Error('No working stream URL found');
    }

    const result = await runPipelineInternal({
      url: streamUrl,
      station_id: station.id,
      station_name: station.name,
      country: station.country,
      freq: station.freq,
      lang: station.lang,
      duration: 15,
    });

    monitorState.set(station.id, {
      status: 'idle',
      lastScan: new Date().toISOString(),
      error: result.success ? null : result.error,
      lastThreatLevel: result.threat_level || 0,
      lastTranscript: result.transcription?.text?.slice(0, 100) || null,
    });
  } catch (err) {
    monitorState.set(station.id, {
      status: 'error',
      lastScan: new Date().toISOString(),
      error: err.message,
    });
    console.error(`[MONITOR] ${station.name}: ${err.message}`);
  }

  broadcast({ type: 'monitor_update', station_id: station.id, state: monitorState.get(station.id) });
}

function startAutoMonitor() {
  if (!GROQ_API_KEY || !ANTHROPIC_API_KEY) {
    console.log('[MONITOR] Skipping — missing API keys');
    return;
  }
  if (PRIORITY_STATIONS.length === 0) {
    console.log('[MONITOR] No priority stations configured');
    return;
  }

  console.log(`[MONITOR] Auto-monitoring ${PRIORITY_STATIONS.length} priority stations:`);
  PRIORITY_STATIONS.forEach(s => {
    console.log(`  📡 ${s.name} (${s.country}) [${(s.tags || []).join(', ')}]`);
    monitorState.set(s.id, { status: 'pending', lastScan: null, error: null });
  });

  let idx = 0;
  // Scan one station every 30s, cycling through all priority stations
  monitorInterval = setInterval(() => {
    const station = PRIORITY_STATIONS[idx % PRIORITY_STATIONS.length];
    idx++;
    scanStation(station).catch(e => console.error('[MONITOR] Scan error:', e.message));
  }, 30000);

  // First scan after 5s
  setTimeout(() => {
    scanStation(PRIORITY_STATIONS[0]).catch(e => console.error('[MONITOR] Initial scan error:', e.message));
  }, 5000);
}

// ─── ALERTS & MONITOR API ROUTES ────────────────────────────
app.get('/api/alerts', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { limit = 50, min_threat = 0, acknowledged } = req.query;
    let q = 'SELECT * FROM alerts WHERE threat_level >= $1';
    const p = [Number(min_threat)];
    if (acknowledged !== undefined) { p.push(acknowledged === 'true'); q += ` AND acknowledged = $${p.length}`; }
    p.push(Number(limit)); q += ` ORDER BY created_at DESC LIMIT $${p.length}`;
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.json({ error: err.message }); }
});

app.post('/api/alerts/:id/acknowledge', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'No database' });
  try {
    await pool.query('UPDATE alerts SET acknowledged = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitor/status', (req, res) => {
  const stations = PRIORITY_STATIONS.map(s => ({
    id: s.id, name: s.name, country: s.country, lang: s.lang, tags: s.tags,
    ...(monitorState.get(s.id) || { status: 'pending', lastScan: null }),
  }));
  res.json({ active: !!monitorInterval, station_count: PRIORITY_STATIONS.length, stations });
});

// ─── STREAM DISCOVERY ROUTES ─────────────────────────────────
app.get('/api/streams/status', (req, res) => {
  res.json(getStreamStatus());
});

app.post('/api/streams/refresh', async (req, res) => {
  try {
    await refreshAllStreams(PRIORITY_STATIONS);
    res.json({ success: true, status: getStreamStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATS & DATA ROUTES ─────────────────────────────────────
app.get('/api/stats', async (_, res) => {
  if (!pool) return res.json({ total: 0, languages: [], domains: [], pairs: 0, alerts: 0, message: 'No database configured' });
  try {
    const [total, langs, domains, pairs, alertCount] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM transcriptions'),
      pool.query('SELECT source_lang, COUNT(*) as count FROM transcriptions GROUP BY source_lang ORDER BY count DESC'),
      pool.query('SELECT domain, COUNT(*) as count FROM transcriptions WHERE domain IS NOT NULL GROUP BY domain ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) as count FROM translation_pairs'),
      pool.query('SELECT COUNT(*) as count FROM alerts WHERE threat_level >= 7'),
    ]);
    res.json({ total: total.rows[0].count, languages: langs.rows, domains: domains.rows, pairs: pairs.rows[0].count, alerts: alertCount.rows[0].count });
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/api/pairs', async (req, res) => {
  if (!pool) return res.json([]);
  const { lang, min_confidence = 0.8, limit = 100 } = req.query;
  let q = 'SELECT * FROM translation_pairs WHERE confidence >= $1';
  const p = [Number(min_confidence)];
  if (lang) { p.push(lang); q += ` AND source_lang = $${p.length}`; }
  p.push(Number(limit)); q += ` ORDER BY created_at DESC LIMIT $${p.length}`;
  const r = await pool.query(q, p);
  res.json(r.rows);
});

app.get('/api/transcriptions', async (req, res) => {
  if (!pool) return res.json([]);
  const { lang, station, limit = 50, offset = 0 } = req.query;
  let q = 'SELECT * FROM transcriptions WHERE 1=1';
  const p = [];
  if (lang) { p.push(lang); q += ` AND source_lang = $${p.length}`; }
  if (station) { p.push(station); q += ` AND station_id = $${p.length}`; }
  p.push(Number(limit)); q += ` ORDER BY created_at DESC LIMIT $${p.length}`;
  p.push(Number(offset)); q += ` OFFSET $${p.length}`;
  const r = await pool.query(q, p);
  res.json(r.rows);
});

// ─── HEALTH ───────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  services: { groq: !!GROQ_API_KEY, claude: !!ANTHROPIC_API_KEY, database: !!pool },
  monitor: { active: !!monitorInterval, stations: PRIORITY_STATIONS.length },
  alerts: { webhook: !!WEBHOOK_URL, telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
}));

app.get('/', (_, res) => res.json({
  service: 'SIGINT Radio API — Early Warning System',
  version: '2.0.0',
  endpoints: ['/api/proxy', '/api/capture', '/api/transcribe', '/api/translate', '/api/pipeline',
    '/api/alerts', '/api/alerts/:id/acknowledge', '/api/monitor/status',
    '/api/streams/status', '/api/streams/refresh',
    '/api/stats', '/api/pairs', '/api/transcriptions', '/health'],
}));

// ─── START ────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║   📡 SIGINT RADIO API v2 — EARLY WARNING SYSTEM  ║`);
    console.log(`╠══════════════════════════════════════════════════╣`);
    console.log(`║  Port:        ${PORT}                                ║`);
    console.log(`║  Groq:        ${GROQ_API_KEY ? '✅ READY' : '❌ Missing'}                         ║`);
    console.log(`║  Claude:      ${ANTHROPIC_API_KEY ? '✅ READY' : '❌ Missing'}                         ║`);
    console.log(`║  Database:    ${pool ? '✅ READY' : '⚠️  No DB'}                         ║`);
    console.log(`║  Monitor:     ${PRIORITY_STATIONS.length} priority stations              ║`);
    console.log(`║  Webhook:     ${WEBHOOK_URL ? '✅ ' + WEBHOOK_URL.slice(0, 25) : '○ Not set'}              ║`);
    console.log(`║  Telegram:    ${TELEGRAM_BOT_TOKEN ? '✅ READY' : '○ Not set'}                         ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
    startAutoMonitor();

    // Refresh all stream URLs on startup (background)
    refreshAllStreams(PRIORITY_STATIONS).catch(e => console.error('[STREAM] Initial refresh error:', e.message));
  });
});
