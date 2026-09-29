'use strict';
const fs = require('node:fs'), path = require('node:path');
/** Metadata-only preflight. Never sync a checkout or import Python while the
 * aggregate runner still has its parent environment. */
function model3dPythonWorktreeProblem(root) {
  const requirement = 'FLUXPLOT_ROOT must name an isolated fluxplot worktree with its prepared uv .venv';
  if (!root || !path.isAbsolute(root)) return requirement;
  const regular = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  // A linked worktree has a .git file; the owner's main checkout has a directory.
  if (!regular(path.join(root, '.git')) || !regular(path.join(root, 'pyproject.toml')) ||
      !regular(path.join(root, 'examples/scene3d_demo.py')) || !regular(path.join(root, 'src/fluxplot/scene3d.py')) ||
      !regular(path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))) return requirement;
  return null;
}
module.exports = { model3dPythonWorktreeProblem };
