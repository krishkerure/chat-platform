import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const emojis = ['👍', '❤️', '😂', '😮', '😢'];
const idOf = (value) => typeof value === 'string' ? value : value?._id || value?.id;
const initials = (name = '?') => name.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();

async function request(path, token, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || 'Request failed.');
  return data;
}

export default function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem('gather-session')); } catch { return null; }
  });
  const [authMode, setAuthMode] = useState('login');
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [olderCursor, setOlderCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [notice, setNotice] = useState('');
  const [presence, setPresence] = useState({});
  const socketRef = useRef(null);
  const bottomRef = useRef(null);
  const active = conversations.find(c => idOf(c) === activeId);
  const peer = active?.members?.find(m => idOf(m) !== session?.user?.id);

  const loadConversations = useCallback(async () => {
    if (!session?.token) return;
    const rows = await request('/api/conversations', session.token);
    setConversations(rows);
  }, [session]);

  const loadMessages = useCallback(async (conversationId) => {
    if (!conversationId || !session?.token) return;
    setMessages([]);
    const page = await request(`/api/conversations/${conversationId}/messages`, session.token);
    setMessages(page.messages);
    setOlderCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [session]);

  useEffect(() => {
    if (!session?.token) return;
    loadConversations().catch(e => setNotice(e.message));
    const socket = io(API, { auth: { token: session.token }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect_error', e => setNotice(e.message || 'Could not connect to chat.'));
    socket.on('presence:update', data => setPresence(p => ({ ...p, [data.userId]: data })));
    socket.on('message:new', message => {
      const cid = idOf(message.conversation);
      setConversations(old => old.map(c => idOf(c) === cid ? { ...c, lastMessage: message, updatedAt: message.createdAt } : c).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
      if (cid === activeId) {
        setMessages(old => old.some(m => idOf(m) === idOf(message)) ? old : [...old, message]);
        if (idOf(message.sender) !== session.user.id) {
          socket.emit('message:delivered', { messageId: idOf(message) });
          socket.emit('message:read', { conversationId: cid });
        }
      }
    });
    socket.on('receipt:update', event => setMessages(old => old.map(m => {
      if ((event.messageId && idOf(m) !== event.messageId) || idOf(m.conversation) !== event.conversationId) return m;
      return { ...m, [event.type === 'read' ? 'readBy' : 'deliveredTo']: [...new Set([...(m[event.type === 'read' ? 'readBy' : 'deliveredTo'] || []), event.userId])] };
    })));
    socket.on('reaction:update', ({ messageId, reactions }) => setMessages(old => old.map(m => idOf(m) === messageId ? { ...m, reactions } : m)));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [session, loadConversations, activeId]);

  useEffect(() => { if (activeId) loadMessages(activeId).catch(e => setNotice(e.message)); }, [activeId, loadMessages]);
  useEffect(() => {
    if (!activeId || !socketRef.current) return;
    socketRef.current.emit('conversation:join', { conversationId: activeId }, result => result?.error && setNotice(result.error));
    socketRef.current.emit('message:read', { conversationId: activeId });
  }, [activeId, messages.length]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, activeId]);

  useEffect(() => {
    if (!showSearch || query.trim().length < 2 || !session) { setSearchResults([]); return; }
    const timer = setTimeout(() => request(`/api/users?q=${encodeURIComponent(query.trim())}`, session.token).then(setSearchResults).catch(e => setNotice(e.message)), 220);
    return () => clearTimeout(timer);
  }, [query, showSearch, session]);

  async function authenticate(event) {
    event.preventDefault(); setBusy(true); setNotice('');
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await request(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, null, { method: 'POST', body: JSON.stringify(data) });
      localStorage.setItem('gather-session', JSON.stringify(result)); setSession(result);
    } catch (e) { setNotice(e.message); } finally { setBusy(false); }
  }

  async function openOrCreateChat(user) {
    try {
      const conversation = await request('/api/conversations', session.token, { method: 'POST', body: JSON.stringify({ userId: idOf(user) }) });
      setConversations(old => [conversation, ...old.filter(c => idOf(c) !== idOf(conversation))]);
      setActiveId(idOf(conversation)); setShowSearch(false); setQuery('');
    } catch (e) { setNotice(e.message); }
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeId) return;
    socketRef.current?.emit('message:send', { conversationId: activeId, text }, result => {
      if (result?.error) setNotice(result.error);
      else if (result?.message) setMessages(old => old.some(m => idOf(m) === idOf(result.message)) ? old : [...old, result.message]);
    });
    setDraft(''); setNotice('');
  }

  async function loadOlder() {
    if (!hasMore || !olderCursor || !activeId) return;
    const page = await request(`/api/conversations/${activeId}/messages?before=${olderCursor}`, session.token);
    setMessages(old => [...page.messages, ...old]); setOlderCursor(page.nextCursor); setHasMore(page.hasMore);
  }

  function toggleReaction(message, emoji) {
    socketRef.current?.emit('reaction:toggle', { messageId: idOf(message), emoji }, result => result?.error && setNotice(result.error));
  }

  function signOut() {
    localStorage.removeItem('gather-session'); setSession(null); setConversations([]); setMessages([]); setActiveId(null);
  }

  if (!session) return <main className="auth-page"><section className="auth-card">
    <div className="brand-mark">g<span>.</span></div><p className="eyebrow">A little closer</p>
    <h1>{authMode === 'login' ? 'Welcome back.' : 'Make room for a hello.'}</h1>
    <p className="muted">Your conversations, all in one place.</p>
    <form onSubmit={authenticate} className="auth-form">
      {authMode === 'register' && <label>Your name<input name="name" autoComplete="name" placeholder="Alex Morgan" required minLength="2" /></label>}
      <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>
      <label>Password<input name="password" type="password" autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} placeholder={authMode === 'register' ? 'At least 8 characters' : 'Your password'} minLength="8" required /></label>
      {notice && <p className="notice">{notice}</p>}
      <button className="primary-button" disabled={busy}>{busy ? 'One moment…' : authMode === 'login' ? 'Sign in' : 'Create account'} <span>→</span></button>
    </form>
    <p className="switch-auth">{authMode === 'login' ? 'New around here?' : 'Already have an account?'} <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setNotice(''); }}>{authMode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
  </section><div className="auth-orbit orbit-one"/><div className="auth-orbit orbit-two"/></main>;

  return <main className="app-shell">
    <aside className="sidebar">
      <header className="sidebar-top"><a className="brand" href="#"><span className="brand-mark small">g<span>.</span></span><b>gather</b></a><button className="icon-button new-chat" title="New conversation" onClick={() => setShowSearch(v => !v)}>＋</button></header>
      <div className="profile"><div className="avatar self-avatar">{initials(session.user.name)}</div><div className="profile-copy"><strong>{session.user.name}</strong><span><i className="online-dot"/> Available</span></div><button className="dots-button" title="Sign out" onClick={signOut}>···</button></div>
      <div className="section-heading"><span>MESSAGES</span><span className="count">{conversations.length}</span></div>
      {showSearch && <div className="search-box"><span>⌕</span><input value={query} autoFocus onChange={e => setQuery(e.target.value)} placeholder="Find someone…"/><button onClick={() => { setShowSearch(false); setQuery(''); }}>×</button></div>}
      <div className="conversation-list">
        {showSearch && query.length >= 2 && searchResults.map(person => <button className="conversation-row" key={idOf(person)} onClick={() => openOrCreateChat(person)}><Avatar person={person}/><span className="conversation-copy"><b>{person.name}</b><small>{person.email}</small></span><span className="row-arrow">↗</span></button>)}
        {(!showSearch || query.length < 2) && conversations.map(conversation => {
          const other = conversation.members?.find(m => idOf(m) !== session.user.id);
          const online = presence[idOf(other)]?.online ?? other?.online;
          return <button key={idOf(conversation)} className={`conversation-row ${activeId === idOf(conversation) ? 'selected' : ''}`} onClick={() => setActiveId(idOf(conversation))}>
            <Avatar person={other} online={online}/><span className="conversation-copy"><b>{other?.name || 'Conversation'}</b><small>{conversation.lastMessage?.text || 'Start a conversation'}</small></span><time>{formatTime(conversation.updatedAt)}</time>
          </button>;
        })}
        {!conversations.length && !showSearch && <div className="list-empty"><span>✳</span><p>Your conversations will find a home here.</p><button onClick={() => setShowSearch(true)}>Start a chat</button></div>}
      </div>
      <footer className="sidebar-footer"><div className="secure-icon">⌁</div><span><b>Quietly secure</b><small>Your space, your pace.</small></span></footer>
    </aside>

    <section className="chat-area">
      {active ? <>
        <header className="chat-header"><Avatar person={peer} online={presence[idOf(peer)]?.online ?? peer?.online}/><div className="header-copy"><h2>{peer?.name || 'Conversation'}</h2><p>{(presence[idOf(peer)]?.online ?? peer?.online) ? 'Here now' : peer?.lastSeen ? `Last seen ${formatTime(peer.lastSeen)}` : 'Your conversation'}</p></div><div className="header-actions"><span className="encrypted">⌁ <span>Private conversation</span></span><button title="More options" className="icon-button">···</button></div></header>
        <div className="message-scroll">
          {hasMore && <button className="older-button" onClick={loadOlder}>Load earlier messages</button>}
          {!messages.length && <div className="conversation-start"><div className="start-flower">✳</div><h3>A fresh beginning.</h3><p>Say hello to {peer?.name || 'your friend'} and see where it goes.</p></div>}
          <div className="day-divider"><span>Today</span></div>
          {messages.map((message, index) => {
            const mine = idOf(message.sender) === session.user.id;
            const previous = messages[index - 1];
            const grouped = previous && idOf(previous.sender) === idOf(message.sender) && new Date(message.createdAt) - new Date(previous.createdAt) < 5 * 60_000;
            return <article key={idOf(message)} className={`message-row ${mine ? 'mine' : 'theirs'} ${grouped ? 'grouped' : ''}`}>
              {!mine && !grouped && <Avatar person={message.sender} compact/>}<div className="message-content"><div className="bubble">{message.text}</div>
                <div className="message-meta"><time>{formatTime(message.createdAt)}</time>{mine && <span className="receipt" title={message.readBy?.length ? 'Seen' : message.deliveredTo?.length ? 'Delivered' : 'Sent'}>{message.readBy?.length ? '✓✓' : message.deliveredTo?.length ? '✓✓' : '✓'}</span>}</div>
                {!!message.reactions?.length && <div className="reaction-list">{message.reactions.map(r => <span key={idOf(r.user)}>{r.emoji}</span>)}</div>}
                <div className="reaction-picker">{emojis.map(emoji => <button key={emoji} onClick={() => toggleReaction(message, emoji)} title={`React ${emoji}`}>{emoji}</button>)}</div>
              </div>
            </article>;
          })}
          <div ref={bottomRef}/>
        </div>
        {notice && <div className="inline-notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        <form className="composer" onSubmit={sendMessage}><div className="compose-tools"><button type="button" title="Add an attachment">＋</button><span>Write a message</span></div><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} placeholder={`Message ${peer?.name || ''}…`} rows="1" maxLength="4000"/><div className="composer-bottom"><span>Enter to send <i>·</i> Shift + Enter for a new line</span><button className="send-button" disabled={!draft.trim()} aria-label="Send message">↑</button></div></form>
      </> : <div className="welcome-panel"><div className="welcome-art"><span className="art-circle circle-a"/><span className="art-circle circle-b"/><span className="art-flower">✳</span><span className="art-note note-a">hey you ☀</span><span className="art-note note-b">♡</span></div><p className="eyebrow">GOOD THINGS START HERE</p><h1>Make a little<br/>room for connection.</h1><p>Choose a conversation or start something new.</p><button className="primary-button" onClick={() => setShowSearch(true)}>Find someone <span>→</span></button></div>}
      <div className="corner-note">MADE FOR THE IN BETWEEN <span>✳</span></div>
    </section>
  </main>;
}

function Avatar({ person, online, compact = false }) {
  return <div className={`avatar ${compact ? 'compact-avatar' : ''}`}><span>{initials(person?.name)}</span>{online && <i className="online-dot"/>}</div>;
}
function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
