const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');
const projectNodeModules = path.join(projectRoot, 'node_modules');
const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest;

function resolveFromProject(moduleName) {
  return {
    type: 'sourceFile',
    filePath: require.resolve(moduleName, { paths: [projectRoot] }),
  };
}

function shouldResolveFromProject(moduleName) {
  return (
    moduleName === 'react' ||
    moduleName.startsWith('react/') ||
    moduleName === 'react-dom' ||
    moduleName.startsWith('react-dom/') ||
    moduleName === 'react-native' ||
    moduleName.startsWith('react-native/')
  );
}

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [projectNodeModules, workspaceNodeModules];
config.resolver.extraNodeModules = {
  react: path.join(projectNodeModules, 'react'),
  'react-dom': path.join(projectNodeModules, 'react-dom'),
  'react-native': path.join(projectNodeModules, 'react-native'),
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (shouldResolveFromProject(moduleName)) {
    return resolveFromProject(moduleName);
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
