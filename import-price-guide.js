// Script d'import du guide des prix Cardmarket dans MongoDB.
// Complète le catalogue produits déjà importé (jointure par idProduct).
//
// Usage (PowerShell, comme la dernière fois) :
//   $env:MONGODB_URI="ta_connection_string"
//   node import-price-guide.js price_guide_6.json

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const cheminFichier = process.argv[2];
if (!cheminFichier) {
    console.error("Usage : node import-price-guide.js chemin/vers/price_guide_6.json");
    process.exit(1);
}

const guidePrixSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    avg: Number,
    low: Number,
    trend: Number,
    avg1: Number,
    avg7: Number,
    avg30: Number,
    avgHolo: Number,
    lowHolo: Number,
    trendHolo: Number,
    avg1Holo: Number,
    avg7Holo: Number,
    avg30Holo: Number,
    majAt: { type: Date, default: Date.now }
});

const GuidePrix = mongoose.model('GuidePrix', guidePrixSchema, 'guide_prix');

async function main() {
    if (!process.env.MONGODB_URI) {
        console.error("MONGODB_URI n'est pas défini.");
        process.exit(1);
    }

    console.log("Connexion à MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connecté.");

    console.log(`Lecture de ${cheminFichier}...`);
    const brut = fs.readFileSync(cheminFichier, 'utf-8');
    const data = JSON.parse(brut);
    const guides = data.priceGuides;
    console.log(`${guides.length} prix trouvés dans le fichier (créé le ${data.createdAt}).`);

    const TAILLE_LOT = 2000;
    let traites = 0;

    for (let i = 0; i < guides.length; i += TAILLE_LOT) {
        const lot = guides.slice(i, i + TAILLE_LOT);
        const operations = lot.map(g => ({
            updateOne: {
                filter: { idProduct: g.idProduct },
                update: {
                    $set: {
                        avg: g.avg, low: g.low, trend: g.trend,
                        avg1: g.avg1, avg7: g.avg7, avg30: g.avg30,
                        avgHolo: g['avg-holo'], lowHolo: g['low-holo'], trendHolo: g['trend-holo'],
                        avg1Holo: g['avg1-holo'], avg7Holo: g['avg7-holo'], avg30Holo: g['avg30-holo'],
                        majAt: new Date()
                    }
                },
                upsert: true
            }
        }));
        await GuidePrix.bulkWrite(operations, { ordered: false });
        traites += lot.length;
        console.log(`... ${traites}/${guides.length} importés`);
    }

    console.log("✅ Import terminé.");
    await mongoose.disconnect();
}

main().catch(err => {
    console.error("❌ Erreur import :", err);
    process.exit(1);
});
