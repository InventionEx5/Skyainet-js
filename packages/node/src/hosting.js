// packages/node/src/hosting.js
// Hébergement de sites Skycloud (sous-domaines .skyainet.net)
// Chiffrement RomanT369 via DecentralizedStorage + signature Dilithium5.
// Migré depuis skycloud.js : possède l'état #sites ; accède au stockage/signeur/id
// partagés via le node. Les endpoints REST de server.js passent par node.hosting.

function _inferContentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  return {
    html : 'text/html; charset=utf-8',
    css  : 'text/css',
    js   : 'application/javascript',
    json : 'application/json',
    png  : 'image/png',
    jpg  : 'image/jpeg',
    jpeg : 'image/jpeg',
    gif  : 'image/gif',
    svg  : 'image/svg+xml',
    webp : 'image/webp',
    ico  : 'image/x-icon',
    woff : 'font/woff',
    woff2: 'font/woff2',
    ttf  : 'font/ttf',
    pdf  : 'application/pdf',
    mp4  : 'video/mp4',
    webm : 'video/webm',
    mp3  : 'audio/mpeg',
    txt  : 'text/plain',
    xml  : 'application/xml',
    wasm : 'application/wasm',
  }[ext] ?? 'application/octet-stream';
}

class HostedSite {
  constructor({ id, name, domain, owner, createdAt = Date.now() }) {
    this.id            = id;
    this.name          = name;
    this.domain        = domain;        // ex: mon-site.skyainet.net
    this.owner         = owner;         // nodeId du propriétaire
    this.createdAt     = createdAt;
    this.updatedAt     = createdAt;
    this.version       = 0;
    this.active        = false;         // true après publishSite()
    this.files         = new Map();     // path → fileId (ex: '/index.html' → 'file_xxx')
    this.versions      = [];            // historique { version, ts, snapshot: Map }
    this.hits          = 0;
    this.bytesServed   = 0;
    this.lastHit       = null;
    this.signature     = null;          // Dilithium5 de la dernière publication
    this.customDomain  = null;          // domaine custom configuré par l'utilisateur
    this.sizeBytes     = 0;             // taille totale des fichiers
  }

  toJSON() {
    return {
      id          : this.id,
      name        : this.name,
      domain      : this.customDomain ?? this.domain,
      owner       : this.owner,
      createdAt   : this.createdAt,
      updatedAt   : this.updatedAt,
      version     : this.version,
      active      : this.active,
      fileCount   : this.files.size,
      sizeBytes   : this.sizeBytes,
      hits        : this.hits,
      bytesServed : this.bytesServed,
      lastHit     : this.lastHit,
      versionCount: this.versions.length,
      customDomain: this.customDomain,
    };
  }
}

export class HostingManager {
  #node;
  #sites;   // Map<siteId, HostedSite>

  constructor(node) {
    this.#node  = node;
    this.#sites = new Map();
  }

