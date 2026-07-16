// ============================================================
// MODULE LIVE — scraping d'une fiche Cardmarket via ton PC (IP résidentielle)
// ============================================================
// Rôle :
//   - ouvrir la fiche d'un idProduct
//   - lire le prix (tendance / moyennes), filtré par langue si possible
//   - APPRENDRE le code set (ex: TWM) depuis l'URL d'image de la page
//   - respecter des délais pour éviter le ban Cloudflare (Error 1015)
//
// Ce module est autonome et testable seul (voir le bloc de test en bas).
// Il sera ensuite require() par index.js.
//
// Dépendances : puppeteer (npm install puppeteer)

const puppeteer = require('puppeteer');
const path = require('path');
const { exec } = require('child_process');

// Bip sonore réel. Le caractère BEL (\x07) est ignoré par le terminal VS Code et
// Windows Terminal -> on passe par un appel système.
function bip() {
    process.stdout.write('\x07'); // au cas où le terminal l'accepte
    try {
        if (process.platform === 'win32') {
            exec('powershell -NoProfile -c "[console]::beep(880,400)"', () => {});
        } else if (process.platform === 'darwin') {
            exec('afplay /System/Library/Sounds/Ping.aiff', () => {});
        }
    } catch (e) { /* pas de son, tant pis */ }
}

// ---- Config ----
const CHEMIN_PROFIL = path.join(__dirname, 'chrome-profil'); // profil persistant = cookie Cloudflare gardé
const DELAI_MIN_ENTRE_REQUETES_MS = 8000; // au moins 8s entre deux fiches (anti-ban 1015)
const TIMEOUT_NAVIGATION_MS = 45000;
const TIMEOUT_CLOUDFLARE_MS = 90000;

// Fenêtre hors écran : le navigateur tourne en mode "normal" (donc Cloudflare voit
// la même empreinte qu'un vrai Chrome, contrairement au mode headless qui ferait
// rejeter le cookie cf_clearance), mais la fenêtre est placée en dehors de l'écran.
// Modifiable à la volée via setCacherFenetre() : les scripts d'apprentissage la
// laissent visible (les défis y sont fréquents), le serveur la cache.
let CACHER_FENETRE = true;
function setCacherFenetre(v) { CACHER_FENETRE = Boolean(v); }

// Fermeture automatique du navigateur après X ms sans activité (0 = jamais).
// Évite d'avoir à fermer Chrome à la main, tout en le gardant chaud entre deux
// analyses rapprochées (pas de relancement à chaque carte).
//   30000  = 30 s  -> disparaît vite, mais Chrome se relance (~3 s) si tu enchaînes
//   120000 = 2 min -> reste chaud plus longtemps si tu analyses plusieurs annonces
const FERMETURE_AUTO_MS = 30000; // 30 secondes

const TITRES_CLOUDFLARE = ['just a moment', 'un instant', 'attention required', 'un momento'];
const estPageCloudflare = t => TITRES_CLOUDFLARE.some(x => (t || '').toLowerCase().includes(x));

// Un seul navigateur réutilisé pour toute la session (évite de relancer Chrome à chaque fois)
let _browser = null;
let _dernvereRequete = 0;
let _timerFermeture = null;

// (Re)lance le compte à rebours de fermeture automatique
function programmerFermetureAuto() {
    if (_timerFermeture) clearTimeout(_timerFermeture);
    if (!FERMETURE_AUTO_MS) return;
    _timerFermeture = setTimeout(async () => {
        if (_browser) {
            console.log(`💤 Navigateur inactif depuis ${FERMETURE_AUTO_MS / 1000}s — fermeture automatique.`);
            try { await fermerBrowser(); } catch (e) { /* déjà fermé */ }
        }
    }, FERMETURE_AUTO_MS);
    // Ne pas empêcher Node de s'arrêter à cause de ce timer
    if (_timerFermeture.unref) _timerFermeture.unref();
}

// Annule la fermeture programmée : indispensable au DÉMARRAGE de toute opération,
// sinon le minuteur armé par l'opération précédente ferme le navigateur en plein
// travail (erreur "detached Frame").
function annulerFermetureAuto() {
    if (_timerFermeture) { clearTimeout(_timerFermeture); _timerFermeture = null; }
}

