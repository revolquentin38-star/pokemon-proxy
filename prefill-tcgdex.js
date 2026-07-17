// ============================================================
// PRÉ-REMPLISSAGE TCGdex — mapping des numéros SANS toucher Cardmarket
// ============================================================
// Problème : le catalogue Cardmarket ne contient pas les numéros de collection.
// Les scraper coûte des heures et finit en bannissement.
//
// Solution : TCGdex connaît les numéros, gratuitement et sans Cloudflare. Mais il
// ignore les idExpansion Cardmarket. On les identifie donc par EMPREINTE DE
// CONTENU : si l'expansion 6096 contient les mêmes noms de cartes qu'un set
// TCGdex, c'est le même set. Aucun nom d'expansion nécessaire.
//
// USAGE : node prefill-tcgdex.js            (simulation, n'écrit rien)
//         node prefill-tcgdex.js --ecrire   (écrit vraiment en base)
//
// ⚠️ Les entrées déjà apprises depuis Cardmarket ne sont JAMAIS écrasées :
//    elles font autorité (elles ont les variantes V1/V2 que TCGdex n'a pas).

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const ECRIRE = process.argv.includes('--ecrire');

// ---- Modèles ----
const numeroCarteSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    idExpansion: Number, numero: String, numeroUrl: String, codeSet: String,
    nomFr: String, variante: String, slug: String, slugSet: String,
    source: String,      // 'cardmarket' (fiable) ou 'tcgdex' (pré-rempli)
    certitude: String,   // 'exacte' ou 'heuristique' (départagé par prix, ou set partagé)
    setTcgdex: String,   // traçabilité : le set TCGdex d'où vient le numéro
    setPartage: Boolean, // ce set TCGdex sert-il à plusieurs expansions Cardmarket ?
    apprisLe: { type: Date, default: Date.now }
});
const NumeroCarte = mongoose.model('NumeroCarte', numeroCarteSchema, 'numeros_cartes');

const catalogueSchema = new mongoose.Schema({ idProduct: Number, name: String, idExpansion: Number });
const CatalogueProduit = mongoose.model('CatalogueProduit', catalogueSchema, 'catalogue_produits');

const guidePrixSchema = new mongoose.Schema({ idProduct: Number, trend: Number, avg: Number });
const GuidePrix = mongoose.model('GuidePrix', guidePrixSchema, 'guide_prix');

