// Priority stations for auto-monitoring (self-contained for Docker)
// Iran stations use internationally-accessible streams (BBC Persian, Iran Intl, Radio Farda, VOA Persian)
// IRIB direct streams are geo-blocked outside Iran — these alternatives cover Iran in Farsi from outside
export const PRIORITY_STATIONS = [
  // ── IRAN COVERAGE (accessible worldwide) ──
  { id: "ir-bbcpersian", name: "BBC Persian", country: "Iran", lang: "Farsi", url: "https://stream.live.vc.bbcmedia.co.uk/bbc_persian_radio", freq: "Online", tags: ["news","priority","iran-intel"] },
  { id: "ir-intl", name: "Iran International", country: "Iran", lang: "Farsi", url: "https://live.iranintl.com/hls/bb2_audio/index.m3u8", freq: "Online", tags: ["news","priority","iran-intel","opposition"] },
  { id: "ir-farda", name: "Radio Farda (RFE/RL)", country: "Iran", lang: "Farsi", url: "https://rfe-channel-07-hls.akamaized.net/hls/live/2034181/rfe-channel-07/index.m3u8", freq: "SW 1575", tags: ["news","priority","iran-intel"] },
  { id: "ir-voapersian", name: "VOA Persian", country: "Iran", lang: "Farsi", url: "https://voa-ingest.akamaized.net/hls/live/2035190/391_352R/playlist.m3u8", freq: "SW", tags: ["news","priority","iran-intel"] },
  { id: "ir-israel-fa", name: "Radio Israel (Farsi)", country: "Israel", lang: "Farsi", url: "https://kan.mediaelb.kfrproxy.co.il/CanFarsi/CanFarsi/icecast.audio", freq: "Online", tags: ["intel","priority","iran-intel","counter-intel"] },
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
