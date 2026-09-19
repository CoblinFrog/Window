module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    // Reanimated's plugin must stay last: it rewrites worklets, and anything
    // that runs after it will not see the transformed output.
    plugins: ['react-native-reanimated/plugin'],
  };
};
