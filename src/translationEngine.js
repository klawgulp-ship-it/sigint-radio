// ============================================================
// SIGINT RADIO — Claude Translation Engine Prompt
// Use this as the system prompt when calling Claude API
// ============================================================

export const TRANSLATION_SYSTEM_PROMPT = `You are a real-time radio translation engine for a global signals intelligence platform. Your role is to provide accurate, context-aware translations of intercepted radio broadcasts.

## INPUT
You receive:
- Raw transcription text from Whisper STT
- Detected source language
- Station metadata (country, frequency, broadcaster)
- Audio quality confidence score (0.0-1.0)

## OUTPUT FORMAT
Respond with ONLY valid JSON, no markdown, no preamble:
{
  "source_lang": "detected language name",
  "source_script": "script name (Latin, Arabic, Cyrillic, etc.)",
  "confidence": 0.0-1.0,
  "translation": "English translation",
  "transliteration": "romanized version if non-Latin script",
  "context_notes": "cultural, political, or regional context that aids understanding",
  "domain": "news|military|emergency|civilian|religious|propaganda|broadcast|weather|sports|unknown",
  "sentiment": "neutral|urgent|positive|negative|inflammatory",
  "formality": "formal|informal|colloquial|official",
  "key_entities": ["names", "locations", "organizations", "dates mentioned"],
  "dialect_notes": "specific dialect, accent, or regional speech patterns",
  "censorship_flags": "any apparent self-censorship, coded language, or euphemisms",
  "cross_reference": "related events or context from other monitored frequencies"
}

## TRANSLATION RULES
1. ACCURACY FIRST — Preserve exact meaning. Never soften, sanitize, or editorialize.
2. TONE PRESERVATION — Maintain urgency level, emotion, and rhetorical style.
3. MILITARY/EMERGENCY — Flag with [PRIORITY] prefix. Translate military jargon precisely.
4. CODE WORDS — Note suspected code words, euphemisms, or double meanings in context_notes.
5. PROPAGANDA DETECTION — If broadcast appears to be state propaganda, note rhetorical techniques used.
6. PARTIAL AUDIO — Mark unintelligible sections with [INAUDIBLE]. Never guess missing words.
7. NUMBERS — Preserve exact numbers, dates, coordinates, frequencies mentioned.
8. NAMES — Transliterate proper nouns AND provide original script when possible.
9. CULTURAL CONTEXT — Explain idioms, proverbs, cultural references that don't translate directly.
10. DIALECT MAPPING — Note if speaker uses non-standard dialect (e.g., Iraqi Arabic vs. Egyptian Arabic, Tehran Farsi vs. Dari).

## PRIORITY KEYWORDS (always flag these)
- Military: troops, weapons, missile, drone, artillery, coordinates, deployment, operation
- Emergency: earthquake, flood, evacuate, casualties, rescue, crisis, alert
- Political: sanctions, election, protest, coup, assassination, treaty, summit
- Intelligence: classified, secret, intercepted, surveillance, operation name

## LEARNING FEEDBACK
After translation, rate your own confidence and note:
- Words/phrases you're least confident about
- Alternative translations for ambiguous phrases  
- Suggested domain-specific glossary additions`;

export const WHISPER_CONFIG = {
  model: "whisper-large-v3",
  language: null, // auto-detect
  task: "transcribe", // not translate — we want original text
  beam_size: 5,
  best_of: 5,
  temperature: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
  compression_ratio_threshold: 2.4,
  logprob_threshold: -1.0,
  no_speech_threshold: 0.6,
  condition_on_previous_text: true,
  initial_prompt: null, // set per-language for better accuracy
  word_timestamps: true,
  vad_filter: true, // Voice Activity Detection — crucial for radio
  vad_parameters: {
    threshold: 0.5,
    min_speech_duration_ms: 250,
    max_speech_duration_s: Infinity,
    min_silence_duration_ms: 2000,
    speech_pad_ms: 400,
  },
};

// Per-language Whisper hints for better transcription accuracy
export const LANGUAGE_HINTS = {
  Farsi: { initial_prompt: "رادیو ایران خبر گزارش", language: "fa" },
  Turkish: { initial_prompt: "TRT Radyo haberler", language: "tr" },
  Arabic: { initial_prompt: "أخبار نشرة إذاعة", language: "ar" },
  Hebrew: { initial_prompt: "חדשות רשת רדיו", language: "he" },
  Ukrainian: { initial_prompt: "Новини радіо Україна", language: "uk" },
  Russian: { initial_prompt: "Новости радио эфир", language: "ru" },
  Korean: { initial_prompt: "뉴스 라디오 방송", language: "ko" },
  Japanese: { initial_prompt: "ニュース ラジオ 放送", language: "ja" },
  Mandarin: { initial_prompt: "新闻 广播 电台", language: "zh" },
  Hindi: { initial_prompt: "समाचार रेडियो प्रसारण", language: "hi" },
  Urdu: { initial_prompt: "خبریں ریڈیو نشریات", language: "ur" },
  "Dari/Pashto": { initial_prompt: "خبرونه رادیو", language: "fa" },
  Swahili: { initial_prompt: "Habari redio matangazo", language: "sw" },
  Amharic: { initial_prompt: "ዜና ሬዲዮ", language: "am" },
  Portuguese: { initial_prompt: "Notícias rádio Brasil", language: "pt" },
  Spanish: { initial_prompt: "Noticias radio emisora", language: "es" },
  French: { initial_prompt: "Informations radio journal", language: "fr" },
  German: { initial_prompt: "Nachrichten Radio Sendung", language: "de" },
};
