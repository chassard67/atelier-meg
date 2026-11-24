// ==UserScript==
// @name         Socle Atelier (diagnostic + notes de mise à jour)
// @namespace    https://nicolas.chassard/meg
// @version      1.2.0
// @description  v1.2.0 (2026-11-24) : texte du bandeau adapté à la mise à jour automatique de l'extension.
//               v1.1.0 (2026-11-24) : bandeau « nouvelle version de l'extension disponible » si la coquille installée
//               n'est pas la dernière publiée (lien vers le zip + marche à suivre).
//               v1.0.0 (2026-11-24) : versions dans la console + fenêtre « mise à jour activée » (une fois par mise à jour).
// @author       Nicolas
// @match        https://mon-expert-en-gestion.fr/*
// @run-at       document-start
// @connect      chassard67.github.io
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  window.ATM_INFO = { extVersion: ATM.extVersion, build: ATM.build, settings: ATM.settings };
  ATM.log(`extension ${ATM.extVersion} · modules ${ATM.build}`);

  const MODAL_ID = 'atm-update-notice';

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function showNotices(notices) {
    if (!notices.length || document.getElementById(MODAL_ID)) return;
    const overlay = el(
      'div',
      'position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif'
    );
    overlay.id = MODAL_ID;
    const box = el('div', 'background:#fff;border-radius:10px;width:min(560px,92vw);max-height:80vh;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.35)');
    const head = el('div', 'background:#5b45f5;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:600;font-size:15px', 'Atelier MEG — mise à jour activée');
    box.appendChild(head);
    const body = el('div', 'padding:14px 18px;color:#111827');
    for (const n of notices) {
      body.appendChild(el('div', 'font-weight:600;margin:6px 0 4px', n.title + (n.date ? ' — ' + n.date : '')));
      if (n.lines && n.lines.length) {
        const ul = el('ul', 'margin:0 0 8px;padding-left:20px');
        n.lines.forEach((l) => ul.appendChild(el('li', 'margin:3px 0', l)));
        body.appendChild(ul);
      }
    }
    box.appendChild(body);
    const foot = el('div', 'padding:10px 18px 16px;text-align:right');
    const ok = el('button', 'background:#5b45f5;color:#fff;border:0;border-radius:6px;padding:8px 18px;font:inherit;cursor:pointer', 'OK, compris');
    const close = () => {
      overlay.remove();
      ATM.call('notices-ack', { ids: notices.map((n) => n.id) }).catch(() => {});
    };
    ok.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    foot.appendChild(ok);
    box.appendChild(foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    ok.focus();
  }

  // ---------------------------------------------------------------------------
  // L'extension installée est-elle la dernière publiée ?
  // ---------------------------------------------------------------------------
  const PUB = 'https://chassard67.github.io/atelier-meg/';
  const BANNER_ID = 'atm-ext-update';

  function cmpVersions(a, b) {
    const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  function showUpdateBanner(latest, requise) {
    if (document.getElementById(BANNER_ID)) return;
    try {
      if (!requise && sessionStorage.getItem(BANNER_ID) === latest) return; // fermé pour cette session
    } catch (e) {}
    const bar = el(
      'div',
      'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483645;display:flex;align-items:center;gap:12px;' +
        'max-width:min(980px,94vw);padding:10px 14px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);' +
        'font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#fff;background:' + (requise ? '#b91c1c' : '#c2410c')
    );
    bar.id = BANNER_ID;
    const txt = el('div', 'flex:1');
    txt.appendChild(
      el(
        'strong',
        null,
        (requise ? 'Mise à jour obligatoire' : 'Nouvelle version') + ` de l'extension Atelier MEG : ${latest} (installée : ${ATM.extVersion || '?'}). `
      )
    );
    txt.appendChild(
      el('span', null, 'Elle s\'installe seule si la mise à jour automatique est activée (double-clic une fois sur maj\\activer-maj-auto.cmd dans le dossier de l\'extension). Sinon : téléchargez le zip, extrayez-le par-dessus le dossier de l\'extension, puis rechargez MEG.')
    );
    const dl = el('a', 'flex:none;background:#fff;color:#111827;border-radius:6px;padding:6px 12px;font-weight:600;text-decoration:none', 'Télécharger le zip');
    dl.href = PUB + 'atelier-meg-extension.zip';
    dl.target = '_blank';
    dl.rel = 'noopener';
    const close = el('button', 'flex:none;background:none;border:0;color:#fff;font:700 16px system-ui;cursor:pointer', '✕');
    close.title = 'Masquer jusqu\'à la prochaine session';
    close.onclick = () => {
      try {
        sessionStorage.setItem(BANNER_ID, latest);
      } catch (e) {}
      bar.remove();
    };
    bar.append(txt, dl, close);
    document.body.appendChild(bar);
  }

  async function checkExtension() {
    try {
      const r = await ATM.http({ url: PUB + 'manifest.json?t=' + Date.now(), responseType: 'json' });
      const m = r && r.body;
      if (!m || !m.latestExtensionVersion) return;
      if (cmpVersions(m.latestExtensionVersion, ATM.extVersion) > 0) {
        showUpdateBanner(m.latestExtensionVersion, cmpVersions(m.minExtensionVersion, ATM.extVersion) > 0);
      }
    } catch (e) {
      ATM.log('vérification de version impossible :', e.message || e);
    }
  }

  ATM.onReady(() => {
    setTimeout(checkExtension, 2500);
    // Petit délai : laisse l'appli s'afficher avant la fenêtre.
    setTimeout(() => {
      ATM.call('notices-get')
        .then((list) => showNotices(Array.isArray(list) ? list : []))
        .catch(() => {});
    }, 1500);
  });
})();
