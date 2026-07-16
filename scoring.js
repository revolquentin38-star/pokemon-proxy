// ============================================================
// MODULE SCORING — départage plusieurs idProduct candidats
// ============================================================
// Combine 4 signaux (numéro, set, image, prix) pour trouver LE bon idProduct
// parmi plusieurs cartes de même nom. Aucun critère ne décide seul : c'est le
// score total qui tranche, ce qui rend le système robuste aux erreurs
// individuelles (IA qui lit mal, hash d'image imprécis, etc.).
//
// Ce module est PUR (pas d'appels réseau) : on lui passe les candidats déjà
// enrichis, il calcule les scores. Testable isolément (bloc en bas).

// ---- Poids des critères (ajustables) ----
const POIDS = {
    numero: 50,   // fort : "184" == "184"
    set: 40,      // fort : bon set (Destined Rivals)
    image: 25,    // moyen : ressemblance visuelle (max si distance=0)
    prix: 25,     // moyen : prix cohérent avec la rareté lue
    region: 45    // fort : la région (occidental/japonais) doit correspondre
};

const DISTANCE_IMAGE_MAX = 64; // hash 8x8 = 64 bits

/**
 * Note un candidat.
 * @param {object} candidat  { idProduct, idExpansion, numeroCardmarket, prix, distanceImage }
 * @param {object} lu        ce que l'IA/TCGdex ont lu : { numero, total, idExpansionAttendu, rareteElevee }
 * @returns {{score:number, detail:object}}
 */
function scorerCandidat(candidat, lu) {
    let score = 0;
    const detail = {};

    // 1. NUMÉRO : le numéro Cardmarket du candidat == numéro lu sur la carte ?
    //    Le poids dépend de la CERTITUDE du numéro : un numéro scrapé sur Cardmarket
    //    fait foi (50 pts), un numéro déduit de TCGdex (départagé par prix, ou set
    //    partagé JP/international) peut être faux -> il oriente sans écraser (25 pts).
    if (lu.numero != null && candidat.numeroCardmarket != null) {
        const norm = n => String(n).trim().toLowerCase().replace(/^0+/, '') || '0';
        const nCand = norm(candidat.numeroCardmarket);
        const nLu = norm(lu.numero);
        const fiable = candidat.certitudeNumero !== 'heuristique';
        const poids = fiable ? POIDS.numero : Math.round(POIDS.numero / 2);
        if (nCand === nLu) {
            score += poids;
            detail.numero = `+${poids} (match ${nLu}${fiable ? '' : ', numéro estimé'})`;
        } else {
            detail.numero = `0 (candidat ${nCand} ≠ lu ${nLu})`;
        }
    } else detail.numero = '0 (numéro manquant)';

    // 2. SET : le candidat est-il dans l'expansion attendue ?
    if (lu.idExpansionAttendu != null && candidat.idExpansion != null) {
        if (candidat.idExpansion === lu.idExpansionAttendu) { score += POIDS.set; detail.set = `+${POIDS.set} (bon set)`; }
        else detail.set = `0 (exp ${candidat.idExpansion} ≠ ${lu.idExpansionAttendu})`;
    } else detail.set = '0 (set non déterminé)';

    // 3. IMAGE : plus la distance de hash est faible, plus le bonus est élevé
    if (typeof candidat.distanceImage === 'number') {
        const bonus = Math.round(POIDS.image * (1 - candidat.distanceImage / DISTANCE_IMAGE_MAX));
        score += bonus; detail.image = `+${bonus} (distance ${candidat.distanceImage}/64)`;
    } else detail.image = '0 (pas d\'image)';

    // 4. PRIX cohérent avec la rareté lue :
    //    - si carte "secrète"/IR (numéro > total) attendue -> on favorise un prix ÉLEVÉ
    //    - sinon (carte normale) -> on favorise un prix BAS
    if (typeof candidat.prix === 'number') {
        const estCher = candidat.prix >= 3; // seuil simple : au-dessus de 3€ = probablement une carte "à valeur"
        if (lu.rareteElevee && estCher) { score += POIDS.prix; detail.prix = `+${POIDS.prix} (IR attendue, prix élevé ${candidat.prix}€)`; }
        else if (!lu.rareteElevee && !estCher) { score += POIDS.prix; detail.prix = `+${POIDS.prix} (carte normale, prix bas ${candidat.prix}€)`; }
        else detail.prix = `0 (prix ${candidat.prix}€ incohérent avec rareté lue)`;
    } else detail.prix = '0 (pas de prix)';

    // 5. RÉGION : occidental (FR/EN...) vs japonais. Gros malus si ça se contredit
    //    (évite de choisir l'édition japonaise pour une carte française).
    if (lu.regionAttendue && candidat.region) {
        if (candidat.region === lu.regionAttendue) { score += POIDS.region; detail.region = `+${POIDS.region} (${candidat.region})`; }
        else { score -= POIDS.region; detail.region = `-${POIDS.region} (candidat ${candidat.region} ≠ attendu ${lu.regionAttendue})`; }
    } else detail.region = '0 (région indéterminée)';

    return { score, detail };
}

/**
 * Classe tous les candidats et renvoie le meilleur + le niveau de confiance.
 * @returns {{gagnant, scores, confiant:boolean}}
 */
function choisirMeilleur(candidats, lu) {
    const scores = candidats.map(c => ({ candidat: c, ...scorerCandidat(c, lu) }));
    scores.sort((a, b) => b.score - a.score);

    const meilleur = scores[0];
    const second = scores[1];
    // Confiance haute si le meilleur devance nettement le 2e (écart >= 30 points)
    const confiant = !second || (meilleur.score - second.score) >= 30;

    return { gagnant: meilleur, scores, confiant };
}

module.exports = { scorerCandidat, choisirMeilleur, POIDS };

// ---- Test isolé ----
if (require.main === module) {
    console.log("=== TEST scoring sur le cas Cynthia's Roserade ===\n");

    // Ce que l'IA + TCGdex ont lu : carte 184/182 Destined Rivals -> IR (184 > 182)
    const lu = {
        numero: 184,
        total: 182,
        idExpansionAttendu: 6096, // Destined Rivals
        rareteElevee: 184 > 182   // true -> on attend un prix élevé
    };

    // Candidats (extraits réels de nos données)
    const candidats = [
        { idProduct: 826058, idExpansion: 6096, numeroCardmarket: 184, prix: 12.79, distanceImage: 23 }, // la vraie IR
        { idProduct: 825882, idExpansion: 6096, numeroCardmarket: 8,   prix: 0.10,  distanceImage: 30 }, // commune DRI
        { idProduct: 861964, idExpansion: 6413, numeroCardmarket: 139, prix: 30.00, distanceImage: 21 }, // IR d'un autre set
        { idProduct: 816658, idExpansion: 6037, numeroCardmarket: 5,   prix: 0.09,  distanceImage: 31 }, // jap commune
    ];

    const { gagnant, scores, confiant } = choisirMeilleur(candidats, lu);
    for (const s of scores) {
        console.log(`idProduct ${s.candidat.idProduct} : SCORE ${s.score}`);
        console.log(`   ${JSON.stringify(s.detail)}`);
    }
    console.log(`\n🏆 Gagnant : idProduct ${gagnant.candidat.idProduct} (score ${gagnant.score}) — confiance ${confiant ? 'HAUTE' : 'BASSE'}`);
    console.log(`   Attendu : 826058 (la vraie IR 184/182 à 12,79€)`);
}