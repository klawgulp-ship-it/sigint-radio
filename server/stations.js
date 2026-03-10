// Priority stations for auto-monitoring (self-contained for Docker)
// All URLs verified working 2026-03-10 — tested with actual HTTP GET requests
export const PRIORITY_STATIONS = [
  // ── IRAN COVERAGE (verified working worldwide) ──
  { id: "ir-intl", name: "Iran International", country: "Iran", lang: "Farsi", url: "https://radio.iraninternational.app/iintl_c", freq: "Online", tags: ["news","priority","iran-intel","opposition"] },
  { id: "ir-farda", name: "Radio Farda (RFE/RL)", country: "Iran", lang: "Farsi", url: "https://stream.radiojar.com/cp13r2cpn3quv", freq: "SW 1575", tags: ["news","priority","iran-intel"] },
  { id: "ir-rfipersian", name: "RFI Persian (France)", country: "Iran", lang: "Farsi", url: "http://live02.rfi.fr/rfienpersan-64k.mp3", freq: "Online", tags: ["news","priority","iran-intel"] },
  { id: "ir-mojdeh", name: "Radio Mojdeh (Farsi Talk)", country: "Iran", lang: "Farsi", url: "http://ic2326.c1261.fast-serv.com/rm128", freq: "Online", tags: ["iran-intel","priority","talk"] },
  // ── ISRAEL ──
  { id: "il-galatz", name: "Galei Tzahal (IDF)", country: "Israel", lang: "Hebrew", url: "https://glzwizzlv.bynetcdn.com/glz_mp3", freq: "102.3 FM", tags: ["military","priority"] },
  // ── UKRAINE ──
  { id: "ua-hromadske", name: "Hromadske Radio", country: "Ukraine", lang: "Ukrainian", url: "https://stream.hromadskeradio.org:8000/stream", freq: "93.5 FM", tags: ["military","priority","conflict"] },
  { id: "ua-nrcu", name: "UR1 Suspilne", country: "Ukraine", lang: "Ukrainian", url: "https://radio.ukr.radio/ur1-mp3", freq: "72.0 FM", tags: ["military","priority","conflict"] },
  // ── RUSSIA ──
  { id: "ru-mayak", name: "Radio Mayak", country: "Russia", lang: "Russian", url: "https://icecast-vgtrk.cdnvideo.ru/mayakfm_mp3_128kbps", freq: "103.4 FM", tags: ["state","military","priority"] },
  // ── MIDDLE EAST ──
  { id: "qa-aljazeera", name: "Al Jazeera Audio", country: "Qatar", lang: "Arabic", url: "https://live-hls-web-aja.getaj.net/AJA/01.m3u8", freq: "Online", tags: ["news","priority"] },
];
