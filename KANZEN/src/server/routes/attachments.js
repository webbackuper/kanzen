import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { badRequest } from '../lib/errors.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

export default async function attachmentRoutes(app) {
  const { prisma, authz, realtime, cfg, uploadDir } = app;
  const auth = { onRequest: [app.requireUser] };

  app.post('/tasks/:id/attachments', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const file = await req.file();
    if (!file) throw badRequest('Fichier manquant');
    if (!cfg.upload.allowedMime.includes(file.mimetype)) {
      file.file.resume();
      throw badRequest(`Type de fichier non autorisé : ${file.mimetype}`);
    }
    const storageName = crypto.randomUUID(); // jamais le nom fourni par le client
    const tmp = path.join(uploadDir, `.${storageName}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; hash.update(chunk); cb(null, chunk); } });
    try {
      await pipeline(file.file, meter, fs.createWriteStream(tmp, { mode: 0o640 }));
      if (file.file.truncated) throw badRequest(`Fichier trop volumineux (max ${cfg.upload.maxMb} Mo)`);
      fs.renameSync(tmp, path.join(uploadDir, storageName));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // eslint-disable-next-line no-control-regex -- suppression volontaire des caractères de contrôle
    const filename = path.basename(file.filename).replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 200) || 'fichier';
    const attachment = await prisma.attachment.create({
      data: { filename, storageName, mimetype: file.mimetype, size, sha256: hash.digest('hex'), taskId: req.params.id, uploadedById: req.user.id },
      select: { id: true, filename: true, mimetype: true, size: true, uploadedAt: true, task: { select: { column: { select: { boardId: true } } } } },
    });
    await prisma.taskActivity.create({ data: { taskId: req.params.id, actorId: req.user.id, type: 'attachment', data: { filename } } });
    realtime.boardChanged(attachment.task.column.boardId, 'attachment', req);
    const { task: _task, ...out } = attachment;
    return reply.code(201).send({ attachment: out });
  });

  // Téléchargement authentifié : toujours en pièce jointe, sans interprétation possible par le navigateur
  app.get('/attachments/:id/download', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await authz.check(req.user, 'attachment', req.params.id, 'VIEWER');
    const a = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    const filePath = path.join(uploadDir, a.storageName);
    if (!fs.existsSync(filePath)) return reply.code(410).send({ error: 'Fichier absent du stockage' });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(fs.createReadStream(filePath));
  });

  app.delete('/attachments/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'attachment', req.params.id, 'EDITOR');
    const a = await prisma.attachment.delete({ where: { id: req.params.id }, include: { task: { select: { column: { select: { boardId: true } } } } } });
    await app.removeStoredFiles([a.storageName]);
    realtime.boardChanged(a.task.column.boardId, 'attachment', req);
    return { ok: true };
  });
}
