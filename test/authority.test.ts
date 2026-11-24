import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySource, extractDomain } from '../src/core/authority.js';

describe('classifySource', () => {
  it('resmi kurum alan adlarını ve alt alan adlarını Tier 1 sayar', () => {
    assert.equal(classifySource('https://www.tuik.gov.tr/bulten').tier, 'TIER_1_TERMINAL_PROOF');
    assert.equal(classifySource('https://data.tuik.gov.tr/x').tier, 'TIER_1_TERMINAL_PROOF');
    assert.equal(classifySource('https://www.ankara.bel.tr').tier, 'TIER_1_TERMINAL_PROOF');
  });

  it('sahte "tuik.gov.tr.evil.com" gibi alan adlarına kanmaz', () => {
    const r = classifySource('https://tuik.gov.tr.evil.com/bulten');
    assert.equal(r.tier, 'TIER_3_SECONDARY_AGGREGATOR');
    assert.equal(r.isTerminalProof, false);
  });

  it('haber ajanslarının genel haberlerini Tier 2, teyit bölümlerini Tier 1 sayar', () => {
    assert.equal(classifySource('https://www.reuters.com/world/some-news').tier, 'TIER_2_WIRE_JOURNALISM');
    assert.equal(classifySource('https://www.reuters.com/fact-check/abc').tier, 'TIER_1_TERMINAL_PROOF');
    assert.equal(classifySource('https://apnews.com/article/fact-check-xyz').tier, 'TIER_1_TERMINAL_PROOF');
    assert.equal(classifySource('https://factcheck.afp.com/doc.afp.com.123').tier, 'TIER_1_TERMINAL_PROOF');
    assert.equal(classifySource('https://www.afp.com/en/news').tier, 'TIER_2_WIRE_JOURNALISM');
  });

  it('Google Scholar gibi arama motorlarını kanıt saymaz', () => {
    assert.notEqual(classifySource('https://scholar.google.com/scholar?q=x').tier, 'TIER_1_TERMINAL_PROOF');
  });

  it('sosyal medyanın mobil ve kısa alan adlarını Tier 4 sayar', () => {
    assert.equal(classifySource('https://m.facebook.com/post/1').tier, 'TIER_4_SOCIAL_UNVERIFIED');
    assert.equal(classifySource('https://mobile.twitter.com/a/status/1').tier, 'TIER_4_SOCIAL_UNVERIFIED');
    assert.equal(classifySource('https://youtu.be/abc').tier, 'TIER_4_SOCIAL_UNVERIFIED');
  });

  it('akademik yayıncıyı yalnızca DOI varsa Tier 1 sayar', () => {
    assert.equal(classifySource('https://ieeexplore.ieee.org/document/1', 'doi: 10.1109/5.771073').tier, 'TIER_1_TERMINAL_PROOF');
    assert.equal(classifySource('https://ieeexplore.ieee.org/document/1', 'özet').tier, 'TIER_3_SECONDARY_AGGREGATOR');
  });

  it('http(s) olmayan ve bozuk adresleri reddeder', () => {
    assert.equal(extractDomain('javascript:alert(1)'), '');
    assert.equal(extractDomain('not a url'), '');
    assert.equal(classifySource('ftp://tuik.gov.tr').domain, 'unknown');
  });

  it('her sınıflandırmaya okunabilir bir gerekçe ekler', () => {
    assert.match(classifySource('https://www.tbmm.gov.tr').reason, /tbmm\.gov\.tr/);
  });
});
