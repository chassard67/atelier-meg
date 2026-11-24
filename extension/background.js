// Atelier MEG — service worker (coquille stable).
//
// Rôle :
//  1. Télécharger les modules publiés (manifest.json + fichiers .js) depuis
//     cfg.baseUrl, vérifier leur empreinte SHA-256, les garder en cache local.
//  2. Vérifier la licence de l'utilisateur (licences.json publié).
//  3. Injecter les modules actifs via chrome.userScripts (monde MAIN = même
//     contexte que la page, comme le preload Electron) — ou, sans licence
//     valide, seulement un bandeau d'information.
//  4. Servir de relais réseau (ex-GM_xmlhttpRequest / IPC Electron), limité
//     aux hôtes déclarés par @connect.
//  5. Garder les « notes de mise à jour » à afficher dans la page.
//
// Cette partie ne change presque jamais : les évolutions fonctionnelles se
// font dans /scripts et sont poussées sans réinstaller l'extension.

import { DEFAULTS, FALLBACK_SETTINGS, LICENCE_GRACE_DAYS, EXTENSION_NOTES } from './config.js';

const EXT_VERSION = chrome.runtime.getManifest().version;
const ALARM = 'atm-update-check';
// Sites où l'extension agit : publiés dans manifest.json (appMatches = @match des modules +
// publish.json defaultMatches). MEG par défaut tant que rien n'est publié.
const DEFAULT_MATCHES = ['https://mon-expert-en-gestion.fr/*'];
function appMatches(manifest) {
  const m = manifest && Array.isArray(manifest.appMatches) && manifest.appMatches.length ? manifest.appMatches : null;
  if (m) return m;
  const set = new Set(DEFAULT_MATCHES);
  for (const sc of (manifest && manifest.scripts) || []) (sc.matches || []).forEach((x) => set.add(x));
  return [...set];
}
// Motif de correspondance Chrome (https://*.domaine.fr/*) → RegExp.
function matchPatternToRe(p) {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(p);
  if (!m) return null;
  const scheme = m[1] === '*' ? 'https?' : m[1];
  const host = m[2] === '*' ? '[^/]+' : m[2].replace(/\./g, '\\.').replace(/^\*\\\./, '(?:[^/]+\\.)?');
  const path = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + scheme + ':\\/\\/' + host + path + '$');
}
function urlMatches(url, patterns) {
  return patterns.some((p) => {
    const re = matchPatternToRe(p);
    return re && re.test(url);
  });
}
// Réglages pilotés depuis la publication (publish.json → config) : aucun besoin de
// mettre la coquille à jour pour les changer.
function remoteConfig(manifest) {
  const c = (manifest && manifest.config) || {};
  return {
    checkIntervalMin: Math.max(5, Number(c.checkIntervalMin) || 30),
    pageCheckMinutes: Math.max(1, Number(c.pageCheckMinutes) || 5),
    offlineGraceMinutes: Math.max(0, Number(c.offlineGraceMinutes) || 0),
  };
}

// ---------------------------------------------------------------------------
// Configuration / état
// ---------------------------------------------------------------------------

async function getConfig() {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  return {
    ...DEFAULTS,
    ...cfg,
    modules: { ...(cfg.modules || {}) },
    settings: { ...(cfg.settings || {}) },
  };
}

async function patchConfig(patch) {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  const next = { ...cfg, ...patch };
  if (patch.settings) next.settings = { ...(cfg.settings || {}), ...patch.settings };
  if (patch.modules) next.modules = { ...(cfg.modules || {}), ...patch.modules };
  delete next.disabled; // ancien format (1.0.0)
  await chrome.storage.local.set({ cfg: next });
  return getConfig();
}

async function getState() {
  const { state = {} } = await chrome.storage.local.get('state');
  return state;
}

async function patchState(patch) {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state });
  return state;
}

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function userScriptsAvailable() {
  try {
    chrome.userScripts.getScripts(); // lève une exception si le bouton n'est pas activé
    return true;
  } catch {
    return false;
  }
}

// Valeurs effectives = choix de l'utilisateur, sinon défaut publié, sinon repli.
function catalogItems(manifest) {
  const out = [];
  for (const g of (manifest && manifest.catalog) || []) for (const it of g.items || []) out.push(it);
  return out;
}

