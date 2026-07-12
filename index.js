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
// ÉTAPE 2 — Trouver la carte et son prix via l'API TCGdex (gratuite, sans clé)
// Docs : https://tcgdex.dev/markets-prices — prix Cardmarket inclus directement.
// ============================================================

async function chercherCartesTCGdex(name, numberFilter) {
    const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(name)}&localId=${numberFilter}`;
    const response = await axios.get(url, { timeout: 15000 });
    return Array.isArray(response.data) ? response.data : [];
}

async function trouverCarteTCGdex(name, number, setCode) {
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
        if (resultats.length > 1) {
            console.log(`ℹ️ TCGdex : ${resultats.length} résultats pour "${name}" #${number} :`, resultats.map(r => r.id));
            // Si on a le code du set, on s'en sert pour départager plusieurs correspondances
            if (setCode) {
                const correspondance = resultats.find(r => r.id.toLowerCase().includes(setCode.toLowerCase()));
                if (correspondance) choisi = correspondance;
            }
        }

        console.log(`🔗 Carte TCGdex retenue : ${choisi.id} ("${choisi.name}")`);
        return choisi.id;

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
// ÉTAPE 2bis — Scraping DIRECT de Cardmarket (sans proxy payant), en complément
// de TCGdex, pour tenter d'obtenir un prix filtré par langue. Expérimental :
// peut être bloqué par la protection anti-bot de Cardmarket selon les moments.
// Si ça échoue, la route principale se rabat automatiquement sur TCGdex.
// ============================================================

const HEADERS_NAVIGATEUR = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.cardmarket.com/'
};

function pageBloqueeParAntiBot(html) {
    return /cloudflare|attention required|checking your browser|access denied|captcha|just a moment/i.test(html);
}

async function essayerRechercheDirecte(recherche) {
    const urlRecherche = `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(recherche)}`;
    try {
        const response = await axios.get(urlRecherche, { headers: HEADERS_NAVIGATEUR, timeout: 15000 });
        const html = String(response.data);

        if (pageBloqueeParAntiBot(html)) {
            console.log(`🚫 Scraping direct bloqué (anti-bot) pour "${recherche}".`);
            return null;
        }

        const $ = cheerio.load(html);
        let lien = $('a[href*="/Pokemon/Cards/"]').first().attr('href');
        if (!lien) return null;

        if (lien.startsWith('/')) lien = `https://www.cardmarket.com${lien}`;
        console.log(`🔗 [Direct] Fiche Cardmarket trouvée pour "${recherche}" : ${lien}`);
        return lien;

    } catch (e) {
        console.log(`ℹ️ Scraping direct en échec pour "${recherche}" : ${e.response?.status || ''} ${e.message}`);
        return null;
    }
}

async function trouverCarteDirect(name, number, setCode) {
    if (setCode) {
        const lien = await essayerRechercheDirecte(`${setCode} ${number}`);
        if (lien) return lien;
    }
    return await essayerRechercheDirecte(`${name} ${number}`);
}

// Noms de langues (EN + FR, au cas où) à repérer dans les attributs title/alt des
// icônes de langue sur les lignes d'annonces. À AJUSTER si ça ne matche pas —
// voir le commentaire dans la réponse pour comment m'envoyer le bon HTML.
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
    return prixTrouves[0]; // le moins cher parmi les annonces dans la bonne langue
}

async function getPrixDirect(url, language) {
    try {
        const response = await axios.get(url, { headers: HEADERS_NAVIGATEUR, timeout: 15000 });
        const html = String(response.data);

        if (pageBloqueeParAntiBot(html)) {
            console.log(`🚫 Scraping direct bloqué (anti-bot) sur la fiche produit.`);
            return null;
        }

        const $ = cheerio.load(html);

        // Priorité 1 : prix filtré par langue (si on arrive à le détecter)
        const prixLangue = language && language !== 'EN' ? extrairePrixParLangue($, language) : null;

        // Priorité 2 : moyenne globale (dt/dd), méthode confirmée fiable précédemment
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

        console.log(`⚠️ [Direct] Aucun prix exploitable trouvé sur ${url}.`);
        return null;

    } catch (e) {
        console.log(`ℹ️ [Direct] Erreur sur la fiche produit : ${e.response?.status || ''} ${e.message}`);
        return null;
    }
}



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

        // 2. Sinon : on essaie d'abord le scraping direct (gratuit, peut donner un prix
        // filtré par langue), puis TCGdex en repli garanti (fiable mais moyenne globale)
        if (!resultat) {
            const urlDirect = await trouverCarteDirect(cardInfo.name, cardInfo.number, cardInfo.setCode);
            if (urlDirect) {
                resultat = await getPrixDirect(urlDirect, cardInfo.language);
            }

            if (!resultat) {
                console.log("↪️ Repli sur TCGdex (scraping direct indisponible ou bloqué).");
                const cardId = await trouverCarteTCGdex(cardInfo.name, cardInfo.number, cardInfo.setCode);
                if (!cardId) {
                    return res.json({ success: false, error: `Carte "${cardInfo.name}${cardInfo.setCode ? ' ' + cardInfo.setCode : ''} #${cardInfo.number}" non trouvée (ni en direct, ni sur TCGdex)` });
                }
                resultat = await getPrixDepuisTCGdex(cardId, cardInfo.name, cardInfo.number);
            }

            if (!resultat) {
                return res.json({ success: false, error: "Carte trouvée mais aucun prix disponible (voir logs Render)" });
            }

            await ecrireCache(cardInfo.name, cardInfo.number, cardInfo.language, resultat.price, resultat.url);
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