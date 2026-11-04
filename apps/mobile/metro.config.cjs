const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const coreSource =
  path.resolve(__dirname, "../../packages/core/src") + path.sep;

// Node ESM imports name their future .js outputs; Metro consumes these shared
// TypeScript sources directly. Keep the substitution inside our core package.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    context.originModulePath.startsWith(coreSource) &&
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js")
  ) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
