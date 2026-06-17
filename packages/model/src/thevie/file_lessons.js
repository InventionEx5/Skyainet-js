// packages/model/src/thevie/file_lessons.js
// =====================================================
// FileLessons — Fichier-comme-leçon (Fusion L4)
//
// Ingère le contenu textuel d'un fichier et le transforme en leçons
// d'entraînement prêtes à nourrir le volant d'évolution (LoRA / replay).
// Le système apprend ainsi de documents, notes, code, transcripts.
//
// Stratégies de découpe :
//   • paragraphs (défaut) — découpe sur lignes vides, fusionne jusqu'à maxChars
//   • qa     — détecte les paires Q:/R: (ou Question/Réponse) → leçons Q-R
//   • lines  — une leçon par ligne non vide (notes courtes)
//
// Zéro dépendance — pur traitement de texte. Testable en isolation.
//
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

const DEFAULT_MAX_CHARS = 600;
const MIN_LESSON_CHARS  = 12;

// ─────────────────────────────────────────────────────────────────
// FILE LESSONS
// ─────────────────────────────────────────────────────────────────

export class FileLessons {
  #maxChars;
  #ingested;       // {source, lessons}[]
  #totalLessons;

  constructor(opts = {}) {
    this.#maxChars     = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.#ingested     = [];
    this.#totalLessons = 0;
  }

  /**
   * Ingère un fichier (contenu texte) en leçons d'entraînement.
   * @param {string} filename
   * @param {string} content
   * @param {{strategy?: 'paragraphs'|'qa'|'lines', tag?: string}} [opts]
   * @returns {{ source, strategy, lessons: string[], count, totalChars }}
   */
  ingest(filename, content, opts = {}) {
    const text     = String(content ?? '').replace(/\r\n/g, '\n').trim();
    const strategy = opts.strategy ?? this.#autoStrategy(text);
    const tag      = opts.tag ?? this.#tagFromName(filename);

    let raw;
    switch (strategy) {
      case 'qa'    : raw = this.#chunkQA(text);         break;
      case 'lines' : raw = this.#chunkLines(text);      break;
      default      : raw = this.#chunkParagraphs(text); break;
    }

    const lessons = raw
      .map(s => s.trim())
      .filter(s => s.length >= MIN_LESSON_CHARS)
      .map(s => (tag ? `[${tag}] ${s}` : s));

    this.#ingested.push({ source: filename, lessons });
    this.#totalLessons += lessons.length;

    return {
      source    : filename,
      strategy,
      lessons,
      count     : lessons.length,
      totalChars: lessons.reduce((s, l) => s + l.length, 0),
    };
  }

  /** Ingère plusieurs fichiers et renvoie toutes les leçons aplaties. */
  ingestMany(files, opts = {}) {
    const all = [], perFile = [];
    for (const f of files) {
      const res = this.ingest(f.name ?? f.filename ?? 'file', f.content ?? f.text ?? '', opts);
      perFile.push({ source: res.source, count: res.count });
      all.push(...res.lessons);
    }
    return { lessons: all, files: perFile, count: all.length };
  }

  /** Priorise les leçons par densité lexicale (les plus riches en tête). */
  prioritize(lessons, { top = null } = {}) {
    const out = lessons.map(l => ({ l, s: _density(l) }))
                       .sort((a, b) => b.s - a.s)
                       .map(x => x.l);
    return top ? out.slice(0, top) : out;
  }

  stats() {
    return {
      filesIngested: this.#ingested.length,
      totalLessons : this.#totalLessons,
      maxChars     : this.#maxChars,
    };
  }

  // ─── Découpe ──────────────────────────────────────────────────

  #chunkParagraphs(text) {
    const paras = text.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = [];
    let buf = '';
    for (const p of paras) {
      if ((buf + ' ' + p).length > this.#maxChars && buf) { out.push(buf); buf = p; }
      else buf = buf ? `${buf} ${p}` : p;
    }
    if (buf) out.push(buf);
    return out;
  }

  #chunkLines(text) {
    return text.split('\n').map(l => l.trim()).filter(Boolean);
  }

  #chunkQA(text) {
    const out = [];
    const re = /(?:^|\n)\s*(?:Q|Question)\s*[:.\-]\s*([\s\S]*?)\n\s*(?:A|R|Answer|Réponse)\s*[:.\-]\s*([\s\S]*?)(?=\n\s*(?:Q|Question)\s*[:.\-]|$)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const q = m[1].replace(/\s+/g, ' ').trim();
      const a = m[2].replace(/\s+/g, ' ').trim();
      if (q && a) out.push(`Q: ${q}\nR: ${a}`);
    }
    return out.length ? out : this.#chunkParagraphs(text);   // repli
  }

  // ─── Heuristiques ─────────────────────────────────────────────

  #autoStrategy(text) {
    if (/(?:^|\n)\s*(?:Q|Question)\s*[:.\-]/i.test(text) &&
        /(?:A|R|Answer|Réponse)\s*[:.\-]/i.test(text)) return 'qa';
    if (text.includes('\n\n')) return 'paragraphs';
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > 3 && lines.every(l => l.length < 160)) return 'lines';
    return 'paragraphs';
  }

  #tagFromName(filename) {
    if (!filename) return null;
    const base = String(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    return base.slice(0, 32);
  }
}

export default FileLessons;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function _density(text) {
  const words  = String(text).split(/\s+/).filter(Boolean).length;
  const unique = new Set(String(text).toLowerCase().match(/\b\w+\b/g) ?? []).size;
  return words > 0 ? (unique / words) * Math.min(1, words / 60) : 0;
}
