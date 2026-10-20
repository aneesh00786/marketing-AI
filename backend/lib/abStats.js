/**
 * Two-proportion z-test for A/B results. Inputs are real counts; nothing is estimated.
 * Returns null fields when the test is not computable (e.g. no trials, or every trial
 * succeeded / failed in both variants), so callers never present a made-up confidence.
 */

// Abramowitz & Stegun 7.1.26 (max error 1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

const normalCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

function twoProportionTest(x1, n1, x2, n2) {
  if (!(n1 > 0 && n2 > 0)) return { p1: null, p2: null, diff: null, z: null, pValue: null };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return { p1, p2, diff: p2 - p1, z: null, pValue: null };
  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { p1, p2, diff: p2 - p1, z, pValue };
}

module.exports = { twoProportionTest, normalCdf };
