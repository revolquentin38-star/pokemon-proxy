require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ============================================================
// CONFIG — à ajuster facilement
// ============================================================

// Durée pendant laquelle on fait confiance à un prix en cache avant de re-scraper
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

// Seuils pour le verdict "bonne affaire" (ratio prixVinted / prixCardmarket)
const SEUIL_BONNE_AFFAIRE = 0.80; // 20% moins cher ou plus -> bonne affaire
const SEUIL_PRIX_CORRECT  = 1.10; // jusqu'à 10% plus cher -> prix correct
// au-dessus de SEUIL_PRIX_CORRECT -> trop cher

// Modèle IA. google/gemini-2.5-flash = rapide et ~6x moins cher que
// ~google/gemini-pro-latest pour cette tâche simple (lire une image + extraire du texte).
// Si l'extraction se trompe souvent sur des cartes difficiles, remets
// "~google/gemini-pro-latest" ici (plus précis, plus cher).
const MODELE_IA = "google/gemini-2.5-flash";

// ============================================================
// MONGODB — connexion + schéma de cache
// ============================================================

if (!process.env.MONGODB_URI) {
    console.error("⚠️  MONGODB_URI n'est pas défini dans les variables d'environnement Render. Le cache sera désactivé.");
} else {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log("✅ MongoDB connecté"))
        .catch(err => console.error("❌ Erreur connexion MongoDB:", err.message));
}

const cardPriceSchema = new mongoose.Schema({
    name: { type: String, required: true },       // nom EN de la carte, normalisé en minuscule
    number: { type: String, required: true },      // numéro de collection
    language: { type: String, required: true },    // EN, FR, JP, ...
    price: { type: Number, required: true },       // prix Cardmarket en EUR
    url: { type: String, required: true },          // lien vers la fiche Cardmarket
    updatedAt: { type: Date, default: Date.now }
});
cardPriceSchema.index({ name: 1, number: 1, language: 1 }, { unique: true });

const CardPrice = mongoose.model('CardPrice', cardPriceSchema);

// Catalogue produits Cardmarket (importé via import-catalogue.js)
const catalogueProduitSchema = new mongoose.Schema({
    idProduct: Number, name: String, idExpansion: Number, idMetacard: Number
});
const CatalogueProduit = mongoose.model('CatalogueProduit', catalogueProduitSchema, 'catalogue_produits');

// Guide des prix Cardmarket (importé via import-price-guide.js)
const guidePrixSchema = new mongoose.Schema({
    idProduct: Number, avg: Number, low: Number, trend: Number,
    avg1: Number, avg7: Number, avg30: Number,
    avgHolo: Number, lowHolo: Number, trendHolo: Number
});
const GuidePrix = mongoose.model('GuidePrix', guidePrixSchema, 'guide_prix');

function cleKey(name, number, language) {
    return {
        name: String(name).trim().toLowerCase(),
        number: String(number).trim(),
        language: String(language || "EN").trim().toUpperCase()
    };
}

async function lireCache(name, number, language) {
    try {
        if (mongoose.connection.readyState !== 1) return null; // pas connecté
        const key = cleKey(name, number, language);
        const doc = await CardPrice.findOne(key);
        if (!doc) return null;
        const age = Date.now() - doc.updatedAt.getTime();
        if (age > CACHE_DURATION_MS) return null; // trop vieux, on re-scrape
        console.log(`💾 Cache HIT pour ${key.name} #${key.number} (${key.language})`);
        return { price: doc.price, url: doc.url };
    } catch (e) {
        console.error("Erreur lecture cache:", e.message);
        return null;
    }
}

async function ecrireCache(name, number, language, price, url) {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const key = cleKey(name, number, language);
        await CardPrice.findOneAndUpdate(
            key,
            { ...key, price, url, updatedAt: new Date() },
            { upsert: true }
        );
    } catch (e) {
        console.error("Erreur écriture cache:", e.message);
    }
}

// ============================================================
// ÉTAPE 1 — Identification de la carte par l'IA (vision)
// ============================================================