// ---- Utilitaires ----
// Même normalisation que le serveur : absorbe le chaos de nommage Cardmarket
// ("MKangaskhan EX" == "M Kangaskhan EX" == "mkangaskhanex")
function normaliserNom(nom) {
    return String(nom).split('[')[0].trim().toLowerCase().replace(/[\s\-'.&:,!?]/g, '');
}

const pause = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, essais = 3) {
    for (let i = 1; i <= essais; i++) {
        try {
            const r = await axios.get(url, { timeout: 20000 });
            return r.data;
        } catch (e) {
            // Un 404 signifie "ça n'existe pas" (ex: set non traduit en FR) :
            // inutile de réessayer, ça ne fait que ralentir énormément.
            const code = e.response?.status;
            if (code && code >= 400 && code < 500) throw e;
            if (i === essais) throw e;
            await pause(1000 * i);
        }
    }
}

// ---- 1. Récupérer tous les sets TCGdex avec leurs cartes ----
async function chargerSetsTCGdex() {
    console.log("📥 Récupération de la liste des sets TCGdex...");
    const sets = await getJSON('https://api.tcgdex.net/v2/en/sets');
    console.log(`   ${sets.length} sets trouvés. Chargement de leurs cartes (quelques minutes)...`);

    const resultat = [];
    let sansFr = 0;
    for (const [i, s] of sets.entries()) {
        // Progression en continu sur une seule ligne (plus rassurant qu'un silence)
        process.stdout.write(`\r   [${i + 1}/${sets.length}] ${String(s.name).slice(0, 40).padEnd(40)}`);
        try {
            const detail = await getJSON(`https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(s.id)}`);
            if (!detail?.cards?.length) continue;

            // Noms français du même set (pour remplir nomFr au passage).
            // Beaucoup de sets japonais n'ont pas de traduction FR : c'est normal.
            let cartesFr = null;
            try {
                const detailFr = await getJSON(`https://api.tcgdex.net/v2/fr/sets/${encodeURIComponent(s.id)}`);
                if (detailFr?.cards?.length) {
                    cartesFr = new Map(detailFr.cards.map(c => [String(c.localId), c.name]));
                }
            } catch (e) { sansFr++; }

            resultat.push({
                id: s.id,
                name: s.name,
                cartes: detail.cards.map(c => ({
                    localId: String(c.localId),
                    nom: c.name,
                    nomNorm: normaliserNom(c.name),
                    nomFr: cartesFr ? (cartesFr.get(String(c.localId)) || null) : null
                }))
            });
        } catch (e) {
            // set illisible, on passe
        }
        await pause(60); // politesse envers une API gratuite
    }
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(`✅ ${resultat.length} sets TCGdex chargés (${sansFr} sans traduction FR).\n`);
    return resultat;
}

// ---- 2. Apparier une expansion Cardmarket aux set(s) TCGdex correspondants ----
// Deux situations opposées, qu'il ne faut surtout pas confondre :
//
//   DANGEREUX : une petite expansion CM (5 promos) dont tous les noms existent
//     dans un gros set TCGdex (200 cartes). Les numéros n'ont rien à voir.
//     Signature : couverture CM haute, couverture TCGdex très basse.
//
//   LÉGITIME : un sous-ensemble TCGdex (Trainer Gallery = 30 cartes) entièrement
//     contenu dans une expansion CM (Astral Radiance = 250 cartes), parce que
//     Cardmarket ne sépare pas les Trainer Gallery du set principal.
//     Signature : couverture TCGdex quasi totale.
//
// Une expansion CM peut donc correspondre à PLUSIEURS sets TCGdex à la fois
// (le set principal + sa Trainer Gallery) : on les renvoie tous.
// Un sous-ensemble LÉGITIME (Trainer Gallery, Shiny Vault, Galarian Gallery) se
// reconnaît à sa NUMÉROTATION PRÉFIXÉE : TG01, SV001, GG01... C'est justement ce
// qui lui permet de cohabiter avec le set principal dans la même expansion
// Cardmarket, sans collision de numéros.
// Un vrai set (Base Set 2, McDonald's, Énergies) a des numéros simples (1, 2, 3...)
// et possède sa propre expansion : sa "présence" dans un gros set n'est qu'une
// coïncidence de noms de Pokémon.
function estGalerieNumerotee(set) {
    const ids = set.cartes.map(c => String(c.localId));
    if (ids.length === 0) return false;
    const prefixes = ids.filter(id => /^[A-Za-z]{2,3}\d+$/.test(id)).length;
    return prefixes / ids.length >= 0.9; // quasi toutes les cartes préfixées
}

const COUVERTURE_SOUS_ENSEMBLE = 0.8; // un set TCGdex "contenu" doit l'être presque entièrement

function trouverSetsTCGdex(nomsExpansion, setsTCGdex) {
    const cible = new Set(nomsExpansion);
    const retenus = [];

    for (const set of setsTCGdex) {
        const nomsSet = new Set(set.cartes.map(c => c.nomNorm));
        let communs = 0;
        for (const n of cible) if (nomsSet.has(n)) communs++;
        if (communs === 0) continue;

        const couvertureCM = communs / cible.size;
        const couvertureTCG = communs / nomsSet.size;
        const jaccard = communs / (cible.size + nomsSet.size - communs);

        // Cas 1 : les deux ensembles se recouvrent largement -> même set
        const memeSet = couvertureCM >= 0.5 && couvertureTCG >= 0.5;
        // Cas 2 : galerie à numérotation préfixée, contenue dans l'expansion
        const sousEnsemble = !memeSet
            && couvertureTCG >= COUVERTURE_SOUS_ENSEMBLE
            && communs >= 5
            && estGalerieNumerotee(set);

        if (memeSet || sousEnsemble) {
            retenus.push({ set, jaccard, couvertureCM, couvertureTCG, sousEnsemble });
        }
    }

    retenus.sort((a, b) => b.jaccard - a.jaccard);
    return retenus;
}

// ---- 3. Programme principal ----
async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connecté.");
    console.log(ECRIRE ? "✍️  Mode ÉCRITURE : la base sera modifiée.\n" : "👀 Mode SIMULATION : rien ne sera écrit (ajoute --ecrire pour valider).\n");

    const setsTCGdex = await chargerSetsTCGdex();

    // Produits Cardmarket, groupés par expansion
    const produits = await CatalogueProduit.find({}, { idProduct: 1, name: 1, idExpansion: 1 }).lean();
    const parExpansion = new Map();
    for (const p of produits) {
        if (!parExpansion.has(p.idExpansion)) parExpansion.set(p.idExpansion, []);
        parExpansion.get(p.idExpansion).push(p);
    }

    // Ce qui vient de Cardmarket fait autorité : on n'y touche pas
    const dejaFiables = new Set(await NumeroCarte.distinct('idProduct'));
    console.log(`ℹ️ ${dejaFiables.size} cartes déjà apprises depuis Cardmarket — elles ne seront pas écrasées.\n`);

    // Prix (pour départager les variantes de même nom)
    const prix = new Map((await GuidePrix.find({}, { idProduct: 1, trend: 1, avg: 1 }).lean())
        .map(g => [g.idProduct, g.trend ?? g.avg ?? 0]));

    let setsApparies = 0, setsRates = 0, exactes = 0, heuristiques = 0;
    const operations = [];
    const appariements = [];      // pour contrôle visuel
    const usageSetTCG = new Map(); // combien d'expansions pointent vers le même set TCGdex

    // --- PASSE 1 : appariements DIRECTS uniquement (les deux sens ≥ 50 %) ---
    // On repère d'abord quels sets TCGdex ont leur PROPRE expansion Cardmarket.
    const revendiques = new Set();
    const brut = [];
    for (const [idExpansion, prods] of parExpansion) {
        const nomsNorm = prods.map(p => normaliserNom(p.name));
        const retenus = trouverSetsTCGdex(nomsNorm, setsTCGdex);
        brut.push({ idExpansion, prods, retenus });
        for (const r of retenus) if (!r.sousEnsemble) revendiques.add(r.set.id);
    }

    // --- PASSE 1bis : filtrer les sous-ensembles ---
    // Un sous-ensemble n'est LÉGITIME que s'il n'a pas déjà sa propre expansion
    // Cardmarket. C'est ce qui distingue :
    //   - Trainer Gallery : Cardmarket la range DANS le set principal -> légitime
    //   - McDonald's / Trainer Kit / Énergies : ils ONT leur propre expansion,
    //     donc leur présence "dans" un gros set n'est qu'une coïncidence de noms
    //     (Pikachu, Raichu... existent partout) -> à rejeter.
    const usageSousEnsemble = new Map();
    for (const { retenus } of brut) {
        for (const r of retenus) {
            if (r.sousEnsemble && !revendiques.has(r.set.id)) {
                usageSousEnsemble.set(r.set.id, (usageSousEnsemble.get(r.set.id) || 0) + 1);
            }
        }
    }

    // Second garde-fou : un vrai sous-ensemble appartient à UNE expansion.
    // Ceux réclamés par beaucoup d'expansions sont des faux (Énergies de base...).
    const MAX_EXPANSIONS_PAR_SOUS_ENSEMBLE = 2;
    const sousEnsemblesValides = new Set(
        [...usageSousEnsemble.entries()]
            .filter(([, n]) => n <= MAX_EXPANSIONS_PAR_SOUS_ENSEMBLE)
            .map(([id]) => id)
    );

    const rejetesCarRevendiques = [...new Set(brut.flatMap(b => b.retenus.filter(r => r.sousEnsemble && revendiques.has(r.set.id)).map(r => r.set.id)))];
    if (rejetesCarRevendiques.length) {
        console.log(`🚫 ${rejetesCarRevendiques.length} faux sous-ensemble(s) écarté(s) : ils ont leur PROPRE expansion Cardmarket`);
        console.log(`   (ex: ${rejetesCarRevendiques.slice(0, 4).join(', ')}) — leur présence dans un gros set n'est qu'une coïncidence de noms.\n`);
    }

    const correspondances = [];
    let sousEnsemblesRecuperes = 0;
    let concurrentsEcartes = 0;
    let rejetesCarConcurrents = 0;

    for (const { idExpansion, prods, retenus } of brut) {
        const principaux = retenus.filter(r => !r.sousEnsemble);
        let sousEns = retenus.filter(r => r.sousEnsemble && sousEnsemblesValides.has(r.set.id));

        // Si PLUSIEURS sets se disent contenus dans la même expansion, c'est une
        // coïncidence de noms communs, pas une vraie inclusion. Cas typique : Base
        // Set, Base Set 2, Legendary Collection et FireRed partagent tous les mêmes
        // ~150 noms de Pokémon -> indiscernables par empreinte. Un vrai sous-ensemble
        // (Trainer Gallery) est SEUL à être contenu dans son set.
        if (sousEns.length > 1) {
            rejetesCarConcurrents += sousEns.length;
            sousEns = [];
        }

        // Une expansion Cardmarket n'a QU'UN seul set principal. Or plusieurs sets
        // TCGdex peuvent matcher par les noms : "151" est un remake des 151 Pokémon
        // d'origine, donc Base Set 2 / Legendary Collection / FireRed contiennent le
        // MÊME casting et matchent tout autant. Les noms seuls ne les distinguent
        // pas -> on ne garde que le MEILLEUR (jaccard le plus élevé).
        const meilleurPrincipal = principaux[0] || null; // déjà trié par jaccard
        if (principaux.length > 1) concurrentsEcartes += principaux.length - 1;

        const valides = [];
        if (meilleurPrincipal) valides.push(meilleurPrincipal);
        valides.push(...sousEns);

        if (valides.length === 0) { setsRates++; continue; }
        setsApparies++;

        const cartesFusionnees = [];
        for (const r of valides) {
            cartesFusionnees.push(...r.set.cartes);
            usageSetTCG.set(r.set.id, (usageSetTCG.get(r.set.id) || 0) + 1);
            if (r.sousEnsemble) sousEnsemblesRecuperes++;
        }

        const principal = valides[0].set;
        const setFusionne = { id: principal.id, name: principal.name, cartes: cartesFusionnees };
        correspondances.push({ idExpansion, prods, set: setFusionne, retenus: valides });

        appariements.push({
            idExpansion, taille: prods.length,
            setNom: valides.map(r => r.set.name + (r.sousEnsemble ? ' [sous-ens.]' : '')).join(' + '),
            setId: principal.id,
            tousSetIds: valides.map(r => r.set.id),
            score: valides[0].jaccard,
            nbSets: valides.length
        });
    }
    if (rejetesCarConcurrents) {
        console.log(`🚫 ${rejetesCarConcurrents} sous-ensemble(s) écarté(s) : plusieurs se disputaient la même expansion`);
        console.log(`   (coïncidence de noms communs — ex: tous les sets de l'ère Base partagent les mêmes 150 Pokémon).\n`);
    }
    if (concurrentsEcartes) {
        console.log(`🚫 ${concurrentsEcartes} set(s) TCGdex concurrent(s) écarté(s) : une expansion n'a qu'UN set principal.`);
        console.log(`   (ex: "151" et "Base Set 2" partagent les mêmes 151 Pokémon -> indiscernables par les noms.)\n`);
    }
    if (sousEnsemblesRecuperes) {
        console.log(`🎁 ${sousEnsemblesRecuperes} vrai(s) sous-ensemble(s) récupéré(s) (Trainer Gallery, Shiny Vault...).\n`);
    }

    // --- PASSE 2 : construire les opérations, en tenant compte des sets partagés ---
    for (const { idExpansion, prods, set } of correspondances) {
        // Un set TCGdex apparié à PLUSIEURS expansions Cardmarket = éditions
        // régionales du même set (JP / international / suppléments). Elles partagent
        // souvent la numérotation, mais PAS TOUJOURS : on ne peut donc pas garantir
        // ces numéros -> on les marque tous comme heuristiques.
        const setPartage = (usageSetTCG.get(set.id) || 0) > 1;

        // Index des cartes TCGdex par nom normalisé
        const parNomTCG = new Map();
        for (const c of set.cartes) {
            if (!parNomTCG.has(c.nomNorm)) parNomTCG.set(c.nomNorm, []);
            parNomTCG.get(c.nomNorm).push(c);
        }
        // Index des produits Cardmarket par nom normalisé
        const parNomCM = new Map();
        for (const p of prods) {
            const n = normaliserNom(p.name);
            if (!parNomCM.has(n)) parNomCM.set(n, []);
            parNomCM.get(n).push(p);
        }

        for (const [nom, produitsDuNom] of parNomCM) {
            const cartesTCG = parNomTCG.get(nom);
            if (!cartesTCG) continue;

            let paires = [];
            if (produitsDuNom.length === 1 && cartesTCG.length === 1) {
                // Cas simple : un seul produit, une seule carte -> certitude
                paires = [[produitsDuNom[0], cartesTCG[0], 'exacte']];
            } else if (produitsDuNom.length === cartesTCG.length) {
                // Plusieurs versions du même nom (normale / secrète / IR).
                // Astuce : la version au numéro le plus élevé (secrète/IR) est
                // systématiquement la plus chère. On apparie donc prix croissant
                // avec numéro croissant. Heuristique, mais très fiable en pratique.
                const cmTries = [...produitsDuNom].sort((a, b) => (prix.get(a.idProduct) ?? 0) - (prix.get(b.idProduct) ?? 0));
                const tcgTries = [...cartesTCG].sort((a, b) => {
                    const na = parseInt(a.localId.replace(/\D/g, ''), 10) || 0;
                    const nb = parseInt(b.localId.replace(/\D/g, ''), 10) || 0;
                    return na - nb;
                });
                paires = cmTries.map((p, i) => [p, tcgTries[i], 'heuristique']);
            } else {
                // Nombres différents (reverse holo côté Cardmarket, etc.) : on ne
                // devine pas. Ces cartes resteront à résoudre par le live.
                continue;
            }

            for (const [p, c, certitudeBrute] of paires) {
                if (dejaFiables.has(p.idProduct)) continue; // Cardmarket fait autorité

                // Un set partagé entre plusieurs expansions (JP / international) ne
                // garantit pas la même numérotation -> on dégrade la certitude.
                const certitude = (certitudeBrute === 'exacte' && !setPartage) ? 'exacte' : 'heuristique';
                if (certitude === 'exacte') exactes++; else heuristiques++;

                operations.push({
                    updateOne: {
                        filter: { idProduct: p.idProduct },
                        update: {
                            $set: {
                                idProduct: p.idProduct,
                                idExpansion,
                                numero: c.localId,
                                nomFr: c.nomFr || null,
                                source: 'tcgdex',
                                certitude,
                                setTcgdex: set.id,     // traçabilité : d'où vient ce numéro
                                setPartage,            // ce set sert-il à plusieurs expansions ?
                                apprisLe: new Date()
                            }
                        },
                        upsert: true
                    }
                });
            }
        }
    }

    console.log("=== RÉSULTAT ===");
    console.log(`Sets appariés à TCGdex   : ${setsApparies}/${parExpansion.size}`);
    console.log(`Sets non appariés        : ${setsRates} (promos, sets absents de TCGdex...)`);
    console.log(`\nCartes à écrire : ${operations.length}`);
    console.log(`   ✅ exactes      : ${exactes}  (nom unique dans un set exclusif)`);
    console.log(`   🟡 heuristiques : ${heuristiques}  (départagées par prix, ou set partagé JP/international)`);
    console.log(`\n   Les heuristiques sont marquées certitude:'heuristique' en base.`);
    console.log(`   Un futur scraping Cardmarket les écrasera par la vérité.`);

    // --- Contrôle : un set TCGdex apparié à plusieurs expansions est suspect ---
    const doublons = [...usageSetTCG.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    if (doublons.length) {
        console.log(`\n⚠️ ${doublons.length} set(s) TCGdex apparié(s) à PLUSIEURS expansions Cardmarket.`);
        console.log(`   C'est souvent normal (éditions JP / internationale / suppléments du même set).`);
        console.log(`   Ces cartes sont marquées 'heuristique'. Top 5 :`);
        for (const [setId, n] of doublons.slice(0, 5)) {
            // On cherche dans TOUS les setId retenus (pas seulement le principal),
            // sinon un sous-ensemble ne serait pas trouvé -> plantage.
            const exs = appariements.filter(a => (a.tousSetIds || [a.setId]).includes(setId));
            const nom = exs[0]?.setNom || '(inconnu)';
            const listeExp = exs.slice(0, 6).map(e => e.idExpansion).join(', ');
            console.log(`   - ${setId} <- ${n} expansions : ${listeExp}${exs.length > 6 ? '...' : ''}`);
        }
    } else {
        console.log(`\n✅ Aucun set TCGdex apparié à deux expansions : appariement sain.`);
    }

    // --- Contrôle visuel : les 8 plus gros appariements ---
    console.log(`\n🔍 Vérifie ces appariements à l'oeil (les 8 plus gros) :`);
    appariements.sort((a, b) => b.taille - a.taille).slice(0, 8).forEach(a => {
        console.log(`   Expansion ${a.idExpansion} (${a.taille} cartes) -> "${a.setNom}" — score ${(a.score * 100).toFixed(0)}%`);
    });

    if (!ECRIRE) {
        console.log("\n👀 Simulation terminée — rien n'a été écrit.");
        console.log("   Si ces chiffres te conviennent : node prefill-tcgdex.js --ecrire");
    } else if (operations.length) {
        console.log("\n✍️  Écriture en base...");
        for (let i = 0; i < operations.length; i += 2000) {
            await NumeroCarte.bulkWrite(operations.slice(i, i + 2000), { ordered: false });
            console.log(`   ... ${Math.min(i + 2000, operations.length)}/${operations.length}`);
        }
        console.log("✅ Terminé. Ta base est enrichie, sans une seule requête Cardmarket.");
    }

    await mongoose.disconnect();
}

main().catch(e => { console.error("❌ Erreur :", e.message); process.exit(1); });