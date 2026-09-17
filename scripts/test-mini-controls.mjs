// Run with: node --test scripts/test-mini-controls.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadTs(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}

const { createActionGuard } = await loadTs('../src/lib/utils/actionGuard.ts');
const { timerPhase } = await loadTs('../src/lib/utils/timerPhase.ts');

test('reset and skip share a cooldown, but a later deliberate action works', async () => {
  let time = 0;
  const guard = createActionGuard(600, () => time);
  const calls = [];
  await guard(async () => {
    calls.push('reset');
  });
  time = 150;
  await guard(async () => {
    calls.push('skip');
  });
  time = 600;
  await guard(async () => {
    calls.push('skip');
  });
  assert.deepEqual(calls, ['reset', 'skip']);
});

test('an outstanding request blocks repeats even after its cooldown expires', async () => {
  let time = 0;
  let finish;
  const gate = createActionGuard(600, () => time);
  let calls = 0;
  const pending = gate(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  time = 1000;
  await gate(async () => {
    calls++;
  });
  assert.equal(calls, 1);
  finish();
  await pending;
  await gate(async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test('a failed action does not leave controls permanently locked', async () => {
  let time = 0;
  const guard = createActionGuard(600, () => time);
  await assert.rejects(
    guard(async () => {
      throw new Error('IPC failed');
    }),
    /IPC failed/
  );
  time = 600;
  let retried = false;
  await guard(async () => {
    retried = true;
  });
  assert.equal(retried, true);
});

test('idle, running, paused and completed states are distinct', () => {
  const state = { elapsed_secs: 0, total_secs: 1500, is_running: false, is_paused: false };
  assert.equal(timerPhase(state), 'idle');
  assert.equal(timerPhase({ ...state, is_running: true }), 'running');
  assert.equal(timerPhase({ ...state, elapsed_secs: 12, is_paused: true }), 'paused');
  assert.equal(timerPhase({ ...state, elapsed_secs: 1500 }), 'completed');
  assert.equal(timerPhase({ ...state, total_secs: 0 }), 'idle');
});