async function getCardIdFromAI(imageUrl, title) {
    const prompt = `Identifie cette carte Pokémon à partir de l'image (le titre de l'annonce est un complément d'info, en français). Réponds UNIQUEMENT en JSON strict, sans texte ni markdown autour, format exact :
{"name": "Nom anglais de la carte", "number": "numéro de collection sans le total (ex: 25 et pas 25/102)", "setCode": "code du set (ex: BLK, PAL, OBF) si visible sur la carte ou dans le titre, sinon null", "language": "EN"}

Le "setCode" est le petit code alphabétique (2 à 4 lettres) imprimé en bas de la carte à côté du numéro de collection, ou parfois présent dans le titre de l'annonce juste avant le numéro (ex: "BLK 129"). Si tu ne le vois pas clairement, réponds null pour ce champ, n'invente rien.

Pour "language", déduis-la du TEXTE VISIBLE SUR LA CARTE elle-même (pas du titre) : JP si texte japonais, FR si texte français, DE si allemand, IT si italien, ES si espagnol, PT si portugais, KR si coréen, ZH si chinois. Si tu n'es pas sûr, réponds "EN" par défaut.

Titre de l'annonce (contexte) : ${title || "(non fourni)"}`;

    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: MODELE_IA,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: imageUrl } }
                ]
            }]
        }, {
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://render.com",
                "Content-Type": "application/json"
            },
            timeout: 30000
        });

        const content = response.data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
            console.error("Réponse IA inattendue (pas de string content):", JSON.stringify(response.data));
            return null;
        }

        console.log("🤖 Réponse brute IA:", content);

        const clean = content.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);

        if (!parsed.name || !parsed.number) {
            console.error("JSON IA incomplet:", parsed);
            return null;
        }
        parsed.language = (parsed.language || "EN").toUpperCase();
        return parsed;

    } catch (e) {
        // Log complet : c'est ici que tu verras la vraie cause (clé invalide, quota, timeout...)
        console.error("❌ Erreur getCardIdFromAI:", e.response?.data || e.message);
        return null;
    }
}

// ============================================================
// ÉTAPE 1bis — Catalogue LOCAL (importé depuis les exports officiels Cardmarket)
// Gratuit, instantané, aucun appel réseau. On regroupe par idMetacard : si un
// seul "idMetacard" correspond au nom, toutes les entrées sont la même carte
// (juste des réimpressions) -> pas d'ambiguïté, prix directement fiable.
// Si plusieurs idMetacard correspondent, c'est une vraie ambiguïté qu'on ne
// peut pas trancher sans image -> on laisse la main à TCGdex+comparaison photo.
// ============================================================

function echapperRegex(texte) {
    return texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function chercherPrixCatalogueLocal(name) {
    try {
        if (mongoose.connection.readyState !== 1) return { trouvaille: null, ambigu: false };

        // Nom exact, éventuellement suivi de " [Attaque1 | Attaque2]"
        const regex = new RegExp(`^${echapperRegex(name)}(\\s*\\[|$)`, 'i');
        const candidats = await CatalogueProduit.find({ name: regex }).lean();

        if (candidats.length === 0) {
            console.log(`ℹ️ Catalogue local : aucune correspondance pour "${name}".`);
            return { trouvaille: null, ambigu: false };
        }

        const groupes = {};
        for (const c of candidats) (groupes[c.idMetacard] ||= []).push(c);
        const nombreDeGroupes = Object.keys(groupes).length;

        if (nombreDeGroupes > 1) {
            // Le catalogue local n'a pas le numéro de collection par carte, donc un nom
            // très réimprimé (ex: "Mewtwo ex") remonte toutes ses éditions -> ambiguïté
            // qu'une recherche directe (même numéro) ne résoudra pas différemment.
            console.log(`ℹ️ Catalogue local : ${nombreDeGroupes} cartes distinctes possibles pour "${name}" — ambigu, inutile d'essayer la recherche directe, repli direct sur TCGdex+image.`);
            return { trouvaille: null, ambigu: true };
        }

        const idsProducts = candidats.map(c => c.idProduct);
        const guides = await GuidePrix.find({ idProduct: { $in: idsProducts }, trend: { $ne: null } }).lean();

        if (guides.length === 0) {
            console.log(`ℹ️ Catalogue local : "${name}" trouvé (idMetacard unique) mais aucun prix dans le guide local.`);
            return { trouvaille: null, ambigu: false };
        }

        const prixMoyen = guides.reduce((s, g) => s + g.trend, 0) / guides.length;
        const idProductRetenu = guides[0].idProduct;

        console.log(`✅ Catalogue local : "${name}" -> idProduct ${idProductRetenu}, prix ${prixMoyen.toFixed(2)} € (moyenne sur ${guides.length} réimpression(s))`);

        return {
            trouvaille: {
                price: parseFloat(prixMoyen.toFixed(2)),
                idProduct: idProductRetenu,
                url: `https://www.cardmarket.com/en/Pokemon/Products/Singles?idProduct=${idProductRetenu}`
            },
            ambigu: false
        };

    } catch (e) {
        console.error(`❌ Erreur catalogue local pour "${name}" :`, e.message);
        return { trouvaille: null, ambigu: false };
    }
}



// ============================================================
// ÉTAPE 2 — Si ambigu localement : TCGdex (gratuit, sans clé) + comparaison
// d'image. Docs : https://tcgdex.dev/markets-prices
// ============================================================

const Jimp = require('jimp');

// Hash perceptif simple (difference hash 8x8 = 64 bits) — permet de comparer
// deux images visuellement sans dépendance native (contrairement à sharp),
// pour ne pas revivre le calvaire d'installation qu'on a eu avec Puppeteer/Chrome.
async function calculerHashImage(urlImage) {
    const image = await Jimp.read(urlImage);
    image.resize(9, 8).greyscale();
    let hash = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const gauche = Jimp.intToRGBA(image.getPixelColor(x, y)).r;
            const droite = Jimp.intToRGBA(image.getPixelColor(x + 1, y)).r;
            hash += gauche > droite ? '1' : '0';
        }
    }
    return hash;
}

