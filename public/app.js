// IsItReal istemcisi: sunucudan gelen akışı okur, kaynak katmanlarını çizer.
// Tüm dış veriler (başlıklar, özetler, URL'ler) yalnızca textContent ile yazılır; innerHTML kullanılmaz.

const VERDICTS = {
  SUPPORTED: { name: 'Doğrulandı', summary: 'İddia birincil bir kaynakla destekleniyor.' },
  CONTRADICTED: { name: 'Yanlış', summary: 'Güvenilir kaynaklar iddiayı çürütüyor.' },
  MISLEADING_CONTEXT: { name: 'Bağlamından koparılmış', summary: 'Bilgi gerçek olabilir ama eski, başka bir yere ait ya da çarpıtılmış.' },
  NOT_ENOUGH_EVIDENCE: { name: 'Kanıt yetersiz', summary: 'İddianın dayandığı birincil kaynağa ulaşılamadı.' },
  CIRCULAR_ECHO_CHAMBER: { name: 'Yankı odası', summary: 'Siteler aynı metni birbirinden kopyalıyor; arkasında birincil bir belge yok.' },
  OUTDATED: { name: 'Güncelliğini yitirmiş', summary: 'Bir zamanlar doğruydu ama güncel veriler değişmiş.' },
};

const STOP_REASONS = {
  TERMINAL_PROOF_REACHED: 'Kök kanıta ulaşıldı',
  IFCN_FACTCHECK_MATCH: 'Bir teyit kuruluşunun kaydı bulundu',
  MAX_DEPTH_EXCEEDED: 'İz azami derinliğe ulaştı',
  CYCLE_DETECTED: 'Kaynaklar kendi içinde dönüyor',
  NO_CITATION_POINTER: 'Haberler somut bir kaynağa atıf yapmıyor',
  NO_RESULTS: 'Arama sonuç döndürmedi',
};

const SIGNALS = {
  EMOTIONAL_TRIGGER: 'Duygusal tetikleyici',
  ANONYMOUS_AUTHORITY: 'İsimsiz otorite',
  ABSOLUTE_CERTAINTY: 'Kanıtsız kesinlik',
  CHERRY_PICKING: 'Seçici veri',
  CLICKBAIT_GAP: 'Tık tuzağı',
};

const TIERS = ['TIER_4_SOCIAL_UNVERIFIED', 'TIER_3_SECONDARY_AGGREGATOR', 'TIER_2_WIRE_JOURNALISM', 'TIER_1_TERMINAL_PROOF'];
const MAX_LEN = 4000;

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form'), text: $('text'), count: $('count'), submit: $('submit'), cancel: $('cancel'), formError: $('form-error'),
  progress: $('progress'), log: $('log'), report: $('report'), verdict: $('verdict'), claims: $('claims'),
  signals: $('signals'), marked: $('marked'), signalList: $('signal-list'), tipList: $('tip-list'), notes: $('notes'), noteList: $('note-list'),
};

let controller = null;
const liveClaims = new Map(); // claimId → { article, figure, count }

// ---------- yardımcılar ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const pct = (x) => `%${Math.round((Number(x) || 0) * 100)}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} sn`;

function updateCount() {
  const n = els.text.value.length;
  els.count.textContent = `${n} / ${MAX_LEN}`;
  els.count.toggleAttribute('data-over', n > MAX_LEN);
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = !message;
}

function setRunning(running) {
  els.submit.disabled = running;
  els.submit.textContent = running ? 'İzleniyor…' : 'Kaynağını izle';
  els.cancel.hidden = !running;
  els.progress.toggleAttribute('data-running', running);
}

function logLine(kind, ...parts) {
  const li = el('li', { 'data-kind': kind });
  for (const p of parts) li.append(typeof p === 'string' ? document.createTextNode(p) : p);
  els.log.append(li);
}

