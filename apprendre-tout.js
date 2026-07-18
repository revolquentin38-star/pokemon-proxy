// ============================================================
// APPRENDRE TOUT — apprentissage massif, par lots, reprenable
// ============================================================
// Parcourt les expansions du catalogue et apprend les numéros de leurs cartes.
// - SAUTE automatiquement les sets déjà appris (donc relançable à volonté)
// - Traite les plus gros sets d'abord (les vrais sets, pas les micro-promos)
// - S'ARRÊTE PROPREMENT si Cloudflare bloque : tu reprends plus tard, rien n'est perdu
//
// La logique (connexion, modèles, écriture) vit dans apprentissage-commun.js.
//
// USAGE :
//   node apprendre-tout.js             -> apprend 5 sets puis s'arrête
//   node apprendre-tout.js 30          -> apprend 30 sets
//   node apprendre-tout.js 30 --petits -> inclut aussi les sets de <20 cartes
//   node apprendre-tout.js 30 --maj    -> refait les sets appris avant les champs nomFr/variante/slug
//
// ⚠️ Le catalogue compte des centaines d'expansions. Lance plutôt 20-30 sets par
//    session, sur plusieurs jours : la base se complète progressivement et
//    définitivement.

const {
    NumeroCarte, CatalogueProduit,
    connecter, fermerProprement, installerArretPropre, apprendreUnSet,
} = require('./apprentissage-commun');

const MAX_ECHECS_CONSECUTIFS = 2;       // 2 sets vides d'affilée = probablement bloqué -> on arrête

// Pause entre deux SETS (en plus du délai entre pages), conservée telle quelle :
// c'est l'enchaînement soutenu qui pose problème, pas une page isolée.
const PAUSE_ENTRE_SETS_MIN_MS = 60000;  // 1 min
const PAUSE_ENTRE_SETS_MAX_MS = 180000; // 3 min

async function main() {
    const args = process.argv.slice(2);
    const limite = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 5; // petit lot par défaut
    const inclurePetits = args.includes('--petits');
    const majAnciens = args.includes('--maj');

    installerArretPropre();
    await connecter();
    console.log('');

    // 1. Toutes les expansions du catalogue, avec leur taille
    const parExpansion = await CatalogueProduit.aggregate([
        { $group: { _id: '$idExpansion', taille: { $sum: 1 } } }
    ]);

    // 2. Celles déjà apprises. En --maj, on considère "à refaire" celles apprises
    //    avant l'ajout des champs nomFr/variante/slug (elles ne les ont pas).
    let dejaApprises;
    if (majAnciens) {
        const completes = await NumeroCarte.distinct('idExpansion', { variante: { $exists: true } });
        dejaApprises = new Set(completes);
        const toutes = await NumeroCarte.distinct('idExpansion');
        const aCompleter = toutes.filter(e => !dejaApprises.has(e)).length;
        console.log(`🔄 Mode --maj : ${aCompleter} set(s) appris sans les nouveaux champs seront refaits.`);
    } else {
        dejaApprises = new Set(await NumeroCarte.distinct('idExpansion'));
    }

    // 3. Reste à faire : les plus gros sets d'abord (les plus utiles)
    const aFaire = parExpansion
        .filter(e => e._id && !dejaApprises.has(e._id))
        .filter(e => inclurePetits || e.taille >= 20)      // les micro-sets sont rarement sur Vinted
        .sort((a, b) => b.taille - a.taille);

    const total = parExpansion.length;
    console.log(`📚 Progression : ${dejaApprises.size}/${total} expansions déjà apprises.`);
    console.log(`   Reste ${aFaire.length} à faire${inclurePetits ? '' : ' (hors micro-sets <20 cartes)'}.`);

    if (aFaire.length === 0) {
        console.log('\n🎉 Tout est déjà appris !');
        await fermerProprement();
        return;
    }

    const lot = aFaire.slice(0, limite);
    console.log(`   Cette session : ${lot.length} set(s).\n`);

    let totalCartes = 0, echecs = 0, faits = 0;

    for (const [i, e] of lot.entries()) {
        console.log(`--- [${i + 1}/${lot.length}] Expansion ${e._id} (~${e.taille} cartes) ---`);
        try {
            const { n, apercu } = await apprendreUnSet(e._id);
            if (n === 0) {
                echecs++;
                console.log(`   ⚠️ Rien récupéré (${echecs}/${MAX_ECHECS_CONSECUTIFS} échecs consécutifs).`);
                if (echecs >= MAX_ECHECS_CONSECUTIFS) {
                    console.log('\n🚫 Plusieurs échecs d\'affilée — on s\'arrête là.');
                    console.log('   Relance ce script plus tard : il reprend automatiquement où il s\'est arrêté.');
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

        // Souffler entre deux sets (durée aléatoire), comportement inchangé
        if (i < lot.length - 1) {
            const pause = PAUSE_ENTRE_SETS_MIN_MS + Math.random() * (PAUSE_ENTRE_SETS_MAX_MS - PAUSE_ENTRE_SETS_MIN_MS);
            console.log(`   💤 Pause ${(pause / 60000).toFixed(1)} min avant le set suivant...`);
            await new Promise(r => setTimeout(r, pause));
        }
    }

    console.log(`\n🎉 Session terminée : ${faits} set(s), ${totalCartes} cartes apprises.`);
    console.log(`   Progression totale : ${dejaApprises.size + faits}/${total} expansions.`);
    const restant = aFaire.length - faits;
    if (restant > 0) console.log(`   Il reste ${restant} set(s) — relance le script quand tu veux.`);

    await fermerProprement();
}

main().catch(async e => {
    console.error('❌ Erreur :', e.message);
    await fermerProprement();
    process.exit(1);
});