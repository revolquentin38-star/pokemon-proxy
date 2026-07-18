// ============================================================
// ÉTAT DU MAPPING — lecture seule
// ============================================================
// Dit où en est l'apprentissage des numéros de collection.
// N'ouvre AUCUN navigateur, ne scrape RIEN : ne fait que lire MongoDB.
//
// USAGE :
//   node etat-mapping.js

const {
    NumeroCarte, CodeSet, CatalogueProduit,
    connecter, fermerProprement,
} = require('./apprentissage-commun');

async function main() {
    await connecter();

    // Expansions présentes dans le catalogue (+ leur taille)
    const parExpansion = await CatalogueProduit.aggregate([
        { $group: { _id: '$idExpansion', taille: { $sum: 1 } } }
    ]);
    const totalExpansions = parExpansion.filter(e => e._id).length;

    // Ce qui est déjà appris
    const apprises = new Set(await NumeroCarte.distinct('idExpansion'));
    const totalCartes = await NumeroCarte.estimatedDocumentCount();
    const nbCodesSet = await CodeSet.estimatedDocumentCount();

    // Sets appris AVANT les champs nomFr/variante/slug (candidats à --maj)
    const completes = new Set(await NumeroCarte.distinct('idExpansion', { variante: { $exists: true } }));
    const aCompleter = [...apprises].filter(e => !completes.has(e)).length;

    // Reste à faire, hors micro-sets (<20 cartes), gros sets d'abord — même règle
    // que apprendre-tout, pour que la liste ci-dessous corresponde à ce qu'il ferait.
    const reste = parExpansion
        .filter(e => e._id && !apprises.has(e._id))
        .filter(e => e.taille >= 20)
        .sort((a, b) => b.taille - a.taille);

    const pourcent = totalExpansions ? Math.round((apprises.size / totalExpansions) * 100) : 0;

    console.log('\n========== ÉTAT DU MAPPING ==========');
    console.log(`Expansions apprises : ${apprises.size}/${totalExpansions}  (${pourcent}%)`);
    console.log(`Cartes mémorisées   : ${totalCartes}`);
    console.log(`Codes set connus    : ${nbCodesSet}`);
    if (aCompleter > 0) console.log(`À recompléter (--maj): ${aCompleter} set(s) sans nomFr/variante/slug`);
    console.log(`Reste à apprendre   : ${reste.length} set(s) (hors micro-sets <20 cartes)`);
    if (reste.length > 0) {
        console.log('\nProchains sets (les plus gros d\'abord) :');
        reste.slice(0, 10).forEach(e => console.log(`   Expansion ${e._id} — ~${e.taille} cartes`));
        if (reste.length > 10) console.log(`   ... et ${reste.length - 10} autre(s).`);
    } else {
        console.log('\n🎉 Plus rien à apprendre (hors micro-sets).');
    }
    console.log('=====================================\n');

    await fermerProprement();
}

main().catch(async e => {
    console.error('❌ Erreur :', e.message);
    await fermerProprement();
    process.exit(1);
});