async function getBrowser() {
    annulerFermetureAuto(); // on repart pour un tour : plus de fermeture en attente
    if (_browser && _browser.connected) return _browser;
    _browser = await puppeteer.launch({
        headless: false, // mode "normal" : indispensable pour que Cloudflare accepte le cookie
        userDataDir: CHEMIN_PROFIL,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            // On force TOUJOURS la position : Chrome mémorise la dernière position dans
            // le profil et la restaurerait sinon (d'où une fenêtre coincée au bord de
            // l'écran après un lancement en mode caché).
            CACHER_FENETRE ? '--window-position=-2400,-2400' : '--window-position=80,80',
            '--window-size=1280,900'
        ]
    });
    return _browser;
}

// Déplace la fenêtre Chrome à l'écran ou hors écran (via le protocole CDP).
// Sert à la faire réapparaître UNIQUEMENT quand Cloudflare demande la case.
async function deplacerFenetre(page, visible) {
    let session;
    try {
        session = await page.target().createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        // 1) S'assurer que la fenêtre n'est ni minimisée ni plein écran, sinon le
        //    déplacement est refusé silencieusement par Chrome.
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        // 2) Puis la positionner
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: visible
                ? { left: 80, top: 80, width: 1280, height: 900 }
                : { left: -2400, top: -2400 }
        });

        // Sécurité : Windows refuse parfois de sortir une fenêtre de l'écran et la
        // "colle" au bord, où elle devient inutilisable. Si c'est le cas, on la
        // remet proprement à l'écran plutôt que de la laisser coincée.
        if (!visible) {
            const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
            if (bounds && bounds.left > -1000) {
                console.log(`   ℹ️ Windows a refusé de cacher la fenêtre (elle serait restée coincée au bord) — on la laisse visible.`);
                await session.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 80, width: 1280, height: 900 } });
            }
        }

        if (visible) await page.bringToFront();
        return true;
    } catch (e) {
        // On NE tait PAS l'erreur : sans ça, on affiche "la fenêtre revient" alors
        // qu'elle ne bouge pas, et on ne comprend pas pourquoi.
        console.log(`   ⚠️ Impossible de déplacer la fenêtre Chrome : ${e.message}`);
        if (visible) console.log(`      La fenêtre est peut-être hors écran. Mets CACHER_FENETRE = false en haut de live-cardmarket.js.`);
        return false;
    } finally {
        try { if (session) await session.detach(); } catch (_) {}
    }
}

// Délai avant de faire réapparaître la fenêtre lors d'un défi Cloudflare.
// Court : les défis de Cardmarket sont interactifs (case à cocher), inutile de
// te faire attendre. Un bip sonore te prévient pour que tu puisses vaquer
// à autre chose entre deux défis.
const DELAI_AVANT_AFFICHAGE_MS = 2500;

/**
 * Attend que Cloudflare laisse passer. Si un défi apparaît et que la fenêtre est
 * cachée, on la ramène à l'écran (+ bip) pour que tu puisses cocher, puis on la recache.
 * @returns {Promise<boolean>} true si on est passé, false si toujours bloqué
 */
async function attendrePassageCloudflare(page) {
    let titre = await page.title();
    if (!estPageCloudflare(titre)) return true;

    let fenetreMontree = false;
    let dernierBip = 0;
    let annonce = false;
    const debut = Date.now();

    while (estPageCloudflare(titre) && (Date.now() - debut) < TIMEOUT_CLOUDFLARE_MS) {
        const ecoule = Date.now() - debut;
        if (ecoule > DELAI_AVANT_AFFICHAGE_MS) {
            if (!annonce) {
                console.log("🔔 Défi Cloudflare — coche la case dans la fenêtre Chrome.");
                annonce = true;
            }
            // Ramener la fenêtre seulement si elle est cachée
            if (CACHER_FENETRE && !fenetreMontree) {
                await deplacerFenetre(page, true);
                fenetreMontree = true;
            }
            // Bip régulier tant que le défi attend (que la fenêtre soit visible ou non)
            if (Date.now() - dernierBip > 8000) {
                bip();
                dernierBip = Date.now();
            }
        }
        await new Promise(r => setTimeout(r, 1500));
        titre = await page.title();
    }

    const passe = !estPageCloudflare(titre);
    if (fenetreMontree) {
        if (passe) console.log("✅ Défi passé — la fenêtre repart en arrière-plan.");
        await deplacerFenetre(page, false);
    }
    return passe;
}

