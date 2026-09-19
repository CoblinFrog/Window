const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const fs = require('node:fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The app imports `@window/shared` straight out of the workspace, so Metro has
// to watch the monorepo root and resolve from both node_modules trees.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

/**
 * TypeScript's ESM convention is that a relative import written `./foo.js`
 * resolves to `./foo.ts` — the extension names the *emitted* file, not the
 * source. Metro resolves literally and fails on it.
 *
 * Rather than dropping the extensions, which would make the same source invalid
 * under NodeNext resolution in the server package, the specifier is rewritten
 * here when the literal path does not exist but a TypeScript source does.
 */
const TS_EXTENSIONS = ['.ts', '.tsx'];

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && /\.jsx?$/.test(moduleName)) {
    const basedir = path.dirname(context.originModulePath);
    const literal = path.resolve(basedir, moduleName);

    if (!fs.existsSync(literal)) {
      const withoutExtension = moduleName.replace(/\.jsx?$/, '');
      const candidate = path.resolve(basedir, withoutExtension);
      for (const extension of TS_EXTENSIONS) {
        if (fs.existsSync(`${candidate}${extension}`)) {
          return context.resolveRequest(context, withoutExtension, platform);
        }
      }
    }
  }

  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
