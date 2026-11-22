import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { User, Conversation, Message } from './models.js';
import { signToken, verifyToken, requireAuth } from './auth.js';

const app = express();
const server = http.createServer(app);
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: '32kb' }));

let redis;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on('error', (err) => console.error('Redis error:', err.message));
}
const limiterOptions = {
  windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' }
};
if (redis) limiterOptions.store = new RedisStore({ sendCommand: (...args) => redis.call(...args) });
app.use('/api', rateLimit(limiterOptions));

const io = new Server(server, { cors: { origin, credentials: true }, maxHttpBufferSize: 1e6 });
if (redis) {
  const pubClient = new Redis(process.env.REDIS_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 60 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      return res.status(400).json({ error: 'Enter a name, valid email, and password with at least 8 characters.' });
    }
    if (await User.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists.' });
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

app.get('/api/users', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const users = q.length < 2 ? [] : await User.find({ _id: { $ne: req.userId }, name: { $regex: escapeRegex(q), $options: 'i' } }).limit(12).select('name email online lastSeen');
    res.json(users);
  } catch (err) { next(err); }
});

app.get('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const conversations = await Conversation.find({ members: req.userId })
      .sort({ updatedAt: -1 }).populate('members', 'name email online lastSeen')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'name' } });
    res.json(conversations);
  } catch (err) { next(err); }
});

