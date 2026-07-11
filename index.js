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
// ÉTAPE 2 — Trouver la fiche produit sur Cardmarket (sans passer par Google)
// ============================================================

async function essayerRechercheCardmarket(recherche) {
    const urlRecherche = `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(recherche)}`;
    // wait_for_selector : on attend que les résultats (des liens vers des fiches produit)
    // soient réellement présents dans le DOM avant que ScraperAPI ne nous rende le HTML.
    // Sans ça, on récupère parfois la page avant la fin du chargement Ajax des résultats.
    const waitFor = encodeURIComponent('a[href*="Products/Singles"]');
    const scraperUrl = `https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(urlRecherche)}&render=true&wait_for_selector=${waitFor}`;

    const response = await axios.get(scraperUrl, { timeout: 60000 });
    const html = String(response.data);
    const $ = cheerio.load(html);

    let lien = $('a[href*="/Products/Singles/"]').first().attr('href');

    if (!lien) {
        console.error(`⚠️ Aucun lien produit pour la recherche "${recherche}".`);
        console.error(`   Titre de la page reçue : "${$('title').text().trim()}"`);
        console.error(`   Taille HTML : ${html.length} caractères.`);
        const bloque = /cloudflare|attention required|checking your browser|access denied|captcha/i.test(html);
        if (bloque) console.error("   ⚠️ La page ressemble à une page de blocage anti-bot.");
        return null;
    }

    if (lien.startsWith('/')) lien = `https://www.cardmarket.com${lien}`;
    console.log(`🔗 Fiche Cardmarket trouvée pour "${recherche}" : ${lien}`);
    return lien;
}

async function trouverUrlCardmarket(name, number, setCode) {
    try {
        // Essai 1 : "code de set + numéro" (ex: "BLK 129") — format le plus fiable sur Cardmarket
        if (setCode) {
            const lien = await essayerRechercheCardmarket(`${setCode} ${number}`);
            if (lien) return lien;
        }

        // Essai 2 (repli) : "nom + numéro"
        return await essayerRechercheCardmarket(`${name} ${number}`);

    } catch (e) {
        console.error("❌ Erreur trouverUrlCardmarket:", e.response?.status, e.message);
        return null;
    }
}

// ============================================================
// ÉTAPE 3 — Récupérer le prix sur la fiche produit
// ============================================================

async function getPrixDepuisFiche(url) {
    const waitFor = encodeURIComponent('.price-container, [data-testid="price"], .info-list-price-value');
    const scraperUrl = `https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true&wait_for_selector=${waitFor}`;

    try {
        const response = await axios.get(scraperUrl, { timeout: 60000 });
        const html = String(response.data);
        const $ = cheerio.load(html);

        // Plan A : sélecteurs les plus probables sur une fiche Cardmarket.
        // ⚠️ Cardmarket change parfois ses classes CSS — si ça ne marche pas,
        // ouvre la fiche produit dans ton navigateur, fais F12, clique sur le
        // prix affiché, et remplace le(s) sélecteur(s) ci-dessous par le bon.
        const selecteursCandidats = [
            '.price-container .price',
            '[data-testid="price"]',
            '.info-list-price-value',
            '.price-guide .price'
        ];

        let prixTexte = null;
        for (const sel of selecteursCandidats) {
            const texte = $(sel).first().text().trim();
            if (texte) { prixTexte = texte; console.log(`✅ Prix trouvé via le sélecteur "${sel}": ${texte}`); break; }
        }

        // Plan B (secours) : on cherche un motif de prix en euros dans le HTML brut.
        // Moins fiable, mais évite un échec total si les classes CSS ont changé.
        if (!prixTexte) {
            const match = html.match(/(\d+[.,]\d{2})\s*€/);
            if (match) {
                prixTexte = match[0];
                console.log(`⚠️ Prix trouvé via le fallback regex (à vérifier): ${prixTexte}`);
            }
        }

        if (!prixTexte) {
            console.error(`❌ Aucun prix trouvé sur ${url}.`);
            console.error(`   Titre de la page reçue : "${$('title').text().trim()}"`);
            console.error(`   Taille HTML : ${html.length} caractères.`);
            return null;
        }

        const prixNombre = parseFloat(prixTexte.replace(/[^\d,.-]/g, '').replace(',', '.'));
        if (isNaN(prixNombre)) {
            console.error(`❌ Impossible de parser le prix "${prixTexte}"`);
            return null;
        }

        return prixNombre;

    } catch (e) {
        console.error("❌ Erreur getPrixDepuisFiche:", e.response?.status, e.message);
        return null;
    }
}

// ============================================================
// Verdict "bonne affaire"
// ============================================================

function calculerVerdict(prixVinted, prixCardmarket) {
    if (!prixVinted || isNaN(prixVinted)) return null;
    const ratio = prixVinted / prixCardmarket;
    const diffPourcent = Math.round((ratio - 1) * 100);

    if (ratio <= SEUIL_BONNE_AFFAIRE) {
        return { label: "🔥 Bonne affaire", diffPourcent };
    } else if (ratio <= SEUIL_PRIX_CORRECT) {
        return { label: "✅ Prix correct", diffPourcent };
    } else {
        return { label: "⚠️ Plus cher que le marché", diffPourcent };
    }
}

// ============================================================
// ROUTE PRINCIPALE
// ============================================================

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title, vintedPrice } = req.body;

        if (!imageUrl) {
            console.error("⚠️ Requête reçue sans imageUrl. Body reçu:", req.body);
            return res.json({ success: false, error: "Aucune image reçue" });
        }

        const cardInfo = await getCardIdFromAI(imageUrl, title);
        if (!cardInfo) {
            return res.json({ success: false, error: "Analyse IA échouée (voir logs Render pour la cause exacte)" });
        }

        // 1. Cache Mongo
        let resultat = await lireCache(cardInfo.name, cardInfo.number, cardInfo.language);

        // 2. Sinon on scrape
        if (!resultat) {
            const urlFiche = await trouverUrlCardmarket(cardInfo.name, cardInfo.number, cardInfo.setCode);
            if (!urlFiche) {
                return res.json({ success: false, error: `Carte "${cardInfo.name}${cardInfo.setCode ? ' ' + cardInfo.setCode : ''} #${cardInfo.number}" non trouvée sur Cardmarket` });
            }

            const prix = await getPrixDepuisFiche(urlFiche);
            if (prix === null) {
                return res.json({ success: false, error: "Fiche trouvée mais prix illisible (voir logs Render)" });
            }

            resultat = { price: prix, url: urlFiche };
            await ecrireCache(cardInfo.name, cardInfo.number, cardInfo.language, prix, urlFiche);
        }

        const prixVintedNombre = vintedPrice ? parseFloat(String(vintedPrice).replace(',', '.')) : null;
        const verdict = calculerVerdict(prixVintedNombre, resultat.price);

        res.json({
            success: true,
            cardName: cardInfo.name,
            cardNumber: cardInfo.number,
            language: cardInfo.language,
            cardmarketPrice: resultat.price,
            cardmarketUrl: resultat.url,
            vintedPrice: prixVintedNombre,
            verdict: verdict?.label || null,
            diffPourcent: verdict?.diffPourcent ?? null
        });

    } catch (error) {
        console.error("❌ Erreur /api/analyser:", error);
        res.json({ success: false, error: "Erreur serveur interne" });
    }
});

app.get('/', (req, res) => res.send('Serveur Analyseur Pokémon actif'));

app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));