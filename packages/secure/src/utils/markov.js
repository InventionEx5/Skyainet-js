// packages/secure/src/utils/markov.js
// =====================================================
// Markov Chain — Stéganographie Textuelle Intelligente
// Compatible Contact + DID + RomanT369
// SkyAInet × Nikola T369
// =====================================================

export class MarkovError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarkovError';
  }
}

export class MarkovChain {
  constructor() {
    this.transitions = new Map(); // word → Map<nextWord, count>
    this.totalTransitions = 0;
  }

  /**
   * Entraîne la chaîne à partir d’un texte
   */
  train(text) {
    if (!text) return;

    const words = text.trim().split(/\s+/);
    if (words.length < 2) return;

    for (let i = 0; i < words.length - 1; i++) {
      const current = words[i];
      const next = words[i + 1];

      if (!this.transitions.has(current)) {
        this.transitions.set(current, new Map());
      }

      const nextMap = this.transitions.get(current);
      nextMap.set(next, (nextMap.get(next) || 0) + 1);
      this.totalTransitions++;
    }
  }

  /**
   * Entraîne à partir des notes d’un Contact
   */
  trainFromContact(contact) {
    if (contact && contact.notes) {
      this.train(contact.notes);
    }
  }

  /**
   * Génère du texte de manière probabiliste (pondéré)
   */
  generate(start, length = 20) {
    if (this.transitions.size === 0) {
      throw new MarkovError('Not enough training data');
    }

    let current = start;
    const result = [current];

    for (let i = 0; i < length; i++) {
      const nextMap = this.transitions.get(current);
      if (!nextMap || nextMap.size === 0) break;

      // Sélection pondérée (plus naturel)
      const total = Array.from(nextMap.values()).reduce((a, b) => a + b, 0);
      let r = Math.floor(Math.random() * total);

      let chosen = null;
      for (const [word, count] of nextMap) {
        if (r < count) {
          chosen = word;
          break;
        }
        r -= count;
      }

      if (!chosen) break;

      result.push(chosen);
      current = chosen;
    }

    if (result.length === 1) {
      throw new MarkovError('Start word not found in chain');
    }

    return result.join(' ');
  }

  /**
   * Génère à partir d’un mot aléatoire du corpus
   */
  generateRandom(length = 20) {
    if (this.transitions.size === 0) {
      throw new MarkovError('Not enough training data');
    }

    const start = Array.from(this.transitions.keys())[0];
    return this.generate(start, length);
  }

  isTrained() {
    return this.transitions.size > 0;
  }
}