function distanceHamming(hashA, hashB) {
    let distance = 0;
    for (let i = 0; i < hashA.length; i++) if (hashA[i] !== hashB[i]) distance++;
    return distance;
}

// Seuil empirique sur 64 bits : en dessous, on considère que c'est vraiment la
// même illustration (malgré les différences éclairage/angle/protège-carte entre
// la photo Vinted et l'image de référence propre). À ajuster selon les retours.
const SEUIL_HASH_CONFIANT = 20;

async function departagerParImage(imageUrlVinted, candidats) {
    if (!imageUrlVinted) return null;
    try {
        const hashVinted = await calculerHashImage(imageUrlVinted);
        let meilleur = null;
        let meilleureDistance = Infinity;

        for (const candidat of candidats) {
            if (!candidat.image) continue;
            try {
                const hashCandidat = await calculerHashImage(`${candidat.image}/low.webp`);
                const distance = distanceHamming(hashVinted, hashCandidat);
                console.log(`🖼️ Distance image "${candidat.id}" : ${distance}/64`);
                if (distance < meilleureDistance) { meilleureDistance = distance; meilleur = candidat; }
            } catch (e) {
                console.log(`⚠️ Comparaison image impossible pour "${candidat.id}" : ${e.message}`);
            }
        }

        if (meilleur) {
            const confiant = meilleureDistance <= SEUIL_HASH_CONFIANT;
            console.log(`🖼️ Meilleure correspondance : "${meilleur.id}" (distance ${meilleureDistance}/64)${confiant ? '' : ' — encore incertain'}`);
            return { candidat: meilleur, confiant };
        }
        return null;
    } catch (e) {
        console.log(`⚠️ Erreur hash de l'image Vinted : ${e.message}`);
        return null;
    }
}

