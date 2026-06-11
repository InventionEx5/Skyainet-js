// packages/core/src/i18n.js
// =====================================================
// I18n — Internationalisation SkyAInet × Nikola T369
//
// Langues : EN (défaut) · FR · ES
// Portée  : toutes les pages HTML du projet
//
// Usage :
//   import { i18n } from './i18n.js';
//   i18n.setLang('fr');
//   i18n.t('nav.online')         // → "EN LIGNE"
//   i18n.t('rewards.claim')      // → "Réclamer"
//   i18n.t('profile.tier.legend')// → "Légende"
//
// Les clés sont organisées par page/section.
// Toujours ajouter la clé EN en premier.
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CATALOGUE DE TRADUCTIONS
// ─────────────────────────────────────────────────────────────────

const TRANSLATIONS = {

  // ── Navigation globale ──────────────────────────────────────────
  nav: {
    online       : { en: 'ONLINE',      fr: 'EN LIGNE',    es: 'EN LÍNEA'    },
    offline      : { en: 'OFFLINE',     fr: 'HORS LIGNE',  es: 'SIN CONEXIÓN'},
    uptime       : { en: 'Uptime',      fr: 'Disponibilité',es: 'Tiempo activo'},
    preferences  : { en: 'Preferences', fr: 'Préférences', es: 'Preferencias' },
    language     : { en: 'Language',    fr: 'Langue',      es: 'Idioma'       },
    theme        : { en: 'Theme',       fr: 'Thème',       es: 'Tema'         },
    dark         : { en: '🌙 Dark',     fr: '🌙 Sombre',   es: '🌙 Oscuro'   },
    light        : { en: '☀ Light',    fr: '☀ Clair',    es: '☀ Claro'    },
    current      : { en: 'current',     fr: 'actuel',      es: 'actual'       },
  },

  // ── SKYAINET home ───────────────────────────────────────────────
  home: {
    welcome      : { en: 'Welcome to SKYAINET',                    fr: 'Bienvenue sur SKYAINET',             es: 'Bienvenido a SKYAINET'            },
    subtitle     : { en: 'Decentralized Sovereign AI Network',     fr: 'Réseau IA Souverain Décentralisé',   es: 'Red IA Soberana Descentralizada'  },
    openPage     : { en: 'How would you like to open this page?',  fr: 'Comment voulez-vous ouvrir cette page ?', es: '¿Cómo desea abrir esta página?' },
    sameTab      : { en: '↩ Same tab',                            fr: '↩ Même onglet',                      es: '↩ Misma pestaña'                  },
    newTab       : { en: '⧉ New tab',                             fr: '⧉ Nouvel onglet',                    es: '⧉ Nueva pestaña'                  },
    cancel       : { en: 'Cancel',                                 fr: 'Annuler',                            es: 'Cancelar'                         },
  },

  // ── Pages (noms) ────────────────────────────────────────────────
  pages: {
    thevie       : { en: 'Thevie',       fr: 'Thevie',       es: 'Thevie'       },
    skychat      : { en: 'SkyChat',      fr: 'SkyChat',      es: 'SkyChat'      },
    skycloud     : { en: 'Skycloud',     fr: 'Skycloud',     es: 'Skycloud'     },
    node         : { en: 'Node',         fr: 'Nœud',         es: 'Nodo'         },
    marketplace  : { en: 'Marketplace',  fr: 'Marché',       es: 'Mercado'      },
    governance   : { en: 'Governance',   fr: 'Gouvernance',  es: 'Gobernanza'   },
    settings     : { en: 'Settings',     fr: 'Paramètres',   es: 'Ajustes'      },
    skyainet     : { en: 'SKYAINET',     fr: 'SKYAINET',     es: 'SKYAINET'     },
  },

  // ── Sous-titres des boutons ─────────────────────────────────────
  pageDesc: {
    thevie       : { en: 'Chat and Friends',   fr: 'Chat et Amis',       es: 'Chat y Amigos'     },
    skychat      : { en: 'Messaging',           fr: 'Messagerie',         es: 'Mensajería'        },
    skycloud     : { en: 'Node Server',         fr: 'Serveur Nœud',       es: 'Servidor Nodo'     },
    node         : { en: 'Network',             fr: 'Réseau',             es: 'Red'               },
    marketplace  : { en: 'Trade',               fr: 'Commerce',           es: 'Comercio'          },
    governance   : { en: 'DAO · Vote',          fr: 'DAO · Vote',         es: 'DAO · Voto'        },
    settings     : { en: 'Configuration',       fr: 'Configuration',      es: 'Configuración'     },
  },

  // ── Wallet popup ────────────────────────────────────────────────
  wallet: {
    title        : { en: 'SKY Wallet',          fr: 'Portefeuille SKY',   es: 'Billetera SKY'     },
    noWallet     : { en: 'No wallet',            fr: 'Aucun portefeuille', es: 'Sin billetera'     },
    totalBalance : { en: 'SKY — total balance',  fr: 'SKY — solde total',  es: 'SKY — saldo total' },
    pending      : { en: 'Pending Rewards',      fr: 'Récompenses en attente', es: 'Recompensas pendientes' },
    claim        : { en: 'Claim',                fr: 'Réclamer',           es: 'Reclamar'          },
    send         : { en: 'Send',                 fr: 'Envoyer',            es: 'Enviar'            },
    receive      : { en: 'Receive',              fr: 'Recevoir',           es: 'Recibir'           },
    sendAddress  : { en: '0x… destination address', fr: 'Adresse de destination 0x…', es: 'Dirección destino 0x…' },
    sendAmount   : { en: 'Amount (SKY)',         fr: 'Montant (SKY)',       es: 'Cantidad (SKY)'    },
    copy         : { en: '⎘ Copy address',       fr: '⎘ Copier l\'adresse', es: '⎘ Copiar dirección'},
    copied       : { en: 'Address copied ✓',     fr: 'Adresse copiée ✓',   es: 'Dirección copiada ✓'},
    sending      : { en: '↻ Sending…',           fr: '↻ Envoi en cours…',  es: '↻ Enviando…'      },
    sent         : { en: 'SKY sent ✓',           fr: 'SKY envoyés ✓',      es: 'SKY enviados ✓'   },
    noTx         : { en: 'No transactions yet',  fr: 'Aucune transaction',  es: 'Sin transacciones' },
    recentTx     : { en: 'Recent Transactions',  fr: 'Transactions récentes', es: 'Transacciones recientes' },
    insufficient : { en: 'Insufficient balance', fr: 'Solde insuffisant',   es: 'Saldo insuficiente'},
    invalidAddr  : { en: 'Invalid address',      fr: 'Adresse invalide',    es: 'Dirección inválida'},
    yourAddress  : { en: 'Your wallet address',  fr: 'Votre adresse',       es: 'Su dirección'     },
  },

  // ── Profil popup ────────────────────────────────────────────────
  profile: {
    title        : { en: 'Profile',              fr: 'Profil',             es: 'Perfil'            },
    accountType  : { en: 'Account Type',         fr: 'Type de compte',     es: 'Tipo de cuenta'    },
    upgrade      : { en: 'Upgrade',              fr: 'Améliorer',          es: 'Mejorar'           },
    reputation   : { en: 'Reputation',           fr: 'Réputation',         es: 'Reputación'        },
    posiScore    : { en: 'PoSI Score',           fr: 'Score PoSI',         es: 'Puntuación PoSI'   },
    thevieEvo    : { en: 'Thevie Evo',           fr: 'Évo. Thevie',        es: 'Evo. Thevie'       },
    dailyUsage   : { en: 'Daily Usage',          fr: 'Usage journalier',   es: 'Uso diario'        },
    qualityScore : { en: 'Quality Score',        fr: 'Score qualité',      es: 'Puntuación calidad'},
    verification : { en: 'Verification',         fr: 'Vérification',       es: 'Verificación'      },
    // Tiers
    tier: {
      newcomer   : { en: 'Newcomer',             fr: 'Nouveau',            es: 'Nuevo'             },
      reliable   : { en: 'Reliable',             fr: 'Fiable',             es: 'Fiable'            },
      trusted    : { en: 'Trusted',              fr: 'De confiance',       es: 'De confianza'      },
      sovereign  : { en: 'Sovereign',            fr: 'Souverain',          es: 'Soberano'          },
      legend     : { en: 'Legend',               fr: 'Légende',            es: 'Leyenda'           },
    },
    // AccountType
    account: {
      free       : { en: 'Free',                 fr: 'Gratuit',            es: 'Gratuito'          },
      pro        : { en: 'Pro',                  fr: 'Pro',                es: 'Pro'               },
      nodeOwner  : { en: 'Node Owner',           fr: 'Propriétaire Nœud',  es: 'Propietario Nodo'  },
    },
    // Verification levels
    verif: {
      none       : { en: 'Unverified',           fr: 'Non vérifié',        es: 'Sin verificar'     },
      email      : { en: 'Email verified',       fr: 'Email vérifié',      es: 'Email verificado'  },
      wallet     : { en: 'Wallet linked',        fr: 'Wallet lié',         es: 'Billetera vinculada'},
      node       : { en: 'Active node',          fr: 'Nœud actif',         es: 'Nodo activo'       },
      validator  : { en: 'Validator',            fr: 'Validateur',         es: 'Validador'         },
    },
  },

  // ── Rewards popup ───────────────────────────────────────────────
  rewards: {
    title        : { en: 'SKY Rewards',          fr: 'Récompenses SKY',    es: 'Recompensas SKY'   },
    pending      : { en: 'SKY pending',          fr: 'SKY en attente',     es: 'SKY pendientes'    },
    claimMonthly : { en: '🤲 Claim Monthly Rewards', fr: '🤲 Réclamer les récompenses mensuelles', es: '🤲 Reclamar recompensas mensuales' },
    totalEarned  : { en: 'Total Earned',         fr: 'Total gagné',        es: 'Total ganado'      },
    subBonus     : { en: 'Sub Bonus',            fr: 'Bonus abonnement',   es: 'Bono suscripción'  },
    sources      : { en: 'Reward Sources',       fr: 'Sources de gains',   es: 'Fuentes de ganancias' },
    learn        : { en: 'Learn Contributions',  fr: 'Contributions Learn', es: 'Contribuciones Learn' },
    dream        : { en: 'Dream Cycles',         fr: 'Cycles Dream',       es: 'Ciclos Dream'      },
    quality      : { en: 'Quality Interactions', fr: 'Interactions qualité', es: 'Interacciones calidad' },
    dailyLimit   : { en: 'Daily Limit',          fr: 'Limite journalière',  es: 'Límite diario'    },
    history      : { en: 'Payout History',       fr: 'Historique des paiements', es: 'Historial de pagos' },
    noPayout     : { en: 'No payouts yet',       fr: 'Aucun paiement',     es: 'Sin pagos aún'     },
    noClaim      : { en: 'No rewards to claim',  fr: 'Aucune récompense à réclamer', es: 'Sin recompensas que reclamar' },
    claimed      : { en: 'SKY claimed — added to wallet', fr: 'SKY réclamés — ajoutés au portefeuille', es: 'SKY reclamados — añadidos a billetera' },
  },

  // ── Skycloud modals ─────────────────────────────────────────────
  skycloud: {
    dashboard    : { en: 'Skycloud Dashboard',   fr: 'Tableau de bord Skycloud', es: 'Panel Skycloud' },
    gateway      : { en: 'Gateway',              fr: 'Passerelle',          es: 'Pasarela'          },
    keys         : { en: 'Keys',                 fr: 'Clés',               es: 'Llaves'            },
    storage      : { en: 'Storage',              fr: 'Stockage',            es: 'Almacenamiento'    },
    learn        : { en: 'Learn',                fr: 'Apprendre',           es: 'Aprender'          },
    dream        : { en: 'Dream',                fr: 'Rêve',               es: 'Sueño'             },
    metrics      : { en: 'Metrics',              fr: 'Métriques',           es: 'Métricas'          },
    peers        : { en: 'Peers',                fr: 'Pairs',               es: 'Pares'             },
    rewards      : { en: 'Rewards',              fr: 'Récompenses',         es: 'Recompensas'       },
    subscribe    : { en: 'Subscribe',            fr: 'S\'abonner',          es: 'Suscribirse'       },
    cancel       : { en: 'Cancel',               fr: 'Annuler',             es: 'Cancelar'          },
    confirm      : { en: 'Confirm subscription', fr: 'Confirmer l\'abonnement', es: 'Confirmar suscripción' },
    insufficient : { en: 'Insufficient balance', fr: 'Solde insuffisant',   es: 'Saldo insuficiente'},
    online       : { en: 'ONLINE',               fr: 'EN LIGNE',            es: 'EN LÍNEA'          },
    offline      : { en: 'OFFLINE',              fr: 'HORS LIGNE',          es: 'SIN CONEXIÓN'      },
  },

  // ── Plans d'abonnement ──────────────────────────────────────────
  plans: {
    starter      : { en: 'Starter',             fr: 'Starter',             es: 'Básico'            },
    pro          : { en: 'Pro',                  fr: 'Pro',                 es: 'Pro'               },
    sovereign    : { en: 'Sovereign',            fr: 'Souverain',           es: 'Soberano'          },
    perMonth     : { en: 'SKY / month',          fr: 'SKY / mois',          es: 'SKY / mes'         },
    billing      : { en: 'Billed automatically every 30 days from your SKY wallet.',
                     fr: 'Facturé automatiquement tous les 30 jours depuis votre portefeuille SKY.',
                     es: 'Facturado automáticamente cada 30 días desde su billetera SKY.' },
    refund       : { en: 'Unused days are refunded pro-rata if you cancel.',
                     fr: 'Les jours non utilisés sont remboursés au prorata en cas d\'annulation.',
                     es: 'Los días no utilizados se reembolsan proporcionalmente si cancela.' },
    active       : { en: 'ACTIVE',               fr: 'ACTIF',               es: 'ACTIVO'            },
    enabled      : { en: '✓ Enabled',            fr: '✓ Activé',            es: '✓ Activado'        },
    disabled     : { en: '✗ Disabled in Gateway',fr: '✗ Désactivé (Passerelle)', es: '✗ Desactivado (Pasarela)' },
  },

  // ── Toast / notifications ───────────────────────────────────────
  toast: {
    copied       : { en: 'Copied ✓',             fr: 'Copié ✓',             es: 'Copiado ✓'         },
    saved        : { en: 'Saved ✓',              fr: 'Sauvegardé ✓',        es: 'Guardado ✓'        },
    error        : { en: 'An error occurred',    fr: 'Une erreur s\'est produite', es: 'Ocurrió un error' },
    noWallet     : { en: 'No wallet connected',  fr: 'Aucun portefeuille connecté', es: 'Sin billetera conectada' },
    keyGenerated : { en: 'Key generated and signed ✓', fr: 'Clé générée et signée ✓', es: 'Clave generada y firmada ✓' },
    keyCopied    : { en: 'Key copied!',          fr: 'Clé copiée !',        es: '¡Clave copiada!'   },
    dreamStarted : { en: 'Dream Cycle started',  fr: 'Cycle Dream démarré', es: 'Ciclo Dream iniciado' },
    dreamDone    : { en: 'Dream Cycle complete', fr: 'Cycle Dream terminé', es: 'Ciclo Dream completo' },
  },

  // ── Marketplace ─────────────────────────────────────────────────
  marketplace: {
    title        : { en: 'Marketplace',          fr: 'Marché',              es: 'Mercado'           },
    subtitle     : { en: 'Trade compute, models & datasets for SKY',
                     fr: 'Échangez calcul, modèles et données contre SKY',
                     es: 'Intercambia cómputo, modelos y datos por SKY' },
  },

  // ── Governance ──────────────────────────────────────────────────
  governance: {
    title        : { en: 'Governance',           fr: 'Gouvernance',         es: 'Gobernanza'        },
    subtitle     : { en: 'DAO · Vote',           fr: 'DAO · Vote',          es: 'DAO · Voto'        },
    treasury     : { en: 'Treasury: 55% Users · 25% DAO · 15% Burn · 5% Dev',
                     fr: 'Trésorerie : 55% Utilisateurs · 25% DAO · 15% Brûlé · 5% Dév',
                     es: 'Tesorería: 55% Usuarios · 25% DAO · 15% Quema · 5% Dev' },
  },

  // ── Erreurs génériques ──────────────────────────────────────────
  errors: {
    notConnected : { en: 'Wallet not connected',  fr: 'Portefeuille non connecté', es: 'Billetera no conectada' },
    insufficient : { en: 'Insufficient SKY balance', fr: 'Solde SKY insuffisant', es: 'Saldo SKY insuficiente' },
    network      : { en: 'Network error',         fr: 'Erreur réseau',        es: 'Error de red'      },
    unknown      : { en: 'Unknown error',         fr: 'Erreur inconnue',      es: 'Error desconocido' },
  },
};

