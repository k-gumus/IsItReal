import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyGuardrails } from '../src/core/guardrails.js';
import { clampConfidence, extractJson, parseDecomposition, parseJudgeVerdict, parsePointer } from '../src/core/validation.js';
import { node, trace } from './helpers.js';

const judge = (verdict: string, confidence = 0.95) => parseJudgeVerdict({ verdict, confidence, reasoning: 'r', lateralReadingTips: [] });

describe('applyGuardrails', () => {
  it('yalnızca ikincil kaynaklarla verilen SUPPORTED kararını düşürür', () => {
    const r = applyGuardrails(judge('SUPPORTED'), trace([node('TIER_3_SECONDARY_AGGREGATOR'), node('TIER_4_SOCIAL_UNVERIFIED')]));
    assert.equal(r.verdict, 'NOT_ENOUGH_EVIDENCE');
    assert.ok(r.confidence <= 0.5);
    assert.match(r.note ?? '', /SUPPORTED/);
  });

  it('aynı kümedeki iki Tier 2 kopyayı bağımsız saymaz', () => {
    const t = trace([node('TIER_2_WIRE_JOURNALISM', { clusterId: 'c1' }), node('TIER_2_WIRE_JOURNALISM', { clusterId: 'c1' })]);
    assert.equal(applyGuardrails(judge('SUPPORTED'), t).verdict, 'NOT_ENOUGH_EVIDENCE');
  });

  it('iki bağımsız Tier 2 ile SUPPORTED kararına izin verir ama güveni sınırlar', () => {
    const t = trace([node('TIER_2_WIRE_JOURNALISM', { clusterId: 'c1' }), node('TIER_2_WIRE_JOURNALISM', { clusterId: 'c2' })]);
    const r = applyGuardrails(judge('SUPPORTED', 0.99), t);
    assert.equal(r.verdict, 'SUPPORTED');
    assert.equal(r.confidence, 0.75);
  });

  it('Tier 1 varsa SUPPORTED kararına tam güvenle izin verir', () => {
    const r = applyGuardrails(judge('SUPPORTED', 0.92), trace([node('TIER_1_TERMINAL_PROOF')]));
    assert.equal(r.verdict, 'SUPPORTED');
    assert.equal(r.confidence, 0.92);
    assert.equal(r.note, undefined);
  });

  it('güvenilir kaynak yokken CONTRADICTED diyemez', () => {
    assert.equal(applyGuardrails(judge('CONTRADICTED'), trace([node('TIER_4_SOCIAL_UNVERIFIED')])).verdict, 'NOT_ENOUGH_EVIDENCE');
  });

  it('kanıt yokken hiçbir kesin karar veremez', () => {
    assert.equal(applyGuardrails(judge('CONTRADICTED'), trace([])).verdict, 'NOT_ENOUGH_EVIDENCE');
  });

  it('kümeleme kanıtı yokken yankı odası diyemez', () => {
    assert.equal(applyGuardrails(judge('CIRCULAR_ECHO_CHAMBER'), trace([node('TIER_3_SECONDARY_AGGREGATOR')])).verdict, 'NOT_ENOUGH_EVIDENCE');
  });
});

describe('LLM çıktı doğrulaması', () => {
  it('enum dışı kararı NOT_ENOUGH_EVIDENCE yapar', () => {
    assert.equal(parseJudgeVerdict({ verdict: 'TRUE', confidence: 1 }).verdict, 'NOT_ENOUGH_EVIDENCE');
    assert.equal(parseJudgeVerdict(null).verdict, 'NOT_ENOUGH_EVIDENCE');
    assert.equal(parseJudgeVerdict({ verdict: 'supported' }).verdict, 'SUPPORTED');
  });

  it('güven skorunu 0-1 aralığına çeker, 0-100 ölçeğini dönüştürür', () => {
    assert.equal(clampConfidence(87), 0.87);
    assert.equal(clampConfidence(-3), 0);
    assert.equal(clampConfidence(5000), 1);
    assert.equal(clampConfidence('0.4'), 0.4);
    assert.equal(clampConfidence('abc'), 0.5);
  });

  it('iddiaları tekilleştirir, en fazla 3 tane bırakır, geçersiz sinyalleri atar', () => {
    const r = parseDecomposition({
      claims: ['A iddiası', 'a iddiası', 'B', 'C', 'D', 42],
      manipulationSignals: [{ type: 'HACK', excerpt: 'x' }, { type: 'clickbait_gap', excerpt: 'y', explanation: 'z' }, 'bozuk'],
    });
    assert.deepEqual(r.claims, ['A iddiası', 'B', 'C']);
    assert.equal(r.manipulationSignals.length, 1);
    assert.equal(r.manipulationSignals[0]?.type, 'CLICKBAIT_GAP');
  });

  it('işaretçide kaynak sırası aralık dışındaysa yok sayar', () => {
    assert.equal(parsePointer({ hasPrimaryPointer: true, targetedPrimaryQuery: 'q', sourceIndex: 9 }, 3).sourceIndex, null);
    assert.equal(parsePointer({ hasPrimaryPointer: true, targetedPrimaryQuery: '' }, 3).hasPrimaryPointer, false);
  });

  it('kod çiti veya ön metinle gelen JSON\'u ayıklar', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('İşte yanıt: {"a":2} umarım yardımcı olur'), { a: 2 });
    assert.throws(() => extractJson('json yok'));
  });
});