async function chercherCartesTCGdex(name, numberFilter) {
    const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(name)}&localId=${numberFilter}`;
    const response = await axios.get(url, { timeout: 15000 });
    return Array.isArray(response.data) ? response.data : [];
}

async function trouverCarteTCGdex(name, number, setCode, imageUrlVinted) {
    try {
        // Essai 1 : numéro en filtre strict (eq:)
        let resultats = await chercherCartesTCGdex(name, `eq:${encodeURIComponent(number)}`);

        // Essai 2 (repli) : filtre large, au cas où un zéro de tête ou un format différent bloque le match strict
        if (resultats.length === 0) {
            console.log(`ℹ️ TCGdex : 0 résultat en filtre strict pour "${name}" #${number}, nouvel essai en filtre large.`);
            const numeroSansZeros = number.replace(/^0+/, '') || number;
            resultats = await chercherCartesTCGdex(name, encodeURIComponent(numeroSansZeros));
        }

        if (resultats.length === 0) {
            console.error(`⚠️ TCGdex : aucun résultat pour "${name}" #${number}.`);
            return null;
        }

        let choisi = resultats[0];
        let ambigu = false;

        if (resultats.length > 1) {
            console.log(`ℹ️ TCGdex : ${resultats.length} résultats pour "${name}" #${number} :`, resultats.map(r => r.id));

            // 1er départage : comparaison visuelle avec la photo Vinted (comme PokéCardex/
            // les vraies apps de scan) — l'illustration est plus fiable que le texte pour
            // distinguer deux cartes qui partagent le même nom et le même numéro.
            console.log(`ℹ️ Tentative de départage par image...`);
            const resultatImage = await departagerParImage(imageUrlVinted, resultats);

            if (resultatImage?.confiant) {
                choisi = resultatImage.candidat;
            } else {
                // 2e départage (filet de sécurité) : le code du set détecté par l'IA,
                // seulement si l'image n'a pas donné un résultat assez net (photo floue,
                // image de référence introuvable, etc.)
                const correspondance = setCode ? resultats.find(r => r.id.toLowerCase().includes(setCode.toLowerCase())) : null;

                if (correspondance) {
                    choisi = correspondance;
                    console.log(`ℹ️ Image non concluante, départage par set "${setCode}" à la place.`);
                } else {
                    if (resultatImage) choisi = resultatImage.candidat; // meilleur choix informé plutôt qu'au hasard
                    ambigu = true;
                    console.log(`⚠️ ${resultats.length} impressions possibles pour "${name}" #${number}, résultat incertain même après image + set.`);
                }
            }
        }

        console.log(`🔗 Carte TCGdex retenue : ${choisi.id} ("${choisi.name}")${ambigu ? ' [INCERTAIN]' : ''}`);
        return { id: choisi.id, ambigu };

    } catch (e) {
        console.error(`❌ Erreur recherche TCGdex pour "${name}" #${number} :`, e.response?.status, e.message);
        return null;
    }
}

async function getPrixDepuisTCGdex(cardId, name, number) {
    try {
        const url = `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(cardId)}`;
        const response = await axios.get(url, { timeout: 15000 });
        const cardmarket = response.data?.pricing?.cardmarket;

        if (!cardmarket) {
            console.error(`⚠️ TCGdex : pas de données Cardmarket pour "${cardId}" (carte pas encore cotée sur Cardmarket ?).`);
            return null;
        }

        // On privilégie la tendance (reflète le mieux le prix actuel), avec replis successifs
        const prix = cardmarket.trend ?? cardmarket.avg ?? cardmarket['trend-holo'] ?? cardmarket['avg-holo'] ?? cardmarket.avg7 ?? cardmarket.avg30;

        if (typeof prix !== 'number') {
            console.error(`⚠️ TCGdex : objet cardmarket vide/incomplet pour "${cardId}".`, cardmarket);
            return null;
        }

        console.log(`✅ Prix TCGdex/Cardmarket pour "${cardId}" : ${prix} €`);

        // TCGdex ne fournit pas l'URL exacte de la fiche Cardmarket -> on donne un lien de
        // recherche Cardmarket fonctionnel (pas la fiche exacte, mais jamais cassé).
        const urlRecherche = `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(name + ' ' + number)}`;

        return { price: prix, url: urlRecherche };

    } catch (e) {
        console.error(`❌ Erreur récupération prix TCGdex pour "${cardId}" :`, e.response?.status, e.message);
        return null;
    }
}


// ============================================================
// ÉTAPE 2bis — Scraping DIRECT de Cardmarket via un vrai navigateur headless
// (Puppeteer), sans proxy payant. Exécute le vrai JS de la page, ce qui passe
// certaines protections Cloudflare qu'une requête HTTP nue ne passe pas.
// Reste expérimental : la réputation de l'IP de Render peut quand même bloquer.
// Si ça échoue, la route principale se rabat automatiquement sur TCGdex.
// ============================================================

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const USER_AGENT_REALISTE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function pageBloqueeParAntiBot(html) {
    return /attention required|checking your browser|access denied|cf-browser-verification|just a moment/i.test(html);
}

