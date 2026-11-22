import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

const conversationSchema = new Schema({
  members: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  isGroup: { type: Boolean, default: false },
  title: { type: String, trim: true, maxlength: 80, default: '' },
  lastMessage: { type: Schema.Types.ObjectId, ref: 'Message', default: null }
}, { timestamps: true });
conversationSchema.index({ members: 1, updatedAt: -1 });

const messageSchema = new Schema({
  conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 4000 },
  deliveredTo: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  reactions: [{ user: { type: Schema.Types.ObjectId, ref: 'User' }, emoji: { type: String, maxlength: 8 } }]
}, { timestamps: true });
messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });

export const User = model('User', userSchema);
export const Conversation = model('Conversation', conversationSchema);
export const Message = model('Message', messageSchema);
