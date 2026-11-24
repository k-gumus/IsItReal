import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineDeps } from '../config.js';
import { createServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/server ve dist/server için aynı: proje kökündeki public/
const publicDir = path.resolve(here, '../../public');

const forceDemo = process.argv.includes('--demo');
const deps = createEngineDeps(process.env, forceDemo);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';

const server = createServer({
  deps,
  publicDir,
  rateLimitPerMinute: Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '8', 10),
  log: (msg) => console.error(`[isitreal] ${msg}`),
});

server.listen(port, host, () => {
  const modeNote =
    deps.mode === 'demo'
      ? 'DEMO modu: kurgusal veriler kullanılıyor (gerçek tarama için .env içine TAVILY_API_KEY ve GEMINI_API_KEY ekleyin)'
      : 'CANLI mod: Tavily + Gemini' + (deps.factCheckProvider ? ' + Google Fact Check' : '');
  console.log(`\n  IsItReal hazır → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n  ${modeNote}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
