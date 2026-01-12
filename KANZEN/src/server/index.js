import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifySocketIO from 'fastify-socket.io'; // NOUVEAU
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { handleUpload } from './logic/upload.js';
import { notifyValidators } from './logic/notifications.js';
import { comparePassword } from './logic/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const fastify = Fastify({ logger: true });

// --- 1. Plugins & Configuration ---

// Sécurité
fastify.register(fastifyCors, { origin: true });
fastify.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'supersecret_fallback_key' 
});

// Websockets (Temps Réel)
fastify.register(fastifySocketIO, {
  cors: { origin: "*" }
});

// Uploads
fastify.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

// Static Files
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../../public'),
  prefix: '/',
});
fastify.register(fastifyStatic, {
  root: UPLOAD_DIR,
  prefix: '/uploads/',
  decorateReply: false
});

// --- 2. Middleware & Events ---

fastify.decorate("authenticate", async function (request, reply) {
  try { await request.jwtVerify(); } catch (err) { reply.send(err); }
});

// Une fois Socket.io prêt
fastify.ready().then(() => {
  fastify.io.on("connection", (socket) => {
    console.log("🔌 Client connecté Socket.io:", socket.id);
  });
});

// Fonction utilitaire pour diffuser les changements
const broadcastUpdate = () => {
  fastify.io.emit("BOARD_UPDATED");
};

// --- 3. Routes API ---

// Auth
fastify.post('/api/login', async (req, reply) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await comparePassword(password, user.password))) {
    return reply.code(401).send({ error: "Identifiants invalides" });
  }
  const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name });
  return { user: { id: user.id, name: user.name, role: user.role }, token };
});

// Board (Données enrichies avec Sous-tâches et Dates)
fastify.get('/api/board/default', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: req.user.id },
    include: { workspace: true }
  });
  if (!membership) return reply.code(404).send({ error: "Aucun espace de travail." });

  const board = await prisma.board.findFirst({
    where: { workspaceId: membership.workspaceId },
    include: { 
      columns: { 
        include: { 
          tasks: { 
            include: { attachments: true, subtasks: true } // Include subtasks
          } 
        },
        orderBy: { order: 'asc' }
      } 
    }
  });
  return board || reply.code(404).send({ error: "Aucun tableau." });
});

// Déplacement Tâche + Socket Broadcast
fastify.post('/api/tasks/move', { onRequest: [fastify.authenticate] }, async (req) => {
  const { taskId, targetColumnId } = req.body;
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { columnId: targetColumnId }
  });

  const col = await prisma.column.findUnique({ where: { id: targetColumnId } });
  if (col && col.title.toLowerCase().includes('review') && task.validatorGroupId) {
    await notifyValidators(prisma, task);
  }

  broadcastUpdate(); // Notifier tous les clients
  return task;
});

// Toggle Subtask (Check/Uncheck)
fastify.post('/api/subtasks/:id/toggle', { onRequest: [fastify.authenticate] }, async (req) => {
  const { id } = req.params;
  const subtask = await prisma.subTask.findUnique({ where: { id } });
  await prisma.subTask.update({
    where: { id },
    data: { completed: !subtask.completed }
  });
  broadcastUpdate();
  return { success: true };
});

// Upload
fastify.post('/api/tasks/:taskId/attachments', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const data = await req.file();
  const attachment = await handleUpload(prisma, req.params.taskId, data);
  broadcastUpdate();
  return attachment;
});

// --- 4. Start ---
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log(`🚀 KanZen v2 running on port 3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();