// ---------- kaynak kartları ----------
function sourceCard(node, number, { isNew = false, asLink = true } = {}) {
  const href = asLink ? safeHref(node.url) : null;
  const card = el(href ? 'a' : 'div', {
    class: `src${isNew ? ' is-new' : ''}`,
    href,
    target: href ? '_blank' : null,
    rel: href ? 'noopener noreferrer nofollow' : null,
    'data-node-id': node.id,
  });
  const top = el('span', { class: 'src-top' }, el('span', { class: 'src-domain', text: node.domain }));
  if (number) top.append(el('span', { class: 'src-num', text: `Kanıt ${number}` }));
  card.append(top, el('span', { class: 'src-title', text: node.title || node.snippet || node.url }));
  if (node.origin === 'factcheck') card.append(el('span', { class: 'src-hop', text: 'Teyit kuruluşu kaydı' }));
  else if (node.hopDepth > 0) card.append(el('span', { class: 'src-hop', text: node.citationPointer ? `İz: ${node.citationPointer}` : `${node.hopDepth}. adımda bulundu` }));
  card.title = node.snippet || node.title || '';
  return card;
}

function stratumOf(figure, tier) {
  return figure.querySelector(`.stratum[data-tier="${tier}"] .stratum-nodes`);
}

function markEmptyStrata(figure) {
  for (const tier of TIERS) {
    const box = stratumOf(figure, tier);
    if (box.children.length > 0) continue;
    const msg = tier === 'TIER_1_TERMINAL_PROOF' ? 'Kök kanıt bulunamadı' : 'Bu katmanda kaynak yok';
    box.append(el('p', { class: 'stratum-empty', text: msg }));
  }
}

function clearEmpty(box) {
  box.querySelector('.stratum-empty')?.remove();
}

