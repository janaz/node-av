#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const packagesDir = join(rootDir, 'packages');
const installScriptPath = join(__dirname, 'install.js');

// Platform configurations
const platforms = [
  { name: 'linux-arm64', os: 'linux', cpu: 'arm64' },
  { name: 'linux-x64', os: 'linux', cpu: 'x64' },
];

// Read template
const template = JSON.parse(readFileSync(join(packagesDir, 'platform-template.json'), 'utf8'));

// Read main package.json for version
const mainPackage = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));

platforms.forEach((platform) => {
  const packageDir = join(packagesDir, platform.name);

  // Create directory
  mkdirSync(packageDir, { recursive: true });

  // Create package.json
  const packageJson = { ...template };
  packageJson.name = `@revizly/node-av-${platform.name}`;
  packageJson.version = mainPackage.version;
  packageJson.description = `node-av (${platform.name} binary)`;
  packageJson.os = [platform.os];
  packageJson.cpu = [platform.cpu];

  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

  // Create README
  const readme = `# @revizly/node-av-${platform.name}

Platform-specific binary for [node-av](https://github.com/seydx/node-av).

**This package is automatically installed as an optional dependency. You should not install it directly.**

## Platform

- OS: ${platform.os}
- Architecture: ${platform.cpu}

## License

MIT
`;

  writeFileSync(join(packageDir, 'README.md'), readme);

  // Copy install.js
  copyFileSync(installScriptPath, join(packageDir, 'install.js'));

  console.log(`Created package for ${platform.name}`);
});

console.log('\nAll platform packages created successfully!');