function effectiveSettings(manifest, cfg) {
  const defs = {};
  for (const it of catalogItems(manifest)) if (it.type === 'setting') defs[it.id] = !!it.default;
  return { ...FALLBACK_SETTINGS, ...defs, ...cfg.settings };
}

function effectiveModules(manifest, cfg) {
  const enabled = new Set();
  if (!manifest) return enabled;
  const defs = {};
  for (const it of catalogItems(manifest)) if (it.type === 'module') defs[it.id] = !!it.default;
  for (const s of manifest.scripts) {
    const def = s.id in defs ? defs[s.id] : s.default !== false;
    if (s.required || (s.id in cfg.modules ? cfg.modules[s.id] : def)) enabled.add(s.id);
  }
  // Dépendances (ex. consult-premium a besoin de grand-livre).
  const deps = manifest.dependencies || {};
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...enabled]) {
      for (const d of deps[id] || []) {
        if (!enabled.has(d)) {
          enabled.add(d);
          grew = true;
        }
      }
    }
  }
  return enabled;
}

// ---------------------------------------------------------------------------
// Licence
// ---------------------------------------------------------------------------
// licences.json (publié) : { licences: [{ hash, client, status }] } où hash =
// SHA-256 de la clé normalisée. Les clés elles-mêmes ne sont jamais publiées.

function normalizeKey(k) {
  return String(k || '').trim().toUpperCase();
}

async function checkLicence(base, cfg, manifest) {
  if (manifest && manifest.licenceRequired === false) return { status: 'not-required' };
  const prev = (await getState()).licence || {};
  const key = normalizeKey(cfg.licenceKey);
  if (!key) return { status: 'missing' };
  const hash = await sha256Hex(key);
  try {
    const data = JSON.parse(await fetchText(base + 'licence?h=' + hash));
    const st = data && data.status;
    if (st === 'active') {
      return { status: 'active', client: data.client || '', checkedAt: Date.now(), validatedAt: Date.now() };
    }
    if (st === 'expired' || st === 'blocked') {
      return { status: st, client: data.client || '', checkedAt: Date.now() };
    }
    return { status: 'unknown', checkedAt: Date.now() };
  } catch (e) {
    // Serveur injoignable : on garde le dernier état connu, avec un délai de grâce.
    if (prev.status === 'active' && prev.keyHash === hash) {
      const age = Date.now() - (prev.validatedAt || 0);
      if (age > LICENCE_GRACE_DAYS * 86400e3) return { ...prev, status: 'expired' };
      return prev;
    }
    return { status: 'unverified', error: String(e.message || e) };
  }
}

function licenceOk(lic) {
  return lic && (lic.status === 'active' || lic.status === 'not-required');
}

// ---------------------------------------------------------------------------
// Notes de mise à jour (fenêtre affichée dans la page par le module socle)
// ---------------------------------------------------------------------------

async function addNotice(notice) {
  const { notices = [] } = await chrome.storage.local.get('notices');
  const rest = notices.filter((n) => n.id !== notice.id);
  rest.push(notice);
  await chrome.storage.local.set({ notices: rest });
}

// ---------------------------------------------------------------------------
// Téléchargement des modules
// ---------------------------------------------------------------------------

// Deux nouvelles tentatives (3 s puis 10 s) en cas d'échec réseau ou de
// réponse serveur en erreur : pendant une republication GitHub Pages, le
// serveur renvoie brièvement des erreurs (vu en direct : « Failed to fetch »).
async function fetchText(url, headers) {
  const sep = url.includes('?') ? '&' : '?';
  let lastErr;
  for (const wait of [0, 3000, 10000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url + sep + 't=' + Date.now(), { cache: 'no-store', headers: headers || undefined });
      if (res.ok) return res.text();
      lastErr = new Error(`HTTP ${res.status} sur ${url}`);
      lastErr.status = res.status;
      // 403 = licence refusée côté serveur ; inutile de réessayer.
      if (res.status === 403) break;
      if (res.status === 404 && !/manifest\.json|\/licence/.test(url)) break;
    } catch (e) {
      lastErr = new Error(`${e.message} (${url.replace(/\?.*$/, '')})`);
    }
  }
  throw lastErr;
}

