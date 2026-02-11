#!/usr/bin/env node
// Nerve Cord crypto helper
// Usage:
//   node crypto.js keygen                          → generates keypair, prints JSON {publicKey, privateKey}
//   node crypto.js encrypt <publicKeyFile> <text>  → prints base64 encrypted blob
//   node crypto.js decrypt <privateKeyFile> <blob> → prints decrypted text
//
// Hybrid encryption: AES-256-GCM for the message, RSA-OAEP for the AES key

const crypto = require('crypto');
const fs = require('fs');

const cmd = process.argv[2];

if (cmd === 'keygen') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  console.log(JSON.stringify({ publicKey, privateKey }));
}

else if (cmd === 'encrypt') {
  const pubPem = fs.readFileSync(process.argv[3], 'utf8');
  const plaintext = process.argv[4] || fs.readFileSync('/dev/stdin', 'utf8');

  // Generate random AES key + IV
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  // Encrypt message with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Encrypt AES key with RSA public key
  const encKey = crypto.publicEncrypt(
    { key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );

  // Pack: encKey(256) + iv(12) + tag(16) + ciphertext
  const blob = Buffer.concat([encKey, iv, tag, enc]);
  console.log(blob.toString('base64'));
}

else if (cmd === 'decrypt') {
  const privPem = fs.readFileSync(process.argv[3], 'utf8');
  const blob = Buffer.from(process.argv[4] || fs.readFileSync('/dev/stdin', 'utf8').trim(), 'base64');

  // Unpack
  const encKey = blob.subarray(0, 256);
  const iv = blob.subarray(256, 268);
  const tag = blob.subarray(268, 284);
  const enc = blob.subarray(284);

  // Decrypt AES key with RSA private key
  const aesKey = crypto.privateDecrypt(
    { key: privPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    encKey
  );

  // Decrypt message with AES-256-GCM
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  console.log(dec.toString('utf8'));
}

else {
  console.error('Usage: node crypto.js [keygen|encrypt|decrypt] ...');
  process.exit(1);
}
