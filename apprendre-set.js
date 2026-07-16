// ============================================================
// APPRENDRE UN SET — mémorise le numéro de chaque carte d'une extension
// ============================================================
// Résout LE problème de fond : le catalogue Cardmarket ne contient pas les
// numéros de collection. Sans eux, impossible de savoir lequel des 18 candidats
// "M Kangaskhan EX" est le #79 -> le scoring classe au hasard.
//
// Ce script visite UNE FOIS la liste galerie d'une extension. Chaque vignette
// donne à la fois l'idProduct (dans l'URL de l'image) et le numéro (dans le
// titre "Nom (DRI 176)"). On stocke l'appariement en base : c'est acquis pour
// toujours, et le scoring devient précis sans aucune requête supplémentaire.
//
// USAGE :
//   node apprendre-set.js 6096                   (par idExpansion)
//   node apprendre-set.js Lost-Origin            (par slug, lu dans l'URL Cardmarket)
//   node apprendre-set.js Lost-Origin 6096 DRI   (plusieurs, mélangés)
//
// Le slug se lit directement dans l'URL du set sur Cardmarket :
//   cardmarket.com/en/Pokemon/Products/Singles/[Lost-Origin]?...
//
// ⚠️ Chaque set = quelques pages avec 8s de délai anti-ban. Ne lance pas 10 sets d'un coup.

require('dotenv').config();
const mongoose = require('mongoose');
const { scraperListeExpansion, fermerBrowser, setCacherFenetre } = require('./live-cardmarket');

// Pendant l'apprentissage, les défis Cloudflare sont fréquents : on garde la
// fenêtre VISIBLE pour pouvoir cocher sans avoir à la faire réapparaître.
setCacherFenetre(false);

const numeroCarteSchema = new mongoose.Schema({
    idProduct: { type: Number, required: true, unique: true },
    idExpansion: Number,
    numero: String,      // depuis le titre : gère "176" ET "TG06"
    numeroUrl: String,   // depuis l'URL, en secours
    codeSet: String,
    nomFr: String,       // nom français (pour matcher ce que l'IA lit sur une carte FR)
    variante: String,    // V1/V2/V3 : distingue normale / reverse / illustration rare
    slug: String,        // "Team-Rockets-Petrel-V1-DRI176" (URL directe de la fiche)
    slugSet: String,     // "Destined-Rivals"
    apprisLe: { type: Date, default: Date.now }
});
const NumeroCarte = mongoose.model('NumeroCarte', numeroCarteSchema, 'numeros_cartes');

const codeSetSchema = new mongoose.Schema({
    idExpansion: { type: Number, required: true, unique: true },
    codeSet: String,
    apprisLe: { type: Date, default: Date.now }
});
const CodeSet = mongoose.model('CodeSet', codeSetSchema, 'codes_set');

// Le catalogue sert à retrouver l'idExpansion quand on apprend par slug
const catalogueSchema = new mongoose.Schema({ idProduct: Number, idExpansion: Number });
const CatalogueProduit = mongoose.model('CatalogueProduit', catalogueSchema, 'catalogue_produits');

async function apprendre(identifiant) {
    console.log(`\n=== Apprentissage de "${identifiant}" ===`);
    const cartes = await scraperListeExpansion(identifiant);

    if (cartes.length === 0) {
        console.log(`⚠️ Aucune carte récupérée pour "${identifiant}" (slug erroné, Cloudflare, ou rate-limit ?).`);
        return 0;
    }

    // Si on a appris par slug, on retrouve l'idExpansion via le catalogue local
    let idExpansion = /^\d+$/.test(String(identifiant)) ? parseInt(identifiant, 10) : null;
    if (!idExpansion) {
        const ref = await CatalogueProduit.findOne({ idProduct: cartes[0].idProduct }).lean();
        idExpansion = ref?.idExpansion || null;
        console.log(idExpansion
            ? `ℹ️ idExpansion déduit du catalogue : ${idExpansion}`
            : `⚠️ idExpansion introuvable (produit absent du catalogue) — les numéros seront quand même mémorisés.`);
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

    // On mémorise aussi le code set au passage (bonus gratuit)
    const codeSet = cartes.find(c => c.codeSet)?.codeSet;
    if (codeSet && idExpansion) {
        await CodeSet.findOneAndUpdate(
            { idExpansion },
            { idExpansion, codeSet, apprisLe: new Date() },
            { upsert: true }
        );
        console.log(`🧠 Code set : ${idExpansion} -> ${codeSet}`);
    }

    console.log(`✅ ${operations.length} cartes mémorisées.`);
    cartes.slice(0, 3).forEach(c => console.log(`   ex: ${c.idProduct} -> n°${c.numero} ${c.variante || ''} "${c.nomFr || '?'}"`));
    return operations.length;
}

async function main() {
    // On accepte les nombres (idExpansion) ET les slugs (Lost-Origin)
    const cibles = process.argv.slice(2).filter(Boolean);
    if (cibles.length === 0) {
        console.error("Usage : node apprendre-set.js <idExpansion|slug> [autres...]");
        console.error("Exemples :");
        console.error("  node apprendre-set.js 6096");
        console.error("  node apprendre-set.js Lost-Origin");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connecté.");
    console.log("(Si Cloudflare demande la case, la fenêtre Chrome apparaîtra.)");

    let total = 0;
    for (const c of cibles) total += await apprendre(c);

    console.log(`\n🎉 Terminé : ${total} cartes apprises au total.`);
    await fermerBrowser();
    await mongoose.disconnect();
}

main().catch(async e => {
    console.error("❌ Erreur :", e.message);
    try { await fermerBrowser(); } catch (_) {}
    process.exit(1);
});