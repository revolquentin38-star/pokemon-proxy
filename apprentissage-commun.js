// ============================================================
// APPRENTISSAGE — module commun
// ============================================================
// Mutualise ce que apprendre-set.js et apprendre-tout.js dupliquaient : la
// connexion Mongo, les trois modèles, et la logique d'apprentissage d'un set.
// Résultat : modifier un schéma ou la logique d'écriture se fait désormais
// À UN SEUL ENDROIT, et les deux scripts ne sont plus que des enveloppes.

require('dotenv').config();
const mongoose = require('mongoose');
const { scraperListeExpansion, fermerBrowser, setCacherFenetre } = require('./live-cardmarket');

// Pendant l'apprentissage, les défis Cloudflare sont fréquents : on garde la
// fenêtre VISIBLE pour pouvoir cocher soi-même sans la faire réapparaître.
setCacherFenetre(false);

// --- Modèles ---------------------------------------------------------------
// Guardés (mongoose.models.X || ...) pour éviter une erreur si le module est
// requis plus d'une fois dans le même process.
const numeroCarteSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    idExpansion: Number,
    numero: String,      // depuis le titre : gère "176" ET "TG06"
    numeroUrl: String,   // depuis l'URL, en secours
    codeSet: String,
    nomFr: String,       // nom français (pour matcher ce que l'IA lit sur une carte FR)
    variante: String,    // V1/V2/V3 : normale / reverse / illustration rare
    slug: String,        // fiche directe, ex "Team-Rockets-Petrel-V1-DRI176"
    slugSet: String,     // ex "Destined-Rivals"
    apprisLe: { type: Date, default: Date.now }
});
const codeSetSchema = new mongoose.Schema({
    idExpansion: { type: Number, required: true, unique: true },
    codeSet: String,
    apprisLe: { type: Date, default: Date.now }
});
const catalogueSchema = new mongoose.Schema({ idProduct: Number, idExpansion: Number });

const NumeroCarte = mongoose.models.NumeroCarte
    || mongoose.model('NumeroCarte', numeroCarteSchema, 'numeros_cartes');
const CodeSet = mongoose.models.CodeSet
    || mongoose.model('CodeSet', codeSetSchema, 'codes_set');
const CatalogueProduit = mongoose.models.CatalogueProduit
    || mongoose.model('CatalogueProduit', catalogueSchema, 'catalogue_produits');

// --- Connexion / fermeture -------------------------------------------------
async function connecter() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connecté.');
}

let fermetureEnCours = false;
async function fermerProprement() {
    if (fermetureEnCours) return;      // idempotent : appelable sans risque plusieurs fois
    fermetureEnCours = true;
    try { await fermerBrowser(); } catch (_) {}
    try { await mongoose.disconnect(); } catch (_) {}
}

// Ctrl+C : on ferme le navigateur et la base avant de quitter, pour qu'une
// interruption manuelle ne laisse rien de suspendu. Les sets déjà écrits en base
// sont acquis — la reprise les sautera automatiquement au prochain lancement.
function installerArretPropre() {
    process.on('SIGINT', async () => {
        console.log('\n⏹️  Interruption demandée — fermeture propre...');
        await fermerProprement();
        process.exit(0);
    });
}

// --- Cœur : apprendre un set ----------------------------------------------
// identifiant : idExpansion (nombre) OU slug Cardmarket ("Lost-Origin").
// Renvoie { n, cartes, apercu, idExpansion, codeSet }. n = 0 si rien récupéré.
async function apprendreUnSet(identifiant) {
    const cartes = await scraperListeExpansion(identifiant);
    if (cartes.length === 0) {
        return { n: 0, cartes: [], apercu: null, idExpansion: null, codeSet: null };
    }

    // idExpansion : direct si numérique, sinon déduit du catalogue via la 1re carte
    let idExpansion = /^\d+$/.test(String(identifiant)) ? parseInt(identifiant, 10) : null;
    if (!idExpansion) {
        const ref = await CatalogueProduit.findOne({ idProduct: cartes[0].idProduct }).lean();
        idExpansion = ref?.idExpansion || null;
    }

    const operations = cartes
        .filter(c => c.idProduct)
        .map(c => ({
            updateOne: {
                filter: { idProduct: c.idProduct },
                update: { $set: { ...c, idExpansion, apprisLe: new Date() } },
                upsert: true
            }
        }));
    await NumeroCarte.bulkWrite(operations, { ordered: false });

    // Bonus gratuit : on mémorise le code set au passage
    const codeSet = cartes.find(c => c.codeSet)?.codeSet || null;
    if (codeSet && idExpansion) {
        await CodeSet.findOneAndUpdate(
            { idExpansion },
            { idExpansion, codeSet, apprisLe: new Date() },
            { upsert: true }
        );
    }

    return { n: operations.length, cartes, apercu: cartes[0], idExpansion, codeSet };
}

module.exports = {
    mongoose,
    NumeroCarte, CodeSet, CatalogueProduit,
    connecter, fermerProprement, installerArretPropre,
    apprendreUnSet,
};