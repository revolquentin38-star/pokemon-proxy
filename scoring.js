// ============================================================
// MODULE SCORING — départage plusieurs idProduct candidats
// ============================================================
// Combine des signaux (numéro, set, variante, image, prix, région) pour trouver
// LE bon idProduct parmi plusieurs cartes de même nom. Aucun critère ne décide
// seul : c'est le score total qui tranche, ce qui rend le système robuste aux
// erreurs individuelles (IA qui lit mal, hash d'image imprécis, etc.).
//
// Ce module est PUR (pas d'appels réseau) : on lui passe les candidats déjà
// enrichis, il calcule les scores. Testable isolément (bloc en bas).

// ---- Poids des critères (ajustables) ----
const POIDS = {
    numero: 50,    // fort : "184" == "184"
    set: 40,       // fort : bon set (Destined Rivals)
    variante: 35,  // fort : départage normale vs reverse À NUMÉRO ÉGAL
    image: 25,     // moyen : ressemblance visuelle (max si distance=0)
    prix: 25,      // moyen : prix cohérent avec la rareté lue
    region: 45     // fort : la région (occidental/japonais) doit correspondre
};

const DISTANCE_IMAGE_MAX = 64; // hash 8x8 = 64 bits

/**
 * Note un candidat.
 * @param {object} candidat  { idProduct, idExpansion, numeroCardmarket, variante, prix, distanceImage }
 * @param {object} lu        ce que l'IA/TCGdex ont lu : { numero, total, idExpansionAttendu, rareteElevee, varianteAttendue }
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
        // On compare sur la PREMIÈRE suite de chiffres, ce qui gère aussi bien les
        // préfixes de set (SWSH261 -> 261, TG06 -> 6, GG70 -> 70) que les suffixes
        // de réimpression (15A1 -> 15, le "A1" = Celebrations Classic Collection).
        // Le catalogue stocke "261" ou "15A1" ; l'IA lit "261" ou "15".
        const norm = n => { const m = String(n).match(/\d+/); return m ? String(parseInt(m[0], 10)) : '0'; };
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
    //    On accepte une LISTE : un set TCGdex peut correspondre à plusieurs
    //    expansions Cardmarket (édition internationale, japonaise, suppléments).
    //    Le setCode/stamp lu par l'IA affine ce critère : il confronte le code de
    //    set RÉEL du candidat à ce que l'IA a lu sur la carte. Cas typique : une
    //    réimpression (Celebrations, Trainer Gallery...) reprend un ancien numéro,
    //    TCGdex matche le set d'origine par le numéro -> sans le stamp, on choisit
    //    la mauvaise édition (au mauvais prix).
    const attendues = lu.idExpansionsAttendues || (lu.idExpansionAttendu != null ? [lu.idExpansionAttendu] : []);
    const normCode = c => c ? String(c).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    const codeIA = normCode(lu.setCode);
    const codeCand = normCode(candidat.codeSet);
    const codeMatch = codeIA && codeCand && codeIA === codeCand;       // stamp confirme ce candidat
    const codeContredit = codeIA && codeCand && codeIA !== codeCand;   // stamp contredit ce candidat
    if (attendues.length && candidat.idExpansion != null) {
        if (attendues.includes(candidat.idExpansion) && !codeContredit) {
            score += POIDS.set; detail.set = `+${POIDS.set} (bon set)`;
        } else if (attendues.includes(candidat.idExpansion) && codeContredit) {
            // Dans le set déduit par TCGdex, MAIS le code réel contredit le stamp lu
            // -> le set déduit est suspect ici : pas de bonus (sinon on fait gagner
            // la mauvaise édition qui partage juste le numéro).
            detail.set = `0 (dans le set TCGdex mais code ${candidat.codeSet} ≠ stamp lu ${lu.setCode})`;
        } else if (codeMatch) {
            // Hors du set TCGdex, MAIS son code réel == le stamp lu : c'est
            // probablement LUI le bon (réimpression que TCGdex ne relie pas).
            score += POIDS.set; detail.set = `+${POIDS.set} (code ${candidat.codeSet} = stamp lu)`;
        } else {
            detail.set = `0 (exp ${candidat.idExpansion} hors du set attendu)`;
        }
    } else if (codeMatch) {
        score += POIDS.set; detail.set = `+${POIDS.set} (code ${candidat.codeSet} = stamp lu)`;
    } else detail.set = '0 (set non déterminé)';

    // 3. VARIANTE (reverse vs normale) : DÉPARTAGE À NUMÉRO ÉGAL.
    //    Sur un set, une même carte a souvent 2-3 idProducts au MÊME numéro
    //    (normale=V1, reverse=V2, illustration=V3). Le critère numéro leur donne
    //    à tous +50 -> égalité. Ce critère les sépare, MAIS seulement quand deux
    //    conditions sont réunies :
    //      - l'IA a tranché (lu.varianteAttendue est défini, ex. 'V2' si reverse lue)
    //      - la variante du candidat est CONNUE en base (sets appris avec --maj)
    //    Sans l'une des deux (set "allégé", ou IA incertaine), il reste neutre :
    //    on ne pénalise jamais sur une donnée absente.
    if (lu.varianteAttendue && candidat.variante) {
        if (candidat.variante === lu.varianteAttendue) {
            score += POIDS.variante;
            detail.variante = `+${POIDS.variante} (${candidat.variante} = attendu)`;
        } else {
            score -= POIDS.variante;
            detail.variante = `-${POIDS.variante} (${candidat.variante} ≠ attendu ${lu.varianteAttendue})`;
        }
    } else detail.variante = '0 (variante indéterminée)';

    // 4. IMAGE : plus la distance de hash est faible, plus le bonus est élevé
    if (typeof candidat.distanceImage === 'number') {
        const bonus = Math.round(POIDS.image * (1 - candidat.distanceImage / DISTANCE_IMAGE_MAX));
        score += bonus; detail.image = `+${bonus} (distance ${candidat.distanceImage}/64)`;
    } else detail.image = '0 (pas d\'image)';

    // 5. PRIX cohérent avec la rareté lue :
    //    - si carte "secrète"/IR (numéro > total) attendue -> on favorise un prix ÉLEVÉ
    //    - sinon (carte normale) -> on favorise un prix BAS
    if (typeof candidat.prix === 'number') {
        const estCher = candidat.prix >= 3; // seuil simple : au-dessus de 3€ = probablement une carte "à valeur"
        if (lu.rareteElevee && estCher) { score += POIDS.prix; detail.prix = `+${POIDS.prix} (IR attendue, prix élevé ${candidat.prix}€)`; }
        else if (!lu.rareteElevee && !estCher) { score += POIDS.prix; detail.prix = `+${POIDS.prix} (carte normale, prix bas ${candidat.prix}€)`; }
        else detail.prix = `0 (prix ${candidat.prix}€ incohérent avec rareté lue)`;
    } else detail.prix = '0 (pas de prix)';

    // 6. RÉGION : occidental (FR/EN...) vs japonais. Gros malus si ça se contredit
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

// ---- Tests isolés ----
if (require.main === module) {
    let echecs = 0;
    const verifier = (nom, obtenu, attendu) => {
        const ok = obtenu === attendu;
        console.log(`${ok ? '✅' : '❌'} ${nom} : ${obtenu}${ok ? '' : ` (attendu ${attendu})`}`);
        if (!ok) echecs++;
    };

    // --- Test 1 : Cynthia's Roserade IR (184/182 Destined Rivals) ---
    console.log('=== Test 1 : secret rare (numéro > total) ===');
    {
        const lu = { numero: 184, total: 182, idExpansionAttendu: 6096, rareteElevee: true, regionAttendue: 'occidental' };
        const candidats = [
            { idProduct: 826058, idExpansion: 6096, numeroCardmarket: 184, prix: 12.79, region: 'occidental' }, // la vraie IR
            { idProduct: 825882, idExpansion: 6096, numeroCardmarket: 8,   prix: 0.10,  region: 'occidental' },
            { idProduct: 861964, idExpansion: 6413, numeroCardmarket: 139, prix: 30.00, region: 'occidental' },
            { idProduct: 816658, idExpansion: 6037, numeroCardmarket: 5,   prix: 0.09,  region: 'japonais' },
        ];
        const { gagnant } = choisirMeilleur(candidats, lu);
        verifier('gagnant', gagnant.candidat.idProduct, 826058);
    }

    // --- Test 2 : REVERSE à numéro égal (le cas Mentali OBF) ---
    // Trois produits au même n°086 : normale (V1), reverse (V2), spéciale (V3).
    // L'IA a lu une REVERSE -> varianteAttendue 'V2'. Sans ce critère, égalité à +50.
    console.log('\n=== Test 2 : reverse départagée à numéro égal ===');
    {
        const lu = { numero: 86, idExpansionsAttendues: [5385], rareteElevee: false, regionAttendue: 'occidental', varianteAttendue: 'V2' };
        const candidats = [
            { idProduct: 725166, idExpansion: 5385, numeroCardmarket: 86, variante: 'V1', prix: 0.50, region: 'occidental' }, // normale
            { idProduct: 727069, idExpansion: 5385, numeroCardmarket: 86, variante: 'V2', prix: 1.20, region: 'occidental' }, // reverse (attendue)
            { idProduct: 804328, idExpansion: 5385, numeroCardmarket: 86, variante: 'V3', prix: 4.00, region: 'occidental' }, // spéciale
        ];
        const { gagnant, confiant } = choisirMeilleur(candidats, lu);
        verifier('gagnant = reverse', gagnant.candidat.idProduct, 727069);
        verifier('confiance haute', confiant, true);
    }

    // --- Test 3 : set "allégé" (aucune variante connue) -> critère neutre, pas de régression ---
    console.log('\n=== Test 3 : variante inconnue -> neutre ===');
    {
        const lu = { numero: 86, idExpansionsAttendues: [5385], rareteElevee: false, regionAttendue: 'occidental', varianteAttendue: 'V2' };
        const candidats = [
            { idProduct: 725166, idExpansion: 5385, numeroCardmarket: 86, variante: null, prix: 0.50, region: 'occidental' },
            { idProduct: 727069, idExpansion: 5385, numeroCardmarket: 86, variante: null, prix: 1.20, region: 'occidental' },
        ];
        const { scores } = choisirMeilleur(candidats, lu);
        // Sans variante en base, les deux gardent le même score (numéro+set+région) : aucun malus injuste
        verifier('scores égaux (pas de malus sur donnée absente)', scores[0].score, scores[1].score);
    }

    // --- Test 4 : STAMP départage une réimpression (le cas Venusaur Celebrations) ---
    // Venusaur 15/102 existe en Base Set ET en Celebrations (même numéro). TCGdex
    // matche le Base Set par le numéro -> expansion attendue = celle du Base Set.
    // L'IA a lu le stamp "CEL". Le candidat Base Set (code "EXP") est dans le set
    // attendu MAIS son code contredit "CEL" -> il ne doit PAS rafler le bonus de set.
    console.log('\n=== Test 4 : stamp (réimpression Celebrations) ===');
    {
        const lu = { numero: 15, setCode: 'CEL', idExpansionsAttendues: [4169], rareteElevee: false, regionAttendue: 'occidental' };
        const baseSet = { idProduct: 557654, idExpansion: 4169, numeroCardmarket: 15, codeSet: 'EXP', prix: 60, region: 'occidental' };
        const { scores } = choisirMeilleur([baseSet], lu);
        const s = scores.find(x => x.candidat.idProduct === 557654);
        // le détail du set doit indiquer 0 (code contredit le stamp), pas +40
        verifier('Base Set (code≠stamp) ne prend PAS le bonus de set', /^0 /.test(s.detail.set), true);
    }

    // --- Test 5 : stamp CONFIRME un candidat hors du set TCGdex ---
    // La réimpression n'est pas dans le set TCGdex, mais son code appris == stamp lu.
    console.log('\n=== Test 5 : stamp confirme la réimpression ===');
    {
        const lu = { numero: 15, setCode: 'CEL', idExpansionsAttendues: [4169], rareteElevee: false, regionAttendue: 'occidental' };
        const candidats = [
            { idProduct: 557654, idExpansion: 4169, numeroCardmarket: 15, codeSet: 'EXP', prix: 60, region: 'occidental' }, // Base Set (contredit)
            { idProduct: 576773, idExpansion: 4347, numeroCardmarket: '15A1', codeSet: 'CEL', prix: 18, region: 'occidental' }, // Celebrations (code confirme)
        ];
        const { gagnant } = choisirMeilleur(candidats, lu);
        verifier('gagnant = Celebrations (stamp confirme)', gagnant.candidat.idProduct, 576773);
    }

    console.log(`\n${echecs === 0 ? '🎉 Tous les tests passent.' : `⚠️ ${echecs} test(s) en échec.`}`);
    process.exit(echecs === 0 ? 0 : 1);
}