// ─────────────────────────────────────────────────────────────────
// I18N MANAGER
// ─────────────────────────────────────────────────────────────────

export class I18nManager {
  #lang;             // 'en' | 'fr' | 'es'
  #fallback;         // 'en'
  #listeners;        // Set<Function> — callbacks quand la langue change

  constructor(defaultLang = 'en') {
    this.#lang      = this.#validate(defaultLang);
    this.#fallback  = 'en';
    this.#listeners = new Set();
  }

  // ─── Langue ───────────────────────────────────────────────────

  #validate(lang) {
    return ['en', 'fr', 'es'].includes(lang) ? lang : 'en';
  }

  /** Retourne la langue courante. */
  get lang() { return this.#lang; }

  /** Retourne les langues disponibles. */
  get available() { return ['en', 'fr', 'es']; }

  /**
   * Change la langue active.
   * Notifie tous les listeners enregistrés.
   * @param {'en'|'fr'|'es'} lang
   */
  setLang(lang) {
    const validated = this.#validate(lang);
    if (validated === this.#lang) return;
    this.#lang = validated;
    this.#listeners.forEach(fn => fn(validated));
    console.info(`[I18n] Langue → ${validated}`);
  }

  /**
   * S'abonner aux changements de langue.
   * @param {function} callback — appelé avec la nouvelle langue
   * @returns {function} unsubscribe
   */
  onChange(callback) {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  // ─── Traduction ───────────────────────────────────────────────

  /**
   * Retourne la traduction d'une clé.
   * Format : 'section.key' ou 'section.sub.key'
   * Fallback : EN si la clé n'existe pas dans la langue courante.
   *
   * @param {string} key   — ex: 'nav.online', 'profile.tier.legend'
   * @param {object} [vars]— variables à interpoler: t('wallet.sent', { amount: 12 }) → '12 SKY sent ✓'
   * @returns {string}
   */
  t(key, vars = {}) {
    const parts  = key.split('.');
    let   node   = TRANSLATIONS;

    for (const part of parts) {
      if (node?.[part] === undefined) {
        console.warn(`[I18n] Clé manquante : '${key}'`);
        return key; // retourner la clé brute si introuvable
      }
      node = node[part];
    }

    // node est maintenant { en, fr, es } ou une feuille
    if (typeof node === 'object' && node !== null && ('en' in node)) {
      const str = node[this.#lang] ?? node[this.#fallback] ?? key;
      return this.#interpolate(str, vars);
    }

    console.warn(`[I18n] '${key}' ne pointe pas vers une traduction`);
    return key;
  }

  /**
   * Raccourci : retourne toutes les traductions d'une section.
   * @param {string} section — ex: 'nav'
   * @returns {object} — { key: traduction }
   */
  section(section) {
    const node = TRANSLATIONS[section];
    if (!node) return {};
    const result = {};
    for (const [key, val] of Object.entries(node)) {
      if (typeof val === 'object' && 'en' in val) {
        result[key] = val[this.#lang] ?? val[this.#fallback];
      } else if (typeof val === 'object') {
        // Sous-section (ex: profile.tier)
        result[key] = {};
        for (const [subKey, subVal] of Object.entries(val)) {
          result[key][subKey] = subVal[this.#lang] ?? subVal[this.#fallback] ?? subKey;
        }
      }
    }
    return result;
  }

  #interpolate(str, vars) {
    return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
  }

  // ─── Persistance ─────────────────────────────────────────────

  /**
   * Sauvegarde la langue dans localStorage (browser) ou retourne silencieusement (Node).
   */
  save() {
    try { localStorage.setItem('sky_lang', this.#lang); } catch { /* Node.js */ }
  }

  /**
   * Charge la langue depuis localStorage.
   */
  load() {
    try {
      const saved = localStorage.getItem('sky_lang');
      if (saved) this.setLang(saved);
    } catch { /* Node.js */ }
    return this.#lang;
  }
}

// ─────────────────────────────────────────────────────────────────
// INSTANCE SINGLETON — partagée entre toutes les pages
// ─────────────────────────────────────────────────────────────────

export const i18n = new I18nManager('en');

export default i18n;
