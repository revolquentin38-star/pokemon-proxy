const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios'); // Assure-toi d'avoir axios d'installé

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Configuration stricte pour OpenRouter
const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    try {
        // 1. Identification de la carte via l'IA Vision (OpenRouter)
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o", // Le modèle exact attendu par OpenRouter
            max_tokens: 150,        // <-- AJOUT : Limite la longueur pour éviter l'erreur 402 de crédits
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Identifie cette carte Pokémon. Titre Vinted : ${title}. Retourne UNIQUEMENT un objet JSON avec ce format exact : {"nom": "nom exact du pokemon en anglais", "numero": "numero/total"}` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("Données de l'IA reçues :", dataIA);

        // 2. Recherche du prix sur l'API Pokémon TCG
        const url = `https://api.pokemontcg.io/v2/cards?q=name:"${dataIA.nom}" number:${dataIA.numero}`;
        const responseAPI = await axios.get(url);

        if (responseAPI.data.data && responseAPI.data.data.length > 0) {
            const card = responseAPI.data.data[0];
            
            // On vérifie si Cardmarket donne un prix, sinon on indique que ce n'est pas disponible
            const prix = card.cardmarket && card.cardmarket.prices ? card.cardmarket.prices.averageSellPrice : "N/A";

            res.json({
                success: true,
                data: {
                    nom: card.name,
                    numero: dataIA.numero,
                    prix: prix
                }
            });
        } else {
            res.status(404).json({
                success: false,
                error: `Carte ${dataIA.nom} (${dataIA.numero}) introuvable sur la base de données.`
            });
        }

    } catch (error) {
        console.error("Erreur serveur :", error);
        // On renvoie l'erreur détaillée pour l'afficher dans Chrome si OpenRouter bloque
        res.status(500).json({ 
            success: false, 
            error: error.message || "Erreur interne du serveur lors de l'analyse." 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Le serveur écoute sur le port ${PORT}`);
});