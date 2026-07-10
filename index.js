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
        // 1. Analyse IA Optimisée (utilisation de gpt-4o-mini pour le coût et la vitesse)
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini", // Modèle très économique
            max_tokens: 150, // Fixe l'erreur 402
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon. Analyse l'image. Retourne UN JSON pur : {'nom': 'nom', 'numero': '123', 'set_id': 'code de set type sv3'}. Si set_id inconnu, mets null."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte. Titre Vinted: ${title}` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("IA a identifié :", dataIA);

        // 2. Recherche "Pro" : On utilise le Set ID et le Numéro (la méthode la plus fiable)
        let responseAPI;
        if (dataIA.set_id && dataIA.numero) {
            responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q: `set.id:${dataIA.set_id} number:${dataIA.numero}` }
            });
        }

        // 3. Fallback : Si aucune carte trouvée avec ID, on cherche par Nom + Numéro
        if (!responseAPI || responseAPI.data.data.length === 0) {
            responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q: `name:"${dataIA.nom}" number:${dataIA.numero}` }
            });
        }

        const foundCard = responseAPI.data.data[0];

        if (foundCard) {
            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    prix: foundCard.cardmarket?.prices?.averageSellPrice || "N/A"
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte non trouvée" });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});