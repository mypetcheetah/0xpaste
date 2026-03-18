'use strict';

// ============================================================
// Password detector - scoring heuristics
// Returns a score 0-100. Threshold >= 40 = likely password.
// ============================================================

const THRESHOLD = 40;

function shannonEntropy(str) {
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  const len = str.length;
  return Object.values(freq).reduce((acc, f) => {
    const p = f / len;
    return acc - p * Math.log2(p);
  }, 0);
}

function scorePassword(text) {
  // ---- Instant disqualifiers ----
  if (!text || typeof text !== 'string') return 0;
  if (/\s/.test(text))                   return 0; // spaces → never a password
  if (text.length < 6 || text.length > 128) return 0;
  if (/^https?:\/\//i.test(text))        return 0; // URL
  if (/^ftp:\/\//i.test(text))           return 0;
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(text)) return 0; // email
  if (/^[a-zA-Z]:\\/.test(text))         return 0; // Windows path
  if (/^\/[a-z]/.test(text))             return 0; // Unix path

  let score = 0;

  // ---- Character variety ----
  const hasUpper   = /[A-Z]/.test(text);
  const hasLower   = /[a-z]/.test(text);
  const hasDigit   = /[0-9]/.test(text);
  const hasSpecial = /[^a-zA-Z0-9]/.test(text);

  if (hasUpper)   score += 10;
  if (hasLower)   score += 5;
  if (hasDigit)   score += 12;
  if (hasSpecial) score += 15;

  const types = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  if (types >= 3) score += 15;
  if (types >= 4) score += 10;

  // ---- Length sweet spot ----
  if (text.length >= 8)  score += 10;
  if (text.length >= 12) score += 5;

  // ---- Shannon entropy ----
  const entropy = shannonEntropy(text);
  if (entropy > 3.0) score += 10;
  if (entropy > 3.5) score += 10;
  if (entropy < 2.0) score -= 15;

  // ---- Common password patterns ----
  // word + digits (e.g. admin123, hunter2)
  if (/^[a-zA-Z]+\d{2,}$/.test(text))          score += 10;
  // word + digits + symbols (e.g. admin123!, P@ss1)
  if (/^[a-zA-Z]+\d+[^a-zA-Z0-9]+/.test(text)) score += 15;
  // capital + word + digits/symbols (e.g. Admin123)
  if (/^[A-Z][a-z]+\d/.test(text))              score += 10;

  // ---- Penalise simple patterns ----
  if (/^[a-z]+$/.test(text))   score -= 25; // only lowercase letters → normal word
  if (/^[A-Z]+$/.test(text))   score -= 20;
  if (/^[0-9]+$/.test(text))   score -= 20; // only digits → phone/zip/id

  return Math.max(0, Math.min(100, score));
}

function isPassword(text) {
  return scorePassword(text) >= THRESHOLD;
}

module.exports = { isPassword, scorePassword, THRESHOLD };