async function getCachedCode(file) {
  const key = 'code:' + file;
  const { [key]: entry } = await chrome.storage.local.get(key);
  return entry || null;
}

let updateInFlight = null;

// fresh : si une vérification tourne déjà (ex. celle lancée au rechargement
// de l'extension), on attend sa fin puis on en relance une, pour tenir compte
// d'un réglage qui vient de changer (clé de licence saisie, source...).
// Sans cela, la saisie de la clé renvoyait le résultat de la vérification en
// cours, faite SANS la clé (« Aucune clé saisie »).
function checkForUpdates(reason = 'auto', { fresh = false } = {}) {
  if (updateInFlight && fresh) {
    return updateInFlight.catch(() => {}).then(() => checkForUpdates(reason));
  }
  if (!updateInFlight) {
    updateInFlight = doCheckForUpdates(reason).finally(() => {
      updateInFlight = null;
    });
  }
  return updateInFlight;
}

async function doCheckForUpdates(reason) {
  const cfg = await getConfig();
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/';
  const state = await getState();
  const keyHash = cfg.licenceKey ? await sha256Hex(normalizeKey(cfg.licenceKey)) : null;
  let manifest = state.manifest || null;
  let licence = null;
  let changed = false;
  let error = null;
  // Publication GitHub : 'ok' | 'unreachable' (réseau, VPN, GitHub en panne) | 'removed' (dépôt supprimé ou renommé → 404).
  // Hors 'ok', AUCUN module n'est injecté : l'extension ne fonctionne que si la publication répond.
  let publication = 'ok';
  let step = 'manifest';
  try {
    manifest = JSON.parse(await fetchText(base + 'manifest.json'));
    step = 'modules';
    await patchState({ lastOkAt: Date.now() });
    if (!manifest || !Array.isArray(manifest.scripts) || !manifest.runtime) {
      throw new Error('manifest.json invalide');
    }
    // Licence vérifiée AVANT de télécharger : le serveur ne livre le code
    // qu'à une clé valide (403 sinon). On envoie l'empreinte de la clé en
    // en-tête ; sans clé valide, rien n'est téléchargé (bannière affichée).
    licence = await checkLicence(base, cfg, manifest);
    licence.keyHash = keyHash;

    if (licenceOk(licence)) {
      const auth = keyHash ? { 'x-atm-licence': keyHash } : undefined;
      // Télécharge uniquement ce qui a changé, vérifie chaque fichier AVANT de
      // remplacer quoi que ce soit : en cas d'erreur, l'ancienne version reste.
      const toStore = {};
      for (const item of [manifest.runtime, ...manifest.scripts]) {
        const cached = await getCachedCode(item.file);
        if (cached && cached.sha256 === item.sha256) continue;
        const code = await fetchText(base + item.file, auth);
        const hash = await sha256Hex(code);
        if (hash !== item.sha256) {
          throw new Error(`Empreinte incorrecte pour ${item.file} (cache du serveur pas encore à jour ? réessayer dans quelques minutes)`);
        }
        toStore['code:' + item.file] = { sha256: hash, code };
      }
      changed = Object.keys(toStore).length > 0 || state.manifest?.build !== manifest.build;
      if (Object.keys(toStore).length) await chrome.storage.local.set(toStore);

      // Note de version : affichée une fois quand la version de publication
      // change (jamais à la toute première installation).
      const rel = manifest.release;
      if (rel && rel.version && rel.version !== state.releaseSeen) {
        if (state.releaseSeen) {
          await addNotice({
            id: 'release-' + rel.version,
            title: `Atelier MEG ${rel.version} activé`,
            date: rel.date || '',
            lines: rel.notes || [],
          });
        }
        await patchState({ releaseSeen: rel.version });
      }
    }
  } catch (e) {
    error = String(e.message || e);
    if (step === 'manifest') {
      publication = e && e.status === 404 ? 'removed' : 'unreachable';
      // Tolérance hors ligne (publish.json → config.offlineGraceMinutes, 0 par défaut).
      const grace = remoteConfig(state.manifest).offlineGraceMinutes * 60e3;
      if (publication === 'unreachable' && grace && state.lastOkAt && Date.now() - state.lastOkAt < grace) {
        publication = 'ok';
      }
      if (publication === 'removed') {
        // Publication supprimée : on efface aussi le code gardé en cache.
        const all = await chrome.storage.local.get(null);
        const codeKeys = Object.keys(all).filter((k) => k.startsWith('code:'));
        if (codeKeys.length) await chrome.storage.local.remove(codeKeys);
        manifest = null;
      }
    }
  }
  const publicationChanged = (state.publication || 'ok') !== publication;

  if (!licence) licence = await checkLicence(base, cfg, manifest);
  licence.keyHash = keyHash;
  const licenceChanged = (state.licence || {}).status !== licence.status;

  await patchState({
    manifest,
    publication,
    licence,
    lastCheck: Date.now(),
    lastError: error,
    ...(changed ? { lastUpdate: Date.now() } : {}),
  });

  const nothingRegistered =
    userScriptsAvailable() && (await chrome.userScripts.getScripts()).length === 0;
  if (changed || licenceChanged || publicationChanged || nothingRegistered || reason !== 'alarm') {
    await applyRegistrations();
  }
  if (remoteConfig(manifest).checkIntervalMin !== remoteConfig(state.manifest).checkIntervalMin) await scheduleAlarm();
  await refreshBadge();
  return error ? { ok: false, error, licence: licence.status } : { ok: true, changed, build: manifest.build, licence: licence.status };
}

