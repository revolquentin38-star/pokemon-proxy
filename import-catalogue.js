// Script d'import du catalogue produits Cardmarket dans MongoDB.
// À exécuter à la main quand tu as un nouveau fichier products_singles_*.json
// (ex: après un nouveau téléchargement depuis Cardmarket, pour rester à jour).
//
// Usage :
//   MONGODB_URI="ta_connection_string" node import-catalogue.js chemin/vers/products_singles_6.json
//
// (Remplace ta_connection_string par la même valeur que sur Render, ou laisse
// vide si tu as déjà un fichier .env avec MONGODB_URI dedans + `require('dotenv').config()`)

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const cheminFichier = process.argv[2];
if (!cheminFichier) {
    console.error("Usage : node import-catalogue.js chemin/vers/products_singles_6.json");
    process.exit(1);
}

const catalogueProduitSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    idExpansion: { type: Number, required: true },
    idMetacard: { type: Number, required: true },
});
catalogueProduitSchema.index({ name: 'text' });
catalogueProduitSchema.index({ idExpansion: 1 });
catalogueProduitSchema.index({ idMetacard: 1 });

const CatalogueProduit = mongoose.model('CatalogueProduit', catalogueProduitSchema, 'catalogue_produits');

async function main() {
    if (!process.env.MONGODB_URI) {
        console.error("MONGODB_URI n'est pas défini (variable d'environnement ou fichier .env).");
        process.exit(1);
    }

    console.log("Connexion à MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connecté.");

    console.log(`Lecture de ${cheminFichier}...`);
    const brut = fs.readFileSync(cheminFichier, 'utf-8');
    const data = JSON.parse(brut);
    const produits = data.products;
    console.log(`${produits.length} produits trouvés dans le fichier (créé le ${data.createdAt}).`);

    const TAILLE_LOT = 2000;
    let traites = 0;

    for (let i = 0; i < produits.length; i += TAILLE_LOT) {
        const lot = produits.slice(i, i + TAILLE_LOT);
        const operations = lot.map(p => ({
            updateOne: {
                filter: { idProduct: p.idProduct },
                update: {
                    $set: {
                        name: p.name,
                        idExpansion: p.idExpansion,
                        idMetacard: p.idMetacard
                    }
                },
                upsert: true
            }
        }));
        await CatalogueProduit.bulkWrite(operations, { ordered: false });
        traites += lot.length;
        console.log(`... ${traites}/${produits.length} importés`);
    }

    console.log("✅ Import terminé.");
    await mongoose.disconnect();
}

main().catch(err => {
    console.error("❌ Erreur import :", err);
    process.exit(1);
});
