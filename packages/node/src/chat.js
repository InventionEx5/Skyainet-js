// packages/node/src/chat.js
// =====================================================
// AI Chat Manager — Conversations, Tâches, Génération IA
// Multimodal : texte, images, fichiers, médias
// Port de chat.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MAX_ATTACHMENT_SIZE_MB = 50;
const SUPPORTED_IMAGE_TYPES  = ['image/jpeg','image/png','image/webp','image/gif','image/avif'];
const SUPPORTED_DOC_TYPES    = ['application/pdf','text/plain','text/markdown','application/json'];
const SUPPORTED_AUDIO_TYPES  = ['audio/mpeg','audio/ogg','audio/wav','audio/webm'];

// ─────────────────────────────────────────────────────────────────
// MESSAGE
// ─────────────────────────────────────────────────────────────────

export class Message {
  constructor({ id = null, content, isUser, timestamp = Date.now(), aiUsed = null, attachments = [] }) {
    this.id          = id ?? Date.now() + Math.random();
    this.content     = content;
    this.isUser      = isUser;
    this.timestamp   = timestamp;
    this.aiUsed      = aiUsed;
    this.attachments = attachments;   // Attachment[]
  }

  toJSON() {
    return {
      id         : this.id,
      content    : this.content,
      isUser     : this.isUser,
      timestamp  : this.timestamp,
      aiUsed     : this.aiUsed,
      attachments: this.attachments.map(a => a.toJSON?.() ?? a),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// ATTACHMENT — fichier / image / média joint à un message
// ─────────────────────────────────────────────────────────────────

export class Attachment {
  /**
   * @param {object} opts
   * @param {string}     opts.name      — nom du fichier
   * @param {string}     opts.mimeType  — type MIME
   * @param {Uint8Array|string} opts.data — données brutes ou URL
   * @param {number}     [opts.size]    — taille en octets
   */
  constructor({ name, mimeType, data, size = 0 }) {
    this.id       = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.name     = name;
    this.mimeType = mimeType;
    this.data     = data;
    this.size     = size || (data instanceof Uint8Array ? data.length : 0);
    this.kind     = Attachment.classify(mimeType);
  }

  static classify(mimeType) {
    if (SUPPORTED_IMAGE_TYPES.includes(mimeType)) return 'image';
    if (SUPPORTED_AUDIO_TYPES.includes(mimeType)) return 'audio';
    if (SUPPORTED_DOC_TYPES.includes(mimeType))   return 'document';
    return 'file';
  }

  static validate(attachment) {
    const sizeMB = attachment.size / 1_048_576;
    if (sizeMB > MAX_ATTACHMENT_SIZE_MB) {
      throw new Error(`Fichier trop volumineux : ${sizeMB.toFixed(1)} MB (max ${MAX_ATTACHMENT_SIZE_MB} MB)`);
    }
  }

  toJSON() {
    return {
      id      : this.id,
      name    : this.name,
      mimeType: this.mimeType,
      size    : this.size,
      kind    : this.kind,
      // data non sérialisée en JSON — trop volumineuse
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// CONVERSATION
// ─────────────────────────────────────────────────────────────────

export class Conversation {
  constructor({ id = null, title, messages = [], createdAt = Date.now(), pinned = false }) {
    this.id        = id ?? Date.now();
    this.title     = title ?? `Conversation ${new Date().toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`;
    this.messages  = messages;
    this.createdAt = createdAt;
    this.pinned    = pinned;
  }

  addMessage(msg) {
    this.messages.push(msg instanceof Message ? msg : new Message(msg));
  }

  toJSON() {
    return {
      id       : this.id,
      title    : this.title,
      messages : this.messages.map(m => m.toJSON?.() ?? m),
      createdAt: this.createdAt,
      pinned   : this.pinned,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// TASK
// ─────────────────────────────────────────────────────────────────

export class Task {
  constructor({ id = null, title, date = null, planning = null, completed = false }) {
    this.id        = id ?? Date.now();
    this.title     = title;
    this.date      = date;
    this.planning  = planning;
    this.completed = completed;
  }

  toJSON() {
    return { id: this.id, title: this.title, date: this.date, planning: this.planning, completed: this.completed };
  }
}

// ─────────────────────────────────────────────────────────────────
// AI CHAT MANAGER
//
// Responsabilités :
//   — Gérer les conversations (CRUD, épinglage, renommage)
//   — Gérer les tâches (CRUD)
//   — handleUserChat() — point d'entrée principal :
//       1. Génère la réponse via SkyCloud.generateWithAI()
//       2. Stocke les attachments via SkyCloud.uploadFile()
//       3. Appelle SkyCloud.injectChatLesson() pour l'apprentissage
//       4. Retourne la réponse à l'UI
//
// SkyCloud est injecté dans le constructeur (Dependency Injection).
// Ce fichier ne contient aucune logique d'apprentissage — c'est
// la responsabilité exclusive de SkyCloud.
// ─────────────────────────────────────────────────────────────────

export class AIChatManager {
  #skycloud;        // SkyCloud instance — génération + apprentissage
  #conversations;   // Conversation[]
  #tasks;           // Task[]
  #currentConvId;   // number | null
  #currentAI;       // string

  /**
   * @param {object} skycloud — instance SkyCloud (injectée)
   */
  constructor(skycloud) {
    if (!skycloud) throw new Error('[AIChatManager] SkyCloud instance requise');
    this.#skycloud       = skycloud;
    this.#conversations  = [];
    this.#tasks          = [];
    this.#currentConvId  = null;
    this.#currentAI      = 'thevie';
  }

  // ─── Flux principal ──────────────────────────────────────────

  /**
   * Point d'entrée principal — gère un message utilisateur de bout en bout.
   *
   * Flux :
   *   1. Valider et normaliser les attachments
   *   2. Stocker les fichiers via SkyCloud.uploadFile()
   *   3. Construire le prompt enrichi (texte + descriptions des pièces jointes)
   *   4. Appeler SkyCloud.generateWithAI() pour la réponse IA
   *   5. Stocker les messages dans la conversation courante
   *   6. Appeler SkyCloud.injectChatLesson() pour l'apprentissage
   *   7. Retourner { userMessage, aiMessage }
   *
   * @param {object} opts
   * @param {string}       opts.prompt        — texte du message utilisateur
   * @param {Attachment[]} [opts.attachments] — fichiers / images joints
   * @param {string}       [opts.ai]          — IA cible (défaut: currentAI)
   * @param {number}       [opts.maxTokens]
   * @param {number}       [opts.temperature]
   * @returns {Promise<{ userMessage: Message, aiMessage: Message }>}
   */
  async handleUserChat({ prompt, attachments = [], ai = null, maxTokens = 512, temperature = 0.8, reasoning = 'balanced', samples = 3 }) {
    if (!prompt?.trim() && attachments.length === 0) {
      throw new Error('Message vide — texte ou pièce jointe requis');
    }

    const targetAI = ai ?? this.#currentAI;
    let   conv     = this.#ensureConversation();

    // 1. Valider les attachments
    const validAttachments = [];
    for (const att of attachments) {
      try {
        Attachment.validate(att);
        validAttachments.push(att instanceof Attachment ? att : new Attachment(att));
      } catch (e) {
        console.warn(`[Chat] Attachment rejeté : ${e.message}`);
      }
    }

    // 2. Stocker les fichiers via SkyCloud
    const storedIds = [];
    for (const att of validAttachments) {
      if (att.data instanceof Uint8Array) {
        try {
          const id = await this.#skycloud.uploadFile(att.name, att.data);
          storedIds.push({ id, name: att.name, kind: att.kind });
        } catch (e) {
          console.warn(`[Chat] Upload échoué pour ${att.name}: ${e.message}`);
        }
      }
    }

    // 3. Construire le prompt enrichi
    const enrichedPrompt = this.#buildEnrichedPrompt(prompt, validAttachments);

    // 4. Générer la réponse IA via SkyCloud.
    //    reasoning 'deep' → inference-time compute scaling (self-consistency).
    const result = reasoning === 'deep'
      ? await this.#deepReason({ prompt: enrichedPrompt, ai: targetAI, maxTokens, samples })
      : await this.#skycloud.generateWithAI({ prompt: enrichedPrompt, ai: targetAI, maxTokens, temperature });

    // 5. Stocker les messages dans la conversation
    const userMessage = new Message({
      content    : prompt,
      isUser     : true,
      aiUsed     : null,
      attachments: validAttachments,
    });

    const aiMessage = new Message({
      content    : result.text,
      isUser     : false,
      aiUsed     : result.aiUsed ?? targetAI,
      attachments: [],
    });

    conv.addMessage(userMessage);
    conv.addMessage(aiMessage);

    // 6. Injecter la paire dans l'apprentissage SkyCloud
    this.#skycloud.injectChatLesson(prompt, result.text, {
      ai         : targetAI,
      attachments: validAttachments.map(a => a.toJSON()),
    });

    console.debug(`[Chat] ${targetAI} → ${result.tokensGenerated ?? '?'} tokens | conv: ${conv.id}`);

    return { userMessage, aiMessage, reasoning: result.reasoning ?? null };
  }

  // ─── Raisonnement frontière — inference-time compute scaling (L3) ──

  /**
   * Self-consistency / best-of-N : génère plusieurs candidats à températures
   * variées puis sélectionne le plus consensuel. Plus de calcul = meilleur
   * raisonnement (style R1/o1), sans changer le modèle sous-jacent.
   * @returns {Promise<object>} résultat compatible generateWithAI + { reasoning }
   */
  async #deepReason({ prompt, ai, maxTokens, samples = 3 }) {
    const temps = [0.3, 0.7, 1.0];
    const candidates = [];
    for (let i = 0; i < Math.max(1, samples); i++) {
      try {
        const r = await this.#skycloud.generateWithAI({
          prompt, ai, maxTokens, temperature: temps[i % temps.length],
        });
        if (r?.text) candidates.push(r);
      } catch (e) {
        console.warn(`[Chat] Échantillon ${i} échoué : ${e.message}`);
      }
    }
    if (candidates.length === 0) throw new Error('[Chat] Deep reasoning : aucune réponse générée');
    if (candidates.length === 1) {
      return { ...candidates[0], reasoning: { mode: 'deep', samples: 1, selected: 0, agreement: 1 } };
    }
    const { index, agreement } = _selectConsensus(candidates.map(c => c.text));
    return {
      ...candidates[index],
      reasoning: { mode: 'deep', samples: candidates.length, selected: index, agreement: +agreement.toFixed(3) },
    };
  }

  // ─── Conversations ────────────────────────────────────────────

  /**
   * Crée une nouvelle conversation.
   * Port de create_conversation() dans chat.rs.
   */
  createConversation(title = null) {
    const conv = new Conversation({ title: title ?? undefined });
    this.#conversations.unshift(conv);
    this.#currentConvId = conv.id;
    console.info(`[Chat] Conversation créée : ${conv.id}`);
    return conv.id;
  }

  getConversations()    { return [...this.#conversations]; }
  getCurrentConversation() {
    return this.#conversations.find(c => c.id === this.#currentConvId) ?? null;
  }

  setCurrentConversation(id) {
    if (!this.#conversations.find(c => c.id === id)) throw new Error(`Conversation ${id} introuvable`);
    this.#currentConvId = id;
  }

  renameConversation(id, newTitle) {
    const conv = this.#conversations.find(c => c.id === id);
    if (!conv) return false;
    conv.title = newTitle;
    return true;
  }

  deleteConversation(id) {
    const before = this.#conversations.length;
    this.#conversations = this.#conversations.filter(c => c.id !== id);
    if (this.#currentConvId === id) this.#currentConvId = null;
    return this.#conversations.length < before;
  }

  /**
   * Épingle une conversation (une seule à la fois).
   * Port de toggle_pin_conversation() dans chat.rs.
   */
  togglePinConversation(id) {
    const conv = this.#conversations.find(c => c.id === id);
    if (!conv) return false;
    if (!conv.pinned) this.#conversations.forEach(c => c.pinned = false);
    conv.pinned = !conv.pinned;
    return true;
  }

  // ─── Tâches ───────────────────────────────────────────────────

  addTask({ title, date = null, planning = null }) {
    if (!title?.trim()) throw new Error('Titre de tâche requis');
    const task = new Task({ title, date, planning });
    this.#tasks.push(task);
    console.info(`[Chat] Tâche ajoutée : ${title}`);
    return task.id;
  }

  getTasks()             { return [...this.#tasks]; }

  renameTask(id, newTitle) {
    const task = this.#tasks.find(t => t.id === id);
    if (!task) return false;
    task.title = newTitle;
    return true;
  }

  toggleTask(id) {
    const task = this.#tasks.find(t => t.id === id);
    if (!task) return false;
    task.completed = !task.completed;
    return true;
  }

  deleteTask(id) {
    const before = this.#tasks.length;
    this.#tasks = this.#tasks.filter(t => t.id !== id);
    return this.#tasks.length < before;
  }

  // ─── IA ───────────────────────────────────────────────────────

  switchAI(aiName) {
    if (!aiName?.trim()) throw new Error('Nom IA invalide');
    this.#currentAI = aiName;
    console.info(`[Chat] IA changée : ${aiName}`);
  }

  get currentAI()  { return this.#currentAI; }

  // ─── Stats ────────────────────────────────────────────────────

  stats() {
    const totalMessages = this.#conversations.reduce((s, c) => s + c.messages.length, 0);
    return {
      conversations : this.#conversations.length,
      currentConvId : this.#currentConvId,
      currentAI     : this.#currentAI,
      totalMessages,
      tasks         : this.#tasks.length,
      completedTasks: this.#tasks.filter(t => t.completed).length,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Retourne la conversation courante, en crée une si absente. */
  #ensureConversation() {
    if (this.#currentConvId) {
      const found = this.#conversations.find(c => c.id === this.#currentConvId);
      if (found) return found;
    }
    this.createConversation();
    return this.#conversations[0];
  }

  /**
   * Construit un prompt enrichi avec la description des pièces jointes.
   * Pour les images : "[Image jointe: nom.jpg]"
   * Pour les documents : "[Document joint: rapport.pdf]"
   * Pour les médias : "[Média joint: audio.mp3]"
   *
   * Le moteur T369 voit les descriptions textuelles — les données
   * binaires brutes sont stockées via SkyCloud.uploadFile().
   */
  #buildEnrichedPrompt(prompt, attachments) {
    if (attachments.length === 0) return prompt;

    const descriptions = attachments.map(att => {
      switch (att.kind) {
        case 'image'   : return `[Image jointe: ${att.name}]`;
        case 'audio'   : return `[Audio joint: ${att.name}]`;
        case 'document': return `[Document joint: ${att.name}]`;
        default        : return `[Fichier joint: ${att.name}]`;
      }
    });

    return `${prompt}\n\n${descriptions.join('\n')}`;
  }

  // -- Handlers API (page Messaging) -- migres depuis skycloud.js
  //    Delegue aux methodes node.X() (couplees a #messageBus/#apiKeyStore/#evolutionManager, gardees dans skycloud).
  apiHandlers(node) {
    return {
      sendAiMessage    : (from, to, content, apiKey) => node.sendMessage(from, to, content, apiKey),
      injectChatLesson : node.injectChatLesson.bind(node),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS — self-consistency (sélection du consensus)
// ─────────────────────────────────────────────────────────────────

function _tokenSet(text) {
  return new Set(String(text).toLowerCase().match(/\b\w+\b/g) ?? []);
}

function _jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Choisit la réponse la plus "centrale" parmi N candidats : celle dont la
 * similarité moyenne aux autres est la plus élevée (consensus self-consistency).
 * @returns {{ index: number, agreement: number }}
 */
function _selectConsensus(texts) {
  const sets = texts.map(_tokenSet);
  let bestIdx = 0, bestAvg = -1;
  for (let i = 0; i < sets.length; i++) {
    let sum = 0;
    for (let j = 0; j < sets.length; j++) if (i !== j) sum += _jaccard(sets[i], sets[j]);
    const avg = sets.length > 1 ? sum / (sets.length - 1) : 1;
    if (avg > bestAvg) { bestAvg = avg; bestIdx = i; }
  }
  return { index: bestIdx, agreement: bestAvg };
}
