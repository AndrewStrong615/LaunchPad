// What an app does, as far as its launch goes: whether it takes payments,
// signs people in, keeps data on a server, sends email, uses AI models,
// takes uploads or shows what people post. Liftoff tailors the launch steps,
// the paperwork on "Needs you", the readiness checks and what a launch
// certificate requires to it, so a simple app isn't asked for Stripe and a
// complex one gets the extra checks it needs.
//
// The scan sees each one in the code (a library for it), as likely (a hint
// such as a pricing page, or what another one implies), or not at all. The
// owner corrects anything that's wrong; what they set wins over the scan.
import fs from 'node:fs';
import path from 'node:path';

// `does` and `doesnt` finish "Checked as an app that…" on a launch report.
export const FEATURES = [
  { id: 'payments', label: 'Takes payments', hint: 'Subscriptions or one-time purchases', does: 'takes payments', doesnt: "doesn't take payments" },
  { id: 'accounts', label: 'People sign in', hint: 'Sign-up, sign-in and accounts', does: 'signs people in', doesnt: 'has no sign-in' },
  { id: 'database', label: 'Saves data on a server', hint: 'A database the app reads and writes', does: 'saves data on a server', doesnt: 'keeps no data on a server' },
  { id: 'email', label: 'Sends email', hint: 'Welcome, receipt or password reset emails', does: 'sends email', doesnt: 'sends no email' },
  { id: 'ai', label: 'Uses AI models', hint: 'Calls OpenAI, Anthropic, Gemini or similar', does: 'uses AI models', doesnt: 'uses no AI models' },
  { id: 'uploads', label: 'People upload files', hint: 'Photos, documents or other files', does: 'takes file uploads', doesnt: 'takes no uploads' },
  { id: 'community', label: 'People post for others', hint: 'Posts, comments, reviews or chat others can see', does: 'shows what people post', doesnt: 'shows nothing people post' },
];
export const FEATURE_IDS = FEATURES.map((f) => f.id);
export const ALL_FEATURES = Object.freeze(Object.fromEntries(FEATURE_IDS.map((id) => [id, true])));

// ---------- reading the code ----------

