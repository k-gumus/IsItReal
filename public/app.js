// IsItReal istemcisi. Dış veriler (başlık, özet, URL) yalnızca textContent ile yazılır; innerHTML kullanılmaz.

const VERDICTS = {
  SUPPORTED: { name: 'Doğrulandı', summary: 'İddia birincil bir kaynakla destekleniyor.' },
  CONTRADICTED: { name: 'Yanlış', summary: 'Güvenilir kaynaklar iddiayı çürütüyor.' },
  MISLEADING_CONTEXT: { name: 'Bağlamından koparılmış', summary: 'Bilgi gerçek olabilir ama eski, başka bir yere ait ya da çarpıtılmış.' },
  NOT_ENOUGH_EVIDENCE: { name: 'Kanıt yetersiz', summary: 'İddianın dayandığı birincil kaynağa ulaşılamadı.' },
  CIRCULAR_ECHO_CHAMBER: { name: 'Yankı odası', summary: 'Siteler aynı metni birbirinden kopyalıyor; arkasında birincil bir belge yok.' },
  OUTDATED: { name: 'Güncelliğini yitirmiş', summary: 'Bir zamanlar doğruydu ama güncel veriler değişmiş.' },
};

// Yalnızca DOI girildiğinde karar dili yayına göre değişir
const DOI_VERDICTS = {
  SUPPORTED: { name: 'Kayıtlı yayın', summary: 'Bu DOI kayıtlı ve hakkında geri çekme bildirimi yok.' },
  CONTRADICTED: { name: 'Geri çekilmiş', summary: 'Bu yayın geri çekilmiş; kanıt olarak kullanılmamalı.' },
  MISLEADING_CONTEXT: { name: 'Düzeltme yayımlanmış', summary: 'Yayın için düzeltme ya da endişe bildirimi var; güncel halini oku.' },
  NOT_ENOUGH_EVIDENCE: { name: 'Kayıt bulunamadı', summary: 'Bu DOI hiçbir kayıt kuruluşunda yok; uydurulmuş bir atıf olabilir.' },
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

const TIERS = [
  { id: 'TIER_4_SOCIAL_UNVERIFIED', name: 'Sosyal medya', desc: 'doğrulanmamış paylaşımlar', icon: 'i-text' },
  { id: 'TIER_3_SECONDARY_AGGREGATOR', name: 'İkincil siteler', desc: 'portallar, bloglar, aktarımlar', icon: 'i-link' },
  { id: 'TIER_2_WIRE_JOURNALISM', name: 'Haber kuruluşları', desc: 'muhabirlik yapan ajanslar', icon: 'i-doi' },
  { id: 'TIER_1_TERMINAL_PROOF', name: 'Kök kanıt', desc: 'resmi kurum, hakemli yayın, teyit kuruluşu', icon: 'i-verify' },
];
const TIER_NAME = Object.fromEntries(TIERS.map((t) => [t.id, t.name]));

const KIND = {
  text: { label: 'Metin', icon: 'i-text' },
  url: { label: 'Bağlantı', icon: 'i-link' },
  doi: { label: 'DOI', icon: 'i-doi' },
  pdf: { label: 'PDF', icon: 'i-pdf' },
};

const MAX_LEN = 4000;
const HISTORY_KEY = 'isitreal.history.v1';
const HISTORY_MAX = 15;

const $ = (id) => document.getElementById(id);
const state = {
  report: null,
  pane: 0, // iddia sırası ya da 'citations'
  pdf: null,
  controller: null,
  live: null, // akış sırasında { source, claims: [{claimId, claimText, verdict, confidence, nodes}] }
  tiersLoaded: false,
};

// ---------- yardımcılar ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
function icon(id, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
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
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}

// Sunucudaki sınıflandırıcının istemci kopyası (yalnızca gösterim için)
const DOI_ONLY = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"'<>]+)$/i;
function detectKind(text) {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (DOI_ONLY.test(t)) return 'doi';
  if (!/\s/.test(t)) {
    try {
      const u = new URL(t);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) return 'url';
    } catch { /* metin */ }
  }
  return 'text';
}

// ---------- üst bar: arama kutusu ----------
const q = $('q');
const omnibox = $('omnibox');