  createSite(name, domain) {
    if (!name?.trim())   throw new Error('Nom de site requis');
    if (!domain?.trim()) throw new Error('Domaine requis');

    const safeDomain = domain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const fullDomain = `${safeDomain}.skyainet.net`;

    for (const site of this.#sites.values()) {
      if (site.domain === fullDomain) throw new Error(`Domaine '${fullDomain}' déjà utilisé`);
    }

    const id   = `site_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const site = new HostedSite({ id, name: name.trim(), domain: fullDomain, owner: this.#node.id });
    this.#sites.set(id, site);

    console.info(`[Hosting] Site créé : ${name} → ${fullDomain}`);
    return site;
  }

  async uploadSiteFile(siteId, path, data) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);

    const safePath = path.startsWith('/') ? path : `/${path}`;
    const fileName = `${siteId}${safePath}`;
    const raw      = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const fileId   = await this.#node.storage.storeFile(fileName, raw, this.#node.id);

    // Supprimer l'ancienne version si elle existait
    const oldId = site.files.get(safePath);
    if (oldId && oldId !== fileId) await this.#node.storage.deleteFile(oldId).catch(() => {});

    site.files.set(safePath, fileId);
    site.sizeBytes = [...site.files.values()].length * raw.length;
    site.updatedAt = Date.now();

    console.debug(`[Hosting] ${site.domain}${safePath} → ${fileId}`);
    return fileId;
  }

  async publishSite(siteId) {
    const site = this.#sites.get(siteId);
    if (!site)                          throw new Error(`Site '${siteId}' introuvable`);
    if (site.files.size === 0)          throw new Error('Aucun fichier — uploadez au moins index.html');
    if (!site.files.has('/index.html')) throw new Error('index.html requis à la racine du site');

    // Backup de la version courante
    if (site.version > 0) {
      site.versions.push({ version: site.version, ts: site.updatedAt, snapshot: new Map(site.files) });
      if (site.versions.length > 20) site.versions.shift();
    }

    site.version++;
    site.active    = true;
    site.updatedAt = Date.now();

    // Signature Dilithium5 du manifeste du site
    const manifest = JSON.stringify({
      siteId, domain: site.domain, version: site.version,
      files: [...site.files.keys()].sort(), ts: site.updatedAt,
    });
    site.signature = Buffer.from(this.#node.signer.sign(new TextEncoder().encode(manifest)))
      .toString('hex').slice(0, 64);

    await this.#node.storage.replicatePending();

    const domain = site.customDomain ?? site.domain;
    console.info(`[Hosting] Publié : ${domain} v${site.version} | ${site.files.size} fichiers | sig: ${site.signature.slice(0,16)}…`);
    return { version: site.version, domain, url: `https://${domain}`,
             signature: site.signature, fileCount: site.files.size, sizeBytes: site.sizeBytes };
  }

  async rollbackSite(siteId, version = null) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);

    const target = version != null
      ? site.versions.find(v => v.version === version)
      : site.versions[site.versions.length - 1];

    if (!target) throw new Error(`Version ${version ?? 'précédente'} introuvable`);

    // Backup avant rollback
    site.versions.push({ version: site.version, ts: Date.now(), snapshot: new Map(site.files) });
    site.files     = new Map(target.snapshot);
    site.version   = site.version + 1;
    site.updatedAt = Date.now();

    console.info(`[Hosting] Rollback ${site.domain} → v${target.version} (nouvelle v${site.version})`);
    return { rolledBack: target.version, newVersion: site.version };
  }

  async getSiteFile(domain, path) {
    const site = [...this.#sites.values()].find(s =>
      s.active && (s.domain === domain || s.customDomain === domain)
    );
    if (!site) return null;

    let safePath = path.startsWith('/') ? path : `/${path}`;
    if (safePath === '/') safePath = '/index.html';

    const fileId = site.files.get(safePath) ?? site.files.get('/index.html');
    if (!fileId) return null;

    const data = await this.#node.storage.retrieveFile(fileId);
    if (!data)  return null;

    site.hits++;
    site.bytesServed += data.length;
    site.lastHit      = Date.now();

    return { data, contentType: _inferContentType(safePath), sizeBytes: data.length };
  }

  setCustomDomain(siteId, customDomain) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);
    for (const s of this.#sites.values()) {
      if (s.id !== siteId && s.customDomain === customDomain)
        throw new Error(`Domaine '${customDomain}' déjà utilisé`);
    }
    site.customDomain = customDomain;
    console.info(`[Hosting] Domaine custom : ${customDomain} → ${site.id}`);
  }

  listSites()     { return [...this.#sites.values()].map(s => s.toJSON()); }

  getSite(id)     { return this.#sites.get(id)?.toJSON() ?? null; }

  async deleteSite(siteId) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);
    for (const fileId of site.files.values()) {
      await this.#node.storage.deleteFile(fileId).catch(() => {});
    }
    this.#sites.delete(siteId);
    console.info(`[Hosting] Site supprimé : ${site.domain}`);
  }

  recordSiteHit(siteId, bytes = 0) {
    const site = this.#sites.get(siteId);
    if (!site) return;
    site.hits++;
    site.bytesServed += bytes;
    site.lastHit      = Date.now();
  }

  async serveSite(siteId) {
    try {
      const data = await this.#node.storage.retrieveFile(siteId);
      if (!data) return null;
      const signature = this.#node.signer.sign(data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data)));
      return {
        id              : siteId,
        encryptedContent: data,
        isAiGenerated   : true,
        signature       : Array.from(signature.subarray(0, 64)),
        version         : 1,
      };
    } catch {
      return null;
    }
  }

  // ─── Handlers API (page Skycloud — hébergement de sites) ─── migrés depuis skycloud.js
  apiHandlers(node) {
    return {
      createSite                : (name, domain)       => this.createSite(name, domain),
      uploadSiteFile            : (siteId, path, data) => this.uploadSiteFile(siteId, path, data),
      publishSite               : (siteId)             => this.publishSite(siteId),
      deleteSite                : (siteId)             => this.deleteSite(siteId),
      listSites                 : ()                   => this.listSites(),
      getSite                   : (id)                 => this.getSite(id),
      serveSite                 : (siteId)             => this.serveSite(siteId),
    };
  }
}