// Libraries that mean the app does it. A regex matches a package name.
const LIBS = {
  payments: [/^stripe$/, /^@stripe\//, /^react-native-purchases/, /^@revenuecat\//, /^@lemonsqueezy\//, /^@paddle\//, /^react-native-iap$/, /^expo-iap$/, /^expo-in-app-purchases$/, /^@polar-sh\//, /^braintree/, /^@paypal\//, /^purchases_flutter$/, /^in_app_purchase$/, /^flutter_stripe$/],
  accounts: [/^@clerk\//, /^@auth0\//, /^react-native-auth0$/, /^next-auth$/, /^@auth\//, /^lucia$/, /^better-auth$/, /^@kinde-oss\//, /^@supabase\/(ssr|auth-helpers-.*|auth-ui-react)$/, /^@react-native-firebase\/auth$/, /^passport$/, /^@workos-inc\//, /^@stackframe\//, /^expo-auth-session$/, /^expo-apple-authentication$/, /^@react-native-google-signin\//, /^@logto\//, /^@descope\//, /^supertokens-/, /^firebase_auth$/, /^google_sign_in$/, /^sign_in_with_apple$/],
  database: [/^@supabase\/supabase-js$/, /^supabase_flutter$/, /^firebase-admin$/, /^@react-native-firebase\/(firestore|database)$/, /^cloud_firestore$/, /^firebase_database$/, /^@?prisma(\/client)?$/, /^drizzle-orm$/, /^mongoose$/, /^mongodb$/, /^pg$/, /^postgres$/, /^mysql2?$/, /^@planetscale\/database$/, /^@neondatabase\//, /^@libsql\/client$/, /^@vercel\/(postgres|kv)$/, /^i?oredis$/, /^redis$/, /^@upstash\/redis$/, /^convex$/, /^kysely$/, /^typeorm$/, /^sequelize$/, /^knex$/, /^@aws-sdk\/(client|lib)-dynamodb$/, /^appwrite$/, /^pocketbase$/, /^@instantdb\//, /^better-sqlite3$/, /^sqlite3$/],
  email: [/^resend$/, /^postmark$/, /^nodemailer$/, /^@sendgrid\/mail$/, /^mailgun(\.js|-js)$/, /^@react-email\//, /^react-email$/, /^@aws-sdk\/client-sesv?2?$/, /^@mailchimp\/mailchimp_transactional$/, /^@getbrevo\/brevo$/, /^@plunk\/node$/, /^loops$/, /^mailer$/],
  ai: [/^openai$/, /^@anthropic-ai\/sdk$/, /^ai$/, /^@ai-sdk\//, /^@google\/(generative-ai|genai)$/, /^@google-cloud\/vertexai$/, /^langchain$/, /^@langchain\//, /^cohere-ai$/, /^@mistralai\//, /^groq-sdk$/, /^replicate$/, /^together-ai$/, /^llamaindex$/, /^ollama$/, /^@huggingface\/inference$/, /^@fal-ai\//, /^@openrouter\//, /^google_generative_ai$/, /^dart_openai$/, /^firebase_(vertexai|ai)$/],
  uploads: [/^uploadthing$/, /^@uploadthing\//, /^multer$/, /^formidable$/, /^busboy$/, /^@aws-sdk\/(client-s3|s3-request-presigner)$/, /^@vercel\/blob$/, /^cloudinary$/, /^next-cloudinary$/, /^@cloudinary\//, /^expo-(image|document)-picker$/, /^react-native-(image|document)-picker$/, /^@react-native-firebase\/storage$/, /^react-dropzone$/, /^(react-)?filepond$/, /^@uppy\//, /^@supabase\/storage-js$/, /^image_picker$/, /^file_picker$/, /^firebase_storage$/],
  community: [/^stream-chat/, /^@stream-io\//, /^getstream$/, /^@sendbird\//, /^sendbird/, /^talkjs$/, /^@talkjs\//, /^@cometchat\//, /^@liveblocks\/react-comments$/, /^stream_chat_flutter$/],
};

// Files that point at it (when no library says so outright).
const FILE_HINTS = {
  payments: /(^|\/)(pricing|paywall|checkout|billing|subscribe|subscriptions?|upgrade|premium)(\/|\.(m?[jt]sx?|vue|svelte|astro|dart|swift|kt|html?)$)/i,
  accounts: /(^|\/)(log-?in|sign-?in|sign-?up|register|auth|account)(\/|\.(m?[jt]sx?|vue|svelte|astro|dart|swift|kt|html?)$)/i,
  uploads: /(^|\/)uploads?(\/|\.(m?[jt]sx?|vue|svelte|dart|swift|kt)$)/i,
  community: /(^|\/)(comments?|forum|feed|community|chat)(\/|\.(m?[jt]sx?|vue|svelte|dart|swift|kt)$)/i,
};
const FILE_FOUND = {
  database: /(^|\/)(prisma\/schema\.prisma|drizzle\.config\.[jt]s|firestore\.rules|supabase\/migrations\/)/,
};
// Words in the code that point at it.
const TEXT_HINTS = {
  payments: [/checkout\.stripe\.com|buy\.stripe\.com/, 'a Stripe checkout link'],
  uploads: [/type=["']file["']/, 'a file picker'],
};
const SOURCE = /\.(m?[jt]sx?|vue|svelte|astro|dart|swift|kt|html?)$/i;
const SKIP = /(^|\/)(node_modules|\.git|\.next|dist|build|out|Pods|test|tests|__tests__|e2e|fixtures)\//;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Package names from package.json (and pubspec.yaml) at the root and in each
// workspace app.
function packages(root, apps = []) {
  const names = new Set();
  for (const dir of [root, ...apps.map((a) => path.join(root, a.path))]) {
    const pkg = readJson(path.join(dir, 'package.json')) || {};
    for (const k of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) names.add(k);
    let pubspec = '';
    try {
      pubspec = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
    } catch {}
    for (const m of pubspec.matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)) names.add(m[1]);
  }
  return [...names];
}

// Names people know, for the usual libraries; others show as the package name.
const LABEL = {
  stripe: 'Stripe', '@stripe/stripe-js': 'Stripe', '@stripe/react-stripe-js': 'Stripe', '@stripe/stripe-react-native': 'Stripe', 'react-native-purchases': 'RevenueCat', purchases_flutter: 'RevenueCat',
  '@clerk/nextjs': 'Clerk', '@clerk/clerk-react': 'Clerk', '@clerk/clerk-expo': 'Clerk', 'next-auth': 'NextAuth', 'better-auth': 'Better Auth', '@supabase/ssr': 'Supabase Auth',
  '@supabase/supabase-js': 'Supabase', supabase_flutter: 'Supabase', '@prisma/client': 'Prisma', prisma: 'Prisma', 'drizzle-orm': 'Drizzle', mongoose: 'MongoDB', mongodb: 'MongoDB', pg: 'Postgres', convex: 'Convex',
  resend: 'Resend', postmark: 'Postmark', nodemailer: 'Nodemailer', '@sendgrid/mail': 'SendGrid',
  openai: 'OpenAI', '@anthropic-ai/sdk': 'Anthropic', ai: 'The AI SDK', '@google/generative-ai': 'Gemini', '@google/genai': 'Gemini', langchain: 'LangChain', replicate: 'Replicate',
  uploadthing: 'UploadThing', '@vercel/blob': 'Vercel Blob', '@aws-sdk/client-s3': 'S3', cloudinary: 'Cloudinary', 'expo-image-picker': 'The image picker', 'expo-document-picker': 'The document picker', image_picker: 'The image picker',
  'stream-chat': 'Stream Chat', 'stream-chat-react': 'Stream Chat',
};
const PROVIDER = { stripe: 'Stripe', revenuecat: 'RevenueCat', lemonsqueezy: 'Lemon Squeezy', paddle: 'Paddle' };
const found = (why) => ({ how: 'found', why });
const hint = (why) => ({ how: 'hint', why });

// What the code says about each feature, from a fresh scan of `root`.
// `files` are paths relative to the root (state.mjs's shallowFiles).
export function detectFeatures(detected, files = []) {
  const root = detected.root;
  const names = root ? packages(root, detected.apps || []) : [];
  const out = {};
  for (const id of FEATURE_IDS) {
    const lib = names.find((n) => (LIBS[id] || []).some((re) => re.test(n)));
    if (lib) out[id] = found(`${LABEL[lib] || lib} is in the code`);
  }
  const paths = files.map((f) => f.split(path.sep).join('/')).filter((f) => !SKIP.test(f));
  for (const [id, re] of Object.entries(FILE_FOUND)) {
    const f = !out[id] && paths.find((p) => re.test(p));
    if (f) out[id] = found(`${f} is in the code`);
  }
  // From what detect.mjs already knows (older scans keep only that).
  Object.assign(out, fromIntegrations(detected, out));
  for (const [id, re] of Object.entries(FILE_HINTS)) {
    const f = !out[id] && paths.find((p) => re.test(p));
    if (f) out[id] = hint(`${f} is in the code`);
  }
  const textWanted = Object.keys(TEXT_HINTS).filter((id) => !out[id]);
  if (root && textWanted.length) {
    let read = 0;
    for (const f of paths) {
      if (!SOURCE.test(f) || read >= 600 || !textWanted.length) continue;
      let text = '';
      try {
        const abs = path.join(root, f);
        if (fs.statSync(abs).size > 300_000) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      read++;
      for (const id of [...textWanted]) {
        const [re, what] = TEXT_HINTS[id];
        if (re.test(text)) {
          out[id] = hint(`${what} is in ${f}`);
          textWanted.splice(textWanted.indexOf(id), 1);
        }
      }
    }
  }
  return out;
}

// Signals from detect.mjs's integrations, auth and payments.
function fromIntegrations(d, have = {}) {
  const i = d.integrations || {};
  const out = {};
  if (!have.payments && (d.payments || []).length) out.payments = found(`${PROVIDER[d.payments[0]] || d.payments[0]} is in the code`);
  if (!have.accounts && d.auth) out.accounts = found(`${{ clerk: 'Clerk', auth0: 'Auth0', nextAuth: 'NextAuth', firebaseAuth: 'Firebase Auth', supabaseAuth: 'Supabase Auth' }[d.auth] || d.auth} is in the code`);
  if (!have.database && i.supabase) out.database = found('Supabase is in the code');
  if (!have.email && (i.resend || i.postmark)) out.email = found(`${i.resend ? 'Resend' : 'Postmark'} is in the code`);
  // Supabase and Firebase do sign-in as well as data, and Firebase is often only data.
  if (!have.accounts && !out.accounts && (i.supabase || i.firebase)) out.accounts = hint(`${i.supabase ? 'Supabase' : 'Firebase'} is in the code, and apps usually sign people in with it`);
  if (!have.database && !out.database && i.firebase) out.database = hint('Firebase is in the code');
  return out;
}

// ---------- what the app does, all told ----------

// Steps whose progress means the app does it (Pilot set up payments, say),
// even before a rescan sees it in the code. A skipped step means nothing either way.
const STEPS_OF = { payments: ['payments', 'paywall', 'money-test'], accounts: ['auth'], database: ['database'], email: ['email'] };
const STEP_LABEL = { payments: 'Payments', paywall: 'Paywall', 'money-test': 'Purchase flow test', auth: 'Sign-in', database: 'Database', email: 'Email' };
function progressed(state, id) {
  return (STEPS_OF[id] || []).find((s) => {
    const st = state.steps?.[s];
    return st && (['done', 'running', 'blocked'].includes(st.status) || st.provider);
  });
}

// Hosted sign-in that keeps its own users and sends its own emails.
const HOSTED_AUTH = new Set(['clerk', 'auth0', 'firebaseAuth']);

// Each feature with whether it's on and why. Order matters: sign-in follows
// from payments, a database and email from sign-in.
export function resolveProfile(state) {
  const det = state.profile?.detected || fromIntegrations(state);
  const set = state.profile?.set || {};
  const web = (state.platforms || []).includes('web');
  const out = {};
  const pick = (id, implied = null) => {
    const d = det[id] || {};
    const step = progressed(state, id);
    let r;
    if (typeof set[id] === 'boolean') r = { on: set[id], source: 'you', why: null };
    else if (d.how === 'found') r = { on: true, source: 'code', why: d.why };
    else if (step) r = { on: true, source: 'launch', why: `The ${STEP_LABEL[step]} step is under way` };
    else if (d.how === 'hint') r = { on: true, source: 'hint', why: d.why };
    else if (implied) r = { on: true, source: 'hint', why: implied };
    else r = { on: false, source: 'scan', why: null };
    // What the code shows, kept even when the owner says otherwise.
    r.inCode = d.how === 'found' ? d.why : null;
    out[id] = r;
  };
  pick('payments');
  pick('accounts', out.payments.on && web ? 'Paying customers need an account to keep what they bought' : null);
  const hosted = HOSTED_AUTH.has(state.auth);
  pick('database', out.accounts.on && !hosted ? 'Accounts need somewhere to keep each person’s data' : null);
  pick('email', out.accounts.on && !hosted ? 'People who sign in need password reset emails' : null);
  pick('ai');
  pick('uploads');
  pick('community');
  return out;
}

// { payments: true, accounts: false, … }
export function featuresOf(state) {
  const r = resolveProfile(state);
  return Object.fromEntries(FEATURE_IDS.map((id) => [id, r[id].on]));
}

// How big the launch is: simple apps have no payments, sign-in or server
// data; complex ones do many things or ship to several platforms.
export function sizeOf(platforms = [], features = {}) {
  const on = FEATURE_IDS.filter((id) => features[id]).length;
  const weight = on + Math.max(0, platforms.length - 1);
  if (!features.payments && !features.accounts && !features.database && weight <= 1) return 'simple';
  return weight >= 5 ? 'complex' : 'standard';
}
export const SIZE_LABEL = { simple: 'Simple app', standard: 'Standard app', complex: 'Complex app' };

// What the Flight Board and the launch plan show.
export function profileView(state) {
  const r = resolveProfile(state);
  const features = Object.fromEntries(FEATURE_IDS.map((id) => [id, r[id].on]));
  const size = sizeOf(state.platforms || [], features);
  return {
    size,
    sizeLabel: SIZE_LABEL[size],
    confirmedAt: state.profile?.confirmedAt || null,
    features: FEATURES.map((f) => ({ id: f.id, label: f.label, hint: f.hint, on: r[f.id].on, source: r[f.id].source, why: r[f.id].why, inCode: r[f.id].inCode })),
    // Things the code has that the owner says the app doesn't do. A launch
    // report says so, so turning payments off can't quietly skip its checks.
    overridden: FEATURE_IDS.filter((id) => r[id].source === 'you' && !r[id].on && r[id].inCode),
  };
}

// "takes payments, signs people in and sends email"
export function describe(features, { negative = false } = {}) {
  const words = FEATURES.filter((f) => (negative ? !features[f.id] : features[f.id])).map((f) => (negative ? f.doesnt : f.does));
  if (words.length <= 1) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
