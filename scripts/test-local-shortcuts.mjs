// Run with: node --experimental-vm-modules --test scripts/test-local-shortcuts.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(
  new URL('../src/lib/utils/localShortcuts.ts', import.meta.url),
  'utf8'
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});

async function fixture(mini) {
  const calls = [];
  const context = vm.createContext({});
  const mocks = {
    '$lib/ipc': {
      timerToggle: () => calls.push('toggle'),
      timerRestartRound: () => calls.push('reset'),
      timerSkip: () => calls.push('skip'),
      setSetting: () => {},
    },
    '@tauri-apps/api/webviewWindow': {
      getCurrentWebviewWindow: () => ({
        setFullscreen: (value) => calls.push(['fullscreen', value]),
      }),
    },
  };
  const module = new vm.SourceTextModule(outputText, { context });
  await module.link((name) => {
    const exports = mocks[name];
    assert.ok(exports, 'Unexpected runtime dependency: ' + name);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context }
    );
  });
  await module.evaluate();
  let fullscreen = false;
  const handle = module.namespace.createLocalShortcutHandler({
    getSettings: () => ({
      mini_mode: mini,
      local_shortcut_toggle: ' ',
      local_shortcut_reset: 'ArrowLeft',
      local_shortcut_skip: 'ArrowRight',
      local_shortcut_fullscreen: 'F11',
    }),
    getFullscreen: () => fullscreen,
    setFullscreen: (value) => {
      fullscreen = value;
    },
  });
  function press(key, tag = 'DIV') {
    let prevented = false;
    handle({
      key,
      target: { tagName: tag },
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  }
  return { calls, press };
}

test('mini mode blocks fullscreen while retaining timer controls', async () => {
  const { calls, press } = await fixture(true);
  assert.equal(press('F11'), true);
  assert.deepEqual(calls, []);
  for (const key of [' ', 'ArrowLeft', 'ArrowRight']) press(key);
  assert.deepEqual(calls, ['toggle', 'reset', 'skip']);
});

test('normal mode can enter and leave fullscreen', async () => {
  const { calls, press } = await fixture(false);
  press('F11');
  press('F11');
  assert.deepEqual(calls, [
    ['fullscreen', true],
    ['fullscreen', false],
  ]);
});

test('shortcut capture inputs do not trigger window operations', async () => {
  const { calls, press } = await fixture(false);
  assert.equal(press('F11', 'INPUT'), false);
  assert.deepEqual(calls, []);
});