function openOmni() {
  if (state.pdf) return;
  omnibox.classList.add('is-open');
  $('omni-panel').hidden = false;
}
function closeOmni() {
  omnibox.classList.remove('is-open');
  $('omni-panel').hidden = true;
}
function updateKind() {
  const n = q.value.length;
  $('count').textContent = `${n} / ${MAX_LEN}`;
  $('count').toggleAttribute('data-over', n > MAX_LEN);
  const kind = state.pdf ? null : detectKind(q.value);
  $('kind-pill').hidden = !kind;
  if (kind) $('kind-pill').textContent = KIND[kind].label;
}

q.addEventListener('focus', openOmni);
q.addEventListener('input', updateKind);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    omnibox.requestSubmit();
  } else if (e.key === 'Escape') {
    closeOmni();
    q.blur();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!omnibox.contains(e.target)) closeOmni();
  for (const pile of document.querySelectorAll('details.pile[open]')) if (!pile.contains(e.target)) pile.open = false;
});
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    switchTab('verify');
    q.focus();
  }
});
for (const b of document.querySelectorAll('[data-example]')) {
  b.addEventListener('click', () => {
    clearPdf();
    q.value = b.dataset.example;
    updateKind();
    closeOmni();
    omnibox.requestSubmit();
  });
}

omnibox.addEventListener('submit', (e) => {
  e.preventDefault();
  closeOmni();
  if (state.pdf) return run({ pdf: { name: state.pdf.name, pages: state.pdf.pages, text: state.pdf.text, title: state.pdf.title } }, state.pdf.name);
  const text = q.value.trim();
  if (!text) return q.focus();
  if (detectKind(text) === 'text' && text.length < 10) return showBanner('Doğrulamak için en az 10 karakterlik bir metin, bir bağlantı ya da DOI gir.');
  if (text.length > MAX_LEN) return showBanner(`Metin en fazla ${MAX_LEN} karakter olabilir; en önemli kısmını yapıştır.`);
  run({ text }, text);
});
$('cancel').addEventListener('click', () => state.controller?.abort());

// ---------- PDF ----------
$('attach').addEventListener('click', () => $('file').click());
$('blank-pdf').addEventListener('click', () => $('file').click());
$('blank-focus').addEventListener('click', () => q.focus());
$('file').addEventListener('change', () => {
  const file = $('file').files?.[0];
  $('file').value = '';
  if (file) uploadPdf(file);
});
$('pdf-remove').addEventListener('click', () => {
  clearPdf();
  q.focus();
});

function clearPdf() {
  state.pdf = null;
  $('pdf-chip').hidden = true;
  q.hidden = false;
  updateKind();
}

// PDF tarayıcıda okunur (pdf.js); sunucuya dosya değil, yalnızca çıkarılan metin gider.
const MAX_PDF_PAGES = 80;
const MAX_PDF_CHARS = 300_000;
let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ??= import('/vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return pdfjs;
  });
  return pdfjsPromise;
}

async function extractPdfText(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true }).promise;
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new Error(`PDF en fazla ${MAX_PDF_PAGES} sayfa olabilir (bu dosya ${doc.numPages} sayfa).`);
    let text = '';
    for (let p = 1; p <= doc.numPages && text.length < MAX_PDF_CHARS; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
      $('pdf-chip-text').textContent = `${file.name} okunuyor, ${p}/${doc.numPages} sayfa…`;
    }
    let title;
    try {
      const meta = await doc.getMetadata();
      title = typeof meta?.info?.Title === 'string' ? meta.info.Title : undefined;
    } catch { /* üst veri isteğe bağlı */ }
    return { name: file.name, pages: doc.numPages, text: text.slice(0, MAX_PDF_CHARS), title };
  } finally {
    doc.destroy();
  }
}

const DOI_ANY = /10\.\d{4,9}\/[^\s"'<>]+/gi;

async function uploadPdf(file) {
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return showBanner('Yalnızca PDF dosyası yüklenebilir.');
  if (file.size > 25 * 1024 * 1024) return showBanner('PDF en fazla 25 MB olabilir.');
  switchTab('verify');
  closeOmni();
  showBanner('');
  state.pdf = null;
  q.hidden = true;
  $('kind-pill').hidden = true;
  $('pdf-chip').hidden = false;
  $('pdf-chip-text').textContent = `${file.name} okunuyor…`;
  try {
    const pdf = await extractPdfText(file);
    if (!pdf.text.trim()) throw new Error('Bu PDF\'te seçilebilir metin yok (taranmış bir belge olabilir).');
    const dois = new Set((pdf.text.match(DOI_ANY) ?? []).map((d) => d.toLowerCase().replace(/[.,;:)\]]+$/, ''))).size;
    state.pdf = { ...pdf, dois };
    $('pdf-chip-text').textContent = `${pdf.name}, ${pdf.pages} sayfa, ${dois} DOI`;
    run({ pdf }, pdf.name);
  } catch (err) {
    clearPdf();
    showBanner(err?.name === 'PasswordException' ? 'Bu PDF şifreli; şifresiz bir kopyasını dene.' : err?.message ?? 'PDF okunamadı.');
  }
}

