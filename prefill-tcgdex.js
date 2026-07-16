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
const SEUIL_CONFIANCE = 0.5; // % de noms communs pour valider l'appariement d'un set

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

// ---- 2. Apparier une expansion Cardmarket au bon set TCGdex ----
// ⚠️ Le score doit pénaliser l'écart de taille. Avec un simple
// "communs / plus petit des deux", une promo de 5 cartes dont les noms existent
// dans un gros set obtiendrait un score parfait — et se verrait attribuer les
// numéros du mauvais set. On utilise donc l'indice de Jaccard :
//     communs / (taille union)
// qui n'est élevé que si les deux ensembles se recouvrent VRAIMENT.
function trouverMeilleurSet(nomsExpansion, setsTCGdex) {
    const cible = new Set(nomsExpansion);
    let meilleur = null, meilleurScore = 0;

    for (const set of setsTCGdex) {
        const nomsSet = new Set(set.cartes.map(c => c.nomNorm));
        let communs = 0;
        for (const n of cible) if (nomsSet.has(n)) communs++;
        if (communs === 0) continue;

        const union = cible.size + nomsSet.size - communs;
        const jaccard = communs / union;

        // Garde-fou supplémentaire : les deux sets doivent se recouvrir dans les
        // DEUX sens (une expansion ne peut pas être "incluse" dans un set 10x plus gros)
        const couvertureCM = communs / cible.size;
        const couvertureTCG = communs / nomsSet.size;
        if (couvertureCM < 0.5 || couvertureTCG < 0.5) continue;

        if (jaccard > meilleurScore) { meilleurScore = jaccard; meilleur = set; }
    }
    return { set: meilleur, score: meilleurScore };
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

    // --- PASSE 1 : apparier chaque expansion à un set TCGdex ---
    // (on ne peut pas encore construire les opérations : il faut d'abord savoir
    //  quels sets TCGdex sont partagés par plusieurs expansions)
    const correspondances = [];
    for (const [idExpansion, prods] of parExpansion) {
        const nomsNorm = prods.map(p => normaliserNom(p.name));
        const { set, score } = trouverMeilleurSet(nomsNorm, setsTCGdex);

        if (!set || score < SEUIL_CONFIANCE) { setsRates++; continue; }
        setsApparies++;
        correspondances.push({ idExpansion, prods, set, score });
        appariements.push({ idExpansion, taille: prods.length, setNom: set.name, setId: set.id, score });
        usageSetTCG.set(set.id, (usageSetTCG.get(set.id) || 0) + 1);
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
        console.log(`   C'est parfois normal (une expansion + ses "Suppléments"), mais si les`);
        console.log(`   chiffres sont élevés, l'appariement est douteux. Top 5 :`);
        for (const [setId, n] of doublons.slice(0, 5)) {
            const exs = appariements.filter(a => a.setId === setId);
            console.log(`   - ${setId} ("${exs[0].setNom}") <- ${n} expansions : ${exs.map(e => e.idExpansion + ' (' + e.taille + ' cartes)').join(', ')}`);
        }
    } else {
        console.log(`\n✅ Aucun set TCGdex apparié à deux expansions : appariement sain.`);
    }

    // --- Contrôle visuel : les 8 plus gros appariements ---
    console.log(`\n🔍 Vérifie ces appariements à l'oeil (les 8 plus gros) :`);
    appariements.sort((a, b) => b.taille - a.taille).slice(0, 8).forEach(a => {
        console.log(`   Expansion ${a.idExpansion} (${a.taille} cartes) -> "${a.setNom}" [${a.setId}] — score ${(a.score * 100).toFixed(0)}%`);
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