// ---------------------------------------------------------------------------
// Injection dans les pages
// ---------------------------------------------------------------------------

const LICENCE_MESSAGES = {
  missing: "Atelier MEG : aucune clé de licence n'est saisie. Cliquez sur l'icône de l'extension pour la renseigner.",
  unknown: 'Atelier MEG : clé de licence non reconnue. Vérifiez la clé saisie dans l\'extension.',
  blocked: 'Atelier MEG : licence suspendue. Les fonctionnalités Premium sont désactivées — contactez votre administrateur.',
  expired: 'Atelier MEG : licence non vérifiée depuis trop longtemps. Vérifiez votre connexion puis cliquez sur « Vérifier » dans l\'extension.',
  unverified: 'Atelier MEG : licence pas encore vérifiée (serveur injoignable). Réessayez plus tard.',
};

function licenceBannerCode(message) {
  return `(function () {
  if (window.__atmLicenceBanner) return;
  window.__atmLicenceBanner = true;
  var show = function () {
    try { if (sessionStorage.getItem('atm-licence-banner')) return; sessionStorage.setItem('atm-licence-banner', '1'); } catch (e) {}
    var d = document.createElement('div');
    d.textContent = ${JSON.stringify(message)};
    d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:640px;' +
      'background:#7f1d1d;color:#fff;padding:12px 18px;border-radius:8px;font:13px/1.4 system-ui,Segoe UI,Arial;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer';
    d.title = 'Cliquer pour fermer';
    d.onclick = function () { d.remove(); };
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 15000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();`;
}

const PUBLICATION_MESSAGES = {
  unreachable:
    'Atelier MEG est désactivé : le serveur de publication (GitHub) ne répond pas. Vérifiez la connexion internet ou le VPN ; ' +
    'l\'extension se réactive d\'elle-même dès qu\'il répond (ou icône Atelier MEG → « Vérifier les mises à jour », puis rechargez la page).',
  removed:
    'Atelier MEG est désactivé : sa publication n\'existe plus (dépôt GitHub supprimé ou renommé). ' +
    'Vous pouvez désinstaller l\'extension (chrome://extensions → Atelier MEG → Supprimer).',
};

function publicationBannerCode(message) {
  return `(function () {
  if (window.__atmPubBanner) return;
  window.__atmPubBanner = true;
  var show = function () {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483647;max-width:min(900px,94vw);display:flex;gap:12px;align-items:flex-start;' +
      'background:#7f1d1d;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,Segoe UI,Arial;box-shadow:0 6px 20px rgba(0,0,0,.3)';
    var t = document.createElement('div');
    t.style.flex = '1';
    t.textContent = ${JSON.stringify(message)};
    var x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Fermer';
    x.style.cssText = 'background:none;border:0;color:#fff;font:700 16px system-ui;cursor:pointer';
    x.onclick = function () { d.remove(); };
    d.appendChild(t); d.appendChild(x);
    document.body.appendChild(d);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();`;
}

