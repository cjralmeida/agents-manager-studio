import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { demuxLogs } from './docker.js';

function frame(stream: 1 | 2, text: string) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxLogs', () => {
  it('splits stdout and stderr frames in order', () => {
    const buffer = Buffer.concat([frame(1, '{"a":'), frame(2, 'warn\n'), frame(1, '1}\n')]);
    assert.deepEqual(demuxLogs(buffer), { stdout: '{"a":1}\n', stderr: 'warn\n' });
  });

  it('ignores an incomplete trailing header', () => {
    const buffer = Buffer.concat([frame(1, 'ok'), Buffer.from([1, 0, 0])]);
    assert.deepEqual(demuxLogs(buffer), { stdout: 'ok', stderr: '' });
  });
});
