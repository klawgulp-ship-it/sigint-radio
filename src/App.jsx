import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { STATIONS, REGIONS, TRANSCRIPTION_PHRASES } from './stations.js';
import { TRANSLATION_SYSTEM_PROMPT, WHISPER_CONFIG, LANGUAGE_HINTS } from './translationEngine.js';

// Backend URL — set VITE_API_URL env var or empty for demo mode
const API_URL = import.meta.env.VITE_API_URL || '';

function WorldMap({ stations, activeStation, onSelect }) {
  const mapToX = (lng) => ((lng + 180) / 360) * 100;
  const mapToY = (lat) => ((90 - lat) / 180) * 100;
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '2.2/1', background: 'linear-gradient(180deg, #060a12 0%, #0a1018 50%, #060a12 100%)', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(0,255,136,0.08)' }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', opacity: 0.06 }}>
        {Array.from({ length: 36 }).map((_, i) => (<line key={`v${i}`} x1={`${(i/36)*100}%`} y1="0" x2={`${(i/36)*100}%`} y2="100%" stroke="#00ff88" />))}
        {Array.from({ length: 18 }).map((_, i) => (<line key={`h${i}`} x1="0" y1={`${(i/18)*100}%`} x2="100%" y2={`${(i/18)*100}%`} stroke="#00ff88" />))}
      </svg>
      {stations.map((s) => {
        const active = activeStation?.id === s.id;
        return (<button key={s.id} onClick={() => onSelect(s)} title={`${s.name} — ${s.country} (${s.lang})`} style={{ position: 'absolute', left: `${mapToX(s.lng)}%`, top: `${mapToY(s.lat)}%`, transform: 'translate(-50%,-50%)', border: 'none', padding: 0, width: active ? 14 : 8, height: active ? 14 : 8, borderRadius: '50%', background: active ? '#00ff88' : 'rgba(0,255,136,0.55)', outline: active ? '2px solid #fff' : 'none', cursor: 'pointer', zIndex: active ? 10 : 1, boxShadow: active ? '0 0 24px rgba(0,255,136,0.9)' : '0 0 6px rgba(0,255,136,0.25)', animation: active ? 'pulse 1.8s infinite' : 'none', transition: 'all 0.2s' }} />);
      })}
      <div style={{ position: 'absolute', bottom: 8, left: 12, fontSize: 10, color: 'rgba(0,255,136,0.35)', fontFamily: "'Orbitron',sans-serif", letterSpacing: 2 }}>
        {stations.length} STATIONS • {new Set(stations.map(s => s.lang)).size} LANGUAGES {API_URL ? '• LIVE' : '• DEMO'}
      </div>
    </div>
  );
}

function AudioVisualizer({ analyser, isPlaying }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  useEffect(() => {
    if (!analyser || !isPlaying || !canvasRef.current) return;
    const canvas = canvasRef.current; const ctx = canvas.getContext('2d');
    const bufLen = analyser.frequencyBinCount; const data = new Uint8Array(bufLen);
    const draw = () => { animRef.current = requestAnimationFrame(draw); analyser.getByteFrequencyData(data); ctx.fillStyle = 'rgba(6,10,18,0.88)'; ctx.fillRect(0,0,canvas.width,canvas.height); const bw = (canvas.width/bufLen)*2.5; let x = 0; for (let i = 0; i < bufLen; i++) { const h = (data[i]/255)*canvas.height; const g = Math.floor((data[i]/255)*255); ctx.fillStyle = `rgba(0,${Math.max(g,60)},${Math.floor(g*0.45)},0.92)`; ctx.fillRect(x, canvas.height-h, bw, h); x += bw + 1; } };
    draw(); return () => cancelAnimationFrame(animRef.current);
  }, [analyser, isPlaying]);
  return <canvas ref={canvasRef} width={700} height={70} style={{ width: '100%', height: 70, borderRadius: 6, background: '#060a12' }} />;
}

