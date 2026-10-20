import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDnsRecord, parseInstances, signRequest, xmlText } from './client.js';

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

describe('parseInstances', () => {
  it('reads each instance of a DescribeInstances answer with its own tags', () => {
    const xml = `<DescribeInstancesResponse><reservationSet><item><instancesSet>
      <item><instanceId>i-0aaa</instanceId><instanceType>t3.small</instanceType><instanceState><code>16</code><name>running</name></instanceState>
        <ipAddress>52.6.45.238</ipAddress><tagSet><item><key>Name</key><value>studio-api-hom</value></item><item><key>studio</key><value>true</value></item></tagSet></item>
      <item><instanceId>i-0bbb</instanceId><instanceType>t3.micro</instanceType><instanceState><code>0</code><name>pending</name></instanceState><tagSet/></item>
    </instancesSet></item></reservationSet></DescribeInstancesResponse>`;
    assert.deepEqual(parseInstances(xml), [
      { instanceId: 'i-0aaa', name: 'studio-api-hom', type: 't3.small', state: 'running', publicIp: '52.6.45.238', studio: true },
      { instanceId: 'i-0bbb', name: null, type: 't3.micro', state: 'pending', publicIp: null, studio: false },
    ]);
  });

  it('reads the error code and message of an XML answer', () => {
    assert.equal(xmlText('<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized &amp; denied</Message></Error></Errors></Response>', 'Message'), 'You are not authorized & denied');
  });
});

describe('parseDnsRecord', () => {
  it('turns the records Amplify asks for into full names', () => {
    assert.deepEqual(parseDnsRecord('_3674b47b.v2.globalfarm.com.br. CNAME _335c3724.acm-validations.aws.', 'v2.globalfarm.com.br'), {
      name: '_3674b47b.v2.globalfarm.com.br',
      type: 'CNAME',
      value: '_335c3724.acm-validations.aws',
    });
    assert.deepEqual(parseDnsRecord(' CNAME d3iquxablloh54.cloudfront.net', 'v2.globalfarm.com.br'), { name: 'v2.globalfarm.com.br', type: 'CNAME', value: 'd3iquxablloh54.cloudfront.net' });
    assert.deepEqual(parseDnsRecord('www CNAME d1.cloudfront.net', 'example.com'), { name: 'www.example.com', type: 'CNAME', value: 'd1.cloudfront.net' });
  });
});
