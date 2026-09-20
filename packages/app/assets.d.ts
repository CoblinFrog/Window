/**
 * Images imported as modules.
 *
 * Metro turns `import icon from './icon.png'` into an asset module whose
 * default export is the registry id, and nothing in the dependency tree types
 * that. In a normal Expo app the declaration arrives in `expo-env.d.ts`, which
 * `expo start` writes into the project root — this project has never had one,
 * so it is written here instead of being regenerated and gitignored.
 */
declare module '*.png' {
  const asset: number;
  export default asset;
}

declare module '*.jpg' {
  const asset: number;
  export default asset;
}