export default function App() {
  const [activeStation, setActiveStation] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [region, setRegion] = useState('All');
  const [search, setSearch] = useState('');
  const [transcription, setTranscription] = useState([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [translations, setTranslations] = useState({});
  const [volume, setVolume] = useState(0.7);
  const [stats, setStats] = useState({ sessions: 0, langs: new Set(), translations: 0, pipeline: 0 });
  const [tab, setTab] = useState('stations');
  const [wsConnected, setWsConnected] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState('');

  const audioRef = useRef(null);
  const hlsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const gainRef = useRef(null);
  const sourceRef = useRef(null);
  const transcribeRef = useRef(null);
  const pipelineRef = useRef(null);

  const filtered = STATIONS.filter(s => region === 'All' || s.region === region).filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.country.toLowerCase().includes(search.toLowerCase()) || s.lang.toLowerCase().includes(search.toLowerCase()));

  // WebSocket
  useEffect(() => {
    if (!API_URL) return;
    const wsUrl = API_URL.replace(/^http/, 'ws') + '/ws';
    let ws;
    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => { setWsConnected(false); setTimeout(connect, 3000); };
      ws.onmessage = (e) => { try { const msg = JSON.parse(e.data); if (msg.type === 'pipeline_result' && msg.success) console.log('[WS]', msg); } catch(err) {} };
    };
    connect();
    return () => { if (ws) ws.close(); };
  }, []);

  const cleanupAudio = useCallback(() => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; audioRef.current.load(); }
    if (sourceRef.current) { try { sourceRef.current.disconnect(); } catch(e){} sourceRef.current = null; }
    if (transcribeRef.current) clearInterval(transcribeRef.current);
    if (pipelineRef.current) clearInterval(pipelineRef.current);
  }, []);

  const initAudioContext = useCallback(async () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      analyserRef.current = audioCtxRef.current.createAnalyser(); analyserRef.current.fftSize = 256;
      gainRef.current = audioCtxRef.current.createGain();
      gainRef.current.connect(analyserRef.current); analyserRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
  }, []);

  const connectAndPlay = useCallback((audio) => {
    try { if (!sourceRef.current) { sourceRef.current = audioCtxRef.current.createMediaElementSource(audio); sourceRef.current.connect(gainRef.current); } } catch(e) {}
    gainRef.current.gain.value = volume;
    audio.play().catch(() => {});
    setIsPlaying(true);
    setStats(prev => ({ ...prev, sessions: prev.sessions + 1, langs: new Set([...prev.langs, activeStation?.lang].filter(Boolean)) }));
  }, [volume, activeStation]);

  const isHLS = (url) => /\.m3u8(\?|$)/i.test(url);

  const tryPlaySource = useCallback((audio, url, label) => {
    return new Promise((resolve) => {
      if (isHLS(url) && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true, xhrSetup: (xhr) => { xhr.timeout = 10000; } });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(audio);
        const timer = setTimeout(() => { resolve(false); }, 12000);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { clearTimeout(timer); resolve(true); });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) { clearTimeout(timer); hls.destroy(); hlsRef.current = null; resolve(false); }
        });
      } else if (isHLS(url) && audio.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        audio.src = url;
        const timer = setTimeout(() => { resolve(false); }, 10000);
        audio.addEventListener('canplay', () => { clearTimeout(timer); resolve(true); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
        audio.load();
      } else {
        audio.src = url;
        const timer = setTimeout(() => { resolve(false); }, 10000);
        audio.addEventListener('canplay', () => { clearTimeout(timer); resolve(true); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
        audio.load();
      }
    });
  }, []);

  const playStation = useCallback(async (station) => {
    cleanupAudio();
    setActiveStation(station); setIsPlaying(false); setTranscription([]); setIsTranscribing(false); setPipelineStatus('');

    try {
      await initAudioContext();
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audioRef.current = audio;

      // Build list of URLs to try in order
      const urls = [];
      if (API_URL) urls.push({ url: `${API_URL}/api/proxy?url=${encodeURIComponent(station.url)}`, label: 'proxy' });
      urls.push({ url: station.url, label: 'direct' });
      // For HLS via proxy, also try direct HLS with hls.js
      if (API_URL && isHLS(station.url)) urls.splice(1, 0, { url: station.url, label: 'direct-hls' });

      let connected = false;
      for (const { url, label } of urls) {
        console.log(`[AUDIO] Trying ${label}: ${url.slice(0, 80)}...`);
        // Reset for each attempt
        if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
        audio.src = ''; audio.load();

        const ok = await tryPlaySource(audio, url, label);
        if (ok) {
          console.log(`[AUDIO] Connected via ${label}`);
          connectAndPlay(audio);
          connected = true;
          break;
        }
      }

      if (!connected) {
        setTranscription(prev => [{ id: Date.now(), time: new Date().toLocaleTimeString(), type: 'error', text: `⚠ Could not connect to ${station.name} — stream may be offline.` }, ...prev]);
      }
    } catch (err) { console.error('[AUDIO]', err); }
  }, [volume, cleanupAudio, initAudioContext, connectAndPlay, tryPlaySource]);

  const stopPlayback = () => {
    cleanupAudio();
    setIsPlaying(false); setActiveStation(null); setIsTranscribing(false); setPipelineStatus('');
  };

  useEffect(() => { if (gainRef.current) gainRef.current.gain.value = volume; }, [volume]);

  // ═══ REAL PIPELINE: Server capture → Whisper → Claude ═══
  const runPipeline = async (station) => {
    if (!API_URL || !station) return null;
    try {
      setPipelineStatus('capturing');
      const res = await fetch(`${API_URL}/api/pipeline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: station.url, station_id: station.id, station_name: station.name, country: station.country, freq: station.freq, lang: station.lang, duration: 15 }),
      });
      const result = await res.json();
      setPipelineStatus('');

      if (result.success && result.transcription?.text) {
        const entry = { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), text: result.transcription.text, lang: result.transcription.language || station.lang, type: 'transcript', confidence: (result.translation?.confidence || 0.9).toFixed?.(2) || '0.90', station: station.name, country: station.country, real: true };
        setTranscription(prev => [entry, ...prev].slice(0, 100));
        if (result.translation) {
          setTranslations(prev => ({ ...prev, [entry.id]: { loading: false, real: true, ...result.translation } }));
          setStats(prev => ({ ...prev, translations: prev.translations + 1 }));
        }
        setStats(prev => ({ ...prev, pipeline: prev.pipeline + 1 }));
        return result;
      } else {
        if (result.error) setTranscription(prev => [{ id: Date.now(), time: new Date().toLocaleTimeString(), type: 'info', text: `⟳ ${result.error}` }, ...prev]);
        return null;
      }
    } catch (err) {
      setPipelineStatus('');
      setTranscription(prev => [{ id: Date.now(), time: new Date().toLocaleTimeString(), type: 'error', text: `⚠ Pipeline: ${err.message}` }, ...prev]);
      return null;
    }
  };

  const startTranscription = () => {
    if (!activeStation || isTranscribing) return;
    setIsTranscribing(true);

    if (API_URL) {
      runPipeline(activeStation);
      pipelineRef.current = setInterval(() => runPipeline(activeStation), 22000);
    } else {
      const lang = activeStation.lang;
      const phrases = TRANSCRIPTION_PHRASES[lang] || TRANSCRIPTION_PHRASES.English;
      let idx = 0;
      transcribeRef.current = setInterval(() => {
        const entry = { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), text: phrases[idx % phrases.length], lang, type: 'transcript', confidence: (0.72 + Math.random() * 0.26).toFixed(2), station: activeStation.name, country: activeStation.country };
        setTranscription(prev => [entry, ...prev].slice(0, 100));
        idx++;
      }, 3000);
    }
  };

  const stopTranscription = () => {
    setIsTranscribing(false); setPipelineStatus('');
    if (transcribeRef.current) clearInterval(transcribeRef.current);
    if (pipelineRef.current) clearInterval(pipelineRef.current);
  };

  // ═══ REAL TRANSLATION: Claude via backend ═══
  const translateEntry = async (entry) => {
    setTranslations(prev => ({ ...prev, [entry.id]: { loading: true } }));
    if (API_URL) {
      try {
        const res = await fetch(`${API_URL}/api/translate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: entry.text, source_lang: entry.lang, station_name: entry.station, station_id: activeStation?.id, country: entry.country, freq: activeStation?.freq }),
        });
        const result = await res.json();
        setTranslations(prev => ({ ...prev, [entry.id]: { loading: false, real: true, ...result } }));
      } catch (err) {
        setTranslations(prev => ({ ...prev, [entry.id]: { loading: false, error: err.message } }));
      }
    } else {
      await new Promise(r => setTimeout(r, 1200));
      setTranslations(prev => ({ ...prev, [entry.id]: { loading: false, source_lang: entry.lang, confidence: '0.88', translation: `[DEMO — connect backend for real translation] ${entry.text}`, domain: 'broadcast', sentiment: 'neutral', key_entities: [entry.country] } }));
    }
    setStats(prev => ({ ...prev, translations: prev.translations + 1 }));
  };

  const translateAll = () => {
    transcription.filter(t => t.type === 'transcript' && t.lang !== 'English' && t.lang !== 'en' && !translations[t.id]).forEach((t, i) => setTimeout(() => translateEntry(t), i * 800));
  };

  return (
    <div style={{ minHeight: '100vh', background: '#070b12', color: '#dde5ee', fontFamily: "'JetBrains Mono','Fira Code','SF Mono',monospace", padding: '16px 20px' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Orbitron:wght@400;700;900&display=swap');
        @keyframes pulse { 0%,100%{opacity:1;transform:translate(-50%,-50%) scale(1)} 50%{opacity:.6;transform:translate(-50%,-50%) scale(1.5)} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:#0a0f1a} ::-webkit-scrollbar-thumb{background:#1a3a2a;border-radius:3px}
        button{font-family:inherit;cursor:pointer;transition:all .15s} button:hover{filter:brightness(1.15)}
        .rbtn{padding:5px 12px;border:1px solid rgba(0,255,136,.2);background:transparent;color:#00ff88;border-radius:4px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase}
        .rbtn.active{background:rgba(0,255,136,.12);border-color:#00ff88;box-shadow:0 0 10px rgba(0,255,136,.15)}
        .rbtn.blue{border-color:rgba(100,150,255,.25);color:#6496ff} .rbtn.blue.active{background:rgba(100,150,255,.1);border-color:#6496ff}
        .rbtn.orange{border-color:rgba(255,180,50,.25);color:#e8a030}
        .scard{padding:8px 12px;background:rgba(0,255,136,.02);border:1px solid rgba(0,255,136,.06);border-radius:6px;cursor:pointer;transition:all .2s}
        .scard:hover{background:rgba(0,255,136,.06);border-color:rgba(0,255,136,.2)} .scard.active{background:rgba(0,255,136,.1);border-color:#00ff88;box-shadow:0 0 12px rgba(0,255,136,.12)}
        input[type=text]{background:rgba(0,255,136,.04);border:1px solid rgba(0,255,136,.12);color:#dde5ee;padding:6px 10px;border-radius:4px;font-family:inherit;font-size:11px;outline:none;width:100%}
        input[type=text]:focus{border-color:rgba(0,255,136,.35)} input[type=text]::placeholder{color:rgba(255,255,255,.2)}
      `}</style>

      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: 26, fontWeight: 900, color: '#00ff88', margin: 0, letterSpacing: 4, textShadow: '0 0 30px rgba(0,255,136,.35)' }}>SIGINT RADIO</h1>
          <div style={{ fontSize: 10, color: 'rgba(0,255,136,.4)', letterSpacing: 2, marginTop: 2 }}>GLOBAL FREQUENCY INTELLIGENCE • WHISPER STT • CLAUDE TRANSLATE</div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'rgba(0,255,136,.5)', alignItems: 'center' }}>
          <span>SES:{stats.sessions}</span><span>LNG:{stats.langs.size}</span><span>TRN:{stats.translations}</span><span>PPL:{stats.pipeline}</span>
          <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 3, color: API_URL ? (wsConnected ? '#00ff88' : '#e8a030') : '#e8a030', background: API_URL ? (wsConnected ? 'rgba(0,255,136,.1)' : 'rgba(255,180,50,.1)') : 'rgba(255,180,50,.1)' }}>
            {API_URL ? (wsConnected ? '● LIVE PIPELINE' : '○ CONNECTING...') : 'DEMO MODE'}
          </span>
        </div>
      </div>

      <WorldMap stations={filtered} activeStation={activeStation} onSelect={playStation} />

      {/* CONTROLS */}
      <div style={{ display: 'flex', gap: 6, margin: '12px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {REGIONS.map(r => (<button key={r} className={`rbtn ${region === r ? 'active' : ''}`} onClick={() => setRegion(r)}>{r}</button>))}
        <div style={{ flex: 1 }} />
        <button className={`rbtn blue ${tab === 'prompt' ? 'active' : ''}`} onClick={() => setTab(tab === 'prompt' ? 'stations' : 'prompt')}>PROMPT</button>
        <button className={`rbtn blue ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab(tab === 'config' ? 'stations' : 'config')}>WHISPER</button>
        {API_URL && <button className="rbtn orange" onClick={async () => { try { const r = await fetch(`${API_URL}/health`); const h = await r.json(); alert(`Groq: ${h.services?.groq?'OK':'MISSING'}\nClaude: ${h.services?.claude?'OK':'MISSING'}\nDB: ${h.services?.database?'OK':'NONE'}\nUptime: ${Math.floor(h.uptime)}s`); } catch(e) { alert('Unreachable: '+e.message); } }}>HEALTH</button>}
      </div>

      {tab === 'prompt' && (<div style={{ background: 'rgba(100,150,255,.04)', border: '1px solid rgba(100,150,255,.15)', borderRadius: 8, padding: 16, marginBottom: 14, fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', color: '#8ab4ff' }}><div style={{ fontFamily: "'Orbitron'", fontSize: 10, color: '#6496ff', marginBottom: 10, letterSpacing: 2 }}>CLAUDE TRANSLATION SYSTEM PROMPT</div>{TRANSLATION_SYSTEM_PROMPT}</div>)}
      {tab === 'config' && (<div style={{ background: 'rgba(255,180,50,.04)', border: '1px solid rgba(255,180,50,.15)', borderRadius: 8, padding: 16, marginBottom: 14, fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', color: '#e8c87a' }}><div style={{ fontFamily: "'Orbitron'", fontSize: 10, color: '#e8a030', marginBottom: 10, letterSpacing: 2 }}>WHISPER CONFIG</div>{JSON.stringify(WHISPER_CONFIG, null, 2)}<div style={{ marginTop: 16, borderTop: '1px solid rgba(255,180,50,.1)', paddingTop: 12 }}><div style={{ color: '#e8a030', marginBottom: 8 }}>LANGUAGE HINTS:</div>{JSON.stringify(LANGUAGE_HINTS, null, 2)}</div></div>)}

      {/* MAIN GRID */}
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
        <div style={{ background: 'rgba(0,255,136,.015)', border: '1px solid rgba(0,255,136,.06)', borderRadius: 8, padding: 10, maxHeight: 520, overflow: 'auto' }}>
          <input type="text" placeholder="Search stations..." value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 9, color: 'rgba(0,255,136,.4)', letterSpacing: 2, marginBottom: 8 }}>{filtered.length} STATIONS</div>
          {filtered.map(s => (
            <div key={s.id} className={`scard ${activeStation?.id === s.id ? 'active' : ''}`} onClick={() => playStation(s)} style={{ marginBottom: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: activeStation?.id === s.id ? '#00ff88' : '#dde5ee' }}>{s.name}</span>
                <span style={{ fontSize: 8, color: 'rgba(0,255,136,.35)' }}>{s.freq}</span>
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,.35)', marginTop: 2 }}>{s.country} • {s.lang}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {activeStation ? (
            <div style={{ background: 'rgba(0,255,136,.04)', border: '1px solid rgba(0,255,136,.12)', borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 9, color: 'rgba(0,255,136,.45)', letterSpacing: 2 }}>MONITORING</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#00ff88', marginTop: 2 }}>{activeStation.name}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,.4)', marginTop: 1 }}>{activeStation.country} • {activeStation.lang} • {activeStation.freq}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="range" min="0" max="1" step="0.05" value={volume} onChange={e => setVolume(parseFloat(e.target.value))} style={{ width: 70, accentColor: '#00ff88' }} />
                  <button onClick={stopPlayback} style={{ padding: '6px 14px', background: 'rgba(255,60,60,.12)', border: '1px solid rgba(255,60,60,.25)', color: '#ff5050', borderRadius: 4, fontSize: 10 }}>STOP</button>
                </div>
              </div>
              <AudioVisualizer analyser={analyserRef.current} isPlaying={isPlaying} />
              {pipelineStatus && (<div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(100,150,255,.06)', borderRadius: 4, fontSize: 10, color: '#6496ff', animation: 'blink 1.2s infinite', textAlign: 'center', letterSpacing: 1 }}>⟳ {pipelineStatus === 'capturing' ? 'CAPTURING AUDIO...' : 'PROCESSING...'}</div>)}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {!isTranscribing ? (
                  <button onClick={startTranscription} style={{ flex: 1, padding: 8, background: 'rgba(0,255,136,.1)', border: '1px solid rgba(0,255,136,.25)', color: '#00ff88', borderRadius: 4, fontSize: 10, letterSpacing: 1 }}>▶ {API_URL ? 'START PIPELINE (Whisper + Claude)' : 'START TRANSCRIPTION (DEMO)'}</button>
                ) : (
                  <button onClick={stopTranscription} style={{ flex: 1, padding: 8, background: 'rgba(255,180,50,.1)', border: '1px solid rgba(255,180,50,.25)', color: '#e8a030', borderRadius: 4, fontSize: 10 }}>■ STOP PIPELINE</button>
                )}
                {API_URL && !isTranscribing && (<button onClick={() => runPipeline(activeStation)} style={{ padding: '8px 14px', background: 'rgba(100,150,255,.1)', border: '1px solid rgba(100,150,255,.2)', color: '#6496ff', borderRadius: 4, fontSize: 10 }}>⚡ SINGLE</button>)}
                <button onClick={translateAll} style={{ padding: '8px 16px', background: 'rgba(100,150,255,.1)', border: '1px solid rgba(100,150,255,.2)', color: '#6496ff', borderRadius: 4, fontSize: 10 }}>TRANSLATE ALL</button>
              </div>
            </div>
          ) : (
            <div style={{ background: 'rgba(0,255,136,.02)', border: '1px solid rgba(0,255,136,.06)', borderRadius: 8, padding: 40, textAlign: 'center', color: 'rgba(255,255,255,.2)', fontSize: 12 }}>Select a station to begin monitoring</div>
          )}

          {/* TRANSCRIPTION FEED */}
          <div style={{ background: 'rgba(0,0,0,.25)', border: '1px solid rgba(0,255,136,.06)', borderRadius: 8, padding: 14, minHeight: 180, maxHeight: 400, overflow: 'auto' }}>
            <div style={{ fontSize: 9, color: 'rgba(0,255,136,.4)', letterSpacing: 2, marginBottom: 10 }}>
              FEED — {transcription.length} {transcription.some(t => t.real) && <span style={{ color: '#00ff88' }}>● LIVE</span>}
            </div>
            {transcription.length === 0 ? (
              <div style={{ color: 'rgba(255,255,255,.15)', fontSize: 11, textAlign: 'center', marginTop: 50 }}>Start pipeline to capture → transcribe → translate</div>
            ) : transcription.map((t) => (
              <div key={t.id || Math.random()} style={{ padding: '7px 10px', marginBottom: 5, animation: 'fadeIn .3s ease', background: t.type === 'error' ? 'rgba(255,60,60,.06)' : t.type === 'info' ? 'rgba(255,180,50,.04)' : t.real ? 'rgba(0,255,136,.05)' : 'rgba(0,255,136,.02)', borderLeft: `2px solid ${t.type === 'error' ? '#ff5050' : t.type === 'info' ? '#e8a030' : t.real ? '#00ff88' : 'rgba(0,255,136,.4)'}`, borderRadius: '0 4px 4px 0', fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ color: 'rgba(0,255,136,.4)', fontSize: 9 }}>{t.time} — {t.station||''} {t.real && <span style={{ color: '#00ff88' }}>LIVE</span>}</span>
                  {t.confidence && <span style={{ fontSize: 9, color: 'rgba(255,255,255,.25)' }}>{t.lang} • {t.confidence}</span>}
                </div>
                <div style={{ color: t.type === 'error' ? '#ff8080' : t.type === 'info' ? '#e8c87a' : '#dde5ee' }}>{t.text}</div>
                {t.type === 'transcript' && t.lang !== 'English' && t.lang !== 'en' && (
                  <div style={{ marginTop: 5 }}>
                    {translations[t.id] ? (
                      translations[t.id].loading ? (<span style={{ fontSize: 10, color: '#6496ff', animation: 'blink 1s infinite' }}>⟳ Claude translating...</span>)
                      : translations[t.id].error ? (<span style={{ fontSize: 10, color: '#ff5050' }}>✗ {translations[t.id].error}</span>)
                      : (<div style={{ padding: '6px 10px', background: 'rgba(100,150,255,.06)', borderRadius: 3, fontSize: 10 }}>
                          <div><span style={{ color: '#6496ff' }}>→ </span><span style={{ color: '#a8c8ff', fontSize: 11 }}>{translations[t.id].translation}</span></div>
                          {translations[t.id].transliteration && <div style={{ color: 'rgba(255,255,255,.25)', fontSize: 9, marginTop: 2 }}>◇ {translations[t.id].transliteration}</div>}
                          <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap', color: 'rgba(255,255,255,.2)' }}>
                            <span>[{translations[t.id].domain||'?'}]</span>
                            <span>conf:{translations[t.id].confidence||'?'}</span>
                            <span>{translations[t.id].sentiment||''}</span>
                            {translations[t.id].real && <span style={{ color: '#00ff88' }}>● CLAUDE</span>}
                          </div>
                          {translations[t.id].context_notes && <div style={{ color: 'rgba(255,255,255,.18)', fontSize: 9, marginTop: 3, fontStyle: 'italic' }}>{translations[t.id].context_notes}</div>}
                          {translations[t.id].key_entities?.length > 0 && <div style={{ color: 'rgba(100,150,255,.4)', fontSize: 9, marginTop: 2 }}>ENTITIES: {translations[t.id].key_entities.filter(Boolean).join(', ')}</div>}
                        </div>)
                    ) : (<button onClick={() => translateEntry(t)} style={{ padding: '2px 8px', background: 'rgba(100,150,255,.08)', border: '1px solid rgba(100,150,255,.15)', color: '#6496ff', borderRadius: 3, fontSize: 9 }}>TRANSLATE → EN</button>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, padding: 14, background: 'rgba(255,255,255,.015)', border: '1px solid rgba(255,255,255,.04)', borderRadius: 8, fontSize: 10, lineHeight: 1.7, color: 'rgba(255,255,255,.3)' }}>
        <span style={{ color: 'rgba(0,255,136,.5)', fontFamily: "'Orbitron'", fontSize: 9, letterSpacing: 2 }}>PIPELINE {API_URL ? '● ACTIVE' : '○ DEMO'}</span>
        <div style={{ marginTop: 6 }}>{API_URL ? `Connected: ${API_URL}. Stream → CORS Proxy → Capture (15s) → Groq Whisper-v3-Turbo → Claude Sonnet → PostgreSQL → WebSocket.` : 'Demo mode. Deploy backend and set VITE_API_URL to enable: Stream → Groq Whisper → Claude → PostgreSQL.'}</div>
      </div>
    </div>
  );
}