// Pont page ⇄ extension sur tous les sites publiés (en plus de MEG, déclaré dans le
// manifest de l'extension). Un nouveau site = une ligne @match dans un module, sans
// toucher à la coquille. bridge.js se protège contre un double chargement.
async function registerBridge(manifest) {
  try {
    const matches = appMatches(manifest);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['atm-bridge'] });
    const def = { id: 'atm-bridge', matches, js: ['bridge.js'], runAt: 'document_start', allFrames: false, world: 'ISOLATED' };
    if (existing.length) await chrome.scripting.updateContentScripts([def]);
    else await chrome.scripting.registerContentScripts([def]);
  } catch (e) {
    console.warn('[Atelier] pont non enregistré', e);
  }
}

async function applyRegistrations() {
  if (!userScriptsAvailable()) {
    await refreshBadge();
    return { ok: false, error: 'userScripts indisponible' };
  }
  const cfg = await getConfig();
  const { manifest, licence, publication } = await getState();
  await chrome.userScripts.unregister(); // repart de zéro (idempotent)
  await registerBridge(manifest);
  if (publication && publication !== 'ok') {
    await chrome.userScripts.register([
      {
        id: 'atm-publication',
        matches: appMatches(manifest),
        runAt: 'document_idle',
        world: 'MAIN',
        allFrames: false,
        js: [{ code: publicationBannerCode(PUBLICATION_MESSAGES[publication] || PUBLICATION_MESSAGES.unreachable) }],
      },
    ]);
    return { ok: true, count: 0, publication };
  }
  if (!manifest) return { ok: true, count: 0 };

  if (!licenceOk(licence)) {
    const msg = LICENCE_MESSAGES[(licence && licence.status) || 'missing'] || LICENCE_MESSAGES.missing;
    await chrome.userScripts.register([
      { id: 'atm-licence', matches: appMatches(manifest), runAt: 'document_idle', world: 'MAIN', allFrames: false, js: [{ code: licenceBannerCode(msg) }] },
    ]);
    return { ok: true, count: 0, licence: licence && licence.status };
  }

  const runtime = await getCachedCode(manifest.runtime.file);
  if (!runtime) return { ok: false, error: 'runtime absent du cache' };

  const preamble = `window.__ATM_BOOT = ${JSON.stringify({
    extVersion: EXT_VERSION,
    build: manifest.build,
    release: manifest.release ? manifest.release.version : null,
    settings: effectiveSettings(manifest, cfg),
  })};\n`;

  // UN SEUL enregistrement contenant tous les modules actifs, dans l'ordre de
  // publication (= ordre de require() du preload Electron) : premium.js
  // définit window.TMBC avant les autres. document_start comme le preload.
  const enabled = effectiveModules(manifest, cfg);
  const js = [{ code: preamble + runtime.code + `\n//# sourceURL=atelier-meg/${manifest.runtime.file}` }];
  const matches = new Set();
  for (const s of manifest.scripts) {
    if (!enabled.has(s.id)) continue;
    const cached = await getCachedCode(s.file);
    if (!cached) continue;
    s.matches.forEach((m) => matches.add(m));
    js.push({
      code:
        `try {\n${cached.code}\n} catch (e) { console.error('[Atelier] erreur au chargement du module ${s.id}', e); }` +
        `\n//# sourceURL=atelier-meg/${s.file}`,
    });
  }
  if (js.length > 1) {
    await chrome.userScripts.register([
      { id: 'atm-bundle', matches: [...matches], runAt: 'document_start', world: 'MAIN', allFrames: false, js },
    ]);
  }
  return { ok: true, count: js.length - 1 };
}