/**
 * Renvoie l'onglet de travail, en RÉUTILISANT celui qui existe déjà.
 * Chrome ouvre toujours un onglet "about:blank" au lancement : si on faisait
 * browser.newPage() à chaque fois, on accumulerait des onglets vides.
 */
async function getPage() {
    const browser = await getBrowser();
    const pages = await browser.pages();
    let page = pages.find(p => !p.isClosed());
    if (!page) page = await browser.newPage();

    // Fermer d'éventuels onglets en trop (sécurité si un ancien lancement en a laissé)
    for (const p of pages) {
        if (p !== page && !p.isClosed()) {
            try { await p.close(); } catch (_) {}
        }
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    return page;
}

async function fermerBrowser() {
    if (_timerFermeture) { clearTimeout(_timerFermeture); _timerFermeture = null; }
    if (_browser) { await _browser.close(); _browser = null; }
}

// Respecte le délai minimum entre deux requêtes (anti-ban)
async function respecterDelai() {
    const ecoule = Date.now() - _dernvereRequete;
    if (ecoule < DELAI_MIN_ENTRE_REQUETES_MS) {
        const attente = DELAI_MIN_ENTRE_REQUETES_MS - ecoule;
        console.log(`⏱️ Attente anti-ban : ${(attente / 1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, attente));
    }
    _dernvereRequete = Date.now();
}

const NOMS_LANGUES = {
    EN: ['english', 'anglais'], FR: ['french', 'français', 'francais'],
    DE: ['german', 'allemand'], IT: ['italian', 'italien'], ES: ['spanish', 'espagnol'],
    JP: ['japanese', 'japonais'], PT: ['portuguese', 'portugais'],
    KR: ['korean', 'coréen'], ZH: ['chinese', 'chinois']
};

// Codes langue Cardmarket (paramètre ?language=X) — confirmés par la doc officielle.
const CODE_LANGUE_CM = {
    EN: 1, FR: 2, DE: 3, ES: 4, IT: 5, ZH: 6, JP: 7, PT: 8, RU: 9, KR: 10
};

// Codes d'état Cardmarket (paramètre ?minCondition=X) — vérifiés sur le site.
// C'est un MINIMUM : demander 4 (GD) renvoie GD, EX, NM, MT triés par prix.
// Donc le repli "si pas de GD, prends le grade au-dessus" est natif.
const CODE_ETAT_CM = { MT: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };

/**
 * Ouvre la fiche d'un idProduct et en extrait prix + code set + infos.
 * @param {number} idProduct
 * @param {string} langue      ex: 'FR'
 * @param {string|null} etatMin  ex: 'NM', 'EX', 'GD'... (null = pas de filtre d'état)
 * @returns {Promise<null|object>}
 */
async function scraperFiche(idProduct, langue = 'EN', etatMin = null) {
    await respecterDelai();
    // On filtre directement la fiche par langue via ?language=X : Cardmarket ne montre
    // alors que les offres de cette langue -> le prix "De" / le plus bas est le vrai
    // prix dans la langue voulue, sans avoir à deviner les drapeaux des vendeurs.
    const codeLangueCM = CODE_LANGUE_CM[langue] || 1;
    let url = `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${idProduct}&language=${codeLangueCM}`;

    // Filtre d'état : le "De" devient alors le moins cher DANS CET ÉTAT OU MIEUX
    const codeEtat = etatMin ? CODE_ETAT_CM[String(etatMin).toUpperCase()] : null;
    if (codeEtat) url += `&minCondition=${codeEtat}`;

    const page = await getPage();

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVIGATION_MS });

        // Attendre le passage de Cloudflare (la fenêtre réapparaît si un défi surgit)
        if (!(await attendrePassageCloudflare(page))) {
            console.log(`🚫 [Live] Cloudflare non franchi pour idProduct ${idProduct}.`);
            return null;
        }

        await new Promise(r => setTimeout(r, 2000)); // laisser le contenu se stabiliser

        // Détecter un éventuel rate-limit
        const contenu = await page.content();
        if (/error 1015|rate limited|you are being rate limited/i.test(contenu)) {
            console.log(`🚫 [Live] Rate-limité (1015) sur idProduct ${idProduct}. Il faut ralentir / attendre.`);
            return null;
        }

        // Extraction dans le contexte de la page (fiche DÉJÀ filtrée par langue via l'URL)
        const infos = await page.evaluate(() => {
            const res = { prixTendance: null, prixParLangue: null, prixDe: null, moyenne30j: null, moyenne7j: null, moyenne1j: null, codeSet: null, numero: null, nomSet: null, urlImage: null, prixParEtat: {} };

            // Prix via les paires dt/dd
            const dts = Array.from(document.querySelectorAll('dt'));
            for (const dt of dts) {
                const label = dt.textContent.toLowerCase();
                const dd = dt.nextElementSibling;
                if (!dd) continue;
                const val = dd.textContent.trim();
                const prix = () => { const m = val.match(/(\d+[.,]\d{2})/); return m ? parseFloat(m[1].replace(',', '.')) : null; };
                if (label.includes('trend') || label.includes('tendance')) res.prixTendance = prix();
                // "De" (FR) / "From" (EN) = prix le plus bas des offres AFFICHÉES (donc de la langue filtrée)
                if (label === 'de' || label.includes('from') || label.startsWith('de ')) res.prixDe = prix();
                if (label.includes('30') && (label.includes('jour') || label.includes('day'))) res.moyenne30j = prix();
                if (label.includes('7') && (label.includes('jour') || label.includes('day'))) res.moyenne7j = prix();
                if (label.includes('1') && (label.includes('jour') || label.includes('day'))) res.moyenne1j = prix();
                if (label.includes('number') || label.includes('nombre')) res.numero = val;
                if (label.includes('printed') || label.includes('édité')) res.nomSet = val;
            }

            // URL de l'image -> code set : /{cat}/{CODE}/{id}/{id}.jpg
            const img = document.querySelector('img[src*="product-images.s3.cardmarket.com"]');
            if (img) {
                res.urlImage = img.src;
                const parts = img.src.split('/');
                const idx = parts.findIndex(p => p.includes('cardmarket.com'));
                if (idx !== -1 && parts[idx + 2]) res.codeSet = parts[idx + 2];
            }

            // Prix par langue = le "De" (prix le plus bas des offres affichées, donc de
            // la langue filtrée via ?language=X). C'est LE prix fiable fourni par
            // Cardmarket, contrairement à un scan du tableau qui attrape des valeurs
            // parasites (graphiques, pubs...). On garde la tendance en complément.
            res.prixParLangue = res.prixDe;

            // Prix le moins cher PAR ÉTAT, depuis le tableau des vendeurs.
            // Structure Cardmarket réelle :
            //   <a class="article-condition condition-ex" title="Excellent"><span class="badge">EX</span></a>
            // et le prix dans un conteneur dédié. On évite de lire le texte de la ligne
            // entière : la quantité y est collée au prix ("1" + "3,00 €" -> "13,00 €").
            const ETATS_VALIDES = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
            const REGEX_PRIX_SEUL = /^\s*\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?\s*€\s*$|^\s*\d+[.,]\d{2}\s*€\s*$/;

            const enNombre = (t) => {
                const nettoye = t.replace(/€/g, '').replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
                const v = parseFloat(nettoye);
                return isNaN(v) ? null : v;
            };

            const lirePrixDeLaLigne = (ligne) => {
                // 1) Conteneur de prix dédié (le plus fiable)
                for (const sel of ['.price-container', '.col-offer', '[class*="price"]']) {
                    for (const c of ligne.querySelectorAll(sel)) {
                        // On ignore la version mobile, dupliquée dans le DOM
                        if (c.closest('.mobile-offer-container')) continue;
                        for (const el of [c, ...c.querySelectorAll('*')]) {
                            const t = (el.textContent || '').trim();
                            if (REGEX_PRIX_SEUL.test(t)) {
                                const v = enNombre(t);
                                if (v && v > 0) return v;
                            }
                        }
                    }
                }
                // 2) Repli : n'importe quel élément dont le texte est EXACTEMENT un prix
                for (const el of ligne.querySelectorAll('*')) {
                    if (el.closest('.mobile-offer-container')) continue;
                    const t = (el.textContent || '').trim();
                    if (!REGEX_PRIX_SEUL.test(t)) continue;
                    const v = enNombre(t);
                    if (v && v > 0) return v;
                }
                return null;
            };

            res.prixParEtat = {};
            res.debugLignes = [];
            document.querySelectorAll('.article-condition, .badge').forEach(el => {
                // L'état : depuis la classe "condition-xx" si dispo, sinon le texte du badge
                let etat = null;
                const cls = [...el.classList].find(c => c.startsWith('condition-'));
                if (cls) etat = cls.replace('condition-', '').toUpperCase();
                else etat = (el.textContent || '').trim().toUpperCase();
                if (!ETATS_VALIDES.includes(etat)) return;

                // Remonter jusqu'à l'ancêtre qui contient le conteneur de prix de CETTE
                // offre (plus fiable que deviner le nom de classe de la ligne).
                let ligne = el.parentElement;
                let niveaux = 0;
                while (ligne && niveaux < 8 && !ligne.querySelector('.price-container, .col-offer')) {
                    ligne = ligne.parentElement;
                    niveaux++;
                }
                if (!ligne) return;

                const prix = lirePrixDeLaLigne(ligne);
                if (prix == null) return;
                if (res.debugLignes.length < 3) res.debugLignes.push(`${etat}=${prix}€`);
                if (res.prixParEtat[etat] == null || prix < res.prixParEtat[etat]) res.prixParEtat[etat] = prix;
            });

            return res;
        });

        // Garde-fou : le moins cher de la grille doit correspondre au "De" (le prix
        // plancher affiché par Cardmarket). Si ça diverge nettement, c'est que
        // l'extraction du tableau a déraillé -> on préfère ne rien afficher que du faux.
        const valeurs = Object.values(infos.prixParEtat || {});
        if (valeurs.length && typeof infos.prixDe === 'number') {
            const minGrille = Math.min(...valeurs);
            const ecart = Math.abs(minGrille - infos.prixDe);
            if (ecart > Math.max(0.5, infos.prixDe * 0.2)) {
                console.log(`   ⚠️ Grille incohérente (min ${minGrille}€ vs De ${infos.prixDe}€) — grille ignorée.`);
                if (infos.debugLignes?.length) console.log(`      (debug 3 premières lignes lues : ${infos.debugLignes.join(', ')})`);
                infos.prixParEtat = {};
            }
        }

        const grille = Object.entries(infos.prixParEtat || {}).map(([e, p]) => `${e} ${p}€`).join(' · ');
        console.log(`✅ [Live] idProduct ${idProduct} : tendance=${infos.prixTendance}€, De(${langue})=${infos.prixParLangue}€, codeSet=${infos.codeSet}, num=${infos.numero}`);
        if (grille) console.log(`   📊 Grille par état : ${grille}`);
        return infos;

    } catch (e) {
        console.log(`ℹ️ [Live] Erreur idProduct ${idProduct} : ${e.message}`);
        return null;
    } finally {
        // On NE ferme PAS l'onglet : il est réutilisé au prochain appel (évite
        // d'accumuler des onglets). On le vide juste pour libérer la mémoire.
        try { await page.goto('about:blank'); } catch (_) {}
        programmerFermetureAuto();
    }
}

/**
 * Scrape la LISTE d'une extension pour apparier idProduct <-> numéro de carte.
 * C'est le "pont" qui manquait : sur la page galerie d'un set, chaque vignette
 * porte à la fois l'URL de l'image (qui contient l'idProduct) et le titre
 * "Nom (CODE 176)" (qui contient le code set et le numéro).
 * Une seule visite par set, ensuite tout est mémorisé en base.
 *
 * @param {number|string} identifiant  idExpansion (ex: 6096) OU slug d'URL (ex: "Lost-Origin")
 * @param {number} maxPages            sécurité
 * @returns {Promise<Array<{idProduct, numero, numeroUrl, codeSet}>>}
 */
async function scraperListeExpansion(identifiant, maxPages = 25) {
    const page = await getPage();
    const toutes = [];

    // perSite : nombre de cartes par page. Plus il est élevé, moins on charge de
    // pages -> plus rapide et moins de risque de ban. 100 semble accepté ; si
    // Cardmarket le plafonne, on récupérera simplement moins par page (sans casse).
    const PAR_PAGE = 100;
    const estSlug = typeof identifiant === 'string' && !/^\d+$/.test(identifiant);

    try {
        for (let site = 1; site <= maxPages; site++) {
            annulerFermetureAuto(); // on est en plein travail : pas de fermeture en douce
            await respecterDelai();
            const url = estSlug
                ? `https://www.cardmarket.com/fr/Pokemon/Products/Singles/${identifiant}?site=${site}&perSite=${PAR_PAGE}`
                : `https://www.cardmarket.com/fr/Pokemon/Products/Singles?idCategory=51&idExpansion=${identifiant}&site=${site}&perSite=${PAR_PAGE}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVIGATION_MS });

            // Attendre le passage de Cloudflare (la fenêtre réapparaît si un défi surgit)
            if (!(await attendrePassageCloudflare(page))) {
                console.log(`🚫 [Liste] Cloudflare non franchi (page ${site}). Arrêt.`);
                break;
            }

            const html = await page.content();
            if (/error 1015|rate limited/i.test(html)) {
                console.log(`🚫 [Liste] Rate-limité (1015) page ${site}. Arrêt — on garde ce qui est déjà récupéré.`);
                break;
            }

            const lot = await page.evaluate(() => {
                const res = [];
                document.querySelectorAll('a.galleryBox').forEach(a => {
                    // --- idProduct + code set, depuis l'URL de l'image ---
                    // .../product-images.s3.cardmarket.com/51/DRI/826050/826050.jpg
                    const img = a.querySelector('img');
                    const src = (img && (img.getAttribute('data-echo') || img.getAttribute('src'))) || '';
                    const mImg = src.match(/\/(\d+)\/(\d+)\.jpg/i);
                    if (!mImg) return;
                    const idProduct = parseInt(mImg[1], 10);
                    const mCode = src.match(/cardmarket\.com\/\d+\/([^/]+)\//i);
                    const codeSet = mCode ? mCode[1] : null;

                    // --- Nom FRANÇAIS, depuis l'attribut alt de l'image ---
                    // Permet de matcher directement ce que l'IA lit sur une carte FR,
                    // sans dépendre de TCGdex ni d'une traduction.
                    const nomFr = (img && img.getAttribute('alt') || '').trim() || null;

                    // --- Numéro + code set, depuis le titre : "Lambda de la Team Rocket (DRI 176)"
                    // C'est la source la plus fiable : elle gère les numéros à lettres (TG06).
                    const h2 = a.querySelector('h2');
                    let numero = null;
                    if (h2) {
                        const mTitre = h2.textContent.trim().match(/\(([^)\s]+)\s+([^)\s]+)\)\s*$/);
                        if (mTitre) numero = mTitre[2];
                    }

                    // --- Slug + variante, depuis le lien ---
                    // href = /fr/Pokemon/Products/Singles/Destined-Rivals/Team-Rockets-Petrel-V1-DRI176
                    const href = a.getAttribute('href') || '';
                    const morceaux = href.split('/').filter(Boolean);
                    const dernierSegment = morceaux[morceaux.length - 1] || '';
                    const slugSet = morceaux[morceaux.length - 2] || null;

                    // Variante V1/V2/V3 : c'est ce qui distingue la version normale de
                    // la reverse ou de l'illustration rare (même nom, même set).
                    const mVar = dernierSegment.match(/-(V\d+)-/i);
                    const variante = mVar ? mVar[1].toUpperCase() : null;

                    // Numéro de secours depuis l'URL (...DRI176 -> 176)
                    const mUrl = dernierSegment.match(/(\d+)$/);
                    const numeroUrl = mUrl ? mUrl[1] : null;

                    res.push({
                        idProduct, numero, numeroUrl, codeSet,
                        nomFr, variante, slugSet,
                        slug: dernierSegment || null
                    });
                });
                return res;
            });

            if (lot.length === 0) break;
            toutes.push(...lot);
            console.log(`   page ${site} : ${lot.length} cartes (total ${toutes.length})`);
            if (lot.length < PAR_PAGE) break; // dernière page atteinte
        }
    } catch (e) {
        console.log(`ℹ️ [Liste] Erreur : ${e.message}`);
    } finally {
        // On NE ferme PAS l'onglet : il est réutilisé au prochain appel (évite
        // d'accumuler des onglets). On le vide juste pour libérer la mémoire.
        try { await page.goto('about:blank'); } catch (_) {}
        programmerFermetureAuto();
    }

    return toutes;
}

module.exports = { scraperFiche, scraperListeExpansion, fermerBrowser, setCacherFenetre };

// ---- Bloc de test : lancé seulement si on exécute ce fichier directement ----
if (require.main === module) {
    (async () => {
        console.log("=== TEST du module live ===");
        console.log("Coche Cloudflare dans la fenêtre si demandé (1re fois).\n");
        // Évoli Crimson Haze (sv5a 050) qu'on connaît
        const r = await scraperFiche(769362, 'FR');
        console.log("\nRésultat brut :", r);
        await fermerBrowser();
    })();
}