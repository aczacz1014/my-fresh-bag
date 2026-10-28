function aiFeaturesEnabled(env = process.env) {
  return env.VERCEL !== '1' || env.AI_FEATURES_ENABLED === 'true';
}

module.exports = { aiFeaturesEnabled };
