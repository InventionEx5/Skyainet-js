// build.js — Compilation des binaires SkyAInet
// =====================================================
// Produit 3 binaires standalone via Bun :
//   dist/skyainet-windows.exe  (~25 Mo)
//   dist/skyainet-macos        (~25 Mo)
//   dist/skyainet-linux        (~25 Mo)
//
// Chaque binaire embarque :
//   • Bun runtime
//   • server.js + toutes les dépendances
//   • Tous les assets (HTML, CSS, JS, icônes)
//   • Service Worker + manifest PWA
//   • Tray, autostart, updater
//
// Usage :
//   bun build.js
//   bun build.js --platform linux
//   bun build.js --version 0.2.0
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { execSync }   from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const platArg     = args[args.indexOf('--platform') + 1];
const versionArg  = args[args.indexOf('--version')  + 1];
const VERSION     = versionArg ?? JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version ?? '0.1.0';
const DIST        = join(__dirname, 'dist');

// ── Targets Bun ───────────────────────────────────────────────
const TARGETS = {
    linux  : { target: 'bun-linux-x64',   outfile: 'skyainet-linux'       },
    macos  : { target: 'bun-darwin-x64',  outfile: 'skyainet-macos'       },
    macosArm: { target: 'bun-darwin-arm64', outfile: 'skyainet-macos-arm64' },
    windows: { target: 'bun-windows-x64', outfile: 'skyainet-windows.exe' },
};

// ── Sélection des targets ─────────────────────────────────────
const toBuild = platArg
    ? [TARGETS[platArg]].filter(Boolean)
    : Object.values(TARGETS);

if (!toBuild.length) {
    console.error(`Platform inconnue : ${platArg}. Valides : linux, macos, macosArm, windows`);
    process.exit(1);
}

// ── Préparation ───────────────────────────────────────────────
mkdirSync(DIST, { recursive: true });

// Injecter la version dans l'env du build
process.env.SKYAINET_VERSION = VERSION;

console.info(`\n★ SkyAInet Build v${VERSION}`);
console.info(`  Targets : ${toBuild.map(t => t.outfile).join(', ')}`);
console.info(`  Output  : ${DIST}\n`);

// ── Vérifier que Bun est installé ────────────────────────────
try {
    const bunVersion = execSync('bun --version', { encoding: 'utf8' }).trim();
    console.info(`  Bun     : v${bunVersion}`);
} catch {
    console.error('  ✗ Bun non trouvé — installer via https://bun.sh');
    process.exit(1);
}

// ── Build ─────────────────────────────────────────────────────
const entrypoint = join(__dirname, 'packages', 'node', 'src', 'start.js');
let   allOk      = true;

for (const { target, outfile } of toBuild) {
    const outPath = join(DIST, outfile);
    console.info(`  Building ${outfile}…`);

    try {
        execSync(
            [
                'bun build',
                `"${entrypoint}"`,
                '--compile',
                `--target ${target}`,
                `--outfile "${outPath}"`,
                `--define SKYAINET_VERSION='"${VERSION}"'`,
                '--minify',
            ].join(' '),
            {
                stdio: 'inherit',
                env  : { ...process.env, SKYAINET_VERSION: VERSION },
            }
        );

        // Vérifier que le binaire a été créé
        if (existsSync(outPath)) {
            const size = Math.round(readFileSync(outPath).length / 1_048_576);
            console.info(`  ✓ ${outfile} — ${size} Mo\n`);
        } else {
            throw new Error('Fichier de sortie non trouvé');
        }

    } catch (e) {
        console.error(`  ✗ ${outfile} — ${e.message}\n`);
        allOk = false;
    }
}

// ── Générer version.json pour l'auto-updater ─────────────────
const baseUrl    = `https://skyainet.net/releases/${VERSION}`;
const versionInfo = {
    version: VERSION,
    date   : new Date().toISOString(),
    url    : {
        linux  : `${baseUrl}/skyainet-linux`,
        darwin : `${baseUrl}/skyainet-macos`,
        win32  : `${baseUrl}/skyainet-windows.exe`,
    },
    sha256 : {},   // à remplir par le CI avec les checksums réels
};
writeFileSync(join(DIST, 'version.json'), JSON.stringify(versionInfo, null, 2));
console.info(`  ✓ version.json généré`);

// ── Résultat ──────────────────────────────────────────────────
if (allOk) {
    console.info(`\n✅ Build terminé — ${DIST}`);
    console.info(`   Distribuer les binaires depuis dist/`);
    console.info(`   Uploader version.json sur https://skyainet.net/version.json\n`);
} else {
    console.error(`\n⚠ Certains builds ont échoué — vérifier les erreurs ci-dessus\n`);
    process.exit(1);
}
