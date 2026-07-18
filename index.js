require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');

// Le module live (Puppeteer) n'est utilisé QUE par l'ancienne architecture, où le
// serveur tournait sur ton PC. En déploiement (Render), Puppeteer n'est pas
// installé — et c'est voulu : le prix live est désormais récupéré par l'EXTENSION,
// depuis le navigateur de l'utilisateur. On charge donc ce module sans exiger
// qu'il soit présent.
let scraperFiche = null;
let fermerBrowser = null;
try {
    ({ scraperFiche, fermerBrowser } = require('./live-cardmarket'));
    console.log("🧩 Module live chargé (Puppeteer disponible).");
} catch (e) {
    console.log("ℹ️ Module live non chargé — normal en déploiement : le prix live est fait par l'extension.");
}

const { choisirMeilleur } = require('./scoring');

const app = express();
const PORT = process.env.PORT || 3000;

// SÉCURITÉ : sans restriction, n'importe quel site ouvert dans ton navigateur
// pourrait appeler ce serveur local et brûler tes crédits IA / déclencher du
// scraping en ton nom.
// ⚠️ Un content script s'exécute DANS la page : sa requête porte donc l'origine
//    de la page (https://www.vinted.fr) et NON "chrome-extension://".
const ORIGINES_AUTORISEES = [
    /^chrome-extension:\/\/[a-p]+$/,                       // l'extension elle-même
    /^https:\/\/(www\.)?vinted\.(fr|be|com|de|es|it|nl|lu|at|pl|pt|se|cz|sk|lt|uk)$/ // Vinted, domaines officiels
];
app.use(cors({
    origin: (origin, callback) => {
        // Pas d'origine = appel direct (curl, tests locaux) -> autorisé
        if (!origin) return callback(null, true);
        if (ORIGINES_AUTORISEES.some(re => re.test(origin))) return callback(null, true);
        console.warn(`🚫 Requête refusée depuis une origine non autorisée : ${origin}`);
        return callback(new Error('Origine non autorisée'));
    }
}));
app.use(express.json());

// Jeton partagé entre l'extension et le serveur. Empêche une page web d'utiliser
// ton serveur même si elle contournait le CORS. À définir dans le .env :
//   JETON_API=une_chaine_longue_et_aleatoire
// et à recopier dans content.js. Si absent, la protection est simplement inactive.
const JETON_API = process.env.JETON_API || null;
if (!JETON_API) {
    console.warn("⚠️ Aucun JETON_API défini dans .env — le serveur accepte toute requête locale.");
}
function verifierJeton(req, res, next) {
    if (!JETON_API) return next();
    if (req.headers['x-jeton'] === JETON_API) return next();
    console.warn("🚫 Requête refusée : jeton absent ou invalide.");
    return res.status(401).json({ success: false, error: "Non autorisé" });
}

// ============================================================
// CONFIG — à ajuster facilement
// ============================================================

// Durée pendant laquelle on fait confiance à un prix en cache avant de re-scraper
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

// Seuils pour le verdict "bonne affaire" (ratio prixVinted / prixCardmarket)
const SEUIL_BONNE_AFFAIRE = 0.80; // 20% moins cher ou plus -> bonne affaire
const SEUIL_PRIX_CORRECT  = 1.10; // jusqu'à 10% plus cher -> prix correct
// au-dessus de SEUIL_PRIX_CORRECT -> trop cher

// Modèle IA pour lire la carte (OCR + extraction). google/gemini-3-flash =
// actuellement en tête des classements OCR, pour ~1,5-2x le coût de l'ancien
// 2.5-flash (qui sera arrêté en oct. 2026). Pour un maximum de précision sur
// les cartes difficiles : "google/gemini-3.5-flash" (plus cher, ~4-5x).
// Alternative moins chère à tester : "qwen/qwen3-vl-235b-a22b-instruct".
// ⚠️ Vérifie l'ID exact sur https://openrouter.ai/models : un ID inconnu
// renvoie une erreur "model not found" (sans casse : on ajuste et on relance).
const MODELE_IA = "google/gemini-3-flash-preview";

// Interrupteur du scraping live Cardmarket. Mets à false pour tester sans aucune
// requête vers Cardmarket (utile en cas de ban IP, ou pour un fonctionnement
// 100% guide local). À true, le live tente d'obtenir le prix exact + par langue.
const LIVE_ACTIF = true;

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

// Codes set appris au fil de l'eau (idExpansion Cardmarket -> code court type "TWM").
// Rempli automatiquement quand le module live lit une fiche : on ne redécouvre
// jamais deux fois le code d'un même set.
const codeSetSchema = new mongoose.Schema({
    idExpansion: { type: Number, required: true, unique: true },
    codeSet: { type: String, required: true },
    apprisLe: { type: Date, default: Date.now }
});
const CodeSet = mongoose.model('CodeSet', codeSetSchema, 'codes_set');

// Numéros de collection appris set par set (via apprendre-set.js).
// Le catalogue Cardmarket ne contient PAS les numéros : sans cette table, on ne
// peut pas savoir lequel des 18 "M Kangaskhan EX" est le #79.
const numeroCarteSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    idExpansion: Number,
    numero: String,
    numeroUrl: String,
    codeSet: String,
    nomFr: String,
    variante: String,
    slug: String,
    slugSet: String,
    source: String,      // 'cardmarket' (fait foi) ou 'tcgdex' (pré-rempli)
    certitude: String    // 'exacte' ou 'heuristique'
});
const NumeroCarte = mongoose.model('NumeroCarte', numeroCarteSchema, 'numeros_cartes');

// Récupère les numéros connus pour une liste d'idProduct -> Map(idProduct => {numero, numeroUrl})
async function lireNumeros(idsProducts) {
    try {
        if (mongoose.connection.readyState !== 1 || idsProducts.length === 0) return new Map();
        const docs = await NumeroCarte.find({ idProduct: { $in: idsProducts } }).lean();
        return new Map(docs.map(d => [d.idProduct, d]));
    } catch (e) {
        console.error("Erreur lecture numéros :", e.message);
        return new Map();
    }
}

async function lireCodeSet(idExpansion) {
    try {
        if (mongoose.connection.readyState !== 1) return null;
        const doc = await CodeSet.findOne({ idExpansion });
        return doc ? doc.codeSet : null;
    } catch (e) {
        console.error("Erreur lecture codeSet:", e.message);
        return null;
    }
}

async function memoriserCodeSet(idExpansion, codeSet) {
    try {
        if (mongoose.connection.readyState !== 1 || !idExpansion || !codeSet) return;
        await CodeSet.findOneAndUpdate(
            { idExpansion },
            { idExpansion, codeSet, apprisLe: new Date() },
            { upsert: true }
        );
        console.log(`🧠 Code set appris et mémorisé : idExpansion ${idExpansion} -> ${codeSet}`);
    } catch (e) {
        console.error("Erreur mémorisation codeSet:", e.message);
    }
}

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

