import type { LLMCallOptions, StructuredLLMProvider } from '../core/providers.js';
import { extractJson } from '../core/validation.js';
import { fetchWithRetry, ProviderError, type RetryOptions } from './http.js';

/**
 * Not: `gemini-2.5-flash` artık yalnızca daha önce kullanmış hesaplara açık;
 * yeni projeler için Google 3.x Flash ailesini öneriyor. Model GEMINI_MODEL ile değiştirilebilir.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export class GeminiJSONProvider implements StructuredLLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_GEMINI_MODEL,
    private readonly options: RetryOptions = {}
  ) {
    if (!apiKey) throw new ProviderError('Gemini', 'API anahtarı eksik');
    if (!/^[\w.-]+$/.test(model)) throw new ProviderError('Gemini', `Geçersiz model adı: ${model}`);
  }

  async generateJSON(systemPrompt: string, userPrompt: string, _options?: LLMCallOptions): Promise<unknown> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const response = await fetchWithRetry(
      'Gemini',
      endpoint,
      {
        method: 'POST',
        // Anahtar URL yerine başlıkta: log ve hata mesajlarına sızmaz
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
      },
      { timeoutMs: 45_000, ...this.options }
    );

    const data = (await response.json()) as {
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };

    if (data.promptFeedback?.blockReason) {
      throw new ProviderError('Gemini', `İstek güvenlik filtresine takıldı (${data.promptFeedback.blockReason})`);
    }

    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text.trim()) {
      throw new ProviderError('Gemini', `Boş yanıt (finishReason: ${data.candidates?.[0]?.finishReason ?? 'yok'})`);
    }
    return extractJson(text);
  }
}
