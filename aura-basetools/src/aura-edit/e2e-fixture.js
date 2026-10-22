/**
 * 端到端测试用的固定样本。
 */
function classify(value) {
  if (value === 0) return { kind: 'zero' };
  if (value < 0) return { kind: 'negative', magnitude: -value };
  return { kind: 'positive', magnitude: value };
}

module.exports = { classify };