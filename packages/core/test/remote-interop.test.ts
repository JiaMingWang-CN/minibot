import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createHandshake,
  publicKeyOf,
  type CipherState,
  type KeyPair,
  type NoisePattern,
} from '../src/remote/noise.ts';
import { FRAME_KK, FRAME_PAIR, SecureChannel, type Carrier } from '../src/remote/channel.ts';

// 跨语言互通夹具：固定密钥（含固定临时密钥）下 TS 实现产生的全部线上帧。
// Kotlin 端读同一个文件，扮演手机逐帧比对。UPDATE_FIXTURES=1 时重写夹具。
// 夹具只含测试用密钥，不是任何真实设备的密钥。

const FIXTURE = new URL('./fixtures/remote-interop.json', import.meta.url);
const hex = (b: Buffer): string => b.toString('hex');
const unhex = (s: string): Buffer => Buffer.from(s, 'hex');

const pair = (fill: number): KeyPair => {
  const privateKey = Buffer.alloc(32, fill);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
};

const PC_S = pair(0x11);
const PC_E = pair(0x12);
const PHONE_S = pair(0x21);
const PHONE_E = pair(0x22);
const PC_KK_E = pair(0x13);
const PHONE_KK_E = pair(0x23);
const PSK = Buffer.alloc(32, 0x5a);
const PC_PAYLOAD = Buffer.from(JSON.stringify({ pcName: '互通测试电脑' }), 'utf8');
const PHONE_PAYLOAD = Buffer.from(JSON.stringify({ deviceName: '互通测试手机' }), 'utf8');
const DEVICE_ID = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

function handshakePair(pattern: NoisePattern, phoneE: KeyPair, pcE: KeyPair) {
  const phone = createHandshake({
    pattern,
    initiator: true,
    s: PHONE_S,
    ...(pattern === 'KK' ? { rs: PC_S.publicKey } : { psk: PSK }),
    e: phoneE,
  });
  const pc = createHandshake({
    pattern,
    initiator: false,
    s: PC_S,
    ...(pattern === 'KK' ? { rs: PHONE_S.publicKey } : { psk: PSK }),
    e: pcE,
  });
  return { phone, pc };
}

/** 只记录发出的帧的承载 */
function recorder(): Carrier & { sent: Buffer[] } {
  const sent: Buffer[] = [];
  return {
    sent,
    send: (f) => void sent.push(f),
    onFrame: () => {},
    onClose: () => {},
    close: () => {},
  };
}

function channelFrames(send: CipherState, recv: CipherState, messages: unknown[]): string[] {
  const carrier = recorder();
  const channel = new SecureChannel(carrier, send, recv);
  for (const m of messages) channel.send(m);
  return carrier.sent.map(hex);
}

