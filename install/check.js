#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { log } from './ffmpeg.js';

const require = createRequire(import.meta.url);

const tryLoadPrebuilt = () => {
  const platform = process.platform;
  const arch = process.arch;
  const packageName = `@revizly/node-av-${platform}-${arch}`;

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    if (existsSync(packageJsonPath)) {
      log(`Using prebuilt binary from ${packageName}`);
      return true;
    }
  } catch {
    // Package not installed
  }

  // Try local binary folder (for development)
  const localBinary = join(process.cwd(), 'binary', 'node-av.node');
  if (existsSync(localBinary)) {
    log('Using local binary from binary/node-av.node');
    return true;
  }

  return false;
};

const isMuslLibc = () => {
  if (process.platform !== 'linux') {
    return false;
  }

  try {
    const report = process.report?.getReport?.();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
};

const noPrebuiltError = () => {
  log('');
  log(`No prebuilt binary available for ${process.platform}-${process.arch}.`);

  if (isMuslLibc()) {
    log('Note: You appear to be on a musl-based system (e.g. Alpine Linux).');
    log('Prebuilt binaries are only provided for glibc-based Linux distributions.');
  }

  log('The published npm package does not contain the native sources,');
  log('so it cannot be built from source inside node_modules.');
  log('To build from source, clone the repository and follow the build instructions:');
  log('  https://github.com/seydx/node-av');
  process.exit(1);
};

(async () => {
  try {
    const shouldBuildFromSource = process.env.npm_config_build_from_source === 'true';

    if (shouldBuildFromSource) {
      log('--build-from-source was specified, but the published npm package cannot be built from source.');
      noPrebuiltError();
    }

    // Try to use prebuilt binary
    if (tryLoadPrebuilt()) {
      return;
    }

    noPrebuiltError();
  } catch (err) {
    console.error(`node-av: Installation error: ${err.message}`);
    process.exit(1);
  }
})();
