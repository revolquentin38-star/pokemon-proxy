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

    try {
        // 1. Analyse visuelle par l'IA
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o",
            max_tokens: 300,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon. Analyse l'image et le titre fourni. Retourne TOUJOURS un objet JSON pur sans texte autour. Format: {'nom': 'nom exact', 'numero': 'juste le numéro', 'serie': 'nom de la série', 'langue': 'fr/en/jp'}"
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte. Titre Vinted: ${title}.` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        // 2. Sécurisation : Tentative de parsing
        const rawContent = completion.choices[0].message.content;
        let dataIA;
        
        try {
            dataIA = JSON.parse(rawContent);
        } catch (e) {
            throw new Error("L'IA n'a pas renvoyé un format JSON valide.");
        }

        // Vérification de sécurité : est-ce qu'on a bien un nom ?
        if (!dataIA || !dataIA.nom) {
            throw new Error("L'IA n'a pas réussi à identifier la carte.");
        }

        console.log("Données IA identifiées :", dataIA);

        // 3. Recherche API Pokémon (Requête flexible)
        // On cherche par nom + numéro pour être précis
        const query = `name:"${dataIA.nom}" number:${dataIA.numero}`;
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: query }
        });

        if (responseAPI.data.data && responseAPI.data.data.length > 0) {
            const card = responseAPI.data.data[0];
            const prix = card.cardmarket?.prices?.averageSellPrice || "N/A";

            res.json({
                success: true,
                data: {
                    nom: card.name,
                    numero: dataIA.numero,
                    serie: dataIA.serie, // La série identifiée par l'IA
                    prix: prix
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte trouvée par l'IA mais pas dans la base de données officielle." });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});