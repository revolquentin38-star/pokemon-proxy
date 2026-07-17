// ============================================================
// APPRENDRE TOUT — apprentissage massif, par lots, reprenable
// ============================================================
// Parcourt les expansions du catalogue et apprend les numéros de leurs cartes.
// - SAUTE automatiquement les sets déjà appris (donc relançable à volonté)
// - Traite les plus gros sets d'abord (les plus utiles : ce sont les vrais sets,
//   pas les micro-promos)
// - S'ARRÊTE PROPREMENT si Cloudflare bloque : tu reprends plus tard, rien n'est perdu
//
// USAGE :
//   node apprendre-tout.js            -> apprend 10 sets puis s'arrête
//   node apprendre-tout.js 30         -> apprend 30 sets
//   node apprendre-tout.js 30 --petits -> inclut aussi les sets de <20 cartes
//
// ⚠️ Le catalogue compte 759 expansions (~1150 pages, ~4h en continu). Tout faire
//    d'une traite = ban quasi certain. Lance plutôt 20-30 sets par session, sur
//    plusieurs jours. La base se complète progressivement et définitivement.

require('dotenv').config();
const mongoose = require('mongoose');
const { scraperListeExpansion, fermerBrowser, setCacherFenetre } = require('./live-cardmarket');

// Pendant l'apprentissage, les défis Cloudflare sont fréquents : on garde la
// fenêtre VISIBLE pour pouvoir cocher sans avoir à la faire réapparaître.
setCacherFenetre(false);

const numeroCarteSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    idExpansion: Number, numero: String, numeroUrl: String, codeSet: String,
    nomFr: String, variante: String, slug: String, slugSet: String,
    apprisLe: { type: Date, default: Date.now }
});
const NumeroCarte = mongoose.model('NumeroCarte', numeroCarteSchema, 'numeros_cartes');

const codeSetSchema = new mongoose.Schema({
    idExpansion: { type: Number, required: true, unique: true },
    codeSet: String, apprisLe: { type: Date, default: Date.now }
});
const CodeSet = mongoose.model('CodeSet', codeSetSchema, 'codes_set');

const catalogueSchema = new mongoose.Schema({ idProduct: Number, idExpansion: Number });
const CatalogueProduit = mongoose.model('CatalogueProduit', catalogueSchema, 'catalogue_produits');

const MAX_ECHECS_CONSECUTIFS = 2; // 2 sets vides d'affilée = probablement banni -> on arrête

// Pause entre deux SETS (en plus du délai entre pages). Un scraping soutenu de
// plusieurs heures est ce qui a déclenché les bans : on souffle entre chaque set.
const PAUSE_ENTRE_SETS_MIN_MS = 60000;  // 1 min
const PAUSE_ENTRE_SETS_MAX_MS = 180000; // 3 min

let apercu = null; // 1re carte du dernier set appris, pour vérification à l'oeil

async function apprendreUnSet(idExpansion) {
    const cartes = await scraperListeExpansion(idExpansion);
    apercu = cartes[0] || null;
    if (cartes.length === 0) return 0;

    const operations = cartes.filter(c => c.idProduct).map(c => ({
        updateOne: {
            filter: { idProduct: c.idProduct },
            update: { $set: { ...c, idExpansion, apprisLe: new Date() } },
            upsert: true
        }
    }));
    await NumeroCarte.bulkWrite(operations, { ordered: false });

    const codeSet = cartes.find(c => c.codeSet)?.codeSet;
    if (codeSet) {
        await CodeSet.findOneAndUpdate({ idExpansion }, { idExpansion, codeSet, apprisLe: new Date() }, { upsert: true });
    }
    return operations.length;
}