function attendre(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Petite pause aléatoire pour casser le rythme "trop régulier" d'un bot
function pauseAleatoire(minMs, maxMs) {
    return attendre(minMs + Math.random() * (maxMs - minMs));
}

async function ouvrirPage(browser) {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT_REALISTE);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' });
    return page;
}

async function essayerRechercheDirecte(browser, recherche) {
    const urlRecherche = `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(recherche)}`;
    let page;
    try {
        await pauseAleatoire(800, 2200); // pause avant de naviguer, comme un humain qui vient de taper sa recherche
        page = await ouvrirPage(browser);
        await page.goto(urlRecherche, { waitUntil: 'networkidle2', timeout: 30000 });
        const html = await page.content();

        if (pageBloqueeParAntiBot(html)) {
            console.log(`🚫 [Puppeteer] Bloqué (anti-bot) pour "${recherche}".`);
            return null;
        }

        const $ = cheerio.load(html);
        let lien = $('a[href*="/Pokemon/Cards/"]').first().attr('href');
        if (!lien) {
            console.log(`⚠️ [Puppeteer] Page chargée mais aucun lien produit pour "${recherche}".`);
            return null;
        }

        if (lien.startsWith('/')) lien = `https://www.cardmarket.com${lien}`;
        console.log(`🔗 [Puppeteer] Fiche Cardmarket trouvée pour "${recherche}" : ${lien}`);
        return lien;

    } catch (e) {
        console.log(`ℹ️ [Puppeteer] Erreur pour "${recherche}" : ${e.message}`);
        return null;
    } finally {
        if (page) await page.close();
    }
}

async function trouverCarteDirect(name, number, setCode) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled', // masque le signal d'automatisation le plus évident
                '--disable-infobars'
            ]
        });

        if (setCode) {
            const lien = await essayerRechercheDirecte(browser, `${setCode} ${number}`);
            if (lien) return { lien, browser };
            await pauseAleatoire(1000, 2500); // pause entre deux tentatives, pas de rafale
        }
        const lien = await essayerRechercheDirecte(browser, `${name} ${number}`);
        if (lien) return { lien, browser };

        await browser.close();
        return null;
    } catch (e) {
        console.log(`ℹ️ [Puppeteer] Erreur au lancement du navigateur : ${e.message}`);
        if (browser) await browser.close();
        return null;
    }
}

// Noms de langues à repérer dans les attributs title/alt des icônes de langue
// sur les lignes d'annonces. À AJUSTER si ça ne matche pas — envoie-moi le
// Ctrl+U d'une ligne d'annonce et on corrige ensemble, comme pour le prix.
const NOMS_LANGUES = {
    EN: ['english', 'anglais'],
    FR: ['french', 'français', 'francais'],
    DE: ['german', 'allemand'],
    IT: ['italian', 'italien'],
    ES: ['spanish', 'espagnol'],
    JP: ['japanese', 'japonais'],
    PT: ['portuguese', 'portugais'],
    KR: ['korean', 'coréen', 'coreen'],
    ZH: ['chinese', 'chinois']
};

function extrairePrixParLangue($, language) {
    const motsCles = NOMS_LANGUES[language];
    if (!motsCles) return null;

    const prixTrouves = [];
    $('[title], [alt]').each((i, el) => {
        const attr = ($(el).attr('title') || $(el).attr('alt') || '').toLowerCase();
        if (motsCles.some(mot => attr.includes(mot))) {
            const ligne = $(el).closest('tr, .row, li, article');
            const texteLigne = ligne.text();
            const match = texteLigne.match(/(\d+[.,]\d{2})\s*€/);
            if (match) prixTrouves.push(parseFloat(match[1].replace(',', '.')));
        }
    });

    if (prixTrouves.length === 0) return null;
    prixTrouves.sort((a, b) => a - b);
    console.log(`🌐 ${prixTrouves.length} annonce(s) en langue "${language}" trouvée(s), prix min: ${prixTrouves[0]} €`);
    return prixTrouves[0];
}