// Sürükle-bırak
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop-overlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadPdf(file);
});

// ---------- sekmeler ----------
const TAB_NAMES = { verify: 'Doğrula', history: 'Geçmiş', tiers: 'Kaynak katmanları', about: 'Nasıl çalışır' };
function switchTab(tab) {
  for (const b of document.querySelectorAll('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
  $('crumb').textContent = TAB_NAMES[tab];
  if (tab === 'history') renderHistory();
  if (tab === 'tiers') loadTiers();
  if (tab === 'verify') requestAnimationFrame(redrawEdges);
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));

// ---------- durum ve yan panel ----------
function showBanner(message) {
  $('banner').textContent = message;
  $('banner').hidden = !message;
}
function setRunning(running) {
  $('submit').disabled = running;
  $('submit').textContent = running ? 'İzleniyor…' : 'Kaynağını izle';
  $('cancel').hidden = !running;
}
function logLine(kind, ...parts) {
  const li = el('li', { 'data-kind': kind });
  const span = el('span');
  for (const p of parts) span.append(typeof p === 'string' ? document.createTextNode(p) : p);
  li.append(span);
  $('log').append(li);
  li.scrollIntoView({ block: 'nearest' });
}
function sideMode(mode) {
  $('side-about').hidden = mode !== 'about';
  $('side-log').hidden = mode !== 'live';
  if (mode !== 'report') for (const id of ['side-verdict', 'side-signals', 'side-tips', 'side-notes']) $(id).hidden = true;
}

// ---------- kaynak kartları ve katmanlar ----------
function sourceCard(node, number, { isNew = false, asLink = true } = {}) {
  const href = asLink ? safeHref(node.url) : null;
  const card = el(href ? 'a' : 'div', {
    class: `src${isNew ? ' is-new' : ''}`,
    href,
    target: href ? '_blank' : null,
    rel: href ? 'noopener noreferrer nofollow' : null,
    'data-node-id': node.id,
    title: node.snippet || node.title || '',
  });
  const top = el('span', { class: 'src-top' }, el('span', { class: 'src-domain', text: node.domain }));
  if (number) top.append(el('span', { class: 'src-num', text: `Kanıt ${number}` }));
  card.append(top, el('span', { class: 'src-title', text: node.title || node.snippet || node.url }));
  if (node.origin === 'factcheck') card.append(el('span', { class: 'src-hop', text: 'Teyit kuruluşu kaydı' }));
  else if (node.hopDepth > 0) card.append(el('span', { class: 'src-hop', text: node.citationPointer ? `İz: ${node.citationPointer}` : `${node.hopDepth}. adımda bulundu` }));
  return card;
}

function buildStrata() {
  const strata = el('div', { class: 'strata' });
  for (const t of TIERS) {
    const nodes = el('div', { class: 'stratum-nodes' });
    nodes.addEventListener('scroll', () => requestAnimationFrame(redrawEdges), { passive: true });
    strata.append(
      el('div', { class: 'stratum', 'data-tier': t.id },
        el('div', { class: 'stratum-label' }, icon(t.icon), el('div', {}, el('strong', { text: t.name }), el('small', { text: t.desc }))),
        nodes)
    );
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'edges');
  svg.setAttribute('aria-hidden', 'true');
  strata.append(svg);
  return strata;
}
const nodesBox = (strata, tier) => strata.querySelector(`.stratum[data-tier="${tier}"] .stratum-nodes`);

function markEmpty(strata) {
  for (const t of TIERS) {
    const box = nodesBox(strata, t.id);
    if (box.children.length === 0) box.append(el('p', { class: 'stratum-empty', text: t.id === 'TIER_1_TERMINAL_PROOF' ? 'Kök kanıt bulunamadı' : 'Bu katmanda kaynak yok' }));
  }
}

function fillStrata(strata, claim) {
  const numberOf = new Map(claim.nodes.map((n, i) => [n.id, i + 1]));
  const clusters = new Map();
  for (const n of claim.nodes) {
    const key = n.clusterId ?? n.id;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(n);
  }
  for (const members of clusters.values()) {
    const rep = members.find((n) => n.isClusterRepresentative) ?? members[0];
    const box = nodesBox(strata, rep.tier);
    if (members.length === 1) {
      box.append(sourceCard(rep, numberOf.get(rep.id)));
      continue;
    }
    // Kopya yığını: üstteki kart tıklanınca tüm kopyalar açılır pencerede listelenir
    const list = el('ul', { class: 'pile-pop' });
    for (const n of members) list.append(el('li', {}, sourceCard(n, numberOf.get(n.id))));
    const pile = el('details', { class: 'pile' },
      el('summary', {}, sourceCard(rep, numberOf.get(rep.id), { asLink: false }), el('span', { class: 'pile-count', text: `${members.length} site, aynı metin` })),
      list);
    pile.addEventListener('toggle', () => {
      if (!pile.open) return;
      for (const other of strata.querySelectorAll('details.pile[open]')) if (other !== pile) other.open = false;
      placePopover(pile.querySelector('summary'), list);
    });
    box.append(pile);
  }
  markEmpty(strata);
}

/** Açılır kopya listesini kutunun kırpmasından kurtarmak için ekrana göre konumlar; altta yer yoksa yukarı açar. */
function placePopover(anchor, pop) {
  const r = anchor.getBoundingClientRect();
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const wanted = Math.min(pop.scrollHeight, 320);
  const downward = below >= wanted || below >= above;
  const height = Math.max(120, Math.min(wanted, downward ? below : above));
  pop.style.maxHeight = `${height}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 308))}px`;
  pop.style.top = `${downward ? r.bottom + 6 : r.top - 6 - Math.min(pop.scrollHeight, height)}px`;
}
window.addEventListener('resize', () => document.querySelectorAll('details.pile[open]').forEach((p) => (p.open = false)));
document.addEventListener('scroll', () => document.querySelectorAll('details.pile[open]').forEach((p) => (p.open = false)), true);

function drawEdges(strata, edges) {
  const svg = strata.querySelector('.edges');
  svg.replaceChildren();
  const box = strata.getBoundingClientRect();
  if (!box.width) return;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const anchor = (id) => {
    const t = strata.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    if (!t) return null;
    const pile = t.closest('details.pile');
    return pile ? pile.querySelector('summary .src') : t;
  };
  const visible = (r, p) => r.right > p.left + 4 && r.left < p.right - 4;
  for (const e of edges ?? []) {
    if (e.relation !== 'CITES_PRIMARY' && e.relation !== 'SUPPORTS') continue;
    const a = anchor(e.fromNodeId);
    const b = anchor(e.toNodeId);
    if (!a || !b || a === b) continue;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    // Yatay kaydırmayla görünmeyen kartlara çizgi çekme
    if (!visible(ra, a.closest('.stratum-nodes').getBoundingClientRect()) || !visible(rb, b.closest('.stratum-nodes').getBoundingClientRect())) continue;
    const x1 = ra.left + ra.width / 2 - box.left;
    const y1 = ra.bottom - box.top;
    const x2 = rb.left + rb.width / 2 - box.left;
    const y2 = rb.top - box.top;
    const bend = Math.max(20, (y2 - y1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
    path.setAttribute('class', e.relation === 'CITES_PRIMARY' ? 'cites' : 'supports');
    svg.append(path);
  }
}

let currentEdges = null;
function redrawEdges() {
  const strata = document.querySelector('#claim-pane .strata');
  if (strata && currentEdges) drawEdges(strata, currentEdges);
}
new ResizeObserver(() => redrawEdges()).observe($('claim-pane'));

// ---------- sonuç bölmesi ----------
function sourceLine(source, report) {
  const kind = KIND[source.kind] ?? KIND.text;
  const wrap = el('span', { class: 'source' }, icon(kind.icon));
  if (source.kind === 'url') {
    const href = safeHref(source.url);
    wrap.append(el('strong', {}, href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', text: source.label }) : source.label));
    if (source.classification) {
      const t = source.classification.tier;
      wrap.append(el('span', { class: 'label source-tier', 'data-tone': t === 'TIER_1_TERMINAL_PROOF' ? 'SUPPORTED' : t === 'TIER_2_WIRE_JOURNALISM' ? 'OUTDATED' : 'NOT_ENOUGH_EVIDENCE', text: TIER_NAME[t], title: source.classification.reason }));
    }
  } else if (source.kind === 'doi') {
    wrap.append(el('strong', { class: 'mono', text: source.label }));
  } else if (source.kind === 'pdf') {
    wrap.append(el('strong', { text: source.label }));
    if (source.pages) wrap.append(el('span', { class: 'muted', text: `${source.pages} sayfa` }));
  } else {
    wrap.append(el('strong', { text: 'Metin' }));
  }
  if (report) {
    const parts = [];
    if (report.claims.length) parts.push(`${report.claims.length} iddia`);
    if (report.citations.length) parts.push(`${report.citations.length} atıf`);
    parts.push(seconds(report.durationMs));
    if (report.cached) parts.push('önbellekten');
    wrap.append(el('span', { class: 'muted small', text: parts.join(', ') }));
  }
  return wrap;
}

function renderSwitcher(items) {
  const sw = $('switcher');
  sw.replaceChildren();
  sw.hidden = items.length < 2;
  for (const item of items) {
    const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(item.key === state.pane), 'data-tone': item.tone }, el('span', { class: 'dot' }), item.label);
    b.addEventListener('click', () => {
      state.pane = item.key;
      renderResult();
    });
    sw.append(b);
  }
}

function claimPane(claim, { live = false } = {}) {
  const pane = document.createDocumentFragment();
  const verdict = claim.verdict ? VERDICTS[claim.verdict] : null;
  pane.append(
    el('div', { class: 'claim-head' },
      el('p', { class: 'claim-text', text: `“${claim.claimText}”` }),
      el('span', { class: 'label', 'data-tone': claim.verdict ?? 'pending' }, verdict ? verdict.name : 'İzleniyor…', claim.confidence != null ? el('small', { text: `${pct(claim.confidence)} güven` }) : null))
  );
  if (live) {
    pane.append(el('p', { class: 'claim-stop', text: `${claim.nodes.length} kaynak bulundu…` }));
  } else {
    const reason = el('p', { class: 'claim-reason', text: claim.reasoning, title: 'Tamamını göster' });
    reason.addEventListener('click', () => reason.classList.toggle('is-open'));
    pane.append(reason);
    if (claim.guardrailNote) pane.append(el('p', { class: 'claim-guard', text: `Denetim notu: ${claim.guardrailNote}` }));
    pane.append(el('p', { class: 'claim-stop', text: `${STOP_REASONS[claim.stopReason] ?? claim.stopReason}. ${claim.rawResultCount} kaynak, ${claim.uniqueClusterCount} bağımsız metin.` }));
  }
  const strata = buildStrata();
  if (live) {
    for (const n of claim.nodes) nodesBox(strata, n.tier).append(sourceCard(n, null, { isNew: n._new }));
    markEmpty(strata);
  } else {
    fillStrata(strata, claim);
  }
  pane.append(strata);
  currentEdges = live ? null : claim.edges;
  return pane;
}

const citationTone = (c) => (c.status === 'error' ? 'error' : c.status === 'not_found' ? 'not_found' : c.isRetracted ? 'retracted' : c.updates.length ? 'corrected' : 'found');
const CITATION_LABEL = { found: 'Kayıtlı', not_found: 'Kayıt bulunamadı', retracted: 'Geri çekilmiş', corrected: 'Düzeltme var', error: 'Denetlenemedi' };
const CITATION_ICON = { found: 'i-check', not_found: 'i-x', retracted: 'i-x', corrected: 'i-alert', error: 'i-alert' };

function citationsPane(report) {
  const s = report.citationSummary;
  const pane = el('div', { class: 'citation-pane' });
  const summary = el('div', { class: 'citation-summary' });
  const chip = (tone, n, text) => { if (n > 0) summary.append(el('span', { class: 'label', 'data-tone': tone, text: `${n} ${text}` })); };
  chip('found', s.found - s.retracted - s.corrected, 'kayıtlı');
  chip('not_found', s.notFound, 'kayıt bulunamadı');
  chip('retracted', s.retracted, 'geri çekilmiş');
  chip('corrected', s.corrected, 'düzeltme var');
  chip('error', s.unchecked, 'denetlenemedi');
  pane.append(summary);
  const rows = el('ul', { class: 'rows' });
  for (const c of report.citations) {
    const tone = citationTone(c);
    const meta = [c.container, c.year, c.agency].filter(Boolean).join(', ');
    rows.append(
      el('li', { 'data-tone': tone },
        icon(CITATION_ICON[tone], 'row-icon'),
        el('span', { class: 'row-main' },
          el('span', { class: 'row-title' }, c.title ?? el('span', { class: 'muted', text: tone === 'not_found' ? 'Bu DOI hiçbir kayıt kuruluşunda yok' : 'Başlık alınamadı' })),
          el('span', { class: 'row-meta' }, el('a', { class: 'mono', href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: c.doi }), meta ? ` ${meta}` : '')),
        el('span', { class: 'label', 'data-tone': tone, text: CITATION_LABEL[tone] }))
    );
  }
  pane.append(rows);
  currentEdges = null;
  return pane;
}

function paperPane(c) {
  const tone = citationTone(c);
  const pane = el('div', { class: 'paper' });
  if (c.status === 'not_found') {
    pane.append(el('h2', { text: 'Bu DOI kayıtlı değil' }), el('p', { class: 'authors', text: 'Crossref, doi.org ve DataCite\'ta kaydı yok. DOI\'yi yanlış kopyalamış olabilirsin; değilse bu atıf uydurulmuş olabilir.' }));
  } else if (c.status === 'error') {
    pane.append(el('h2', { text: 'DOI denetlenemedi' }), el('p', { class: 'authors', text: c.error ?? 'Kayıt servislerine ulaşılamadı.' }));
  } else {
    pane.append(el('h2', { text: c.title ?? c.doi }), el('p', { class: 'authors', text: (c.authors ?? []).join(', ') || 'Yazar bilgisi yok' }));
  }
  for (const u of c.updates ?? []) {
    pane.append(el('div', { class: 'notice', 'data-tone': u.type === 'retraction' ? 'retracted' : 'corrected' },
      el('strong', { text: u.type === 'retraction' ? 'Geri çekme bildirimi' : u.label }),
      document.createTextNode(` ${u.date ?? ''} ${u.source === 'retraction-watch' ? '(Retraction Watch)' : '(yayıncı)'} `),
      u.noticeDoi ? el('a', { class: 'mono', href: `https://doi.org/${u.noticeDoi}`, target: '_blank', rel: 'noopener noreferrer nofollow', text: u.noticeDoi }) : null));
  }
  const dl = el('dl');
  const row = (k, v) => { if (v !== undefined && v !== null && v !== '') dl.append(el('dt', { text: k }), el('dd', {}, v)); };
  row('Durum', el('span', { class: 'label', 'data-tone': tone, text: CITATION_LABEL[tone] }));
  row('DOI', el('a', { class: 'mono', href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: c.doi }));
  row('Dergi / kaynak', c.container);
  row('Yayıncı', c.publisher);
  row('Yıl', c.year ? `${c.year} (${new Date().getFullYear() - c.year} yıl önce)` : undefined);
  row('Tür', c.type);
  row('Atıf sayısı', c.citedBy != null ? String(c.citedBy) : undefined);
  row('Kayıt kuruluşu', c.agency);
  pane.append(dl);
  currentEdges = null;
  return pane;
}

function renderResult() {
  const r = state.report;
  const live = state.live;
  $('blank').hidden = true;
  $('result').hidden = false;
  const pane = $('claim-pane');

  if (live) {
    $('source').replaceChildren(sourceLine(live.source));
    renderSwitcher(live.claims.map((c, i) => ({ key: i, label: `İddia ${i + 1}`, tone: c.verdict ?? 'pending' })));
    const claim = live.claims[typeof state.pane === 'number' ? state.pane : 0];
    pane.replaceChildren(claim ? claimPane(claim, { live: true }) : el('p', { class: 'claim-stop', text: 'Hazırlanıyor…' }));
    return;
  }
  if (!r) return;

  $('source').replaceChildren(sourceLine(r.source, r));
  if (r.source.kind === 'doi') {
    renderSwitcher([]);
    pane.replaceChildren(paperPane(r.citations[0]));
    return;
  }
  const items = r.claims.map((c, i) => ({ key: i, label: `İddia ${i + 1}`, tone: c.verdict }));
  if (r.citations.length) {
    const s = r.citationSummary;
    items.push({ key: 'citations', label: `Atıflar ${s.total}`, tone: s.retracted || s.notFound ? 'not_found' : s.corrected ? 'corrected' : 'found' });
  }
  if (!items.some((i) => i.key === state.pane)) state.pane = items[0]?.key ?? 0;
  renderSwitcher(items);
  if (state.pane === 'citations') pane.replaceChildren(citationsPane(r));
  else pane.replaceChildren(claimPane(r.claims[state.pane]));
  requestAnimationFrame(redrawEdges);
}

function renderSide(r) {
  sideMode('report');
  const table = r.source.kind === 'doi' ? DOI_VERDICTS : VERDICTS;
  const v = table[r.overallVerdict] ?? VERDICTS[r.overallVerdict];
  const block = $('side-verdict');
  block.hidden = false;
  block.dataset.tone = r.overallVerdict;
  $('verdict-name').textContent = v.name;
  $('verdict-summary').textContent = v.summary;
  $('score').textContent = `${r.literacyScore} / 100`;
  $('scale-fill').style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => ($('scale-fill').style.width = `${r.literacyScore}%`)));
  const sources = r.claims.reduce((n, c) => n + c.rawResultCount, 0);
  $('verdict-meta').textContent = r.claims.length ? `${sources} kaynak tarandı, ${r.checkedAt}.` : `${r.checkedAt} tarihinde denetlendi.`;

  $('side-signals').hidden = r.manipulationSignals.length === 0;
  $('signal-count').textContent = r.manipulationSignals.length;
  $('signal-list').replaceChildren(...r.manipulationSignals.map((s) =>
    el('li', { 'data-signal': s.type }, el('strong', { text: SIGNALS[s.type] ?? s.type }), s.excerpt ? el('q', { text: s.excerpt }) : null, el('span', { text: s.explanation }))));

  $('side-tips').hidden = r.lateralReadingTips.length === 0;
  $('tip-list').replaceChildren(...r.lateralReadingTips.map((t) => el('li', { text: t })));

  $('side-notes').hidden = r.warnings.length === 0;
  $('note-count').textContent = r.warnings.length;
  $('note-list').replaceChildren(...r.warnings.map((w) => el('li', { text: w })));
}

function showReport(report) {
  state.report = report;
  state.live = null;
  state.pane = report.claims.length ? 0 : 'citations';
  renderResult();
  renderSide(report);
}

// ---------- canlı akış ----------
function handleProgress(e) {
  const live = state.live;
  if (!live) return;
  switch (e.type) {
    case 'stage':
      if (e.stage !== 'done') logLine('stage', e.message);
      break;
    case 'claims':
      logLine('info', `${e.claims.length} doğrulanabilir iddia bulundu.`);
      live.claims = e.claims.map((c) => ({ ...c, nodes: [] }));
      state.pane = 0;
      renderResult();
      break;
    case 'search':
      logLine('search', e.hop === 0 ? 'Aranıyor: ' : `${e.hop}. adım: `, el('q', { text: e.query }));
      break;
    case 'pointer':
      logLine('pointer', 'Dayanılan kaynak: ', el('q', { text: e.pointer }));
      break;
    case 'evidence': {
      const idx = live.claims.findIndex((c) => c.claimId === e.claimId);
      if (idx === -1) break;
      live.claims[idx].nodes.forEach((n) => (n._new = false));
      live.claims[idx].nodes.push({ ...e.node, _new: true });
      if (state.pane === idx) renderResult();
      break;
    }
    case 'claim-done': {
      const c = live.claims.find((x) => x.claimId === e.claimId);
      if (c) Object.assign(c, { verdict: e.verdict, confidence: e.confidence });
      renderResult();
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
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
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

function liveSource(body, label) {
  if (body.pdf) return { kind: 'pdf', label, pages: body.pdf.pages };
  const kind = detectKind(body.text);
  if (kind === 'url') {
    try {
      return { kind, label: new URL(body.text).hostname.replace(/^www\./, ''), url: body.text };
    } catch { /* düş */ }
  }
  if (kind === 'doi') return { kind, label: body.text.replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, '') };
  return { kind: 'text', label: 'Metin' };
}

async function run(body, label) {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  switchTab('verify');
  showBanner('');
  setRunning(true);
  $('log').replaceChildren();
  sideMode('live');
  state.report = null;
  state.live = { source: liveSource(body, label), claims: [] };
  renderResult();
  logLine('stage', `${KIND[state.live.source.kind].label} alındı`);

  let report = null;
  try {
    const res = await fetch('/api/verify/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Sunucu ${res.status} döndürdü.`);
    }
    await readEventStream(res, (event, data) => {
      if (event === 'progress') handleProgress(data);
      else if (event === 'report') report = data;
      else if (event === 'error') throw new Error(data.error);
    });
    if (!report) throw new Error('Bağlantı rapor gelmeden kapandı. Tekrar dene.');
    showReport(report);
    saveHistory(report, label);
  } catch (err) {
    state.live = null;
    if (err.name === 'AbortError') {
      logLine('error', 'Durduruldu.');
    } else {
      showBanner(err instanceof TypeError ? 'Sunucuya ulaşılamadı. Uygulama çalışıyor mu?' : err.message);
      logLine('error', err.message);
    }
    if (!state.report) {
      $('result').hidden = true;
      $('blank').hidden = false;
    }
  } finally {
    if (state.controller === controller) state.controller = null;
    setRunning(false);
  }
}

// ---------- geçmiş ----------
function readHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeHistory(list) {
  for (let n = list.length; n >= 0; n--) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, n)));
      return;
    } catch {
      // kota doluysa en eskileri at
    }
  }
}
function saveHistory(report, label) {
  const list = readHistory().filter((h) => h.input !== report.originalInput);
  list.unshift({ at: Date.now(), label: String(label).slice(0, 160), input: report.originalInput, report });
  writeHistory(list.slice(0, HISTORY_MAX));
  updateHistoryCount();
}
function updateHistoryCount() {
  $('history-count').textContent = readHistory().length;
}
function renderHistory() {
  const list = readHistory();
  const ul = $('history-list');
  if (!list.length) {
    ul.replaceChildren(el('li', { class: 'history-empty', text: 'Henüz bir doğrulama yapmadın.' }));
    return;
  }
  ul.replaceChildren(...list.map((h) => {
    const r = h.report;
    const table = r.source?.kind === 'doi' ? DOI_VERDICTS : VERDICTS;
    const kind = KIND[r.source?.kind] ?? KIND.text;
    const li = el('li', { class: 'history-row', tabindex: '0', 'data-tone': r.overallVerdict },
      icon(kind.icon, 'row-icon'),
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: h.label }), el('span', { class: 'row-meta', text: `${kind.label}, ${timeAgo(h.at)}, şeffaflık ${r.literacyScore}/100` })),
      el('span', { class: 'label', 'data-tone': r.overallVerdict, text: table[r.overallVerdict]?.name ?? r.overallVerdict }));
    const open = () => {
      switchTab('verify');
      clearPdf();
      if (r.source?.kind !== 'pdf') q.value = h.input;
      updateKind();
      showReport(r);
    };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return li;
  }));
}
$('history-clear').addEventListener('click', () => {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch { /* yoksay */ }
  renderHistory();
  updateHistoryCount();
});