async function refreshBadge() {
  const { manifest, lastError, licence, publication } = await getState();
  let text = '';
  let color = '#10b981';
  let title = 'Atelier MEG';
  if (!userScriptsAvailable()) {
    text = '!';
    color = '#dc2626';
    title += ' — activer « Autoriser les scripts utilisateur »';
  } else if (publication === 'removed') {
    text = 'OFF';
    color = '#dc2626';
    title += ' — désactivée : publication GitHub supprimée ou renommée';
  } else if (publication === 'unreachable') {
    text = 'OFF';
    color = '#dc2626';
    title += ' — désactivée : serveur de publication injoignable (' + (lastError || '') + ')';
  } else if (manifest && !licenceOk(licence)) {
    text = 'LIC';
    color = '#dc2626';
    title += ' — licence : ' + ((licence && licence.status) || 'absente');
  } else if (manifest && compareVersions(manifest.minExtensionVersion, EXT_VERSION) > 0) {
    text = 'EXT';
    color = '#f97316';
    title += ` — nouvelle version de l'extension requise (${manifest.minExtensionVersion})`;
  } else if (manifest && compareVersions(manifest.latestExtensionVersion, EXT_VERSION) > 0) {
    text = 'MAJ';
    color = '#f97316';
    title += ` — nouvelle version de l'extension disponible (${manifest.latestExtensionVersion}, installée : ${EXT_VERSION})`;
  } else if (!manifest && lastError) {
    text = '?';
    color = '#f97316';
    title += ' — modules jamais téléchargés : ' + lastError;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

async function scheduleAlarm() {
  const { manifest } = await getState();
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, {
    delayInMinutes: 1,
    periodInMinutes: remoteConfig(manifest).checkIntervalMin,
  });
}

// ---------------------------------------------------------------------------
// Relais réseau et services pour les modules
// ---------------------------------------------------------------------------

function hostAllowed(hostname, hosts) {
  for (const h of hosts) {
    if (hostname === h || hostname.endsWith('.' + h)) return true;
  }
  return false;
}

// responseType : 'text' | 'json' | 'base64' (binaire). credentials : 'omit' (défaut) | 'include'.
async function proxyHttp({ url, method = 'GET', headers, body, responseType = 'text', credentials = 'omit' }) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Seul https est autorisé');
  const { manifest } = await getState();
  if (!hostAllowed(u.hostname, new Set((manifest && manifest.connect) || []))) {
    throw new Error(`Hôte non autorisé : ${u.hostname} (ajouter @connect dans le module)`);
  }
  const res = await fetch(url, { method, headers, body, credentials: credentials === 'include' ? 'include' : 'omit' });
  const out = {
    status: res.status,
    statusText: res.statusText,
    finalUrl: res.url,
    headers: Object.fromEntries(res.headers.entries()),
  };
  if (responseType === 'base64') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    out.body = btoa(bin);
  } else {
    out.body = responseType === 'json' ? await res.json() : await res.text();
  }
  return out;
}

// Téléchargement d'un fichier produit par un module (ex. PDF de facture) dans
// le dossier Téléchargements de Chrome, sous-dossier compris. Attend la fin
// réelle du téléchargement : le module ne marque la facture « réglée » qu'après.
function cleanPath(p) {
  return String(p || '')
    .split('/')
    .map((seg) =>
      seg
        .replace(/[\u0000-\u001f<>:"\\|?*~]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .slice(0, 150)
    )
    .filter(Boolean)
    .join('/');
}

// Nom imposé au moment où Chrome détermine le nom du fichier : sans cela, une
// autre extension qui écoute onDeterminingFilename (ou Chrome lui-même pour une
// URL data:) remplace le nom demandé par « téléchargement (n).pdf ».
const pendingNames = new Map(); // url → { filename, conflictAction }
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const p = pendingNames.get(item.url) || pendingNames.get(item.finalUrl);
    if (p) {
      suggest({ filename: p.filename, conflictAction: p.conflictAction });
      return;
    }
  }
  suggest();
});