async function main() {
    const args = process.argv.slice(2);
    const limite = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 5; // petit lot par défaut : mieux vaut plusieurs sessions courtes
    const inclurePetits = args.includes('--petits');
    const majAnciens = args.includes('--maj');

    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connecté.\n");

    // 1. Toutes les expansions du catalogue, avec leur taille
    const parExpansion = await CatalogueProduit.aggregate([
        { $group: { _id: '$idExpansion', taille: { $sum: 1 } } }
    ]);

    // 2. Celles déjà apprises. En mode --maj, on considère "à refaire" celles
    //    apprises AVANT l'ajout des champs nomFr/variante/slug (elles n'ont donc
    //    pas ces données) : mieux vaut les compléter maintenant qu'un jour où il
    //    faudrait tout re-scraper.
    let dejaApprises;
    if (majAnciens) {
        const completes = await NumeroCarte.distinct('idExpansion', { variante: { $exists: true } });
        dejaApprises = new Set(completes);
        const toutes = await NumeroCarte.distinct('idExpansion');
        const aCompleter = toutes.filter(e => !dejaApprises.has(e)).length;
        console.log(`🔄 Mode --maj : ${aCompleter} set(s) appris sans les nouveaux champs (nom FR, variante, slug) seront refaits.`);
    } else {
        dejaApprises = new Set(await NumeroCarte.distinct('idExpansion'));
    }

    // 3. Reste à faire : les plus gros sets d'abord (les plus utiles)
    let aFaire = parExpansion
        .filter(e => e._id && !dejaApprises.has(e._id))
        .filter(e => inclurePetits || e.taille >= 20) // les micro-sets sont rarement sur Vinted
        .sort((a, b) => b.taille - a.taille);

    const total = parExpansion.length;
    console.log(`📚 Progression : ${dejaApprises.size}/${total} expansions déjà apprises.`);
    console.log(`   Reste ${aFaire.length} à faire${inclurePetits ? '' : ' (hors micro-sets <20 cartes)'}.`);

    if (aFaire.length === 0) {
        console.log("\n🎉 Tout est déjà appris !");
        await fermerBrowser(); await mongoose.disconnect(); return;
    }

    const lot = aFaire.slice(0, limite);
    console.log(`   Cette session : ${lot.length} set(s).\n`);

    let totalCartes = 0, echecs = 0, faits = 0;

    for (const [i, e] of lot.entries()) {
        console.log(`--- [${i + 1}/${lot.length}] Expansion ${e._id} (~${e.taille} cartes) ---`);
        try {
            const n = await apprendreUnSet(e._id);
            if (n === 0) {
                echecs++;
                console.log(`   ⚠️ Rien récupéré (${echecs}/${MAX_ECHECS_CONSECUTIFS} échecs consécutifs).`);
                if (echecs >= MAX_ECHECS_CONSECUTIFS) {
                    console.log(`\n🚫 Plusieurs échecs d'affilée : Cloudflare bloque probablement.`);
                    console.log(`   On s'arrête là. Relance ce script plus tard (dans quelques heures),`);
                    console.log(`   il reprendra automatiquement où il s'est arrêté.`);
                    break;
                }
            } else {
                echecs = 0; faits++; totalCartes += n;
                console.log(`   ✅ ${n} cartes mémorisées.`);
                if (apercu) console.log(`      ex: ${apercu.idProduct} -> n°${apercu.numero} ${apercu.variante || ''} "${apercu.nomFr || '?'}"`);
            }
        } catch (err) {
            console.log(`   ❌ Erreur : ${err.message}`);
            echecs++;
            if (echecs >= MAX_ECHECS_CONSECUTIFS) break;
        }

        // Souffler entre deux sets (durée aléatoire) : c'est l'enchaînement soutenu
        // qui déclenche les bans, pas une page isolée.
        if (i < lot.length - 1) {
            const pause = PAUSE_ENTRE_SETS_MIN_MS + Math.random() * (PAUSE_ENTRE_SETS_MAX_MS - PAUSE_ENTRE_SETS_MIN_MS);
            console.log(`   💤 Pause ${(pause / 60000).toFixed(1)} min avant le set suivant...`);
            await new Promise(r => setTimeout(r, pause));
        }
    }

    const restant = aFaire.length - faits;
    console.log(`\n🎉 Session terminée : ${faits} set(s), ${totalCartes} cartes apprises.`);
    console.log(`   Progression totale : ${dejaApprises.size + faits}/${total} expansions.`);
    if (restant > 0) console.log(`   Il reste ${restant} set(s) — relance le script quand tu veux.`);

    await fermerBrowser();
    await mongoose.disconnect();
}

main().catch(async e => {
    console.error("❌ Erreur :", e.message);
    try { await fermerBrowser(); } catch (_) {}
    process.exit(1);
});