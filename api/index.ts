import dotenv from "dotenv";

dotenv.config({
	path: ".env",
});

import { GoogleGenAI } from "@google/genai";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { Pool } from "pg";

export const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	host: process.env.PGHOST,
	user: process.env.PGUSER,
	database: process.env.PGDATABASE,
	password: process.env.PGPASSWORD,
	port: 5432,
	query_timeout: 20000,
	idle_in_transaction_session_timeout: 20000,
	keepAlive: true,
	ssl: {
		rejectUnauthorized: false,
	},
});

export const ai = new GoogleGenAI({
	apiKey: `${process.env.GEMINI_API_KEY}`,
});

export async function cleanDatabase(
	expeditionNumber: string,
	destinationNumber: string,
	timestampStart: string,
	timestampEnd: string,
) {
	try {
		const client = await pool.connect();
		await client.query(
			"DELETE FROM messages WHERE (expedition_number = $1 AND destination_number = $2 OR expedition_number = $2 AND destination_number = $1) AND timestamp > $3 AND timestamp < $4",
			[expeditionNumber, destinationNumber, timestampStart, timestampEnd],
		);
		client.release();
	} catch {
		console.error("Les messages n'ont pas pu être supprimés");
	}
}

export async function saveMessage(
	message: string,
	author: string,
	expeditionNumber: string,
	destinationNumber: string,
) {
	try {
		const timestamp = `${Date.now()}`;
		const client = await pool.connect();
		await client.query(
			"INSERT INTO messages (message, author, expedition_number, destination_number, timestamp) VALUES ($1, $2, $3, $4, $5)",
			[message, author, expeditionNumber, destinationNumber, timestamp],
		);
		client.release();
	} catch {
		console.error("Le message n'a pas pu être traité");
	}
}

export async function getMessages(
	expeditionNumber: string,
	destinationNumber: string,
) {
	try {
		const client = await pool.connect();
		const messages = await client.query(
			"SELECT * FROM messages WHERE expedition_number = $1 AND destination_number = $2 OR expedition_number = $2 AND destination_number = $1 ORDER BY timestamp ASC",
			[expeditionNumber, destinationNumber],
		);
		client.release();
		return messages.rows;
	} catch {
		console.error("Les messages n'ont pas pu être récupérés");
	}
}

export async function sendSummary(
	expeditionNumber: string,
	destinationNumber: string,
	fromMe: boolean,
) {
	try {
		const rows = await getMessages(expeditionNumber, destinationNumber);
		const debut = new Date(parseInt(rows?.at(0).timestamp, 10)).toLocaleString(
			"fr-FR",
		);
		const fin = new Date(parseInt(rows?.at(-1).timestamp, 10)).toLocaleString(
			"fr-FR",
		);

		const summary = await summarizeMessages(rows);

		const data = new URLSearchParams();
		data.append("to", fromMe ? destinationNumber : expeditionNumber);
		data.append("token", `${process.env.ULTRAMSG_TOKEN}`);
		data.append(
			"body",
			`*_Résumé des messages de WhatsApp_*
*De*: ${debut}
*À*: ${fin}
*Nombre de messages*: ${rows?.length}

${summary}
`,
		);

		await fetch(
			`https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE_ID}/messages/chat`,
			{
				headers: {
					"content-type": "application/x-www-form-urlencoded",
				},
				method: "POST",
				body: data,
			},
		);

		cleanDatabase(
			expeditionNumber,
			destinationNumber,
			rows?.at(0).timestamp,
			rows?.at(-1).timestamp,
		);
	} catch {
		console.error("Erreur lors de la génération du résumé de la discussion");
	}
}

export async function summarizeMessages(messages: any) {
	let _contenu = "";
	for (const message of messages) {
		_contenu += `

Numéro: ${message.expeditionNumber}
Nom: ${message.author}
Date et Heure: ${new Date(parseInt(message.timestamp, 10).toLocaleString("fr-FR"))}
Contenu: ${message.message}
----------`;
	}
	const response = await ai.models.generateContent({
		model: "gemini-2.5-flash-lite",
		contents: "Explications",
		config: {
			temperature: 0,
			topK: 0,
			topP: 0,
			systemInstruction: `Tous les messages proviennent d'une discussion WhatsApp. Fais un résumé clair et concis en langue française. Voici le format des messages:
Numéro: {numéro_whatsapp_de_l'expéditeur}
Nom: {nom_whatsapp_de_l'expéditeur}
Date et Heure: {date_et_heure_du_message}
Contenu: {message_whatsapp_envoyé_par_l'expéditeur}
----------`,
		},
	});

	return convertToWhatsappMarkdown(response.text);
}

function convertToWhatsappMarkdown(markdownText: string | undefined) {
	if (!markdownText) return "";
	const boldRegex = /\*\*([^*]+)\*\*/g;
	const italicRegex = /__([^_]+)__/g;
	const strikethroughRegex = /~~([^~]+)~~/g;
	const monospaceRegex = /`([^`]+)`/g;
	const lineBreakRegex = /\s\s\n/g;

	let whatsappText = markdownText.replace(boldRegex, "*$1*");
	whatsappText = whatsappText.replace(italicRegex, "_$1_");
	whatsappText = whatsappText.replace(strikethroughRegex, "~$1~");
	whatsappText = whatsappText.replace(monospaceRegex, "```$1```");
	whatsappText = whatsappText.replace(lineBreakRegex, "\n");

	return whatsappText;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);

// Serves as a webhook.
// Receive data from ultramsg API
app.post("/whatsapp-webhook", async (req: Request, res: Response) => {
	const message = req.body;
	// Check if secret message is being sent
	if (req.headers["content-type"] === "application/json") {
		const body = `${message.data.body}`;
		if (body === "{{# summarize #}}") {
			await sendSummary(
				message.data.from,
				message.data.to,
				message.data.fromMe,
			);
		}
		// Types of messages to ignore
		else if (
			body.startsWith("*_Résumé des messages de WhatsApp_*") ||
			`${message.from}`.endsWith("@newsletter")
		) {
		} else {
			await saveMessage(
				body,
				message.data.pushname,
				message.data.from,
				message.data.to,
			);
		}
	}
	res.end();
});

app.listen(8000, () => {
	console.log("Server is active and listening on port 8000");
});

export default app;
