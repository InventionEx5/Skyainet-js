"use strict";
/* =====================================================
   skychrome.js — Chrome partagé SkyAInet
   • Registre des 8 pages (icône Lucide + couleur signature)
   • Fenêtre Navigation (logo cliquable → 8 pages)
   • Dialogue de redirection (Open X / Same tab / New tab / Cancel)
   • Thème Light/Dark global (clé localStorage sky_theme, sync multi-onglets)
   • i18n optionnel (clé sky_lang) via skyApplyI18n(dict)
   Conventions Android : 0 backtick, concaténation, == pour IDs.
   SkyAInet × Nikola T369
   ===================================================== */

// ─────────── REGISTRE DES 8 PAGES ───────────
// svg = contenu interne <svg> (paths Lucide), identique au dashboard SKYAINET.
var SKY_PAGES = [
  { file:'skyainet.html',    name:'SKYAINET',     color:'#4ade80',
    svg:'<path d="M15 3c.4 2.85 1.5 3.95 4.35 4.35C16.5 7.75 15.4 8.85 15 11.7 14.6 8.85 13.5 7.75 10.65 7.35 13.5 6.95 14.6 5.85 15 3Z"/><path d="M4 20l5-5"/><path d="M4.7 15.6l1.9 1.9"/><path d="M8.6 19.4l1.4 1.4"/>' },
  { file:'thevie.html',      name:'Thevie',       color:'#92400e',
    svg:'<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3Z"/>' },
  { file:'messaging.html',   name:'SkyChat',      color:'#fbbf24',
    svg:'<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>' },
  { file:'skycloud.html',    name:'Skycloud',     color:'#1d4ed8',
    svg:'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>' },
  { file:'node.html',        name:'Node',         color:'#38bdf8',
    svg:'<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="11" x2="13" y1="12" y2="12"/>' },
  { file:'marketplace.html', name:'Marketplace',  color:'#ef4444',
    svg:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" x2="21" y1="6" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>' },
  { file:'governance.html',  name:'Governance',   color:'#cbd5e1',
    svg:'<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21H17"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>' },
  { file:'settings.html',    name:'Settings',     color:'#f97316',
    svg:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' }
];

// ─────────── Helpers SVG ───────────
function skyIconSvg(page, size, cls){
  var s = size || 18;
  return '<svg xmlns="http://www.w3.org/2000/svg" class="' + (cls||'') + '" width="' + s + '" height="' + s
    + '" style="color:' + page.color + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + page.svg + '</svg>';
}
function skyCurrentFile(){
  var p = (location.pathname || '').split('/').pop();
  return p && p.indexOf('.html') >= 0 ? p : 'skyainet.html';
}
function skyPage(file){ for (var i=0;i<SKY_PAGES.length;i++){ if (SKY_PAGES[i].file === file) return SKY_PAGES[i]; } return null; }

// ─────────── THÈME GLOBAL ───────────
function skyApplyTheme(t){
  var theme = t || localStorage.getItem('sky_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
}
function skySetTheme(t){
  localStorage.setItem('sky_theme', t);
  skyApplyTheme(t);
}
// Synchronisation multi-onglets : si le thème/langue change ailleurs, on applique ici.
window.addEventListener('storage', function(e){
  if (e.key === 'sky_theme') skyApplyTheme(e.newValue);
  if (e.key === 'sky_lang' && window._skyI18nDict) skyApplyI18n(window._skyI18nDict);
});

// ─────────── i18n OPTIONNEL ───────────
// dict : { 'cle': { en:'…', fr:'…', es:'…' }, … } ; éléments balisés data-i18n="cle".
function skyApplyI18n(dict){
  if (!dict) return;
  window._skyI18nDict = dict;
  var lang = localStorage.getItem('sky_lang') || 'en';
  var els = document.querySelectorAll('[data-i18n]');
  for (var i=0;i<els.length;i++){
    var key = els[i].getAttribute('data-i18n');
    var entry = dict[key];
    if (entry && entry[lang]) els[i].textContent = entry[lang];
  }
}
function skySetLang(l){ localStorage.setItem('sky_lang', l); if (window._skyI18nDict) skyApplyI18n(window._skyI18nDict); }

// ─────────── FENÊTRE NAVIGATION (logo → 8 pages) ───────────
// Styles INLINE : fonctionne même si skychrome.css n'est pas chargé.
function openNavMenu(accent){
  var cur = skyCurrentFile();
  var ac  = accent || (skyPage(cur) ? skyPage(cur).color : '#4ade80');
  var prev = document.getElementById('sky-nav-overlay'); if (prev) prev.remove();
  var ov  = document.createElement('div');
  ov.id = 'sky-nav-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:flex-start;justify-content:flex-start;padding:3.5rem 0 0 1.5rem;background:rgba(0,0,0,.6)';

  var rows = '';
  for (var i=0;i<SKY_PAGES.length;i++){
    var pg = SKY_PAGES[i];
    var isCur = pg.file === cur;
    rows += '<button '
      + (isCur ? '' : 'onclick="navigateTo(\'' + pg.file + '\',\'' + ac + '\')" onmouseover="this.style.background=\'rgba(255,255,255,.08)\'" onmouseout="this.style.background=\'transparent\'" ')
      + 'style="width:100%;display:flex;align-items:center;gap:.7rem;padding:.6rem .85rem;border-radius:.85rem;font-size:.85rem;color:#fff;text-align:left;border:none;cursor:' + (isCur?'default':'pointer') + ';background:' + (isCur?'rgba(255,255,255,.06)':'transparent') + ';opacity:' + (isCur?'.55':'1') + '">'
      + skyIconSvg(pg, 18, '')
      + '<span style="font-weight:600">' + pg.name + '</span>'
      + (isCur ? '<span style="margin-left:auto;font-size:.6rem;color:' + ac + '">current</span>' : '')
      + '</button>';
  }

  ov.innerHTML = '<div onclick="event.stopPropagation()" style="background:rgba(16,18,26,.98);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.1);border-radius:1.4rem;padding:1rem;width:15rem;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.5)">'
    + '<div style="font-size:.6rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.4);padding:.2rem .85rem .55rem">Navigation</div>'
    + rows
    + '<button onclick="document.getElementById(\'sky-nav-overlay\').remove()" style="width:100%;padding:.5rem;background:none;border:none;color:rgba(255,255,255,.4);font-size:.72rem;cursor:pointer;margin-top:.3rem">Close</button>'
    + '</div>';
  ov.addEventListener('click', function(e){ if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

// ─────────── DIALOGUE DE REDIRECTION (styles inline) ───────────
function navigateTo(page, accent){
  var navOv = document.getElementById('sky-nav-overlay'); if (navOv) navOv.remove();
  var rprev = document.getElementById('sky-redirect-overlay'); if (rprev) rprev.remove();
  var pg = skyPage(page);
  var name = pg ? pg.name : page;
  var curPg = skyPage(skyCurrentFile());
  var ac = accent || (curPg ? curPg.color : '#4ade80');   // couleur dominante de la page courante
  var ov = document.createElement('div');
  ov.id = 'sky-redirect-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:rgba(0,0,0,.75)';
  ov.innerHTML = '<div onclick="event.stopPropagation()" style="background:rgba(16,18,26,.98);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.1);border-radius:1.4rem;padding:1.4rem;width:100%;max-width:280px;box-shadow:0 20px 60px rgba(0,0,0,.5)">'
    + '<div style="font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:.4rem;padding:0 .3rem">Open <span style="color:' + ac + '">' + name + '</span></div>'
    + '<div style="font-size:.82rem;color:rgba(255,255,255,.6);margin:0 .3rem 1rem">How would you like to open this page?</div>'
    + '<div style="display:flex;flex-direction:column;gap:.5rem">'
    + '<button onclick="_skyGo(\'' + page + '\',false,this)" style="width:100%;padding:.65rem 1rem;border-radius:.9rem;font-size:.8rem;font-weight:600;cursor:pointer;border:1px solid ' + ac + '55;background:' + ac + '22;color:' + ac + '">&#8629;&nbsp; Same tab</button>'
    + '<button onclick="_skyGo(\'' + page + '\',true,this)" style="width:100%;padding:.65rem 1rem;border-radius:.9rem;font-size:.8rem;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:rgba(255,255,255,.6)">&#8607;&nbsp; New tab</button>'
    + '<button onclick="document.getElementById(\'sky-redirect-overlay\').remove()" style="width:100%;padding:.45rem;background:none;border:none;color:rgba(255,255,255,.4);font-size:.72rem;cursor:pointer;margin-top:.1rem">Cancel</button>'
    + '</div></div>';
  ov.addEventListener('click', function(e){ if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}
function _skyGo(page, newTab, btn){
  var ov = document.getElementById('sky-redirect-overlay'); if (ov) ov.remove();
  if (newTab) window.open(page, '_blank'); else window.location.href = page;
}

// ─────────── AUTO-APPLICATION AU CHARGEMENT ───────────
skyApplyTheme();   // applique sky_theme immédiatement (évite le flash)
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', function(){ skyApplyTheme(); });
