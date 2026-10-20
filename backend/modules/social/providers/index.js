const meta = require('./meta');
const linkedin = require('./linkedin');
const youtube = require('./youtube');
const { ProviderError } = require('./http');

const ADAPTERS = { meta, linkedin, youtube };

function getAdapter(providerKey) {
  const adapter = ADAPTERS[providerKey];
  if (!adapter) {
    throw new ProviderError({ message: `Unknown provider: ${providerKey}`, code: 'NOT_SUPPORTED' });
  }
  return adapter;
}

module.exports = { ADAPTERS, getAdapter, ProviderError };
