// ==UserScript==
// @name         Achats : téléchargement en lot des factures
// @namespace    https://nicolas.chassard/meg
// @version      1.0.0
// @description  v1.0.0 (2026-11-24) : bouton « Télécharger les factures » sur Achats simplifiés. Télécharge le PDF de
//               chaque facture non réglée dans Téléchargements/<Société>/« Fournisseur - JJ-MM-AAAA - N°.pdf »,
//               puis la passe en Réglé, mode de règlement « Téléchargé » (code TELECHARGE), date du jour.
// @author       Nicolas
// @match        https://mon-expert-en-gestion.fr/*
// @run-at       document-start
// @noframes
// ==/UserScript==

// CHANGELOG
// 1.0.0 (2026-11-24) — première version.
//
// API MEG utilisée (relevée le 24/11/2026 sur DYNASTIE TRANSACTION) — hôte rest.mon-expert-en-gestion.fr,
// en-têtes Authorization: Bearer … + X-IdEntreprise, cookies (withCredentials) :
//   GET  /ac/rest/achats-simplifies?page&size&sort&filter=etat:in:NON_REGLE|…  → { data[], totalPages }
//   GET  /ac/rest/achats-simplifies/{id}                                    → détail, échéances, _links
//   GET  …/{id}/telecharger-document                                         → application/pdf
//   GET  /ac/rest/achats-simplifies/modes-reglement                          → [{ id, code, libelle }]
//   POST …/{id}/modifier-echeances   body = [échéances]                      → achat mis à jour
//        (lien HATEOAS _links['modifier-achat-echeances'] du détail ; '-' = interdit)
//   GET  /ac/rest/commun/utilisateur?withCompanies=true                      → listeEntreprises [{ id, name }]
// Le jeton n'est pas lisible ailleurs : on le capte au vol sur les requêtes de l'appli (XHR).

