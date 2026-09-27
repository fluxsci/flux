"use strict";
const path = require('node:path');
const fs = require('node:fs/promises');

function documentationIndex({ packaged, resourcesPath, sourceRoot }, paths = path) {
  return packaged
    ? paths.join(resourcesPath, 'docs', 'index.html')
    : paths.join(sourceRoot, 'docs', '_site', 'index.html');
}

async function openDocumentation(options, openPath, io = fs) {
  const index = documentationIndex(options);
  try {
    if (!(await io.stat(index)).isFile()) throw new Error('Documentation entry is not a file');
    const error = await openPath(index);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT'
      ? options.packaged
        ? 'Bundled documentation is missing. Reinstall this Flux package.'
        : 'Docs are not rendered yet. Run `npm run build:docs` in the Flux checkout.'
      : `Documentation could not open: ${error.message || error}` };
  }
}

module.exports = { documentationIndex, openDocumentation };