async function downloadFile({ url, filename, conflictAction = 'uniquify' }) {
  if (!/^(data:|https:\/\/)/.test(String(url))) throw new Error('URL de téléchargement refusée (data: ou https: uniquement)');
  const name = cleanPath(filename);
  if (!name) throw new Error('Nom de fichier vide');
  pendingNames.set(url, { filename: name, conflictAction });
  let id;
  try {
    id = await chrome.downloads.download({ url, filename: name, conflictAction, saveAs: false });
  } catch (e) {
    pendingNames.delete(url);
    throw e;
  }
  return new Promise((resolve, reject) => {
    const done = (item) => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      pendingNames.delete(url);
      if (item.state === 'complete') resolve({ id, filename: item.filename });
      else reject(new Error('Téléchargement interrompu : ' + (item.error || item.state)));
    };
    const check = () =>
      chrome.downloads.search({ id }).then(([item]) => {
        if (item && item.state !== 'in_progress') done(item);
      });
    const listener = (delta) => {
      if (delta.id === id && delta.state) check();
    };
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      pendingNames.delete(url);
      reject(new Error('Téléchargement trop long (délai dépassé)'));
    }, 120000);
    chrome.downloads.onChanged.addListener(listener);
    check();
  });
}

async function storeGet(key) {
  const k = 'us:' + key;
  const { [k]: v } = await chrome.storage.local.get(k);
  return v === undefined ? null : v;
}
async function storeSet(key, value) {
  const k = 'us:' + key;
  if (value === null || value === undefined) await chrome.storage.local.remove(k);
  else await chrome.storage.local.set({ [k]: value });
  return true;
}

// API Chrome utilisables par les modules sans modifier la coquille : ATM.chrome('downloads.show', id), etc.
const CHROME_API = new Set([
  'downloads.search',
  'downloads.show',
  'downloads.showDefaultFolder',
  'downloads.open',
  'downloads.erase',
  'downloads.cancel',
  'tabs.create',
  'tabs.query',
  'tabs.reload',
  'tabs.update',
  'tabs.remove',
  'windows.create',
  'windows.update',
  'notifications.create',
  'notifications.clear',
]);
async function chromeApi({ api, args = [] }, sender) {
  if (!CHROME_API.has(api)) throw new Error('API Chrome non autorisée : ' + api);
  const [ns, fn] = api.split('.');
  const target = chrome[ns];
  if (!target || typeof target[fn] !== 'function') throw new Error('API Chrome indisponible : ' + api);
  // « tabs.reload/update/remove » sans identifiant = l'onglet du module.
  if (/^tabs\.(reload|update|remove)$/.test(api) && typeof args[0] !== 'number' && sender.tab) args = [sender.tab.id, ...args];
  if (api === 'notifications.create' && args.length === 1) args = ['', args[0]];
  if (api === 'notifications.create') {
    args[1] = { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Atelier MEG', message: '', ...args[1] };
  }
  return await target[fn](...args);
}

const PAGE_HANDLERS = {
  chrome: chromeApi,
  info: async () => ({ extVersion: EXT_VERSION, capabilities: [...CHROME_API, 'http', 'download', 'store', 'notices'] }),
  http: proxyHttp,
  'store-get': ({ key }) => storeGet(key),
  'store-set': ({ key, value }) => storeSet(key, value),
  ping: () => ({ extVersion: EXT_VERSION }),
  download: downloadFile,
  // Ex-webFrame.setZoomFactor d'Electron : zoom propre à l'onglet.
  'set-zoom': async ({ factor }, sender) => {
    const f = Number(factor);
    if (!sender.tab || !(f >= 0.25 && f <= 5)) throw new Error('zoom invalide');
    await chrome.tabs.setZoomSettings(sender.tab.id, { mode: 'automatic', scope: 'per-tab' });
    await chrome.tabs.setZoom(sender.tab.id, f);
    return true;
  },
  // Notes de mise à jour en attente (affichées une fois par le module socle).
  'notices-get': async () => (await chrome.storage.local.get('notices')).notices || [],
  'notices-ack': async ({ ids }) => {
    const { notices = [] } = await chrome.storage.local.get('notices');
    await chrome.storage.local.set({ notices: notices.filter((n) => !(ids || []).includes(n.id)) });
    return true;
  },
};

// ---------------------------------------------------------------------------
// Messages (pont page ⇄ extension, et fenêtre de l'extension)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.atm === 'page') {
        const fn = PAGE_HANDLERS[msg.type];
        if (!fn) throw new Error('Action inconnue : ' + msg.type);
        return { ok: true, data: await fn(msg.payload || {}, sender) };
      }
      if (msg && msg.atm === 'popup') return { ok: true, data: await handlePopup(msg) };
      return { ok: false, error: 'message ignoré' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  })().then(sendResponse);
  return true;
});