// ---------- soy ağacı çizgileri ----------
function drawEdges(figure, claim) {
  const svg = figure.querySelector('.edges');
  svg.replaceChildren();
  const box = figure.getBoundingClientRect();
  if (box.width === 0) return;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);

  const anchorFor = (id) => {
    const target = figure.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    if (!target) return null;
    // Kapalı bir kopya yığınının içindeyse yığının üst kartına bağla
    const pile = target.closest('details.pile');
    if (pile && !pile.open) return pile.querySelector('summary .src');
    return target;
  };

  for (const edge of claim.edges) {
    if (edge.relation !== 'CITES_PRIMARY' && edge.relation !== 'SUPPORTS') continue;
    const from = anchorFor(edge.fromNodeId);
    const to = anchorFor(edge.toNodeId);
    if (!from || !to || from === to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - box.left;
    const y1 = a.bottom - box.top;
    const x2 = b.left + b.width / 2 - box.left;
    const y2 = b.top - box.top;
    const bend = Math.max(24, (y2 - y1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
    path.setAttribute('class', edge.relation === 'CITES_PRIMARY' ? 'cites' : 'supports');
    svg.append(path);
  }
}

// ---------- iddia makalesi ----------
function createClaimArticle(claimText) {
  const article = document.getElementById('tpl-claim').content.firstElementChild.cloneNode(true);
  article.querySelector('.claim-text').textContent = claimText;
  article.querySelector('.claim-verdict-name').textContent = 'İzleniyor…';
  return article;
}

function setClaimVerdict(article, verdict, confidence) {
  article.dataset.verdict = verdict;
  article.querySelector('.claim-verdict-name').textContent = VERDICTS[verdict]?.name ?? verdict;
  article.querySelector('.claim-confidence').textContent = confidence != null ? `${pct(confidence)} güven` : '';
}

function renderClaim(claim) {
  const article = createClaimArticle(claim.claimText);
  setClaimVerdict(article, claim.verdict, claim.confidence);
  article.querySelector('.claim-reasoning').textContent = claim.reasoning;

  const guard = article.querySelector('.claim-guard');
  if (claim.guardrailNote) {
    guard.textContent = `Denetim notu: ${claim.guardrailNote}`;
    guard.hidden = false;
  }

  const independent = claim.uniqueClusterCount;
  article.querySelector('.claim-stop').textContent =
    `${STOP_REASONS[claim.stopReason] ?? claim.stopReason}. ${claim.rawResultCount} kaynak, ${independent} bağımsız metin.`;

  const figure = article.querySelector('.strata');
  const numberOf = new Map(claim.nodes.map((n, i) => [n.id, i + 1]));

  // Kümelere göre grupla: birden fazla üyesi olan küme, temsilcinin katmanında "kopya yığını" olur
  const clusters = new Map();
  for (const node of claim.nodes) {
    const key = node.clusterId ?? node.id;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(node);
  }

  for (const members of clusters.values()) {
    const rep = members.find((n) => n.isClusterRepresentative) ?? members[0];
    const box = stratumOf(figure, rep.tier);
    if (members.length === 1) {
      box.append(sourceCard(rep, numberOf.get(rep.id)));
      continue;
    }
    const others = members.filter((n) => n !== rep);
    const summary = el('summary', {},
      // Yığının üst kartı bağlantı değil: tıklanınca yığın açılır, bağlantılar listede
      sourceCard(rep, numberOf.get(rep.id), { asLink: false }),
      el('span', { class: 'pile-count', text: `${members.length} site, aynı metin` }));
    const list = el('ul', { class: 'pile-list' });
    for (const n of [rep, ...others]) list.append(el('li', {}, sourceCard(n, numberOf.get(n.id))));
    const pile = el('details', { class: 'pile' }, summary, list);
    pile.addEventListener('toggle', () => {
      summary.querySelector('.pile-count').textContent = `${members.length} site, aynı metin${pile.open ? ' (kapat)' : ''}`;
      drawEdges(figure, claim);
    });
    box.append(pile);
  }

  markEmptyStrata(figure);
  requestAnimationFrame(() => drawEdges(figure, claim));
  new ResizeObserver(() => drawEdges(figure, claim)).observe(figure);
  return article;
}

// ---------- manipülasyon işaretleri ----------
function highlightSignals(input, signals) {
  const lower = input.toLocaleLowerCase('tr-TR');
  const ranges = [];
  for (const s of signals) {
    const needle = (s.excerpt || '').replace(/^[…."“”'\s]+|[…."“”'\s]+$/g, '');
    if (needle.length < 2) continue;
    const at = lower.indexOf(needle.toLocaleLowerCase('tr-TR'));
    if (at === -1) continue;
    const range = { start: at, end: at + needle.length, type: s.type };
    if (!ranges.some((r) => range.start < r.end && r.start < range.end)) ranges.push(range);
  }
  ranges.sort((a, b) => a.start - b.start);

  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const r of ranges) {
    frag.append(document.createTextNode(input.slice(cursor, r.start)));
    frag.append(el('mark', { 'data-signal': r.type, title: SIGNALS[r.type], text: input.slice(r.start, r.end) }));
    cursor = r.end;
  }
  frag.append(document.createTextNode(input.slice(cursor)));
  return frag;
}

// ---------- rapor ----------
function renderReport(report) {
  const v = VERDICTS[report.overallVerdict] ?? { name: report.overallVerdict, summary: '' };
  els.verdict.dataset.verdict = report.overallVerdict;
  $('verdict-title').textContent = v.name;
  $('verdict-summary').textContent = v.summary;
  $('score').textContent = `${report.literacyScore} / 100`;
  $('scale-marker').style.left = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => ($('scale-marker').style.left = `${report.literacyScore}%`)));

  const sources = report.claims.reduce((n, c) => n + c.rawResultCount, 0);
  const meta = [`${report.claims.length} iddia`, `${sources} kaynak tarandı`, seconds(report.durationMs)];
  if (report.cached) meta.push('son 10 dakikadaki aynı sorgudan');
  $('verdict-meta').textContent = `${meta.join(', ')}.`;
  els.verdict.hidden = false;

  els.claims.replaceChildren(...report.claims.map(renderClaim));
  liveClaims.clear();

  els.signals.hidden = report.manipulationSignals.length === 0;
  els.marked.replaceChildren(highlightSignals(report.originalInput, report.manipulationSignals));
  els.signalList.replaceChildren(
    ...report.manipulationSignals.map((s) =>
      el('div', { 'data-signal': s.type },
        el('dt', { text: SIGNALS[s.type] ?? s.type }),
        el('dd', {}, s.excerpt ? el('q', { text: s.excerpt.replace(/^…|…$/g, '') }) : null, document.createTextNode(s.excerpt ? ` ${s.explanation}` : s.explanation)))
    )
  );

  els.tipList.replaceChildren(...report.lateralReadingTips.map((t) => el('li', { text: t })));
  $('tips').hidden = report.lateralReadingTips.length === 0;

  els.notes.hidden = report.warnings.length === 0;
  els.noteList.replaceChildren(...report.warnings.map((w) => el('li', { text: w })));
  els.report.hidden = false;
}

// ---------- canlı akış ----------
function handleProgress(e) {
  switch (e.type) {
    case 'stage':
      if (e.stage !== 'done') logLine('stage', e.message);
      break;
    case 'claims': {
      logLine('info', `${e.claims.length} doğrulanabilir iddia bulundu.`);
      els.report.hidden = false;
      els.verdict.hidden = true;
      els.signals.hidden = true;
      els.notes.hidden = true;
      els.tipList.replaceChildren();
      $('tips').hidden = true;
      const articles = e.claims.map(({ claimId, claimText }) => {
        const article = createClaimArticle(claimText);
        liveClaims.set(claimId, { article, figure: article.querySelector('.strata'), count: 0 });
        return article;
      });
      els.claims.replaceChildren(...articles);
      break;
    }
    case 'search':
      logLine('search', e.hop === 0 ? 'Aranıyor: ' : `${e.hop}. adım, birincil kaynak aranıyor: `, el('q', { text: e.query }));
      break;
    case 'pointer':
      logLine('pointer', 'Haberlerin dayandığı kaynak: ', el('q', { text: e.pointer }));
      break;
    case 'evidence': {
      const live = liveClaims.get(e.claimId);
      if (!live) break;
      const box = stratumOf(live.figure, e.node.tier);
      clearEmpty(box);
      live.count++;
      box.append(sourceCard(e.node, null, { isNew: true }));
      break;
    }
    case 'claim-done': {
      const live = liveClaims.get(e.claimId);
      if (live) setClaimVerdict(live.article, e.verdict, e.confidence);
      break;
    }
  }
}

async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) onEvent(event, JSON.parse(data.join('\n')));
    }
  }
}