async function getPrixDirect(browser, url, language) {
    let page;
    try {
        page = await ouvrirPage(browser);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const html = await page.content();

        if (pageBloqueeParAntiBot(html)) {
            console.log(`🚫 [Puppeteer] Bloqué (anti-bot) sur la fiche produit.`);
            return null;
        }

        const $ = cheerio.load(html);

        const prixLangue = language && language !== 'EN' ? extrairePrixParLangue($, language) : null;

        function chercherParLabel(libelles) {
            let resultat = null;
            $('dt').each((i, el) => {
                const texteLabel = $(el).text().trim().toLowerCase();
                if (libelles.some(l => texteLabel.includes(l))) {
                    const valeur = $(el).next('dd').text().trim();
                    if (valeur) { resultat = valeur; return false; }
                }
            });
            return resultat;
        }
        const texteAgregat = chercherParLabel(['tendance des prix', 'price trend'])
            || chercherParLabel(['prix moyen 7 jours', '7-days average']);
        const prixAgregat = texteAgregat ? parseFloat(texteAgregat.replace(/[^\d,.-]/g, '').replace(',', '.')) : null;

        if (prixLangue !== null) {
            return { price: prixLangue, url, filtrePar: 'langue' };
        }
        if (prixAgregat !== null && !isNaN(prixAgregat)) {
            if (language && language !== 'EN') console.log(`⚠️ Prix filtré par langue non trouvé pour "${language}", on utilise la moyenne globale à défaut.`);
            return { price: prixAgregat, url, filtrePar: 'global' };
        }

        console.log(`⚠️ [Puppeteer] Aucun prix exploitable trouvé sur ${url}.`);
        return null;

    } catch (e) {
        console.log(`ℹ️ [Puppeteer] Erreur sur la fiche produit : ${e.message}`);
        return null;
    } finally {
        if (page) await page.close();
    }
}



