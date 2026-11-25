import { describe, it, expect } from 'vitest';
import { hashPassword, comparePassword, authorize } from '../src/server/logic/auth.js';

const fakeReply = () => {
  const r = { statusCode: 200, body: null };
  r.code = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
};

describe('auth', () => {
  it('hache puis vérifie un mot de passe', async () => {
    const h = await hashPassword('S3cret!');
    expect(h).not.toBe('S3cret!');
    expect(await comparePassword('S3cret!', h)).toBe(true);
    expect(await comparePassword('mauvais', h)).toBe(false);
  });

  it('authorize renvoie 401 sans utilisateur', async () => {
    const reply = fakeReply();
    await authorize(['ADMIN'])({}, reply);
    expect(reply.statusCode).toBe(401);
  });

  it('authorize renvoie 403 si le rôle ne correspond pas', async () => {
    const reply = fakeReply();
    await authorize(['ADMIN'])({ user: { role: 'USER' } }, reply);
    expect(reply.statusCode).toBe(403);
  });

  it('authorize laisse passer le bon rôle', async () => {
    const reply = fakeReply();
    await authorize(['ADMIN'])({ user: { role: 'ADMIN' } }, reply);
    expect(reply.statusCode).toBe(200);
  });
});