async function handlePopup(msg) {
  switch (msg.type) {
    case 'status': {
      const [cfg, state] = await Promise.all([getConfig(), getState()]);
      const enabled = effectiveModules(state.manifest, cfg);
      return {
        extVersion: EXT_VERSION,
        extensionId: chrome.runtime.id,
        defaultBaseUrl: DEFAULTS.baseUrl,
        userScripts: userScriptsAvailable(),
        chromeVersion: Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || 0),
        cfg,
        state,
        settings: effectiveSettings(state.manifest, cfg),
        enabledModules: [...enabled],
      };
    }
    case 'check':
      return checkForUpdates('manual', { fresh: true });
    case 'set-module':
      await patchConfig({ modules: { [msg.id]: !!msg.value } });
      return applyRegistrations();
    case 'set-setting':
      await patchConfig({ settings: { [msg.id]: !!msg.value } });
      return applyRegistrations();
    case 'reset-defaults':
      // Fonctionnalités par défaut + source officielle (la clé de licence est gardée).
      {
        const { cfg = {} } = await chrome.storage.local.get('cfg');
        await chrome.storage.local.set({ cfg: { ...cfg, modules: {}, settings: {}, baseUrl: DEFAULTS.baseUrl } });
      }
      return applyRegistrations();
    case 'set-licence':
      await patchConfig({ licenceKey: normalizeKey(msg.key) });
      return checkForUpdates('manual', { fresh: true });
    case 'set-base-url': {
      let url = String(msg.baseUrl || '').trim();
      if (url && !url.endsWith('/')) url += '/';
      await patchConfig({ baseUrl: url || DEFAULTS.baseUrl });
      return checkForUpdates('manual', { fresh: true });
    }
    case 'reload-tabs': {
      const tabs = await chrome.tabs.query({ url: appMatches((await getState()).manifest) });
      await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
      return { count: tabs.length };
    }
    case 'reapply':
      return applyRegistrations();
    default:
      throw new Error('Action inconnue : ' + msg.type);
  }
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

// NB : Chrome efface les scripts enregistrés à chaque mise à jour de
// l'extension → on ré-enregistre systématiquement à l'install et au démarrage.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'update' && details.previousVersion && details.previousVersion !== EXT_VERSION) {
    await addNotice({
      id: 'extension-' + EXT_VERSION,
      title: `Extension Atelier MEG mise à jour (${details.previousVersion} → ${EXT_VERSION})`,
      lines: EXTENSION_NOTES[EXT_VERSION] || [],
    });
  }
  await scheduleAlarm();
  await applyRegistrations();
  await checkForUpdates('install');
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await applyRegistrations();
  await checkForUpdates('startup');
});

// Vérification aussi à l'ouverture d'une page MEG (au plus toutes les 5 min) : une
// publication supprimée ou injoignable désactive l'extension sans attendre l'alarme.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  const url = tab.url || changeInfo.url || '';
  const { lastCheck = 0, manifest } = await getState();
  if (!urlMatches(url, appMatches(manifest))) return;
  if (Date.now() - lastCheck > remoteConfig(manifest).pageCheckMinutes * 60e3) {
    checkForUpdates('page');
    reloadIfUpdatedOnDisk();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    checkForUpdates('alarm');
    reloadIfUpdatedOnDisk();
  }
});

// Mise à jour de la coquille sans intervention : quand les fichiers de l'extension ont été
// remplacés sur le disque (script maj/ de mise à jour automatique, ou zip extrait à la main),
// l'extension se recharge d'elle-même — plus besoin de cliquer ↻ dans chrome://extensions.
async function reloadIfUpdatedOnDisk() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    const onDisk = (await res.json()).version;
    if (compareVersions(onDisk, EXT_VERSION) > 0) {
      console.log('[Atelier] nouvelle version sur le disque', onDisk, '→ rechargement');
      chrome.runtime.reload();
    }
  } catch (e) {
    /* manifest illisible pendant l'écriture des fichiers : on réessaiera */
  }
}
reloadIfUpdatedOnDisk();
