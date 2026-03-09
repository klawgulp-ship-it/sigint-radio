import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import crypto from 'crypto';
import { Readable } from 'stream';

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

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

// ─── TRANSLATION SYSTEM PROMPT ────────────────────────────────
const TRANSLATION_PROMPT = `You are a real-time radio translation engine for a global signals intelligence platform.

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
  "dialect_notes": "dialect or regional speech patterns if notable"
}

RULES:
- ACCURACY FIRST. Preserve exact meaning, tone, urgency.
- Flag military/emergency with [PRIORITY] prefix in translation.
- Note code words or euphemisms in context_notes.
- Mark unintelligible sections with [INAUDIBLE].
- Preserve numbers, dates, coordinates exactly.
- Transliterate proper nouns.
- Explain idioms that don't translate directly.`;

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
    `);
    console.log('[DB] Schema ready');
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
// ROUTE 1: CORS AUDIO PROXY
// Proxies radio streams to bypass browser CORS restrictions
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
        'User-Agent': 'Mozilla/5.0 (SIGINT Radio Stream Player)',
        'Accept': '*/*',
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    // Forward content-type
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Pipe the stream
    const reader = upstream.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(value);
        }
      } catch (e) {
        // Client disconnected or upstream closed
      } finally {
        if (!res.writableEnded) res.end();
      }
    };

    req.on('close', () => { try { reader.cancel(); } catch(e){} });
    pump();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 2: AUDIO CAPTURE FROM STREAM
// Captures N seconds of audio from a stream URL, returns WAV
// Used by the auto-transcription loop
// ═══════════════════════════════════════════════════════════════
app.post('/api/capture', async (req, res) => {
  const { url, duration = 15 } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const controller = new AbortController();
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = duration * 16000 * 2; // rough: 16kHz mono 16bit

    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (SIGINT Radio Capture)' },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    const reader = upstream.body.getReader();
    const startTime = Date.now();

    while (Date.now() - startTime < duration * 1000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
      if (totalBytes > maxBytes * 2) break; // safety cap
    }

    try { reader.cancel(); } catch(e) {}
    controller.abort();

    const audioBuffer = Buffer.concat(chunks);
    res.json({
      success: true,
      size: audioBuffer.length,
      duration,
      base64: audioBuffer.toString('base64'),
      contentType: upstream.headers.get('content-type') || 'audio/mpeg',
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 3: GROQ WHISPER TRANSCRIPTION
// Accepts audio (base64 or multipart), returns transcription
// ═══════════════════════════════════════════════════════════════
app.post('/api/transcribe', async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const { audio_base64, content_type = 'audio/mpeg', language = null } = req.body;
    if (!audio_base64) return res.status(400).json({ error: 'Missing audio_base64' });

    const audioBuffer = Buffer.from(audio_base64, 'base64');

    // Build multipart form data manually for Groq
    const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
    const ext = content_type.includes('wav') ? 'wav' : content_type.includes('ogg') ? 'ogg' : 'mp3';

    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n`;
    body += `Content-Type: ${content_type}\r\n\r\n`;

    const bodyStart = Buffer.from(body, 'utf-8');
    const bodyEnd = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0` +
      (language ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}` : '') +
      `\r\n--${boundary}--\r\n`,
      'utf-8'
    );

    const fullBody = Buffer.concat([bodyStart, audioBuffer, bodyEnd]);

    console.log(`[WHISPER] Sending ${(audioBuffer.length / 1024).toFixed(1)}KB to Groq...`);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: fullBody,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[WHISPER] Groq error:', response.status, errText);
      return res.status(response.status).json({ error: `Groq API error: ${response.status}`, details: errText });
    }

    const result = await response.json();
    console.log(`[WHISPER] Detected: ${result.language} — "${(result.text || '').slice(0, 80)}..."`);

    res.json({
      success: true,
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments || [],
    });
  } catch (err) {
    console.error('[WHISPER] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 4: CLAUDE TRANSLATION
// Accepts text + metadata, returns structured translation
// ═══════════════════════════════════════════════════════════════
app.post('/api/translate', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { text, source_lang, station_name, country, freq } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    console.log(`[CLAUDE] Translating ${source_lang}: "${text.slice(0, 60)}..."`);

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: TRANSLATION_PROMPT,
      messages: [{
        role: 'user',
        content: `Translate this radio transcription:

SOURCE LANGUAGE: ${source_lang || 'auto-detect'}
STATION: ${station_name || 'Unknown'} (${country || 'Unknown'})
FREQUENCY: ${freq || 'Unknown'}

TRANSCRIPTION:
${text}`,
      }],
    });

    const raw = msg.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = {
        source_lang: source_lang || 'unknown',
        confidence: 0.5,
        translation: raw,
        domain: 'unknown',
        sentiment: 'neutral',
        key_entities: [],
      };
    }

    console.log(`[CLAUDE] → "${(parsed.translation || '').slice(0, 60)}..." [${parsed.domain}]`);

    // Store in DB if available
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO transcriptions (station_id, station_name, country, source_lang, transcription, translation, confidence, domain)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          req.body.station_id || 'unknown', station_name, country,
          parsed.source_lang || source_lang, text, JSON.stringify(parsed),
          parsed.confidence, parsed.domain,
        ]);

        // Store high-confidence pairs for learning
        if (parsed.confidence > 0.8 && parsed.translation) {
          await pool.query(`
            INSERT INTO translation_pairs (source_lang, source_text, target_text, confidence, domain, station_id)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [parsed.source_lang || source_lang, text, parsed.translation, parsed.confidence, parsed.domain, req.body.station_id]);
        }
      } catch (dbErr) {
        console.error('[DB] Store error:', dbErr.message);
      }
    }

    // Broadcast to WebSocket clients
    broadcast({ type: 'translation', data: parsed, original: text, station: station_name });

    res.json({ success: true, ...parsed });
  } catch (err) {
    console.error('[CLAUDE] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 5: FULL PIPELINE — capture + transcribe + translate
// One-shot: give it a stream URL, get back everything
// ═══════════════════════════════════════════════════════════════
app.post('/api/pipeline', async (req, res) => {
  const { url, station_id, station_name, country, freq, lang, duration = 15 } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    // Step 1: Capture audio
    console.log(`[PIPELINE] Capturing ${duration}s from ${station_name || url}...`);
    const controller = new AbortController();
    const chunks = [];
    const startTime = Date.now();

    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (SIGINT Radio Pipeline)' },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: `Stream error: ${upstream.status}` });

    const reader = upstream.body.getReader();
    while (Date.now() - startTime < duration * 1000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    try { reader.cancel(); } catch(e) {}
    controller.abort();

    const audioBuffer = Buffer.concat(chunks);
    if (audioBuffer.length < 1000) {
      return res.json({ success: false, error: 'Audio capture too small — stream may be silent or unavailable' });
    }

    // Step 2: Transcribe with Groq Whisper
    const boundary = '----FB' + crypto.randomBytes(8).toString('hex');
    const ct = upstream.headers.get('content-type') || 'audio/mpeg';
    const ext = ct.includes('wav') ? 'wav' : ct.includes('ogg') ? 'ogg' : 'mp3';

    const langHints = {
      Farsi: 'fa', Turkish: 'tr', Arabic: 'ar', Hebrew: 'he', Ukrainian: 'uk',
      Russian: 'ru', Korean: 'ko', Japanese: 'ja', Mandarin: 'zh', Hindi: 'hi',
      Urdu: 'ur', Swahili: 'sw', Portuguese: 'pt', Spanish: 'es', French: 'fr',
      German: 'de', Thai: 'th', Vietnamese: 'vi', Polish: 'pl', Dutch: 'nl',
      Italian: 'it', Swedish: 'sv', Norwegian: 'no', Finnish: 'fi', Romanian: 'ro',
      Greek: 'el', Czech: 'cs', Bengali: 'bn', Burmese: 'my', Amharic: 'am',
    };
    const whisperLang = langHints[lang] || null;

    let formBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${ct}\r\n\r\n`;
    const formStart = Buffer.from(formBody, 'utf-8');
    const formEnd = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0` +
      (whisperLang ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${whisperLang}` : '') +
      `\r\n--${boundary}--\r\n`,
      'utf-8'
    );

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
      return res.json({ success: false, error: `Whisper error: ${whisperRes.status}`, details: errText });
    }

    const whisperResult = await whisperRes.json();
    const text = (whisperResult.text || '').trim();

    if (!text || text.length < 3) {
      return res.json({ success: false, error: 'No speech detected in audio chunk' });
    }

    console.log(`[PIPELINE] Whisper result (${whisperResult.language}): "${text.slice(0, 80)}..."`);

    // Step 3: Translate with Claude (skip if English)
    let translation = null;
    const detectedLang = whisperResult.language || lang;
    const isEnglish = detectedLang === 'en' || detectedLang === 'English' || lang === 'English';

    if (!isEnglish && ANTHROPIC_API_KEY) {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
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
        translation = { translation: raw, confidence: 0.5, domain: 'unknown', sentiment: 'neutral', key_entities: [] };
      }

      console.log(`[PIPELINE] Claude: → "${(translation.translation || '').slice(0, 60)}..."`);
    }

    // Step 4: Store in DB
    const audioHash = crypto.createHash('sha256').update(audioBuffer).digest('hex').slice(0, 16);
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO transcriptions (audio_hash, station_id, station_name, country, source_lang, transcription, translation, confidence, domain)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [audioHash, station_id, station_name, country, detectedLang, text,
            translation ? JSON.stringify(translation) : null,
            translation?.confidence || null, translation?.domain || null]);

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

    // Step 5: Broadcast + respond
    const result = {
      success: true,
      audio_hash: audioHash,
      audio_size: audioBuffer.length,
      transcription: { text, language: detectedLang, duration: whisperResult.duration },
      translation,
      station: { id: station_id, name: station_name, country, freq },
      timestamp: new Date().toISOString(),
    };

    broadcast({ type: 'pipeline_result', ...result });
    res.json(result);
  } catch (err) {
    console.error('[PIPELINE] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── STATS & DATA ROUTES ─────────────────────────────────────
app.get('/api/stats', async (_, res) => {
  if (!pool) return res.json({ total: 0, languages: [], domains: [], pairs: 0, message: 'No database configured' });
  try {
    const [total, langs, domains, pairs] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM transcriptions'),
      pool.query('SELECT source_lang, COUNT(*) as count FROM transcriptions GROUP BY source_lang ORDER BY count DESC'),
      pool.query('SELECT domain, COUNT(*) as count FROM transcriptions WHERE domain IS NOT NULL GROUP BY domain ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) as count FROM translation_pairs'),
    ]);
    res.json({ total: total.rows[0].count, languages: langs.rows, domains: domains.rows, pairs: pairs.rows[0].count });
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
  services: {
    groq: !!GROQ_API_KEY,
    claude: !!ANTHROPIC_API_KEY,
    database: !!pool,
  },
}));

app.get('/', (_, res) => res.json({
  service: 'SIGINT Radio API',
  version: '1.0.0',
  endpoints: ['/api/proxy', '/api/capture', '/api/transcribe', '/api/translate', '/api/pipeline', '/api/stats', '/api/pairs', '/api/transcriptions', '/health'],
}));

// ─── START ────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   📡 SIGINT RADIO API — Port ${PORT}        ║`);
    console.log(`╠══════════════════════════════════════════╣`);
    console.log(`║  Groq Whisper: ${GROQ_API_KEY ? '✅ READY' : '❌ Missing GROQ_API_KEY'}       ║`);
    console.log(`║  Claude:      ${ANTHROPIC_API_KEY ? '✅ READY' : '❌ Missing ANTHROPIC_API_KEY'}       ║`);
    console.log(`║  Database:    ${pool ? '✅ READY' : '⚠️  No DB (stateless)'}       ║`);
    console.log(`║  WebSocket:   ws://0.0.0.0:${PORT}/ws       ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
  });
});