app.post('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const memberId = String(req.body.userId || '');
    if (!mongoose.isValidObjectId(memberId) || memberId === req.userId) return res.status(400).json({ error: 'Choose a valid person to start a chat.' });
    if (!(await User.exists({ _id: memberId }))) return res.status(404).json({ error: 'That person could not be found.' });
    let conversation = await Conversation.findOne({ isGroup: false, members: { $all: [req.userId, memberId], $size: 2 } });
    if (!conversation) conversation = await Conversation.create({ members: [req.userId, memberId] });
    conversation = await conversation.populate('members', 'name email online lastSeen');
    res.status(200).json(conversation);
  } catch (err) { next(err); }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const conversation = await Conversation.findOne({ _id: req.params.id, members: req.userId }).select('_id');
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 20);
    const filter = { conversation: conversation._id };
    if (req.query.before) {
      if (!mongoose.isValidObjectId(req.query.before)) return res.status(400).json({ error: 'Invalid pagination cursor.' });
      const cursor = await Message.findOne({ _id: req.query.before, conversation: conversation._id }).select('createdAt');
      if (!cursor) return res.status(400).json({ error: 'Pagination cursor not found.' });
      filter.$or = [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }];
    }
    const rows = await Message.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).populate('sender', 'name');
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    res.json({ messages, nextCursor: hasMore ? messages[0]?._id : null, hasMore });
  } catch (err) { next(err); }
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    const payload = verifyToken(token);
    const user = await User.findById(payload.sub).select('_id name');
    if (!user) return next(new Error('Account not found'));
    socket.user = user;
    next();
  } catch { next(new Error('Invalid or expired session')); }
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  socket.join(`user:${userId}`);
  await User.updateOne({ _id: userId }, { online: true });
  io.emit('presence:update', { userId, online: true });

  socket.on('conversation:join', async ({ conversationId } = {}, ack = () => {}) => {
    try {
      const conversation = await Conversation.findOne({ _id: conversationId, members: userId }).select('_id members');
      if (!conversation) return ack({ error: 'Conversation not found.' });
      socket.join(`conversation:${conversationId}`);
      const delivered = await Message.updateMany(
        { conversation: conversationId, sender: { $ne: userId }, deliveredTo: { $ne: userId } },
        { $addToSet: { deliveredTo: userId } }
      );
      if (delivered.modifiedCount) io.to(`conversation:${conversationId}`).emit('receipt:update', { conversationId, userId, type: 'delivered' });
      ack({ ok: true });
    } catch { ack({ error: 'Could not join conversation.' }); }
  });

  socket.on('message:send', async ({ conversationId, text } = {}, ack = () => {}) => {
    try {
      const body = String(text || '').trim();
      if (!body || body.length > 4000) return ack({ error: 'Message must be between 1 and 4000 characters.' });
      const conversation = await Conversation.findOne({ _id: conversationId, members: userId }).select('_id members');
      if (!conversation) return ack({ error: 'Conversation not found.' });
      const recipients = conversation.members.filter(id => id.toString() !== userId);
      const message = await Message.create({ conversation: conversationId, sender: userId, text: body, deliveredTo: [] });
      await Conversation.updateOne({ _id: conversationId }, { lastMessage: message._id, updatedAt: new Date() });
      const fullMessage = await message.populate('sender', 'name');
      // One room union reaches an open conversation and online members with one event each.
      const delivery = io.to(`conversation:${conversationId}`);
      for (const recipient of recipients) delivery.to(`user:${recipient}`).emit('message:new', fullMessage);
      ack({ ok: true, message: fullMessage });
    } catch { ack({ error: 'Message could not be sent.' }); }
  });

  socket.on('message:delivered', async ({ messageId } = {}) => updateReceipt(socket, messageId, userId, 'delivered'));
  socket.on('message:read', async ({ conversationId } = {}) => {
    try {
      const conversation = await Conversation.findOne({ _id: conversationId, members: userId }).select('_id');
      if (!conversation) return;
      await Message.updateMany({ conversation: conversationId, sender: { $ne: userId }, readBy: { $ne: userId } }, { $addToSet: { readBy: userId, deliveredTo: userId } });
      io.to(`conversation:${conversationId}`).emit('receipt:update', { conversationId, userId, type: 'read' });
    } catch (err) { console.error('Read receipt failed:', err.message); }
  });
  socket.on('reaction:toggle', async ({ messageId, emoji } = {}, ack = () => {}) => {
    try {
      const allowed = ['👍', '❤️', '😂', '😮', '😢'];
      if (!allowed.includes(emoji)) return ack({ error: 'Reaction not supported.' });
      const message = await Message.findById(messageId);
      if (!message || !(await Conversation.exists({ _id: message.conversation, members: userId }))) return ack({ error: 'Message not found.' });
      const existing = message.reactions.find(r => r.user.toString() === userId);
      if (existing?.emoji === emoji) message.reactions = message.reactions.filter(r => r.user.toString() !== userId);
      else if (existing) existing.emoji = emoji;
      else message.reactions.push({ user: userId, emoji });
      await message.save();
      io.to(`conversation:${message.conversation}`).emit('reaction:update', { messageId, reactions: message.reactions });
      ack({ ok: true });
    } catch { ack({ error: 'Reaction could not be saved.' }); }
  });

  socket.on('disconnect', async () => {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    if (sockets.length) return;
    const lastSeen = new Date();
    await User.updateOne({ _id: userId }, { online: false, lastSeen });
    io.emit('presence:update', { userId, online: false, lastSeen });
  });
});

async function updateReceipt(socket, messageId, userId, type) {
  try {
    const message = await Message.findById(messageId).select('conversation sender');
    if (!message || message.sender.toString() === userId) return;
    const conversation = await Conversation.exists({ _id: message.conversation, members: userId });
    if (!conversation) return;
    const field = type === 'read' ? 'readBy' : 'deliveredTo';
    await Message.updateOne({ _id: messageId }, { $addToSet: { [field]: userId, ...(type === 'read' ? { deliveredTo: userId } : {}) } });
    io.to(`conversation:${message.conversation}`).emit('receipt:update', { conversationId: message.conversation, messageId, userId, type });
  } catch (err) { console.error('Delivery receipt failed:', err.message); }
}

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === 11000) return res.status(409).json({ error: 'That email is already registered.' });
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

function publicUser(user) { return { id: user.id, name: user.name, email: user.email, online: user.online, lastSeen: user.lastSeen }; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const port = Number(process.env.PORT || 4000);
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scalable-chat');
server.listen(port, () => console.log(`Chat API listening on http://localhost:${port}`));

async function shutdown() {
  await mongoose.disconnect();
  await redis?.quit();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