async function run(text) {
  controller?.abort();
  controller = new AbortController();
  showFormError('');
  setRunning(true);
  els.log.replaceChildren();
  els.progress.hidden = false;
  els.progress.open = true;
  els.report.hidden = true;
  $('tips').hidden = false;
  liveClaims.clear();

  let gotReport = false;
  try {
    const res = await fetch('/api/verify/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Sunucu ${res.status} döndürdü.`);
    }
    await readEventStream(res, (event, data) => {
      if (event === 'progress') handleProgress(data);
      else if (event === 'report') {
        gotReport = true;
        renderReport(data);
        els.progress.open = false;
        // Önbellekten gelen raporda iz kaydı yok: boş "0 adım" göstermek yerine gizle
        els.progress.hidden = els.log.children.length === 0;
        $('progress-title').textContent = `İz kaydı (${els.log.children.length} adım)`;
      } else if (event === 'error') throw new Error(data.error);
    });
    if (!gotReport) throw new Error('Bağlantı rapor gelmeden kapandı. Tekrar dene.');
    els.verdict.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    if (err.name === 'AbortError') {
      logLine('error', 'Durduruldu.');
    } else {
      const message = err instanceof TypeError ? 'Sunucuya ulaşılamadı. Uygulama çalışıyor mu?' : err.message;
      showFormError(message);
      logLine('error', message);
    }
  } finally {
    setRunning(false);
    controller = null;
  }
}

// ---------- başlangıç ----------
els.text.addEventListener('input', updateCount);
els.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) els.form.requestSubmit();
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.text.value.trim();
  if (text.length < 10) return showFormError('Doğrulamak için en az 10 karakterlik bir metin yapıştır.');
  if (text.length > MAX_LEN) return showFormError(`Metin en fazla ${MAX_LEN} karakter olabilir; en önemli kısmını yapıştır.`);
  run(text);
});

els.cancel.addEventListener('click', () => controller?.abort());

for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => {
    els.text.value = button.dataset.example;
    updateCount();
    els.form.requestSubmit();
  });
}

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => ($('demo-bar').hidden = h.mode !== 'demo'))
  .catch(() => {});

updateCount();