async function getCardIdFromAI(imageUrls, title) {
    // Accepte une URL unique ou un tableau d'URLs (recto, verso, gros plans).
    const images = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [imageUrls].filter(Boolean);
    if (images.length === 0) return null;
    const prompt = `Identifie cette carte Pokémon à partir de l'image (le titre de l'annonce est un complément d'info, en français). Réponds UNIQUEMENT en JSON strict, sans texte ni markdown autour, format exact :
{"name": "Nom anglais de la carte", "number": "numéro de collection SEUL sans le total (ex: 184)", "total": "le nombre APRÈS le slash (ex: 182 pour 184/182), ou null si absent", "setCode": "code du set (ex: BLK, PAL, OBF) si visible, sinon null", "rarete": "IR/SR/SIR/UR/AR/promo/normale selon ce que tu vois", "reverse": "true/false/null — true SEULEMENT si c'est une REVERSE HOLO, false si tu es sûr que non, null si tu n'arrives pas à juger", "language": "EN", "etatEstime": "NM/EX/GD/LP/PL/PO", "etatConfiance": "haute/moyenne/basse", "defautsVus": ["liste courte des défauts visibles, [] si aucun"]}

ÉVALUATION DE L'ÉTAT (etatEstime) — barème Cardmarket, du meilleur au pire : MT > NM > EX > GD > LP > PL > PO.
- NM (Near Mint) : aucun défaut visible, bords nets, coins pointus.
- EX (Excellent) : très légères marques d'usure, minuscule blanchiment de bord.
- GD (Good) : blanchiment net des bords/coins, légères rayures visibles.
- LP (Light Played) : usure marquée, rayures, coins émoussés.
- PL / PO : dégâts importants (pli, déchirure, tache).

RÈGLES IMPORTANTES pour etatConfiance — sois HONNÊTE sur ce que tu ne peux pas voir :
- "basse" si : la carte est sous sleeve/toploader/blister (reflets qui masquent les défauts), photo floue, angle en biais, éclairage mauvais, ou verso non visible.
- "moyenne" si : photo correcte de face mais détails des bords/coins pas nets.
- "haute" UNIQUEMENT si : carte nue, photo nette, bords et coins clairement visibles.
Dans le doute, sois PESSIMISTE (préfère GD à EX) : surestimer l'état conduit à surpayer.
Ne devine pas un état "haute confiance" à partir d'une photo qui ne le permet pas.

PLUSIEURS PHOTOS te sont fournies (recto, verso, gros plans). EXAMINE-LES TOUTES.
Le VERSO est déterminant : c'est là que l'usure se voit le mieux (bords blanchis, coins
usés, dos terni/jauni par le temps, rayures). Une carte au recto impeccable mais au dos
usé n'est PAS NM ni EX — un dos visiblement fatigué signifie GD ou moins.
Ton etatEstime doit refléter la PIRE face observée, pas la meilleure.
Si aucune photo du verso n'est fournie, dis-le via etatConfiance "basse".

defautsVus : décris ce que tu OBSERVES réellement (ex: "blanchiment bord gauche", "rayure sur l'illustration", "coin corné"). Tableau vide [] si tu ne vois aucun défaut. N'invente rien.

IMPORTANT pour "number" et "total" : le numéro de collection est imprimé en bas de la carte sous la forme "X/Y" (ex: "184/182", "025/165"). Lis les DEUX nombres avec attention, ils sont petits mais cruciaux. "number" = le X (avant le slash), "total" = le Y (après le slash). Si le X est SUPÉRIEUR au Y (ex: 184/182), c'est une carte secrète/spéciale (souvent une Illustration Rare) — lis bien, ne confonds pas 184 avec 8.

Le "setCode" est le petit code alphabétique (2 à 4 lettres) imprimé en bas de la carte à côté du numéro, ou parfois dans le titre de l'annonce (ex: "BLK 129"). Si tu ne le vois pas clairement, réponds null, n'invente rien.

Pour "rarete" : regarde le symbole de rareté et le style de la carte. "IR" = Illustration Rare (illustration pleine, personnage humain souvent), "SIR"/"SR" = Special/Super Rare, "AR" = Art Rare, "promo" = carte promotionnelle, "normale" = carte de jeu standard. Si tu n'es pas sûr, réponds "normale".
⚠️ NE CONFONDS PAS "rarete" et "etatEstime" : la rareté est une propriété d'IMPRESSION de la carte (IR, SR, promo, normale...), l'état est son USURE physique (NM, EX, GD...). N'écris JAMAIS un code d'état (EX, GD, NM...) dans le champ "rarete".

Pour "reverse" : une REVERSE HOLO est une carte de jeu normale dont le motif holographique/brillant recouvre le FOND et les BORDURES (toute la carte scintille SAUF l'illustration), alors que sur une holo normale c'est l'ILLUSTRATION qui brille. Le numéro d'une reverse est IDENTIQUE à celui de la version normale. Réponds true UNIQUEMENT si tu distingues clairement ce scintillement de fond ; false si la carte est visiblement mate/normale ; null si reflets, sleeve ou photo ne permettent pas d'en être sûr. Ne devine pas.

Pour "language", déduis-la du TEXTE VISIBLE SUR LA CARTE elle-même (pas du titre) : JP si texte japonais, FR si texte français, DE si allemand, IT si italien, ES si espagnol, PT si portugais, KR si coréen, ZH si chinois. Si tu n'es pas sûr, réponds "EN" par défaut.

Titre de l'annonce (contexte) : ${title || "(non fourni)"}`;

    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: MODELE_IA,
            // Température 0 : lire un numéro sur une carte n'est pas une tâche
            // créative. Sans ça, le modèle "improvise" et donne des résultats
            // différents sur la MÊME photo (vu en conditions réelles : rareté AR
            // puis "normale", total TG30 puis absent -> 25 points d'écart au
            // scoring et la confiance qui bascule de HAUTE à BASSE).
            temperature: 0,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    // Toutes les photos de l'annonce : le verso et les gros plans sont
                    // indispensables pour juger l'état (l'usure s'y voit le mieux).
                    ...images.map(url => ({ type: "image_url", image_url: { url } }))
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

        // Normalisation des nouveaux champs pour le scoring
        parsed.total = parsed.total ? String(parsed.total).replace(/\D/g, '') : null;
        parsed.rarete = parsed.rarete || 'normale';
        // reverse : on ne garde QUE true ou false explicites ; tout le reste ("null",
        // absent, chaîne "null") devient null -> le scoring restera neutre dans le doute.
        parsed.reverse = (parsed.reverse === true || parsed.reverse === 'true') ? true
            : (parsed.reverse === false || parsed.reverse === 'false') ? false
            : null;
        // Carte "à valeur" si : numéro > total (secrète), ou rareté spéciale lue par l'IA
        const numN = parseInt(String(parsed.number).replace(/\D/g, ''), 10);
        const totN = parsed.total ? parseInt(parsed.total, 10) : null;
        const raretesElevees = ['IR', 'SR', 'SIR', 'UR', 'AR', 'SAR', 'CHR', 'CSR'];
        parsed.rareteElevee = (totN != null && numN > totN)
            || raretesElevees.includes(String(parsed.rarete).toUpperCase());
        console.log(`🎴 IA : ${parsed.name} #${parsed.number}${parsed.total ? '/' + parsed.total : ''}, rareté=${parsed.rarete}, élevée=${parsed.rareteElevee}, langue=${parsed.language}`);
        if (parsed.etatEstime) {
            const defauts = Array.isArray(parsed.defautsVus) && parsed.defautsVus.length ? parsed.defautsVus.join(', ') : 'aucun défaut vu';
            console.log(`   👁️ État estimé par l'IA : ${parsed.etatEstime} (confiance ${parsed.etatConfiance || '?'}) — ${defauts}`);
        }

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

        // Un seul idMetacard, MAIS avec beaucoup de réimpressions (ex: cartes promo très
        // rééditées comme "Iono") -> des produits différents avec des valeurs très
        // différentes (promo vs ETB vs deck thème). Une moyenne aveugle serait fausse —
        // on préfère laisser TCGdex+comparaison d'image identifier le produit précis.
        const idsProducts = candidats.map(c => c.idProduct);
        const SEUIL_REIMPRESSIONS_FIABLE = 5;
        if (idsProducts.length > SEUIL_REIMPRESSIONS_FIABLE) {
            console.log(`ℹ️ Catalogue local : "${name}" a ${idsProducts.length} réimpressions sous le même idMetacard — trop pour une moyenne fiable, repli sur TCGdex+image.`);
            return { trouvaille: null, ambigu: true };
        }

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
// ÉTAPE 2 — Identification via TCGdex (gratuit, sans clé)
// ============================================================
// NOTE : la comparaison d'images (hash perceptif via sharp) a été RETIRÉE.
// Mesuré en conditions réelles : sur des photos d'annonce (angle, reflets,
// carte sous sleeve), les distances tournaient entre 21 et 41/64 — aucune ne se
// détachait, et le hash désignait parfois la MAUVAISE carte. Il apportait ~15
// points de bruit face au numéro (50), à la région (±45) et au set (40), qui
// décident réellement.
// Le retirer supprime au passage la dépendance à `sharp` (module natif, lourd en
// RAM), ce qui allège le déploiement et rend l'architecture portable en extension.

// Langues supportées par TCGdex pour la recherche (codes ISO)
const LANGUES_TCGDEX = ['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'ko', 'zh-cn', 'zh-tw', 'nl', 'pl', 'ru', 'id', 'th'];

// Convertit notre code langue (EN, FR, JP...) vers le code TCGdex (en, fr, ja...)
function langueVersTCGdex(langue) {
    const map = { EN: 'en', FR: 'fr', DE: 'de', ES: 'es', IT: 'it', PT: 'pt', JP: 'ja', KR: 'ko', ZH: 'zh-cn', RU: 'ru' };
    return map[(langue || 'EN').toUpperCase()] || 'en';
}

async function chercherCartesTCGdex(name, numberFilter, langueApi = 'en') {
    const url = `https://api.tcgdex.net/v2/${langueApi}/cards?name=${encodeURIComponent(name)}&localId=${numberFilter}`;
    const response = await axios.get(url, { timeout: 15000 });
    return Array.isArray(response.data) ? response.data : [];
}

// Recherche TCGdex par nom seul (sans numéro), pour les cas où le numéro bloque le match
async function chercherCartesTCGdexNomSeul(name, langueApi = 'en') {
    const url = `https://api.tcgdex.net/v2/${langueApi}/cards?name=${encodeURIComponent(name)}`;
    const response = await axios.get(url, { timeout: 15000 });
    return Array.isArray(response.data) ? response.data : [];
}

// Génère des variantes d'un nom de carte pour contourner les différences de
// nommage entre l'IA, TCGdex et Cardmarket (Méga, esperluette, tirets, suffixes...).
function genererVariantesNom(name) {
    const variantes = new Set();
    const base = name.trim();
    variantes.add(base);

    // "M Kangaskhan-EX" / "M-Kangaskhan" -> "Mega Kangaskhan..."
    if (/^M[\s-]/i.test(base)) {
        variantes.add(base.replace(/^M[\s-]/i, 'Mega '));
    }
    // "Mega X" -> "M X" (l'inverse, au cas où)
    if (/^Mega\s/i.test(base)) {
        variantes.add(base.replace(/^Mega\s/i, 'M '));
    }
    // Esperluette : "Jesse & James" -> "and", et l'orthographe "Jessie"
    if (base.includes('&')) {
        variantes.add(base.replace(/\s*&\s*/g, ' and '));
    }
    if (/jesse/i.test(base)) variantes.add(base.replace(/jesse/gi, 'Jessie'));

    // Tirets : "Kangaskhan-EX" <-> "Kangaskhan EX" <-> "Kangaskhan"
    if (base.includes('-')) {
        variantes.add(base.replace(/-/g, ' '));
        variantes.add(base.replace(/-/g, ''));
    }
    // Retirer les suffixes de type -EX/-GX/-V/-VMAX pour élargir
    const sansSuffixe = base.replace(/[\s-]*(EX|GX|V|VMAX|VSTAR)\b/gi, '').trim();
    if (sansSuffixe && sansSuffixe !== base) variantes.add(sansSuffixe);

    // Nom principal seul (premier mot significatif) en tout dernier recours
    const premierMot = base.split(/[\s&-]/)[0];
    if (premierMot && premierMot.length > 2) variantes.add(premierMot);

    return [...variantes];
}

async function trouverCarteTCGdex(name, number, setCode, imageUrlVinted, langue = 'EN') {
    try {
        const variantes = genererVariantesNom(name);
        let resultats = [];
        let nomUtilise = name;

        // On cherche d'abord dans la langue de la carte (le nom lu par l'IA correspond
        // mieux au nom TCGdex dans cette langue), puis en anglais en repli.
        const langueCarte = langueVersTCGdex(langue);
        const languesAEssayer = langueCarte === 'en' ? ['en'] : [langueCarte, 'en'];

        // Pour chaque langue, chaque variante de nom, essayer : numéro strict -> numéro large
        for (const langApi of languesAEssayer) {
            for (const variante of variantes) {
                resultats = await chercherCartesTCGdex(variante, `eq:${encodeURIComponent(number)}`, langApi);
                if (resultats.length === 0) {
                    const numeroSansZeros = String(number).replace(/^0+/, '') || number;
                    resultats = await chercherCartesTCGdex(variante, encodeURIComponent(numeroSansZeros), langApi);
                }
                if (resultats.length > 0) {
                    nomUtilise = variante;
                    if (langApi !== 'en' || variante !== name) console.log(`ℹ️ TCGdex : trouvé via "${variante}" en [${langApi}] (recherche initiale "${name}").`);
                    break;
                }
            }
            if (resultats.length > 0) break;
        }

        // Dernier recours : recherche par NOM SEUL (sans numéro) dans les deux langues
        if (resultats.length === 0) {
            for (const langApi of languesAEssayer) {
                for (const variante of variantes) {
                    const parNom = await chercherCartesTCGdexNomSeul(variante, langApi);
                    if (parNom.length > 0) {
                        const numLu = String(number).replace(/^0+/, '');
                        const matchNum = parNom.filter(c => String(c.localId).replace(/^0+/, '') === numLu);
                        resultats = matchNum.length > 0 ? matchNum : parNom;
                        nomUtilise = variante;
                        console.log(`ℹ️ TCGdex : trouvé par nom seul via "${variante}" en [${langApi}] (${resultats.length} résultat(s)).`);
                        break;
                    }
                }
                if (resultats.length > 0) break;
            }
        }

        if (resultats.length === 0) {
            console.error(`⚠️ TCGdex : aucun résultat pour "${name}" #${number} (même avec variantes).`);
            return null;
        }

        let choisi = resultats[0];
        let ambigu = false;

        if (resultats.length > 1) {
            console.log(`ℹ️ TCGdex : ${resultats.length} résultats pour "${nomUtilise}" #${number} :`, resultats.map(r => r.id));

            // Départage par le code du set lu par l'IA. (La comparaison d'images a été
            // retirée : sur des photos d'annonce, elle donnait 35-41/64 même pour la
            // bonne carte — donc aucun signal exploitable.)
            const correspondance = setCode ? resultats.find(r => r.id.toLowerCase().includes(setCode.toLowerCase())) : null;

            if (correspondance) {
                choisi = correspondance;
                console.log(`ℹ️ Départage par le set "${setCode}".`);
            } else {
                // Aucun moyen de trancher ici : on prend le premier mais on signale
                // l'incertitude. Le garde-fou live vérifiera le numéro et rebondira
                // si besoin — c'est lui qui garantit la justesse, pas ce choix.
                ambigu = true;
                console.log(`⚠️ ${resultats.length} impressions possibles pour "${name}" #${number} et pas de set pour trancher — le live vérifiera.`);
            }
        }

        // Le nom du candidat peut être dans la langue de recherche (ex: français).
        // Or le catalogue Cardmarket est en anglais -> on récupère le nom ANGLAIS via
        // l'id (universel) pour que la recherche catalogue fonctionne.
        let nomExact = choisi.name;
        let variants = null;
        try {
            const detailEN = await axios.get(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(choisi.id)}`, { timeout: 15000 });
            if (detailEN.data?.name) {
                if (detailEN.data.name !== choisi.name) console.log(`🔤 Nom anglais récupéré : "${detailEN.data.name}" (trouvé en "${choisi.name}").`);
                nomExact = detailEN.data.name;
            }
            // variants = { normal, reverse, holo, firstEdition, wPromo } : dit quelles
            // impressions EXISTENT. Récupéré gratuitement ici (même réponse que le nom).
            // Sert à valider/infirmer la reverse lue par l'IA, sans scraper Cardmarket.
            if (detailEN.data?.variants) variants = detailEN.data.variants;
        } catch (e) { /* on garde choisi.name si l'appel échoue */ }

        console.log(`🔗 Carte TCGdex retenue : ${choisi.id} ("${nomExact}")${ambigu ? ' [INCERTAIN]' : ''}`);
        return { id: choisi.id, ambigu, nomExact, localId: choisi.localId || number, variants };

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



// Récupère les noms d'attaques + talents d'une carte TCGdex (pour croiser avec
// les noms entre crochets du catalogue Cardmarket).
async function getAttaquesTCGdex(cardId) {
    try {
        const url = `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(cardId)}`;
        const response = await axios.get(url, { timeout: 15000 });
        const data = response.data || {};
        const noms = [];
        if (Array.isArray(data.attacks)) noms.push(...data.attacks.map(a => a.name).filter(Boolean));
        if (Array.isArray(data.abilities)) noms.push(...data.abilities.map(a => a.name).filter(Boolean));
        return noms.map(n => n.toLowerCase().trim());
    } catch (e) {
        console.log(`ℹ️ Impossible de récupérer les attaques TCGdex pour "${cardId}" : ${e.message}`);
        return [];
    }
}

// Parmi plusieurs idProduct candidats du catalogue local, trouve celui dont les
// attaques entre crochets correspondent le mieux aux attaques TCGdex. C'est ce
// qui permet de distinguer LE bon Charizard TG03 parmi les 79 Charizard.
async function trouverIdProductParAttaques(nomExact, attaquesTCGdex) {
    try {
        if (mongoose.connection.readyState !== 1 || attaquesTCGdex.length === 0) return null;

        const regex = new RegExp(`^${echapperRegex(nomExact)}\\s*\\[`, 'i');
        const candidats = await CatalogueProduit.find({ name: regex }).lean();
        if (candidats.length === 0) return null;

        let meilleur = null;
        let meilleurScore = 0;

        for (const c of candidats) {
            // Extraire le contenu entre crochets : "Charizard [Battle Sense | Royal Blaze]"
            const match = c.name.match(/\[([^\]]+)\]/);
            if (!match) continue;
            const attaquesCatalogue = match[1].split('|').map(s => s.toLowerCase().trim());

            // Score = nombre d'attaques TCGdex retrouvées dans le nom catalogue
            const score = attaquesTCGdex.filter(a => attaquesCatalogue.some(ac => ac.includes(a) || a.includes(ac))).length;
            if (score > meilleurScore) { meilleurScore = score; meilleur = c; }
        }

        // On exige qu'au moins une attaque corresponde pour être sûr
        if (meilleur && meilleurScore > 0) {
            console.log(`🎯 idProduct ${meilleur.idProduct} identifié par attaques (${meilleurScore} correspondance(s)) : "${meilleur.name}"`);
            return meilleur; // objet complet { idProduct, idExpansion, name, ... }
        }
        return null;
    } catch (e) {
        console.log(`ℹ️ Erreur croisement par attaques : ${e.message}`);
        return null;
    }
}

// ============================================================
// Détection de région (occidental vs japonais) pour éviter de confondre
// une carte FR/EN (ex: Destined Rivals) avec son édition japonaise (sv9a).
// ============================================================

// Région d'un code set Cardmarket : les codes occidentaux sont en MAJUSCULES
// (DRI, TWM, OBF, PAL...), les japonais en minuscules / format sv+chiffres
// (sv9a, sv10s, m2a...). Règle empirique fiable sur nos données.
function regionDuCodeSet(codeSet) {
    if (!codeSet) return null;
    // Un code purement en majuscules (lettres) = occidental
    if (/^[A-Z0-9]+$/.test(codeSet) && /[A-Z]/.test(codeSet)) return 'occidental';
    // Contient une minuscule = japonais (sv9a, m2a, mC, xm2a...)
    if (/[a-z]/.test(codeSet)) return 'japonais';
    return null;
}

// Région attendue déduite de ce que l'IA a lu :
//  - langue JP -> japonais
//  - langue occidentale (FR/EN/DE/ES/IT/PT) -> occidental
//  - à défaut, la structure du numéro : "184/182" (occidental) vs pas de total (souvent JP)
function regionAttendue(cardInfo) {
    const langue = (cardInfo.language || '').toUpperCase();
    if (langue === 'JP') return 'japonais';
    if (['FR', 'EN', 'DE', 'ES', 'IT', 'PT'].includes(langue)) return 'occidental';
    // Repli sur la structure du numéro : un total présent (X/Y) = format occidental
    if (cardInfo.total) return 'occidental';
    return null;
}

// Normalise un nom pour comparaison : minuscules, sans espaces/tirets/ponctuation.
// "M Kangaskhan EX" et "MKangaskhan EX" -> "mkangaskhanex" (identiques).
function normaliserNom(nom) {
    return nom.toLowerCase().replace(/[\s\-'.&]/g, '');
}

// Retrouve le(s) produit(s) dans le catalogue local pour un nom de carte donné.
// Utilise une comparaison NORMALISÉE (ignore espaces, tirets, casse, ponctuation)
// car le format Cardmarket est très irrégulier (MKangaskhan, Mega Kangaskhan ex...).
async function trouverProduitsLocaux(nomExact) {
    try {
        if (mongoose.connection.readyState !== 1) return [];

        // Le nom Cardmarket a la forme "Nom [Attaques]". On isole le nom (avant le [) et on normalise.
        // On construit d'abord une liste de "cœurs de nom" à accepter (nom + variantes principales).
        const cibles = new Set();
        for (const v of genererVariantesNom(nomExact)) cibles.add(normaliserNom(v));

        // Récupère un sur-ensemble via le 1er mot significatif (indexé, rapide), puis filtre en JS
        const premierMot = nomExact.replace(/^(M|Mega)[\s-]*/i, '').split(/[\s&-]/)[0];
        if (!premierMot || premierMot.length < 3) {
            // Nom trop court pour pré-filtrer : on tente une regex directe sur les variantes
            const variantes = genererVariantesNom(nomExact);
            for (const variante of variantes) {
                const regex = new RegExp(`^${echapperRegex(variante)}(\\s*\\[|$)`, 'i');
                const r = await CatalogueProduit.find({ name: regex }).lean();
                if (r.length > 0) return r;
            }
            return [];
        }

        const preselection = await CatalogueProduit.find({ name: new RegExp(echapperRegex(premierMot), 'i') }).lean();

        // Garde ceux dont le nom (partie avant "[") normalisé correspond à une de nos cibles
        const resultats = preselection.filter(p => {
            const nomProduit = p.name.split('[')[0].trim();
            return cibles.has(normaliserNom(nomProduit));
        });

        if (resultats.length > 0) {
            console.log(`ℹ️ Catalogue local : ${resultats.length} produit(s) via correspondance normalisée pour "${nomExact}".`);
            return resultats;
        }
        return [];
    } catch (e) {
        console.error(`❌ Erreur trouverProduitsLocaux pour "${nomExact}" :`, e.message);
        return [];
    }
}

// Prix depuis le guide local (instantané) pour un idProduct précis.
async function getPrixGuideLocal(idProduct) {
    try {
        if (mongoose.connection.readyState !== 1) return null;
        const g = await GuidePrix.findOne({ idProduct }).lean();
        if (!g) return null;
        const prix = g.trend ?? g.avg ?? g.avg7 ?? g.avg30 ?? g.trendHolo ?? g.avgHolo;
        if (typeof prix !== 'number') return null;
        return prix;
    } catch (e) {
        console.error(`❌ Erreur getPrixGuideLocal pour ${idProduct} :`, e.message);
        return null;
    }
}

// ============================================================
// Enrichit les candidats (numéro appris + prix local + région) puis les score.
// NIVEAU 1 : 100% local, aucune requête Cardmarket, aucun risque de ban.
// ============================================================
async function scorerCandidatsLocal(produits, cardInfo, imageUrlVinted, idExpansionsAttendues = []) {
    const regionCible = regionAttendue(cardInfo);
    console.log(`🌍 Région attendue : ${regionCible || 'indéterminée'} (langue=${cardInfo.language}, total=${cardInfo.total || 'absent'})`);

    // Numéros appris (via apprendre-set.js) : c'est ce qui permet au critère
    // "numéro" du scoring de fonctionner, et donc de viser LE bon candidat.
    const numerosConnus = await lireNumeros(produits.map(p => p.idProduct));
    if (numerosConnus.size > 0) {
        console.log(`🔢 Numéros connus pour ${numerosConnus.size}/${produits.length} candidats.`);
    } else {
        const expansions = [...new Set(produits.map(p => p.idExpansion))];
        console.log(`💡 Aucun numéro connu pour ces candidats. Pour rendre l'identification précise, lance : node apprendre-set.js ${expansions.join(' ')}`);
    }

    const candidatsEnrichis = [];
    for (const p of produits) {
        const codeSet = await lireCodeSet(p.idExpansion); // connu si déjà appris
        const infoNum = numerosConnus.get(p.idProduct);
        candidatsEnrichis.push({
            idProduct: p.idProduct,
            idExpansion: p.idExpansion,
            numeroCardmarket: infoNum ? (infoNum.numero || infoNum.numeroUrl) : null,
            certitudeNumero: infoNum ? (infoNum.certitude || 'exacte') : null,
            // V1/V2/V3 = normale/reverse/illustration, présente seulement sur les
            // sets appris AVEC les nouveaux champs (--maj). Absente = null -> neutre.
            variante: infoNum ? (infoNum.variante || null) : null,
            prix: await getPrixGuideLocal(p.idProduct),
            // distanceImage volontairement absente : le hash perceptif a été retiré
            // (bruit sur photos d'annonce). Le critère image du scoring reste dans
            // scoring.js et se réactivera tout seul si on lui refournit un jour une
            // distance (via OffscreenCanvas côté extension, par exemple).
            region: regionDuCodeSet(codeSet || (infoNum && infoNum.codeSet))
        });
    }

    if (idExpansionsAttendues.length) {
        console.log(`🎯 Set attendu -> expansion(s) Cardmarket : ${idExpansionsAttendues.join(', ')}`);
    }

    const lu = {
        numero: cardInfo.number || null,   // le numéro lu par l'IA (ex: 79, TG06)
        idExpansionsAttendues,             // déduites du set TCGdex via le pré-remplissage
        rareteElevee: cardInfo.rareteElevee,
        regionAttendue: regionCible,
        // reverse lue -> on attend la variante V2. false/null -> pas d'exigence
        // (on n'affirme PAS V1 : la carte pourrait être une illustration V3).
        varianteAttendue: cardInfo.reverse === true ? 'V2' : null
    };
    if (lu.varianteAttendue) console.log(`🔁 Reverse lue par l'IA -> on vise la variante ${lu.varianteAttendue}.`);

    return choisirMeilleur(candidatsEnrichis, lu);
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

// Ordre officiel Cardmarket, du meilleur au pire
const ORDRE_ETATS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

// Prix le moins cher pour un état donné OU MIEUX (= ce que ferait minCondition).
// Ex: grille {NM:22.82, EX:18, LP:3} + état EX -> min(22.82, 18) = 18 €
function prixPourEtat(grille, etat) {
    if (!grille || !etat) return null;
    const seuil = ORDRE_ETATS.indexOf(String(etat).toUpperCase());
    if (seuil === -1) return null;
    const prix = ORDRE_ETATS.slice(0, seuil + 1)
        .map(e => grille[e])
        .filter(p => typeof p === 'number');
    return prix.length ? Math.min(...prix) : null;
}

// Renvoie le PIRE des deux états (le plus dégradé). Sert à croiser l'avis de
// l'IA et celui du vendeur : en cas de désaccord, on prend le moins favorable,
// car surestimer l'état conduit à surpayer.
function pireEtat(a, b) {
    const ia = ORDRE_ETATS.indexOf(String(a || '').toUpperCase());
    const ib = ORDRE_ETATS.indexOf(String(b || '').toUpperCase());
    if (ia === -1) return ib === -1 ? null : ORDRE_ETATS[ib];
    if (ib === -1) return ORDRE_ETATS[ia];
    return ORDRE_ETATS[Math.max(ia, ib)]; // index le plus grand = état le plus dégradé
}

// Retrouve les idExpansion Cardmarket correspondant à un set TCGdex.
// C'est le "pont" qui manquait : le pré-remplissage TCGdex a stocké, pour chaque
// carte, le set d'où venait son numéro (champ setTcgdex). En interrogeant cette
// trace, on sait dans quelle(s) expansion(s) Cardmarket chercher — ce qui active
// le critère "set" du scoring (40 points).
//
// ⚠️ Un set TCGdex couvre souvent PLUSIEURS éditions Cardmarket (japonaise,
// internationale, suppléments) : les cartes y portent les mêmes noms. Sans filtre,
// on pourrait donc récompenser l'édition japonaise alors que la carte est
// française. On ne retient que les expansions de la RÉGION attendue.
async function expansionsDuSetTCGdex(tcgdexCardId, regionAttendue = null) {
    try {
        if (mongoose.connection.readyState !== 1 || !tcgdexCardId) return [];
        const setId = String(tcgdexCardId).split('-')[0];
        if (!setId) return [];

        const exps = (await NumeroCarte.distinct('idExpansion', { setTcgdex: setId })).filter(e => e != null);
        if (!regionAttendue || exps.length === 0) return exps;

        // Filtrage par région, via le code set appris (MAJ = occidental, min = japonais)
        const gardees = [];
        for (const e of exps) {
            const code = await lireCodeSet(e);
            const region = regionDuCodeSet(code);
            // Région inconnue -> on garde (on ne pénalise pas ce qu'on ignore)
            if (!region || region === regionAttendue) gardees.push(e);
            else console.log(`   ℹ️ Expansion ${e} (${code}, ${region}) écartée du set attendu : on cherche de l'${regionAttendue}.`);
        }
        return gardees;
    } catch (e) {
        console.error("Erreur expansionsDuSetTCGdex :", e.message);
        return [];
    }
}

// Correspondance état Vinted -> état Cardmarket (minimum demandé).
// ⚠️ L'échelle Vinted est pensée pour les vêtements et l'état est DÉCLARÉ par le
// vendeur : c'est un indice, pas un grading. On reste donc volontairement prudent
// (ex: "Neuf sans étiquette" -> NM et pas MT, car les vendeurs surestiment).
function etatVintedVersCardmarket(etatVinted) {
    if (!etatVinted) return null;
    const e = etatVinted.toLowerCase();
    if (e.includes('neuf')) return 'NM';
    if (e.includes('très bon')) return 'EX';
    if (e.includes('bon état')) return 'GD';
    if (e.includes('satisfaisant')) return 'LP';
    return null;
}

app.post('/api/analyser', verifierJeton, async (req, res) => {
    try {
        const { imageUrl, imageUrls, title, vintedPrice, vintedEtat, debug } = req.body;

        if (!imageUrl) {
            console.error("⚠️ Requête reçue sans imageUrl. Body reçu:", req.body);
            return res.json({ success: false, error: "Aucune image reçue" });
        }

        const etatMin = etatVintedVersCardmarket(vintedEtat);
        if (vintedEtat) console.log(`🏷️ État Vinted : "${vintedEtat}" -> Cardmarket ${etatMin || '(non mappé)'}${etatMin ? ' minimum' : ''}`);

        const photos = (Array.isArray(imageUrls) && imageUrls.length) ? imageUrls : [imageUrl];
        console.log(`📷 ${photos.length} photo(s) envoyée(s) à l'IA.`);
        const cardInfo = await getCardIdFromAI(photos, title);
        if (!cardInfo) {
            return res.json({ success: false, error: "Analyse IA échouée (voir logs Render pour la cause exacte)" });
        }

        // 1. Cache Mongo (sauté si debug=true, pratique pour retester une carte sans attendre 24h)
        let resultat = debug ? null : await lireCache(cardInfo.name, cardInfo.number, cardInfo.language);
        if (debug) console.log("🐛 Mode debug : lecture du cache sautée.");

        // 2. Flux combiné orienté JUSTESSE :
        //    a) identifier le produit exact (TCGdex : numéro + image)
        //    b) retrouver le produit (idProduct + idExpansion) dans le catalogue local
        //    c) prix GUIDE LOCAL (instantané, par défaut)
        //    d) prix LIVE en bonus (exact + langue) si ton PC passe Cloudflare,
        //       + apprentissage du code set au passage
        //    e) repli TCGdex si rien d'autre n'a marché
        if (!resultat) {
            // 2a. Identification précise via TCGdex + image
            const trouvailleTCGdex = await trouverCarteTCGdex(cardInfo.name, cardInfo.number, cardInfo.setCode, imageUrl, cardInfo.language);
            if (!trouvailleTCGdex) {
                return res.json({ success: false, error: `Carte "${cardInfo.name}${cardInfo.setCode ? ' ' + cardInfo.setCode : ''} #${cardInfo.number}" non trouvée sur TCGdex` });
            }

            // 2b. Candidats Cardmarket (avec idExpansion) via le catalogue local
            const produits = await trouverProduitsLocaux(trouvailleTCGdex.nomExact);
            console.log(`🗂️ Catalogue local : ${produits.length} produit(s) pour "${trouvailleTCGdex.nomExact}".`);

            // 2c. NIVEAU 1 — scoring local (classe TOUS les candidats par pertinence)
            let classement = [];
            if (produits.length === 1) {
                classement = [{ candidat: produits[0], confiant: true }];
            } else if (produits.length > 1) {
                const expAttendues = await expansionsDuSetTCGdex(trouvailleTCGdex.id, regionAttendue(cardInfo));
                const { scores, confiant } = await scorerCandidatsLocal(produits, cardInfo, imageUrl, expAttendues);
                // scores est déjà trié par score décroissant ; on récupère les produits complets
                classement = scores.map(s => ({
                    candidat: produits.find(p => p.idProduct === s.candidat.idProduct),
                    score: s.score
                }));
                console.log(`🧮 Scoring local : ${classement.length} candidats classés, meilleur = ${classement[0]?.candidat?.idProduct} (score ${scores[0]?.score}), confiance ${confiant ? 'HAUTE' : 'BASSE'}`);
            }

            const numLu = cardInfo.number ? String(cardInfo.number).replace(/^0+/, '') : null;
            const carteNonEN = cardInfo.language && cardInfo.language !== 'EN';

            // 2d. NIVEAU 2 — on parcourt les candidats classés. Pour chacun, le live
            // confirme le numéro. Si ça correspond -> gagné. Sinon -> candidat suivant.
            // Garde-fou anti-ban : maximum 3 tentatives live.
            const MAX_ESSAIS_LIVE = 3;
            let trouve = false;
            let dernierResultatDouteux = null;

            if (LIVE_ACTIF && scraperFiche && classement.length > 0) {
                const nbEssais = Math.min(MAX_ESSAIS_LIVE, classement.length);
                for (let i = 0; i < nbEssais; i++) {
                    const produitCible = classement[i].candidat;
                    if (!produitCible) continue;

                    console.log(`🌐 Live (essai ${i + 1}/${nbEssais}) sur idProduct ${produitCible.idProduct}...`);
                    try {
                        // Pas de filtre d'état dans l'URL : on récupère TOUTE la grille
                        // en une seule requête, ce qui permet d'en déduire le prix de
                        // n'importe quel état (et d'afficher la grille complète).
                        const live = await scraperFiche(produitCible.idProduct, cardInfo.language, null);
                        if (!live) continue;

                        if (live.codeSet && produitCible.idExpansion) {
                            await memoriserCodeSet(produitCible.idExpansion, live.codeSet);
                        }

                        const nFiche = live.numero ? String(live.numero).replace(/^0+/, '') : null;
                        const numeroOK = !numLu || !nFiche || nFiche === numLu;

                        // Choix de l'état de référence. On retient le PIRE des deux avis
                        // (IA vs vendeur), car l'erreur d'optimisme coûte de l'argent :
                        //  - un vendeur PESSIMISTE est crédible (il a la carte en main et
                        //    n'a aucun intérêt à sous-vendre) -> on le suit ;
                        //  - un vendeur OPTIMISTE est suspect -> l'IA le corrige ;
                        //  - une IA optimiste est corrigée par le vendeur.
                        const grille = live.prixParEtat || {};
                        const confianceIA = String(cardInfo.etatConfiance || '').toLowerCase();
                        const iaFiable = cardInfo.etatEstime && (confianceIA === 'haute' || confianceIA === 'moyenne');
                        if (cardInfo.etatEstime && !iaFiable) {
                            console.log(`   ⚠️ Estimation IA (${cardInfo.etatEstime}) ignorée pour le prix : confiance ${confianceIA || '?'}.`);
                        }

                        const etatIA = iaFiable ? String(cardInfo.etatEstime).toUpperCase() : null;
                        const etatRetenu = pireEtat(etatIA, etatMin);
                        if (etatIA && etatMin && etatIA !== etatMin) {
                            console.log(`   ⚖️ IA dit ${etatIA}, vendeur dit ${etatMin} -> on retient le pire : ${etatRetenu}`);
                        }

                        const prixSelonEtat = prixPourEtat(grille, etatRetenu);
                        // Repli : sans grille ni état fiable, le "De" brut est trompeur
                        // (c'est l'exemplaire le plus abîmé du marché). La tendance est
                        // bien plus représentative de la valeur réelle de la carte.
                        let prixLive = prixSelonEtat ?? live.prixTendance ?? live.prixParLangue;
                        let baseEtat = null;
                        if (prixSelonEtat != null) {
                            const origine = (etatRetenu === etatIA && etatRetenu === etatMin) ? 'IA + vendeur'
                                : (etatRetenu === etatIA ? 'estimé IA' : 'déclaré vendeur');
                            baseEtat = `${etatRetenu}+ (${origine})`;
                        }
                        else if (live.prixTendance != null) baseEtat = `tendance du marché (état indéterminé)`;

                        const resLive = {
                            price: typeof prixLive === 'number' ? prixLive : null,
                            url: `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${produitCible.idProduct}`,
                            source: live.prixParLangue ? 'cardmarket-live-langue' : 'cardmarket-live',
                            filtrePar: live.prixParLangue ? 'langue' : 'global',
                            tendance: live.prixTendance,
                            historique: { jour1: live.moyenne1j, jours7: live.moyenne7j, jours30: live.moyenne30j },
                            grilleEtats: grille,
                            baseEtat
                        };

                        if (numeroOK && resLive.price !== null) {
                            // Bon numéro + prix trouvé -> c'est la bonne carte
                            resultat = resLive;
                            console.log(`✅ Numéro confirmé (${nFiche || 'n/a'}) — prix retenu : ${resLive.price} €${baseEtat ? ' sur base ' + baseEtat : ''}`);
                            trouve = true;
                            break;
                        } else if (!numeroOK) {
                            console.log(`↪️ Numéro fiche (${nFiche}) ≠ lu (${numLu}) — on essaie le candidat suivant.`);
                            // On garde ce résultat sous le coude au cas où aucun ne matche
                            if (resLive.price !== null && !dernierResultatDouteux) dernierResultatDouteux = { ...resLive, carteIncertaine: true };
                        }
                    } catch (e) {
                        console.log(`ℹ️ Live essai ${i + 1} en échec : ${e.message}`);
                    }
                }
            }

            // Si aucun candidat n'a le bon numéro : on prend le prix guide local du
            // meilleur candidat (marqué incertain), ou le dernier résultat live douteux.
            if (!trouve) {
                if (dernierResultatDouteux) {
                    resultat = dernierResultatDouteux;
                    console.log(`⚠️ Aucun numéro exact trouvé — prix indicatif retenu (incertain).`);
                } else if (classement.length > 0) {
                    const meilleur = classement[0].candidat;
                    const prixLocal = await getPrixGuideLocal(meilleur.idProduct);
                    if (prixLocal !== null) {
                        resultat = {
                            price: prixLocal,
                            url: `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${meilleur.idProduct}`,
                            source: 'guide-local',
                            carteIncertaine: produits.length > 1
                        };
                        console.log(`📘 Repli guide local pour idProduct ${meilleur.idProduct} : ${prixLocal} €${produits.length > 1 ? ' (incertain)' : ''}`);
                    }
                }
            }

            // 2e. Repli TCGdex (frais du jour) si ni guide local ni live n'ont donné de prix
            if (!resultat) {
                console.log("↪️ Repli sur TCGdex (pas d'idProduct fiable ou pas de prix local).");
                resultat = await getPrixDepuisTCGdex(trouvailleTCGdex.id, cardInfo.name, cardInfo.number);
                if (resultat) resultat.source = 'tcgdex';
            }

            if (!resultat) {
                return res.json({ success: false, error: "Carte identifiée mais aucun prix disponible (voir logs)" });
            }

            // Marquer incertain si l'identification TCGdex l'était
            if (trouvailleTCGdex.ambigu) resultat.carteIncertaine = true;

            // On ne met pas en cache un résultat incertain
            if (!resultat.carteIncertaine) {
                await ecrireCache(cardInfo.name, cardInfo.number, cardInfo.language, resultat.price, resultat.url);
            }
        }

        const prixVintedNombre = vintedPrice ? parseFloat(String(vintedPrice).replace(',', '.')) : null;
        const verdict = calculerVerdict(prixVintedNombre, resultat.price, cardInfo.language, resultat.carteIncertaine);

        // Le prix est fiable par langue UNIQUEMENT si le live filtré a réussi.
        // Sinon (guide local ou repli TCGdex = toutes langues), on prévient.
        const prixFiltreParLangue = resultat.source === 'cardmarket-live-langue';
        const langueVraimentIncertaine = (cardInfo.language && cardInfo.language !== 'EN') && !prixFiltreParLangue;

        // Lien vers la fiche Cardmarket filtrée dans la langue détectée
        const codeLangueURL = { EN: 1, FR: 2, DE: 3, ES: 4, IT: 5, ZH: 6, JP: 7, PT: 8, RU: 9, KR: 10 }[cardInfo.language] || 1;
        const urlLangue = resultat.url
            ? `${resultat.url}${resultat.url.includes('?') ? '&' : '?'}language=${codeLangueURL}`
            : null;

        res.json({
            success: true,
            cardName: cardInfo.name,
            cardNumber: cardInfo.number,
            cardTotal: cardInfo.total || null,
            rarete: cardInfo.rarete || null,
            language: cardInfo.language,
            cardmarketPrice: resultat.price,
            cardmarketUrl: urlLangue || resultat.url,
            tendance: resultat.tendance ?? null,
            historique: resultat.historique || null,
            vintedPrice: prixVintedNombre,
            verdict: verdict?.label || null,
            diffPourcent: verdict?.diffPourcent ?? null,
            langueIncertaine: langueVraimentIncertaine,
            carteIncertaine: Boolean(resultat.carteIncertaine),
            prixFiltreParLangue,
            etatVinted: vintedEtat || null,
            etatEstimeIA: cardInfo.etatEstime || null,
            etatConfianceIA: cardInfo.etatConfiance || null,
            defautsVus: cardInfo.defautsVus || null,
            grilleEtats: resultat.grilleEtats || null,
            baseEtat: resultat.baseEtat || null,
            etatCardmarket: etatMin || null,
            source: resultat.source || 'inconnue'
        });

    } catch (error) {
        console.error("❌ Erreur /api/analyser:", error);
        res.json({ success: false, error: "Erreur serveur interne" });
    }
});

// ============================================================
// ROUTE /api/identifier — pour l'ARCHITECTURE EXTENSION
// ============================================================
// Fait tout le travail d'identification (IA, TCGdex, catalogue, scoring) et
// renvoie les candidats CLASSÉS, mais ne touche PAS à Cardmarket : c'est
// l'extension qui fera le live depuis le navigateur de l'utilisateur, avec son
// IP et ses cookies. C'est la répartition qui évite les bannissements.
app.post('/api/identifier', verifierJeton, async (req, res) => {
    try {
        const { imageUrl, imageUrls, title, vintedEtat } = req.body;
        const photos = (Array.isArray(imageUrls) && imageUrls.length) ? imageUrls : [imageUrl];
        if (!photos.filter(Boolean).length) {
            return res.json({ success: false, error: "Aucune image reçue" });
        }

        console.log(`\n📷 [identifier] ${photos.length} photo(s) reçue(s).`);

        // 1. Lecture de la carte par l'IA
        const cardInfo = await getCardIdFromAI(photos, title);
        if (!cardInfo) return res.json({ success: false, error: "Analyse IA échouée" });

        // 2. Identification précise via TCGdex (+ variantes de nom, multilingue)
        const trouvaille = await trouverCarteTCGdex(cardInfo.name, cardInfo.number, cardInfo.setCode, photos[0], cardInfo.language);
        if (!trouvaille) {
            return res.json({ success: false, error: `Carte "${cardInfo.name}" #${cardInfo.number} non trouvée sur TCGdex`, cardInfo });
        }

        // Garde-fou : si le numéro de la carte trouvée contredit celui lu sur la photo,
        // c'est que TCGdex s'est trompé de carte (typiquement : set trop récent, absent
        // de sa base -> il retombe sur une homonyme d'un autre set). Dans ce cas on ne
        // se fie plus à son nom : on repart de ce que l'IA a lu.
        const numLuIA = String(cardInfo.number || '').replace(/^0+/, '').toLowerCase();
        const numTCG = String(trouvaille.localId || '').replace(/^0+/, '').toLowerCase();
        let nomPourCatalogue = trouvaille.nomExact;
        let tcgdexDouteux = false;
        if (numLuIA && numTCG && numLuIA !== numTCG) {
            tcgdexDouteux = true;
            nomPourCatalogue = cardInfo.name;
            console.log(`⚠️ [identifier] TCGdex renvoie le n°${numTCG} alors que l'IA a lu ${numLuIA} : set probablement trop récent pour TCGdex.`);
            console.log(`   -> on cherche dans le catalogue avec le nom lu par l'IA ("${cardInfo.name}") plutôt qu'avec celui de TCGdex.`);
        }

        // Validateur de reverse (TCGdex) : on ne garde "reverse=true" que si cette
        // carte possède RÉELLEMENT une impression reverse. Neutralise les faux
        // positifs (une holo normale lue à tort comme reverse par l'IA). On ne
        // l'applique PAS si TCGdex s'est trompé de carte (variants d'une autre carte).
        if (cardInfo.reverse === true && !tcgdexDouteux && trouvaille.variants) {
            if (trouvaille.variants.reverse === false) {
                console.log(`↩️ TCGdex : pas de reverse connue pour cette carte -> on ignore le "reverse" lu par l'IA.`);
                cardInfo.reverse = false;
            } else if (trouvaille.variants.reverse === true) {
                console.log(`✅ TCGdex confirme qu'une reverse existe pour cette carte.`);
            }
        }

        // 3. Candidats Cardmarket via le catalogue local
        const produits = await trouverProduitsLocaux(nomPourCatalogue);
        console.log(`🗂️ [identifier] ${produits.length} candidat(s) pour "${nomPourCatalogue}".`);

        // Le set TCGdex nous dit dans quelle(s) expansion(s) Cardmarket chercher.
        // Si TCGdex s'est trompé de carte (numéro incohérent), on n'utilise pas son set.
        const expansionsAttendues = tcgdexDouteux ? [] : await expansionsDuSetTCGdex(trouvaille.id, regionAttendue(cardInfo));

        // 4. Scoring : on renvoie le CLASSEMENT, l'extension testera dans l'ordre
        let classement = [];
        if (produits.length === 1) {
            classement = [{ idProduct: produits[0].idProduct, idExpansion: produits[0].idExpansion, score: 999 }];
        } else if (produits.length > 1) {
            const { scores, confiant } = await scorerCandidatsLocal(produits, cardInfo, photos[0], expansionsAttendues);
            classement = scores.map(s => ({
                idProduct: s.candidat.idProduct,
                idExpansion: s.candidat.idExpansion,
                score: s.score,
                detail: s.detail
            }));
            console.log(`🧮 [identifier] meilleur = ${classement[0]?.idProduct} (score ${classement[0]?.score}), confiance ${confiant ? 'HAUTE' : 'BASSE'}`);
        }

        // Codes set connus : permettent à l'extension de construire les URLs d'images
        const codesSet = {};
        for (const p of produits) {
            const c = await lireCodeSet(p.idExpansion);
            if (c) codesSet[p.idExpansion] = c;
        }

        const etatMin = etatVintedVersCardmarket(vintedEtat);

        res.json({
            success: true,
            carte: {
                nom: cardInfo.name,
                nomExact: trouvaille.nomExact,
                numero: cardInfo.number,
                total: cardInfo.total || null,
                setCode: cardInfo.setCode || null,
                rarete: cardInfo.rarete || null,
                langue: cardInfo.language,
                rareteElevee: cardInfo.rareteElevee,
                tcgdexId: trouvaille.id,
                // Incertain si TCGdex hésitait, OU s'il s'est manifestement trompé de carte
                ambigu: Boolean(trouvaille.ambigu || tcgdexDouteux)
            },
            etat: {
                estimeIA: cardInfo.etatEstime || null,
                confianceIA: cardInfo.etatConfiance || null,
                defautsVus: cardInfo.defautsVus || [],
                declareVendeur: vintedEtat || null,
                declareCardmarket: etatMin,
                // L'état à retenir = le PIRE des deux avis (voir explication plus haut)
                retenu: pireEtat(
                    (cardInfo.etatConfiance === 'haute' || cardInfo.etatConfiance === 'moyenne') ? cardInfo.etatEstime : null,
                    etatMin
                )
            },
            classement,
            codesSet,
            // Codes langue Cardmarket, pour que l'extension construise l'URL du live
            codeLangue: { EN: 1, FR: 2, DE: 3, ES: 4, IT: 5, ZH: 6, JP: 7, PT: 8, RU: 9, KR: 10 }[cardInfo.language] || 1
        });

    } catch (e) {
        console.error("❌ [identifier]", e.message);
        res.json({ success: false, error: e.message });
    }
});

// Enregistre ce que l'extension a lu en live : le code set et le numéro réel d'un
// idProduct. C'est ainsi que la base s'enrichit — depuis les navigateurs des
// utilisateurs, une carte à la fois, sans jamais scraper en masse.
app.post('/api/apprendre', verifierJeton, async (req, res) => {
    try {
        const { idProduct, idExpansion, codeSet, numero } = req.body;
        if (!idProduct) return res.json({ success: false });

        if (codeSet && idExpansion) await memoriserCodeSet(idExpansion, codeSet);

        if (numero) {
            await NumeroCarte.findOneAndUpdate(
                { idProduct },
                {
                    $set: {
                        idProduct, idExpansion, numero: String(numero), codeSet,
                        source: 'cardmarket',   // vu en direct = fait foi
                        certitude: 'exacte',
                        apprisLe: new Date()
                    }
                },
                { upsert: true }
            );
            console.log(`🧠 [apprendre] idProduct ${idProduct} -> n°${numero} (${codeSet || '?'})`);
        }
        res.json({ success: true });
    } catch (e) {
        console.error("❌ [apprendre]", e.message);
        res.json({ success: false, error: e.message });
    }
});

// Route de réveil : l'extension l'appelle dès qu'une page Vinted se charge, pour
// que le serveur (endormi sur le plan gratuit Render après 15 min d'inactivité)
// soit déjà chaud quand l'utilisateur clique sur "Analyser". Volontairement
// minimale : aucun accès base, aucun calcul.
app.get('/ping', (req, res) => res.json({ ok: true, mongo: mongoose.connection.readyState === 1 }));

app.get('/', (req, res) => res.send('Serveur Analyseur Pokémon actif'));

app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));

// Fermeture propre du navigateur Puppeteer quand on arrête le serveur (Ctrl+C)
process.on('SIGINT', async () => {
    console.log("\nArrêt du serveur, fermeture du navigateur live...");
    try { if (fermerBrowser) await fermerBrowser(); } catch (e) {}
    process.exit(0);
});