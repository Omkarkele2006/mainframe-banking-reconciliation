import assert from 'node:assert/strict';
import test from 'node:test';
import { helpDestinations, helpSections } from './helpContent.js';

test('Help Center covers the current application sections and security boundary', () => {
  const ids = helpSections.map(section => section.id);
  for (const required of ['getting-started','overview','organizations','mainframe-readiness','upload-run','reports-history','audit-logs','common-errors']) assert.ok(ids.includes(required as typeof ids[number]));
  const readiness = helpSections.find(section => section.id === 'mainframe-readiness')?.body ?? '';
  assert.match(readiness, /Zowe CLI `zosmf` profile/);
  assert.match(readiness, /browser sends no mainframe credentials/);
  assert.match(readiness, /does not enable job execution/);
  const upload = helpSections.find(section => section.id === 'upload-run')?.body ?? '';
  assert.match(upload, /never submits JCL/);
  assert.match(upload, /read-back contents/);
  assert.match(upload, /ordinary run request remains NOT_CONFIGURED/);
  assert.match(helpSections.find(section => section.id === 'audit-logs')?.body ?? '', /requires the server-configured application operator session/);
  assert.equal(helpDestinations['upload-run'], 'upload');
  assert.equal(helpDestinations['reports-history'], 'history');
  assert.equal(helpDestinations['audit-logs'], 'audit');
});
