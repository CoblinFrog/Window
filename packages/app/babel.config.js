module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    // The worklet plugin must stay last: it rewrites worklets, and anything
    // that runs after it will not see the transformed output.
    //
    // It moved packages in Reanimated 4. Worklets are their own library now —
    // `react-native-worklets`, which Reanimated declares as a peer — and the
    // plugin went with them. The old `react-native-reanimated/plugin` path
    // still resolves, and re-exports this, but naming the package that owns it
    // is what will keep resolving.
    plugins: ['react-native-worklets/plugin'],
  };
};