// Comme getPrixDirect, mais part directement d'un idProduct connu (catalogue
// local) au lieu de chercher — plus rapide, moins de surface d'échec avec Cloudflare.
async function getPrixDirectParId(idProduct, language) {
    const url = `https://www.cardmarket.com/en/Pokemon/Products/Singles?idProduct=${idProduct}`;
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars']
        });
        await pauseAleatoire(500, 1500);
        return await getPrixDirect(browser, url, language);
    } catch (e) {
        console.log(`ℹ️ [Puppeteer/idProduct] Erreur : ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

function calculerVerdict(prixVinted, prixCardmarket, language, carteIncertaine) {
    if (!prixVinted || isNaN(prixVinted)) return null;
    const ratio = prixVinted / prixCardmarket;
    const diffPourcent = Math.round((ratio - 1) * 100);

    // Nos sources gratuites (TCGdex/scraping direct) ne filtrent pas toujours
    // fiablement par langue, et parfois plusieurs impressions sont ambiguës.
    // Dans ces deux cas, on ne peut pas garantir que le prix de référence
    // correspond à la bonne carte/langue -> seuils plus prudents + avertissement
    // explicite plutôt qu'un faux verdict de confiance. L'incertitude sur la
    // carte elle-même (mauvais set possible) est encore plus grave que la langue.
    const langueIncertaine = Boolean(language) && language !== 'EN';
    const incertitude = carteIncertaine || langueIncertaine;
    const seuilBonneAffaire = carteIncertaine ? 0.50 : (langueIncertaine ? 0.60 : SEUIL_BONNE_AFFAIRE);
    const seuilPrixCorrect = carteIncertaine ? 1.50 : (langueIncertaine ? 1.30 : SEUIL_PRIX_CORRECT);

    let label;
    if (ratio <= seuilBonneAffaire) label = "🔥 Bonne affaire";
    else if (ratio <= seuilPrixCorrect) label = "✅ Prix correct";
    else label = "⚠️ Plus cher que le marché";

    return { label, diffPourcent, langueIncertaine: incertitude };
}

// ============================================================
// ROUTE PRINCIPALE
// ============================================================

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title, vintedPrice, debug } = req.body;

        if (!imageUrl) {
            console.error("⚠️ Requête reçue sans imageUrl. Body reçu:", req.body);
            return res.json({ success: false, error: "Aucune image reçue" });
        }

        const cardInfo = await getCardIdFromAI(imageUrl, title);
        if (!cardInfo) {
            return res.json({ success: false, error: "Analyse IA échouée (voir logs Render pour la cause exacte)" });
        }

        // 1. Cache Mongo (sauté si debug=true, pratique pour retester une carte sans attendre 24h)
        let resultat = debug ? null : await lireCache(cardInfo.name, cardInfo.number, cardInfo.language);
        if (debug) console.log("🐛 Mode debug : lecture du cache sautée.");

        // 2. Sinon, dans l'ordre : catalogue local (instantané) -> scraping direct
        // par recherche (sauté si déjà ambigu) -> TCGdex+image (repli garanti)
        if (!resultat) {
            // 2a. Catalogue local importé (gratuit, aucun appel réseau)
            const { trouvaille: trouvailleLocale, ambigu: ambiguLocal } = await chercherPrixCatalogueLocal(cardInfo.name);

            if (trouvailleLocale) {
                resultat = { price: trouvailleLocale.price, url: trouvailleLocale.url };

                // Carte non-EN trouvée localement : on tente un affinage par langue
                // directement sur la fiche connue (idProduct), sans recherche.
                if (cardInfo.language && cardInfo.language !== 'EN') {
                    const affinage = await getPrixDirectParId(trouvailleLocale.idProduct, cardInfo.language);
                    if (affinage?.filtrePar === 'langue') {
                        console.log(`🌐 Affinage par langue réussi sur idProduct ${trouvailleLocale.idProduct}.`);
                        resultat = affinage;
                    }
                }
            }

            // 2b. Scraping direct par recherche — sauté si le catalogue local a déjà
            // détecté une ambiguïté (une recherche par nom+numéro ne la résoudra pas
            // différemment, ça ne ferait que perdre 30-40s pour rien)
            if (!resultat && !ambiguLocal) {
                const trouvaille = await trouverCarteDirect(cardInfo.name, cardInfo.number, cardInfo.setCode);
                if (trouvaille) {
                    try {
                        resultat = await getPrixDirect(trouvaille.browser, trouvaille.lien, cardInfo.language);
                    } finally {
                        await trouvaille.browser.close(); // toujours fermer, même si getPrixDirect échoue
                    }
                }
            } else if (ambiguLocal) {
                console.log("⏭️ Recherche directe sautée (ambiguïté déjà détectée localement).");
            }

            // 2c. TCGdex + comparaison d'image (repli garanti)
            if (!resultat) {
                console.log("↪️ Repli sur TCGdex (catalogue local et scraping direct indisponibles).");
                const trouvailleTCGdex = await trouverCarteTCGdex(cardInfo.name, cardInfo.number, cardInfo.setCode, imageUrl);
                if (!trouvailleTCGdex) {
                    return res.json({ success: false, error: `Carte "${cardInfo.name}${cardInfo.setCode ? ' ' + cardInfo.setCode : ''} #${cardInfo.number}" non trouvée (catalogue local, direct, ni TCGdex)` });
                }
                resultat = await getPrixDepuisTCGdex(trouvailleTCGdex.id, cardInfo.name, cardInfo.number);
                if (resultat && trouvailleTCGdex.ambigu) resultat.carteIncertaine = true;
            }

            if (!resultat) {
                return res.json({ success: false, error: "Carte trouvée mais aucun prix disponible (voir logs Render)" });
            }

            // On ne met pas en cache un résultat incertain (carte potentiellement fausse) —
            // pas question de figer une possible erreur pendant 24h.
            if (!resultat.carteIncertaine) {
                await ecrireCache(cardInfo.name, cardInfo.number, cardInfo.language, resultat.price, resultat.url);
            }
        }

        const prixVintedNombre = vintedPrice ? parseFloat(String(vintedPrice).replace(',', '.')) : null;
        const verdict = calculerVerdict(prixVintedNombre, resultat.price, cardInfo.language, resultat.carteIncertaine);

        res.json({
            success: true,
            cardName: cardInfo.name,
            cardNumber: cardInfo.number,
            language: cardInfo.language,
            cardmarketPrice: resultat.price,
            cardmarketUrl: resultat.url,
            vintedPrice: prixVintedNombre,
            verdict: verdict?.label || null,
            diffPourcent: verdict?.diffPourcent ?? null,
            langueIncertaine: verdict?.langueIncertaine || false,
            carteIncertaine: Boolean(resultat.carteIncertaine)
        });

    } catch (error) {
        console.error("❌ Erreur /api/analyser:", error);
        res.json({ success: false, error: "Erreur serveur interne" });
    }
});

app.get('/', (req, res) => res.send('Serveur Analyseur Pokémon actif'));

app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));