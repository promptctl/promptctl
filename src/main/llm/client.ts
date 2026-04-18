// [LAW:single-enforcer] All LLM calls go through here.
import OpenAI from "openai";
import { loadSettings } from "../settings/store";

let client: OpenAI | null = null;
let lastKey = "";

async function getClient(): Promise<OpenAI> {
  const settings = await loadSettings();
  if (!settings.openaiApiKey) {
    throw new Error("OpenAI API key not configured. Set it in Settings.");
  }
  // Recreate client if key changed
  if (!client || settings.openaiApiKey !== lastKey) {
    client = new OpenAI({ apiKey: settings.openaiApiKey });
    lastKey = settings.openaiApiKey;
  }
  return client;
}

export async function chatComplete(
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const settings = await loadSettings();
  const openai = await getClient();
  const response = await openai.chat.completions.create(
    {
      model: settings.openaiModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
    },
    // The OpenAI SDK forwards `signal` to fetch so abort actually cancels the HTTP
    // call — no dangling network work after the user hits Cancel.
    signal ? { signal } : undefined,
  );
  return response.choices[0]?.message?.content ?? "";
}
