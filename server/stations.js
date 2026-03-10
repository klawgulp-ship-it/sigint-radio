// Priority stations for auto-monitoring (self-contained for Docker)
export const PRIORITY_STATIONS = [
  { id: "ir-irib-news", name: "IRIB News Radio", country: "Iran", lang: "Farsi", url: "http://live4.presstv.ir/irib/irib1/playlist.m3u8", freq: "Online", tags: ["state","military","news","priority"] },
  { id: "ir-goftogoo", name: "IRIB Goftogoo (Talk)", country: "Iran", lang: "Farsi", url: "http://s1.cdn3.iranseda.ir/liveedge/radio-goftego/playlist.m3u8", freq: "Online", tags: ["state","military","priority"] },
  { id: "il-galatz", name: "Galei Tzahal (IDF)", country: "Israel", lang: "Hebrew", url: "https://glzwizzlv.bynetcdn.com/glz_mp3", freq: "102.3 FM", tags: ["military","priority"] },
  { id: "ua-hromadske", name: "Hromadske Radio", country: "Ukraine", lang: "Ukrainian", url: "https://stream.hromadskeradio.org:8000/stream", freq: "93.5 FM", tags: ["military","priority","conflict"] },
  { id: "ua-nrcu", name: "UR1 Suspilne", country: "Ukraine", lang: "Ukrainian", url: "https://radio.ukr.radio/ur1-mp3", freq: "72.0 FM", tags: ["military","priority","conflict"] },
  { id: "ru-mayak", name: "Radio Mayak", country: "Russia", lang: "Russian", url: "https://icecast-vgtrk.cdnvideo.ru/mayakfm_mp3_128kbps", freq: "103.4 FM", tags: ["state","military","priority"] },
  { id: "qa-aljazeera", name: "Al Jazeera Audio", country: "Qatar", lang: "Arabic", url: "https://live-hls-web-aja.getaj.net/AJA/01.m3u8", freq: "Online", tags: ["news","priority"] },
];