(function () {
  'use strict';
  if (window.__atmAchatsDl) return;
  window.__atmAchatsDl = true;

  const API = 'https://rest.mon-expert-en-gestion.fr';
  const PAGE_RE = /^\/ac\/achats-simplifies\/?$/;
  const MODE_CODE = 'TELECHARGE';
  const ETATS = 'NON_REGLE|PARTIELLEMENT_REGLE';
  const BTN_ID = 'atm-achats-dl-btn';

  // ---------------------------------------------------------------------------
  // Capture du jeton et de l'entreprise courante sur les requêtes de l'appli
  // ---------------------------------------------------------------------------
  const auth = { token: null, ent: null };
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    const key = String(k).toLowerCase();
    if (key === 'authorization' && /^Bearer /.test(v)) auth.token = v;
    else if (key === 'x-identreprise' && v) auth.ent = v;
    return origSetHeader.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Appels API
  // ---------------------------------------------------------------------------
  function api(method, path, { body, binary } = {}) {
    return new Promise((resolve, reject) => {
      if (!auth.token || !auth.ent) {
        return reject(new Error('Session MEG pas encore détectée : rechargez la page (F5) puis réessayez.'));
      }
      const x = new XMLHttpRequest();
      x.open(method, /^https:/.test(path) ? path : API + path);
      x.withCredentials = true;
      if (binary) x.responseType = 'arraybuffer';
      origSetHeader.call(x, 'Authorization', auth.token);
      origSetHeader.call(x, 'X-IdEntreprise', auth.ent);
      origSetHeader.call(x, 'Accept', binary ? 'application/pdf, */*' : 'application/json, text/plain, */*');
      if (body !== undefined) origSetHeader.call(x, 'Content-Type', 'application/json');
      x.onload = () => {
        if (x.status === 401 || x.status === 403) {
          return reject(new Error(`Accès refusé par MEG (${x.status}) : session expirée ? Rechargez la page.`));
        }
        if (x.status < 200 || x.status >= 300) {
          let msg = '';
          try {
            const j = JSON.parse(x.responseText);
            msg = j.message || j.detail || j.title || '';
          } catch (e) {}
          return reject(new Error(`HTTP ${x.status} sur ${path.split('?')[0]}${msg ? ' — ' + msg : ''}`));
        }
        if (binary) return resolve({ buf: x.response, type: x.getResponseHeader('content-type') || '' });
        try {
          resolve(x.responseText ? JSON.parse(x.responseText) : null);
        } catch (e) {
          reject(new Error('Réponse illisible sur ' + path.split('?')[0]));
        }
      };
      x.onerror = () => reject(new Error('Erreur réseau sur ' + path.split('?')[0]));
      x.send(body === undefined ? null : JSON.stringify(body));
    });
  }

  const linkOk = (l) => l && l.href && l.href !== '-';

  async function listAchatsNonRegles() {
    const out = [];
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ page: String(page), size: '50', sort: 'dateEmission,asc', filter: 'etat:in:' + ETATS });
      const r = await api('GET', '/ac/rest/achats-simplifies?' + q);
      out.push(...((r && r.data) || []));
      if (!r || page + 1 >= (r.totalPages || 1)) break;
    }
    return out;
  }

  async function nomSociete() {
    try {
      const u = await api('GET', '/ac/rest/commun/utilisateur?withCompanies=true');
      const e = (u.listeEntreprises || []).find((x) => x.id === auth.ent);
      if (e && e.name) return e.name;
    } catch (e) {}
    // Repli : le sélecteur de dossier dans l'en-tête de MEG.
    const btn = [...document.querySelectorAll('header button, button')].find((b) => /^[A-Z0-9][A-Z0-9 &'.-]{2,}$/.test(b.textContent.trim()));
    return btn ? btn.textContent.trim() : 'Dossier MEG';
  }

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const frDate = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : 'sans date');

  function cleanName(s) {
    return String(s || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 120);
  }

  function fileName(achat) {
    const fournisseur = cleanName((achat.fournisseur && achat.fournisseur.nomComplet) || 'Fournisseur inconnu');
    const numero = cleanName(achat.numeroFacture || achat.numeroComptableAchat || 'sans numero');
    return `${fournisseur} - ${frDate(achat.dateEmission)} - ${numero}.pdf`;
  }

  function toDataUrl(buf, type) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${type || 'application/pdf'};base64,${btoa(bin)}`;
  }

  const isPdf = (buf) => {
    const b = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
    return String.fromCharCode(...b) === '%PDF-';
  };

  // Échéances renvoyées à MEG : celles déjà réglées restent telles quelles,
  // les autres passent en Réglé / Téléchargé / date du jour (même format que
  // l'écran Règlement de MEG).
  function echeancesReglees(detail, idMode, date) {
    return (detail.echeances || []).map((e) => {
      const base = {
        id: e.id,
        version: e.version,
        type: e.type,
        dateEcheance: e.dateEcheance,
        montant: e.montant,
        multiReglement: !!e.multiReglement,
      };
      if (e.statutPaiement === 'REGLE') {
        return { ...base, idModeReglement: e.idModeReglement, statutPaiement: 'REGLE', reglement: e.reglement };
      }
      return { ...base, idModeReglement: idMode, statutPaiement: 'REGLE', reglement: { dateReglement: date } };
    });
  }

  // ---------------------------------------------------------------------------
  // Fenêtre de progression
  // ---------------------------------------------------------------------------
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function panel() {
    const overlay = el('div', 'position:fixed;inset:0;z-index:2147483640;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif');
    const box = el('div', 'background:#fff;border-radius:10px;width:min(760px,94vw);max-height:84vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.35)');
    const head = el('div', 'background:#5b45f5;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0;font-weight:600;font-size:15px', 'Téléchargement des factures d\'achat');
    const status = el('div', 'padding:10px 18px 4px;font-weight:600;color:#111827', 'Préparation…');
    const barWrap = el('div', 'margin:4px 18px 8px;height:6px;background:#eef2ff;border-radius:3px;overflow:hidden');
    const bar = el('div', 'height:100%;width:0;background:#5b45f5;transition:width .2s');
    barWrap.appendChild(bar);
    const log = el('div', 'padding:4px 18px;overflow:auto;flex:1;min-height:120px;font-size:12px;color:#374151');
    const foot = el('div', 'padding:10px 18px 14px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #eee');
    const btnStop = el('button', 'background:#fff;color:#b91c1c;border:1px solid #fca5a5;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer', 'Arrêter');
    const btnClose = el('button', 'background:#5b45f5;color:#fff;border:0;border-radius:6px;padding:7px 16px;font:inherit;cursor:pointer', 'Fermer et actualiser');
    btnClose.hidden = true;
    foot.append(btnStop, btnClose);
    box.append(head, status, barWrap, log, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const ui = {
      stopped: false,
      status: (t) => (status.textContent = t),
      progress: (i, n) => (bar.style.width = n ? Math.round((i / n) * 100) + '%' : '0'),
      line(text, kind) {
        const color = { ok: '#047857', err: '#b91c1c', warn: '#b45309' }[kind] || '#374151';
        const icon = { ok: '✔ ', err: '✖ ', warn: '⚠ ' }[kind] || '';
        const d = el('div', `padding:2px 0;color:${color};white-space:pre-wrap`, icon + text);
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
      },
      finish() {
        btnStop.hidden = true;
        btnClose.hidden = false;
        btnClose.focus();
      },
    };
    btnStop.onclick = () => {
      ui.stopped = true;
      btnStop.disabled = true;
      btnStop.textContent = 'Arrêt après la facture en cours…';
    };
    btnClose.onclick = () => {
      overlay.remove();
      location.reload();
    };
    return ui;
  }

  // ---------------------------------------------------------------------------
  // Traitement
  // ---------------------------------------------------------------------------
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    const ui = panel();
    let ok = 0;
    let ko = 0;
    try {
      const [modes, societeBrut, achats] = await Promise.all([
        api('GET', '/ac/rest/achats-simplifies/modes-reglement'),
        nomSociete(),
        listAchatsNonRegles(),
      ]);
      const mode = (modes || []).find((m) => String(m.code).toUpperCase() === MODE_CODE && m.isActive !== false);
      if (!mode) {
        ui.status('Mode de règlement « Téléchargé » absent de ce dossier');
        ui.line(
          'Créez-le une fois dans ce dossier : Paramètres > Listes par défaut > Modes de règlement > Ajouter\n' +
            '  code TELECHARGE, libellé Téléchargé, délai 0 jours, compte comptable 99999999.\n' +
            'Puis relancez le téléchargement.',
          'err'
        );
        return;
      }
      const societe = cleanName(societeBrut) || 'Dossier MEG';
      const date = today();
      if (!achats.length) {
        ui.status('Aucune facture non réglée : rien à télécharger.');
        return;
      }
      ui.status(`${achats.length} facture(s) non réglée(s) — dossier Téléchargements\\${societe}`);

      for (let i = 0; i < achats.length; i++) {
        if (ui.stopped) {
          ui.line(`Arrêt demandé : ${achats.length - i} facture(s) non traitée(s).`, 'warn');
          break;
        }
        const a = achats[i];
        const nom = fileName(a);
        ui.progress(i, achats.length);
        ui.status(`(${i + 1}/${achats.length}) ${nom}`);
        try {
          const detail = await api('GET', '/ac/rest/achats-simplifies/' + a.id);
          const links = detail._links || {};
          if (!linkOk(links['url-document'])) throw new Error('aucun document PDF attaché');
          const lienRegl = links['modifier-achat-echeances'];
          if (!linkOk(lienRegl)) {
            throw new Error('MEG ne permet pas de modifier le règlement' + (lienRegl && lienRegl.title ? ' (' + lienRegl.title + ')' : ''));
          }
          if (!(detail.echeances || []).length) throw new Error('aucune échéance à régler');

          // 1. Télécharger le PDF et l'enregistrer.
          const { buf, type } = await api('GET', links['url-document'].href, { binary: true });
          if (!isPdf(buf)) throw new Error('le document reçu n\'est pas un PDF (' + (type || 'type inconnu') + ')');
          const saved = await ATM.download(toDataUrl(buf, 'application/pdf'), `${societe}/${nom}`, 'uniquify');

          // 2. Seulement une fois le fichier écrit : passer la facture en Réglé / Téléchargé.
          await api('POST', lienRegl.href, {
            body: echeancesReglees(detail, mode.id, date),
          });
          ok++;
          const fichier = String((saved && saved.filename) || nom).split(/[\\/]/).pop();
          ui.line(`${fichier} — réglée (Téléchargé, ${frDate(date)})`, 'ok');
        } catch (e) {
          ko++;
          ui.line(`${nom} — ${e.message || e}`, 'err');
        }
      }
      ui.progress(1, 1);
      ui.status(`Terminé : ${ok} facture(s) téléchargée(s) et réglée(s)` + (ko ? `, ${ko} en erreur` : '') + '.');
    } catch (e) {
      ui.status('Erreur');
      ui.line(e.message || String(e), 'err');
    } finally {
      ui.finish();
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Bouton dans la page Achats simplifiés (appli monopage : on surveille le DOM)
  // ---------------------------------------------------------------------------
  function findImporter() {
    return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Importer');
  }

  function ensureButton() {
    const onPage = PAGE_RE.test(location.pathname);
    const existing = document.getElementById(BTN_ID);
    if (!onPage) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const importer = findImporter();
    if (!importer || !importer.parentElement) return;
    const b = el(
      'button',
      'display:inline-flex;align-items:center;gap:6px;margin-right:8px;background:#fff;color:#5b45f5;border:1px solid #5b45f5;' +
        'border-radius:6px;padding:0 12px;height:' + (importer.offsetHeight || 32) + 'px;font:600 13px system-ui,Segoe UI,Arial;cursor:pointer;white-space:nowrap',
      '⬇ Télécharger les factures'
    );
    b.id = BTN_ID;
    b.type = 'button';
    b.title = 'Télécharge les PDF des factures non réglées dans Téléchargements\\<Société>, puis les passe en Réglé (mode Téléchargé)';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    importer.parentElement.insertBefore(b, importer);
  }

  ATM.onReady(() => {
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(ensureButton, 150);
    }).observe(document.body, { childList: true, subtree: true });
    ensureButton();
  });
})();
