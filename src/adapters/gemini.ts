import { StructuredLLMProvider } from '../core/lineage-tracer.js';

export class GeminiJSONProvider implements StructuredLLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gemini-2.5-flash'
  ) {}

  async generateJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('LLM boş yanıt döndürdü.');
    }

    return JSON.parse(rawText) as T;
  }
}
