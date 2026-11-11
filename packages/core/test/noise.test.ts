import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createHandshake,
  generateKeyPair,
  publicKeyOf,
  type KeyPair,
  type NoisePattern,
} from '../src/remote/noise.ts';

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static: string;
  resp_ephemeral: string;
  resp_remote_static?: string;
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

const vectors = (
  JSON.parse(readFileSync(new URL('./fixtures/noise-vectors.json', import.meta.url), 'utf8')) as {
    vectors: Vector[];
  }
).vectors;

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

function pairOf(priv: string): KeyPair {
  const privateKey = hex(priv);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

function runVector(v: Vector, pattern: NoisePattern, handshakeMessages: number): void {
  const initStatic = pairOf(v.init_static);
  const respStatic = pairOf(v.resp_static);
  const init = createHandshake({
    pattern,
    initiator: true,
    s: initStatic,
    ...(v.init_remote_static !== undefined ? { rs: hex(v.init_remote_static) } : {}),
    ...(v.init_psks !== undefined ? { psk: hex(v.init_psks[0]!) } : {}),
    e: pairOf(v.init_ephemeral),
    prologue: hex(v.init_prologue),
  });
  const resp = createHandshake({
    pattern,
    initiator: false,
    s: respStatic,
    ...(v.resp_remote_static !== undefined ? { rs: hex(v.resp_remote_static) } : {}),
    ...(v.resp_psks !== undefined ? { psk: hex(v.resp_psks[0]!) } : {}),
    e: pairOf(v.resp_ephemeral),
    prologue: hex(v.resp_prologue),
  });

  for (let i = 0; i < handshakeMessages; i++) {
    const [writer, reader] = i % 2 === 0 ? [init, resp] : [resp, init];
    const msg = v.messages[i]!;
    const out = writer.writeMessage(hex(msg.payload));
    assert.equal(out.toString('hex'), msg.ciphertext, `握手消息 ${i}`);
    assert.equal(reader.readMessage(out).toString('hex'), msg.payload);
  }
  assert.ok(init.isComplete() && resp.isComplete());
  assert.equal(init.handshakeHash().toString('hex'), v.handshake_hash);
  assert.equal(resp.handshakeHash().toString('hex'), v.handshake_hash);

  const a = init.split();
  const b = resp.split();
  for (let i = handshakeMessages; i < v.messages.length; i++) {
    const msg = v.messages[i]!;
    const [sender, receiver] = i % 2 === 0 ? [a.send, b.recv] : [b.send, a.recv];
    const out = sender.encrypt(hex(msg.payload));
    assert.equal(out.toString('hex'), msg.ciphertext, `传输消息 ${i}`);
    assert.equal(receiver.decrypt(out).toString('hex'), msg.payload);
  }
}

test('noise 向量 XXpsk3', () => {
  const v = vectors.find((x) => x.protocol_name === 'Noise_XXpsk3_25519_ChaChaPoly_SHA256');
  assert.ok(v);
  runVector(v, 'XXpsk3', 3);
});

test('noise 向量 KK', () => {
  const v = vectors.find((x) => x.protocol_name === 'Noise_KK_25519_ChaChaPoly_SHA256');
  assert.ok(v);
  runVector(v, 'KK', 2);
});

test('noise 错误 psk', () => {
  const i = generateKeyPair();
  const r = generateKeyPair();
  const init = createHandshake({ pattern: 'XXpsk3', initiator: true, s: i, psk: Buffer.alloc(32, 1) });
  const resp = createHandshake({ pattern: 'XXpsk3', initiator: false, s: r, psk: Buffer.alloc(32, 2) });
  resp.readMessage(init.writeMessage(Buffer.alloc(0)));
  init.readMessage(resp.writeMessage(Buffer.alloc(0)));
  const third = init.writeMessage(Buffer.alloc(0));
  assert.throws(() => resp.readMessage(third));
});

test('noise KK 错误公钥', () => {
  const known = generateKeyPair();
  const stranger = generateKeyPair();
  const r = generateKeyPair();
  const init = createHandshake({ pattern: 'KK', initiator: true, s: stranger, rs: r.publicKey });
  const resp = createHandshake({ pattern: 'KK', initiator: false, s: r, rs: known.publicKey });
  assert.throws(() => resp.readMessage(init.writeMessage(Buffer.alloc(0))));
});
