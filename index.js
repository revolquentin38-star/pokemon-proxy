const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    if (!imageUrl) return res.status(400).json({ error: "Image manquante" });

    try {
        // 1. Analyse IA : On demande spécifiquement le nom du Set
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            max_tokens: 150,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon. Analyse l'image. Retourne un JSON pur : {'nom': 'nom exact', 'numero': 'numéro', 'set_nom': 'nom de l\'extension'}. Si le set est inconnu, mets 'null'."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte. Titre Vinted : ${title}. Identifie bien le nom du set/extension.` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("IA a identifié :", dataIA);

        // 2. Recherche API (Nom + Numéro)
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `name:"${dataIA.nom}" number:${dataIA.numero}` }
        });

        const results = responseAPI.data.data;
        if (!results || results.length === 0) {
            return res.status(404).json({ success: false, error: "Carte non trouvée" });
        }

        // 3. LOGIQUE DE SÉLECTION INTELLIGENTE
        // On cherche une carte dont le nom du set correspond à ce que l'IA a trouvé
        let foundCard = results.find(c => 
            c.set.name.toLowerCase().includes(dataIA.set_nom.toLowerCase())
        );

        // Si on n'a pas trouvé par le nom du set, on trie par prix pour prendre la version la plus probable (la plus chère)
        if (!foundCard) {
            console.log("Aucun match de set exact, tri par prix...");
            foundCard = results.sort((a, b) => 
                (b.cardmarket?.prices?.averageSellPrice || 0) - (a.cardmarket?.prices?.averageSellPrice || 0)
            )[0];
        }

        if (foundCard) {
            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    set: foundCard.set.name,
                    prix: foundCard.cardmarket?.prices?.averageSellPrice || "N/A"
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte introuvable après filtrage" });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});