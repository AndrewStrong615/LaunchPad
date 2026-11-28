// A tiny app with the money-path test ids, and a stand-in for Stripe's hosted
// Checkout on another loopback address (127.0.0.2), for the test browser's tests.
import http from 'node:http';

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>${body}</body></html>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// opts: { upgrade: true, live: false, unlock: true, lock: true, webhookMs: 1200 }
export async function startFakeApp(opts = {}) {
  const o = { upgrade: true, live: false, unlock: true, webhookMs: 1200, ...opts };
  const users = new Map(); // email → { pro }
  const sessions = new Map(); // cs id → { email, paid }
  let port;
  const app = () => `http://127.0.0.1:${port}`;
  const checkout = () => `http://127.0.0.2:${port}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const host = (req.headers.host || '').split(':')[0];
    let raw = '';
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    const who = /(?:^|;\s*)u=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const email = who ? decodeURIComponent(who) : null;
    const html = (body) => res.writeHead(200, { 'content-type': 'text/html' }).end(page(body));
    const go = (to, extra = {}) => res.writeHead(303, { location: to, ...extra }).end();

    if (host === '127.0.0.2') {
      const id = url.pathname.split('/')[3];
      const s = sessions.get(id);
      if (!s) return res.writeHead(404).end();
      if (req.method === 'POST') {
        if (form.get('cardNumber') !== '4242 4242 4242 4242') return html('<div role="alert">Your card was declined.</div>');
        s.paid = true;
        if (o.unlock) setTimeout(() => { users.get(s.email).pro = true; }, o.webhookMs);
        return go(`${app()}/success?session_id=${id}`);
      }
      return html(`<form method="post"><input id="email" name="email" value="${esc(s.email)}" readonly>
        <input id="cardNumber" name="cardNumber"><input id="cardExpiry" name="cardExpiry"><input id="cardCvc" name="cardCvc">
        <input id="billingName" name="billingName"><input id="billingPostalCode" name="billingPostalCode">
        <button type="submit" class="SubmitButton">Subscribe</button></form>`);
    }

    if (url.pathname === '/signup' && req.method === 'POST') {
      const e = form.get('email');
      users.set(e, { pro: false });
      return go('/', { 'set-cookie': `u=${encodeURIComponent(e)}; Path=/` });
    }
    if (url.pathname === '/upgrade' && req.method === 'POST' && email) {
      const id = `cs_${o.live ? 'live' : 'test'}_a1${Math.random().toString(36).slice(2, 12)}`;
      sessions.set(id, { email, paid: false });
      return go(`${checkout()}/c/pay/${id}`);
    }
    if (url.pathname === '/' || url.pathname === '/success') {
      const u = email && users.get(email);
      if (!u) {
        return html(`<form method="post" action="/signup"><input data-testid="signup-email" name="email">
          <input data-testid="signup-password" name="password" type="password"><button data-testid="signup-submit">Sign up</button></form>`);
      }
      return html(`<p>Hi ${esc(email)}</p>${u.pro ? '<p data-testid="pro-active">Pro</p>' : ''}
        ${o.upgrade && !u.pro ? '<form method="post" action="/upgrade"><button data-testid="upgrade-button">Upgrade</button></form>' : ''}`);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  port = server.address().port;
  return {
    url: `${app()}/`,
    checkoutHost: '127.0.0.2',
    users,
    sessions,
    // What Liftoff Cloud's cancel plus the app's webhook do.
    lock(email, ms = 800) {
      setTimeout(() => { if (users.get(email)) users.get(email).pro = false; }, ms);
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
