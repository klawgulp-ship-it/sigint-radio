// Priority stations for auto-monitoring (self-contained for Docker)
export const PRIORITY_STATIONS = [
  { id: "ir-irib-news", name: "IRIB News Radio", country: "Iran", lang: "Farsi", url: "https://radio-khabar.media.gov.ir/live/smil:radio-khabar.smil/playlist.m3u8", freq: "Online", tags: ["state","military","news","priority"] },
  { id: "ir-sepah-media", name: "Sepah (IRGC) Media", country: "Iran", lang: "Farsi", url: "https://stream.radio.co/s3a9b2e1c7/listen", freq: "Online", tags: ["IRGC","military","priority"] },
  { id: "il-galatz", name: "Galei Tzahal (IDF)", country: "Israel", lang: "Hebrew", url: "https://glzwizzlv.bynetcdn.com/glz_mp3", freq: "102.3 FM", tags: ["military","priority"] },
  { id: "ua-hromadske", name: "Hromadske Radio", country: "Ukraine", lang: "Ukrainian", url: "https://stream.hromadske.ua/radio", freq: "93.5 FM", tags: ["military","priority","conflict"] },
  { id: "ua-nrcu", name: "UR1 Suspilne", country: "Ukraine", lang: "Ukrainian", url: "https://radio.nrcu.gov.ua:8443/ur1-mp3", freq: "72.0 FM", tags: ["military","priority","conflict"] },
  { id: "ru-mayak", name: "Radio Mayak", country: "Russia", lang: "Russian", url: "https://icecast-vgtrk.cdnvideo.ru/mayakfm_mp3_128kbps", freq: "103.4 FM", tags: ["state","military","priority"] },
  { id: "kp-kcbs", name: "KCBS Pyongyang (Relay)", country: "North Korea", lang: "Korean", url: "https://stream.radio.co/sda7de92c5/listen", freq: "720 AM", tags: ["state","military","priority","propaganda"] },
];