// ---------- kaynak katmanları sekmesi ----------
async function loadTiers() {
  if (state.tiersLoaded) return;
  const box = $('tier-box');
  try {
    const data = await (await fetch('/api/tiers')).json();
    const body = el('div', { class: 'tier-box-body' });
    const header = el('div', { class: 'box-header' }, el('strong', { text: 'Alan adına göre kaynak katmanları' }), el('span', { class: 'muted small', text: 'Alt alan adları da eşleşir' }));
    for (const t of [...TIERS].reverse()) {
      const d = data[t.id] ?? {};
      const list = el('div', { class: 'tier-list' });
      for (const s of d.suffixes ?? []) list.append(el('code', { text: `*${s}` }));
      for (const s of d.domains ?? []) list.append(el('code', { text: s }));
      for (const s of d.sections ?? []) list.append(el('code', { text: s }));
      for (const s of d.academicWithDoi ?? []) list.append(el('code', { text: `${s} + DOI` }));
      if (!list.children.length) list.append(el('span', { class: 'muted', text: 'Diğer listelerde olmayan her site bu katmana düşer.' }));
      body.append(el('div', { class: 'tier-row', 'data-tier': t.id }, el('div', {}, el('strong', { text: t.name }), el('small', { text: t.desc })), list));
    }
    box.replaceChildren(header, body);
    state.tiersLoaded = true;
  } catch {
    box.replaceChildren(el('p', { class: 'history-empty', text: 'Liste yüklenemedi.' }));
  }
}

// ---------- başlangıç ----------
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    const badge = $('mode-badge');
    badge.hidden = h.mode !== 'demo';
    badge.textContent = 'Demo verisi';
    badge.title = 'Arama ve dil modeli kurgusal demo verisiyle çalışıyor. Gerçek tarama için .env dosyasına API anahtarlarını ekle.';
  })
  .catch(() => {});
updateKind();
updateHistoryCount();
