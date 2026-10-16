'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const aiRoot = path.resolve(__dirname, '../apps/ai');
const localPython = path.join(aiRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.BRANDAI_TEST_PYTHON || localPython;
if (!fs.existsSync(python)) {
  console.error('AI test Python is unavailable. Create apps/ai/.venv and install its test dependencies, or set BRANDAI_TEST_PYTHON to an existing test interpreter.');
  process.exitCode = 1;
} else {
  const result = spawnSync(python, ['-m', 'pytest', '-q', ...process.argv.slice(2)], {
    cwd: aiRoot, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) console.error('AI test interpreter could not be started.');
  process.exitCode = result.status ?? 1;
}
