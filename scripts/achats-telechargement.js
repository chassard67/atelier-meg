// ==UserScript==
// @name         Achats : téléchargement en lot des factures
// @namespace    https://nicolas.chassard/meg
// @version      1.1.0
// @description  v1.1.0 (2026-11-24) : aperçu du PDF au survol du nom de fichier ; seules les factures cochées sont
//               traitées s'il y en a ; création automatique du mode « Téléchargé » s'il manque (avec confirmation).
//               v1.0.0 (2026-11-24) : bouton « Télécharger les factures » sur Achats simplifiés. Télécharge le PDF de
//               chaque facture non réglée dans Téléchargements/<Société>/« Fournisseur - JJ-MM-AAAA - N°.pdf »,
//               puis la passe en Réglé, mode de règlement « Téléchargé » (code TELECHARGE), date du jour.
// @author       Nicolas
// @match        https://mon-expert-en-gestion.fr/*
// @run-at       document-start
// @noframes
// ==/UserScript==

// CHANGELOG
// 1.1.0 (2026-11-24) — aperçu PDF au survol de la colonne « Nom du fichier » ; factures cochées = seules traitées ;
//                      proposition de créer le mode TELECHARGE (Paramètres > Listes par défaut) s'il manque.
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
//   POST /portail/rest/parametres/listes/reglement/update  body = { ordre, finMois, code, libelle, delai, compteComptable,
//        type, jourPrecis, parDefaut, idEntrepriseEncrypted }  → création d'un mode de règlement (portail, sans X-IdEntreprise)
//   GET  /portail/rest/parametres/listes/reglement/liste     → { personnalisee: [...] }
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
  // Dernière liste d'achats chargée par l'appli (ordre = ordre des lignes du tableau).
  let lastList = [];
  const LIST_RE = /^https:\/\/rest\.mon-expert-en-gestion\.fr\/ac\/rest\/achats-simplifies(\?|$)/;
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(method).toUpperCase() === 'GET' && LIST_RE.test(String(url))) {
      this.addEventListener('load', () => {
        if (this.__atm || this.status !== 200) return;
        try {
          const j = typeof this.response === 'string' ? JSON.parse(this.response) : this.response;
          if (j && Array.isArray(j.data)) lastList = j.data;
        } catch (e) {}
      });
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    const key = String(k).toLowerCase();
    if (key === 'authorization' && /^Bearer /.test(v)) auth.token = v;
    else if (key === 'x-identreprise' && v) auth.ent = v;
    return origSetHeader.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Appels API
  // ---------------------------------------------------------------------------
  function api(method, path, { body, binary, noEnt } = {}) {
    return new Promise((resolve, reject) => {
      if (!auth.token || !auth.ent) {
        return reject(new Error('Session MEG pas encore détectée : rechargez la page (F5) puis réessayez.'));
      }
      const x = new XMLHttpRequest();
      x.__atm = true;
      x.open(method, /^https:/.test(path) ? path : API + path);
      x.withCredentials = true;
      if (binary) x.responseType = 'arraybuffer';
      origSetHeader.call(x, 'Authorization', auth.token);
      if (!noEnt) origSetHeader.call(x, 'X-IdEntreprise', auth.ent);
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

  const findMode = (modes) => (modes || []).find((m) => String(m.code).toUpperCase() === MODE_CODE && m.isActive !== false);

  // Création du mode « Téléchargé » dans Paramètres > Listes par défaut > Modes de règlement
  // (même appel que l'écran de MEG). Rien n'est créé s'il existe déjà côté paramétrage.
  async function creerModeTelecharge() {
    const liste = await api('GET', '/portail/rest/parametres/listes/reglement/liste', { noEnt: true });
    const perso = (liste && liste.personnalisee) || [];
    if (!perso.some((m) => String(m.code).toUpperCase() === MODE_CODE)) {
      await api('POST', '/portail/rest/parametres/listes/reglement/update', {
        noEnt: true,
        body: {
          ordre: perso.length,
          finMois: false,
          code: MODE_CODE,
          libelle: 'Téléchargé',
          delai: '0',
          compteComptable: '99999999',
          type: 'TYPE_VIREMENT',
          jourPrecis: '0',
          parDefaut: false,
          idEntrepriseEncrypted: auth.ent,
        },
      });
    }
    return findMode(await api('GET', '/ac/rest/achats-simplifies/modes-reglement'));
  }

  // Lignes du tableau → achats de la dernière liste chargée par l'appli.
  function rowsOfTable() {
    return [...document.querySelectorAll('achat-liste-achats tbody tr.mat-mdc-row, tbody tr.mat-mdc-row')];
  }
  const cellText = (tr, col) => {
    const td = tr.querySelector('td.cdk-column-' + col);
    return td ? td.textContent.trim() : '';
  };
  function achatOfRow(tr) {
    const rows = rowsOfTable();
    const i = rows.indexOf(tr);
    const nom = cellText(tr, 'nomFichier');
    const num = cellText(tr, 'numeroFacture');
    const same = (a) => a && (!nom || (a.document && a.document.nom) === nom) && (!num || a.numeroFacture === num);
    if (i >= 0 && same(lastList[i])) return lastList[i];
    return lastList.find(same) || null;
  }
  function selectedRows() {
    return rowsOfTable().filter((tr) => {
      const cb = tr.querySelector('td.cdk-column-selection input[type=checkbox]');
      return cb && cb.checked;
    });
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
      ask(question, okLabel) {
        return new Promise((resolve) => {
          const wrap = el('div', 'margin:8px 0;padding:10px 12px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#78350f;white-space:pre-wrap');
          wrap.appendChild(el('div', 'margin-bottom:8px', question));
          const yes = el('button', 'background:#5b45f5;color:#fff;border:0;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer;margin-right:8px', okLabel);
          const no = el('button', 'background:#fff;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer', 'Annuler');
          const done = (v) => {
            yes.disabled = no.disabled = true;
            resolve(v);
          };
          yes.onclick = () => done(true);
          no.onclick = () => done(false);
          wrap.append(yes, no);
          log.appendChild(wrap);
          yes.focus();
        });
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
    // Factures cochées : seules celles-là sont traitées (lues AVANT d'afficher la fenêtre).
    const coches = selectedRows();
    const selection = coches.map(achatOfRow);
    running = true;
    const ui = panel();
    let ok = 0;
    let ko = 0;
    try {
      if (coches.length && selection.some((a) => !a)) {
        throw new Error('Impossible de relier les lignes cochées aux factures : actualisez la page (F5) puis recochez.');
      }
      const [modes, societeBrut, achats] = await Promise.all([
        api('GET', '/ac/rest/achats-simplifies/modes-reglement'),
        nomSociete(),
        coches.length ? Promise.resolve(selection) : listAchatsNonRegles(),
      ]);
      let mode = findMode(modes);
      if (!mode) {
        ui.status('Mode de règlement « Téléchargé » absent de ce dossier');
        const ok = await ui.ask(
          'Ce dossier n\'a pas encore le mode de règlement « Téléchargé ».\n' +
            'Le créer maintenant dans Paramètres > Listes par défaut > Modes de règlement ?\n' +
            '  code TELECHARGE · libellé Téléchargé · délai 0 jour · type Virement · compte comptable 99999999',
          'Créer le mode et continuer'
        );
        if (!ok) {
          ui.line('Annulé : aucun fichier téléchargé.', 'warn');
          return;
        }
        mode = await creerModeTelecharge();
        if (!mode) throw new Error('Le mode TELECHARGE n\'a pas pu être créé (droits insuffisants ?). Créez-le à la main dans Paramètres.');
        ui.line('Mode de règlement « Téléchargé » créé dans ce dossier.', 'ok');
      }
      const societe = cleanName(societeBrut) || 'Dossier MEG';
      const date = today();
      if (!achats.length) {
        ui.status('Aucune facture non réglée : rien à télécharger.');
        return;
      }
      ui.status(
        `${achats.length} facture(s) ${coches.length ? 'cochée(s)' : 'non réglée(s)'} — dossier Téléchargements\\${societe}`
      );

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
          if (!(detail.echeances || []).length) throw new Error('aucune échéance à régler');
          const dejaReglee = detail.echeances.every((e) => e.statutPaiement === 'REGLE');
          const lienRegl = links['modifier-achat-echeances'];
          if (!dejaReglee && !linkOk(lienRegl)) {
            throw new Error('MEG ne permet pas de modifier le règlement' + (lienRegl && lienRegl.title ? ' (' + lienRegl.title + ')' : ''));
          }

          // 1. Télécharger le PDF et l'enregistrer.
          const { buf, type } = await api('GET', links['url-document'].href, { binary: true });
          if (!isPdf(buf)) throw new Error('le document reçu n\'est pas un PDF (' + (type || 'type inconnu') + ')');
          const saved = await ATM.download(toDataUrl(buf, 'application/pdf'), `${societe}/${nom}`, 'uniquify');

          // 2. Seulement une fois le fichier écrit : passer la facture en Réglé / Téléchargé.
          const fichier = String((saved && saved.filename) || nom).split(/[\\/]/).pop();
          if (dejaReglee) {
            ok++;
            ui.line(`${fichier} — téléchargée (déjà réglée : règlement inchangé)`, 'ok');
            continue;
          }
          await api('POST', lienRegl.href, {
            body: echeancesReglees(detail, mode.id, date),
          });
          ok++;
          ui.line(`${fichier} — réglée (Téléchargé, ${frDate(date)})`, 'ok');
        } catch (e) {
          ko++;
          ui.line(`${nom} — ${e.message || e}`, 'err');
        }
      }
      ui.progress(1, 1);
      ui.status(`Terminé : ${ok} facture(s) téléchargée(s)` + (ko ? `, ${ko} en erreur` : '') + '.');
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

  function refreshLabel() {
    const b = document.getElementById(BTN_ID);
    if (!b) return;
    const n = selectedRows().length;
    const label = n ? `⬇ Télécharger la sélection (${n})` : '⬇ Télécharger les factures';
    if (b.textContent !== label) b.textContent = label;
    b.title = n
      ? `Télécharge les ${n} facture(s) cochée(s) dans Téléchargements\\<Société>, puis les passe en Réglé (mode Téléchargé)`
      : 'Aucune case cochée : télécharge toutes les factures non réglées dans Téléchargements\\<Société>, puis les passe en Réglé (mode Téléchargé)';
  }

  function ensureButton() {
    const onPage = PAGE_RE.test(location.pathname);
    const existing = document.getElementById(BTN_ID);
    if (!onPage) {
      if (existing) existing.remove();
      hidePreview(true);
      return;
    }
    if (existing) return refreshLabel();
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
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    importer.parentElement.insertBefore(b, importer);
    refreshLabel();
  }

  // ---------------------------------------------------------------------------
  // Aperçu du PDF au survol de la colonne « Nom du fichier »
  // ---------------------------------------------------------------------------
  const PREVIEW_ID = 'atm-achats-preview';
  const pdfCache = new Map(); // id → URL blob (les 20 derniers)
  let hoverTimer = null;
  let hideTimer = null;
  let currentId = null;

  async function pdfUrl(achat) {
    if (pdfCache.has(achat.id)) return pdfCache.get(achat.id);
    const { buf } = await api('GET', `/ac/rest/achats-simplifies/${achat.id}/telecharger-document`, { binary: true });
    if (!isPdf(buf)) throw new Error('document non PDF');
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    pdfCache.set(achat.id, url);
    if (pdfCache.size > 20) {
      const [k, u] = pdfCache.entries().next().value;
      URL.revokeObjectURL(u);
      pdfCache.delete(k);
    }
    return url;
  }

  function previewBox() {
    let box = document.getElementById(PREVIEW_ID);
    if (box) return box;
    box = el(
      'div',
      'position:fixed;z-index:2147483600;width:max(360px,34vw);height:88vh;background:#fff;border-radius:8px;' +
        'box-shadow:0 14px 40px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;font:12px system-ui,Segoe UI,Arial'
    );
    box.id = PREVIEW_ID;
    const head = el('div', 'padding:6px 10px;background:#5b45f5;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
    const body = el('div', 'flex:1;position:relative;background:#525659');
    box.append(head, body);
    box.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    box.addEventListener('mouseleave', () => hidePreview());
    document.body.appendChild(box);
    return box;
  }

  function placeBox(box, td) {
    const r = td.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    // Colonne « Nom du fichier » à droite du tableau : aperçu à gauche de la cellule si possible.
    let left = r.left - w - 12;
    if (left < 8) left = Math.min(r.right + 12, window.innerWidth - w - 8);
    let top = Math.min(Math.max(8, r.top - h / 3), window.innerHeight - h - 8);
    box.style.left = Math.max(8, left) + 'px';
    box.style.top = Math.max(8, top) + 'px';
  }

  async function showPreview(td) {
    const tr = td.closest('tr');
    const achat = tr && achatOfRow(tr);
    if (!achat || !achat.document) return;
    const box = previewBox();
    const [head, body] = box.children;
    currentId = achat.id;
    head.textContent = `${fileName(achat).replace(/\.pdf$/, '')}`;
    body.replaceChildren(el('div', 'color:#fff;padding:16px', 'Chargement du PDF…'));
    box.style.display = 'flex';
    placeBox(box, td);
    try {
      const url = await pdfUrl(achat);
      if (currentId !== achat.id || box.style.display === 'none') return;
      const f = el('iframe', 'border:0;width:100%;height:100%;position:absolute;inset:0');
      f.src = url + '#toolbar=0&navpanes=0&view=FitH';
      body.replaceChildren(f);
    } catch (e) {
      if (currentId === achat.id) body.replaceChildren(el('div', 'color:#fecaca;padding:16px', 'Aperçu impossible : ' + (e.message || e)));
    }
  }

  function hidePreview(now) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    const go = () => {
      const box = document.getElementById(PREVIEW_ID);
      if (box) {
        box.style.display = 'none';
        box.children[1].replaceChildren();
      }
      currentId = null;
    };
    if (now) go();
    else hideTimer = setTimeout(go, 250);
  }

  function installHover() {
    document.addEventListener('mouseover', (e) => {
      if (!PAGE_RE.test(location.pathname)) return;
      const td = e.target.closest && e.target.closest('td.cdk-column-nomFichier');
      if (!td) return;
      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => showPreview(td), 350);
    });
    document.addEventListener('mouseout', (e) => {
      const td = e.target.closest && e.target.closest('td.cdk-column-nomFichier');
      if (!td || (e.relatedTarget && td.contains(e.relatedTarget))) return;
      clearTimeout(hoverTimer);
      hidePreview();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePreview(true);
    });
    // Cases à cocher : le libellé du bouton suit la sélection.
    document.addEventListener('change', () => setTimeout(refreshLabel, 0), true);
    document.addEventListener('click', () => setTimeout(refreshLabel, 50), true);
  }

  ATM.onReady(() => {
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(ensureButton, 150);
    }).observe(document.body, { childList: true, subtree: true });
    installHover();
    ensureButton();
  });
})();
