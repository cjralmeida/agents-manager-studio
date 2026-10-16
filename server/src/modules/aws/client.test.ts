import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signRequest } from './client.js';

describe('signRequest', () => {
  it('matches the Signature V4 example of the AWS documentation (IAM ListUsers)', () => {
    const headers = signRequest({
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
      service: 'iam',
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });
});