function generate() {
  // 配对：XXpsk3，三条消息都是 [0x01][Noise 消息]
  const px = handshakePair('XXpsk3', PHONE_E, PC_E);
  const pairFrames: Buffer[] = [];
  const m1 = px.phone.writeMessage(Buffer.alloc(0));
  px.pc.readMessage(m1);
  pairFrames.push(Buffer.concat([Buffer.from([FRAME_PAIR]), m1]));
  const m2 = px.pc.writeMessage(PC_PAYLOAD);
  px.phone.readMessage(m2);
  pairFrames.push(Buffer.concat([Buffer.from([FRAME_PAIR]), m2]));
  const m3 = px.phone.writeMessage(PHONE_PAYLOAD);
  px.pc.readMessage(m3);
  pairFrames.push(Buffer.concat([Buffer.from([FRAME_PAIR]), m3]));

  // 日常：KK，首帧 [0x02][deviceId][msg1]，回 [0x02][msg2]
  const kk = handshakePair('KK', PHONE_KK_E, PC_KK_E);
  const k1 = kk.phone.writeMessage(Buffer.alloc(0));
  kk.pc.readMessage(k1);
  const k2 = kk.pc.writeMessage(Buffer.alloc(0));
  kk.phone.readMessage(k2);
  const kkFrames = [
    Buffer.concat([Buffer.from([FRAME_KK]), DEVICE_ID, k1]),
    Buffer.concat([Buffer.from([FRAME_KK]), k2]),
  ];

  // 信道：电脑 → 手机 与 手机 → 电脑各一组；含一条跨 3 个分块的长消息
  const pcSplit = kk.pc.split();
  const phoneSplit = kk.phone.split();
  const longText = 'x'.repeat(65518 * 2 + 1000);
  const pcMessages: unknown[] = [
    { t: 'ready', pcName: '互通测试电脑' },
    { t: 'res', id: 1, status: 200, body: { text: longText } },
    { t: 'evt', event: { type: 'turn', threadId: 'th-1', state: 'idle' } },
  ];
  const phoneMessages: unknown[] = [
    { t: 'req', id: 1, method: 'GET', path: '/api/state' },
    { t: 'ctl', msg: { type: 'abort', threadId: 'th-1' } },
  ];
  const pcFrames = channelFrames(pcSplit.send, pcSplit.recv, pcMessages);
  const phoneFrames = channelFrames(phoneSplit.send, phoneSplit.recv, phoneMessages);

  return {
    pairing: {
      pc: { s: hex(PC_S.privateKey), e: hex(PC_E.privateKey) },
      phone: { s: hex(PHONE_S.privateKey), e: hex(PHONE_E.privateKey) },
      psk: hex(PSK),
      pcPayload: hex(PC_PAYLOAD),
      phonePayload: hex(PHONE_PAYLOAD),
      frames: pairFrames.map(hex),
    },
    kk: {
      pc: { s: hex(PC_S.privateKey), e: hex(PC_KK_E.privateKey) },
      phone: { s: hex(PHONE_S.privateKey), e: hex(PHONE_KK_E.privateKey) },
      deviceId: hex(DEVICE_ID),
      frames: kkFrames.map(hex),
    },
    channel: {
      // 电脑发出的消息与帧（手机用 recv 解开）
      messages: pcMessages,
      frames: pcFrames,
      // 手机发出的消息与帧（手机用 send 生成，电脑用 recv 解开）
      phoneMessages,
      phoneFrames,
    },
  };
}

test('interop 夹具一致', () => {
  const actual = generate();
  if (process.env['UPDATE_FIXTURES'] === '1') {
    writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReturnType<typeof generate>;
  assert.deepEqual(actual, expected);
  // 长消息确实跨 3 个分块（第 2 条消息占 3 帧）
  assert.equal(actual.channel.frames.length, 1 + 3 + 1);
  assert.equal(unhex(actual.kk.deviceId).length, 16);
});

test('interop 夹具可被对端解开', () => {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReturnType<typeof generate>;
  const kk = handshakePair('KK', PHONE_KK_E, PC_KK_E);
  kk.phone.writeMessage(Buffer.alloc(0));
  kk.pc.readMessage(unhex(f.kk.frames[0]!).subarray(1 + 16));
  kk.phone.readMessage(kk.pc.writeMessage(Buffer.alloc(0)));
  const phone = kk.phone.split();
  const pc = kk.pc.split();

  const replay = (frames: string[], send: CipherState, recv: CipherState): unknown[] => {
    const got: unknown[] = [];
    let feed: (b: Buffer) => void = () => {};
    const carrier = { ...recorder(), onFrame: (cb: (b: Buffer) => void) => void (feed = cb) };
    new SecureChannel(carrier, send, recv).onMessage((m) => got.push(m));
    for (const x of frames) feed(unhex(x));
    return got;
  };
  assert.deepEqual(replay(f.channel.frames, phone.send, phone.recv), f.channel.messages);
  assert.deepEqual(replay(f.channel.phoneFrames, pc.send, pc.recv), f.channel.phoneMessages);
});
