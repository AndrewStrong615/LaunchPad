// Reads a project directory and works out what kind of app it is:
// which platforms it ships to, which framework it uses, and which
// launch integrations are already wired up.
import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function slugify(name) {
  return String(name || 'app')
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}

function titleCase(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const WEB_FRAMEWORKS = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@remix-run/react', 'Remix'],
  ['vite', 'Vite'],
  ['react-scripts', 'Create React App'],
  ['vue', 'Vue'],
  ['react', 'React'],
];

function detectOne(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const expoConfig = readJson(path.join(root, 'app.json'))?.expo;
  const pubspec = readText(path.join(root, 'pubspec.yaml'));

  const platforms = new Set();
  let framework = null;

  if (has('@capacitor/core')) {
    framework = 'Capacitor';
    platforms.add('web');
    if (has('@capacitor/ios') || exists(root, 'ios')) platforms.add('ios');
    if (has('@capacitor/android') || exists(root, 'android')) platforms.add('android');
  } else if (has('expo') || expoConfig || exists(root, 'app.config.js') || exists(root, 'app.config.ts')) {
    framework = 'Expo';
    platforms.add('ios').add('android');
    if (has('react-native-web') || has('react-dom')) platforms.add('web');
  } else if (has('react-native')) {
    framework = 'React Native';
    platforms.add('ios').add('android');
  } else if (pubspec) {
    framework = 'Flutter';
    if (exists(root, 'ios')) platforms.add('ios');
    if (exists(root, 'android')) platforms.add('android');
    if (exists(root, 'web')) platforms.add('web');
  }

  if (!framework) {
    for (const [dep, label] of WEB_FRAMEWORKS) {
      if (has(dep)) {
        framework = label;
        platforms.add('web');
        break;
      }
    }
  }

  const iosDir = exists(root, 'ios') ? path.join(root, 'ios') : root;
  if (
    listDir(iosDir).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace')) ||
    exists(root, 'Package.swift')
  ) {
    platforms.add('ios');
    framework ||= 'Swift';
  }
  if (exists(root, 'android/build.gradle') || exists(root, 'android/build.gradle.kts') || exists(root, 'app/build.gradle') || exists(root, 'app/build.gradle.kts')) {
    platforms.add('android');
    framework ||= 'Android (Gradle)';
  }
  if (!platforms.size && (exists(root, 'index.html') || exists(root, 'public/index.html'))) {
    platforms.add('web');
    framework ||= 'Static site';
  }

  const rawName =
    expoConfig?.name ||
    (pubspec.match(/^name:\s*(\S+)/m) || [])[1] ||
    pkg.name ||
    path.basename(root);
  const slug = slugify(rawName);
  const name = /[A-Z\s]/.test(rawName) && !rawName.startsWith('@') ? rawName : titleCase(slug);

  const workflows = listDir(path.join(root, '.github/workflows'));
  const dep = (prefix) => Object.keys(deps).some((d) => d.startsWith(prefix));
  const firebaseJson = readJson(path.join(root, 'firebase.json'));
  // Example env files name the database host even when the code only uses a
  // plain Postgres client (pg, postgres.js, Drizzle, Prisma).
  const envExample = ['.env.example', '.env.sample', '.env.local.example', '.env.template'].map((f) => readText(path.join(root, f))).join('\n');
  const integrations = {
    stripe: has('stripe') || has('@stripe/stripe-js') || has('@stripe/stripe-react-native'),
    revenuecat: has('react-native-purchases') || has('@revenuecat/purchases-js') || /purchases_flutter/.test(pubspec),
    supabase: has('@supabase/supabase-js') || /supabase_flutter/.test(pubspec),
    posthog: Object.keys(deps).some((d) => d.startsWith('posthog')) || /posthog/.test(pubspec),
    sentry: Object.keys(deps).some((d) => d.startsWith('@sentry/')) || /sentry/.test(pubspec),
    vercel: exists(root, 'vercel.json') || exists(root, '.vercel'),
    cloudflare: exists(root, 'wrangler.toml') || exists(root, 'wrangler.json') || exists(root, 'wrangler.jsonc'),
    githubActions: workflows.some((f) => /\.ya?ml$/.test(f)),
    eas: exists(root, 'eas.json'),
    fastlane: exists(root, 'fastlane') || exists(root, 'ios/fastlane'),
    lemonsqueezy: has('@lemonsqueezy/lemonsqueezy.js'),
    paddle: has('@paddle/paddle-js') || has('@paddle/paddle-node-sdk'),
    polar: dep('@polar-sh/'),
    firebase: has('firebase') || has('firebase-admin') || has('@react-native-firebase/app') || /firebase_core/.test(pubspec) || exists(root, 'firebase.json'),
    firebaseHosting: !!firebaseJson?.hosting,
    neon: dep('@neondatabase/') || /\.neon\.tech\b/.test(envExample),
    netlify: exists(root, 'netlify.toml') || exists(root, '.netlify') || dep('@netlify/'),
    clerk: dep('@clerk/'),
    auth0: Object.keys(deps).some((d) => d.startsWith('@auth0/') || d === 'react-native-auth0'),
    betterAuth: has('better-auth'),
    nextAuth: has('next-auth') || has('@auth/core'),
    firebaseAuth: has('@react-native-firebase/auth') || /firebase_auth/.test(pubspec) || (has('firebase') && exists(root, 'firebase.json')),
    supabaseAuth: has('@supabase/auth-helpers-nextjs') || has('@supabase/ssr') || /supabase_flutter/.test(pubspec),
    resend: has('resend'),
    postmark: has('postmark'),
    sendgrid: has('@sendgrid/mail'),
  };

  const auth = ['clerk', 'auth0', 'betterAuth', 'nextAuth', 'firebaseAuth', 'supabaseAuth'].find((k) => integrations[k]) || null;
  const payments = ['stripe', 'revenuecat', 'lemonsqueezy', 'paddle', 'polar'].filter((k) => integrations[k]);

  return {
    root,
    name,
    slug,
    framework: framework || 'Unknown',
    platforms: [...platforms].sort(),
    integrations,
    auth,
    payments,
    packageManager: packageManager(root),
  };
}

function packageManager(root) {
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun';
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'package-lock.json')) return 'npm';
  if (exists(root, 'pubspec.lock')) return 'pub';
  return null;
}

// Workspace folders of a monorepo (package.json workspaces, pnpm-workspace.yaml,
// or the usual apps/* and packages/* layout) that look like apps.
function workspaceApps(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  let globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  const pnpm = readText(path.join(root, 'pnpm-workspace.yaml'));
  for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)) globs.push(m[1]);
  if (!globs.length && (exists(root, 'apps') || exists(root, 'turbo.json'))) globs = ['apps/*'];
  const dirs = new Set();
  for (const g of globs) {
    if (g.startsWith('!')) continue;
    const base = g.replace(/\/\*+$/, '');
    if (g.endsWith('*')) for (const d of listDir(path.join(root, base))) dirs.add(path.join(base, d));
    else dirs.add(base);
  }
  return [...dirs].filter((d) => exists(root, path.join(d, 'package.json')) || exists(root, path.join(d, 'pubspec.yaml')));
}

const ANY = (objs, key) => objs.some((o) => o.integrations[key]);

export function detectProject(dir) {
  const root = path.resolve(dir);
  const top = detectOne(root);
  const parts = workspaceApps(root).map((rel) => ({ path: rel, ...detectOne(path.join(root, rel)) })).filter((a) => a.framework !== 'Unknown');
  if (!parts.length) return { ...top, apps: [] };
  // A monorepo: one launch for the whole product, platforms and integrations merged.
  const all = [top, ...parts];
  const integrations = Object.fromEntries(Object.keys(top.integrations).map((k) => [k, ANY(all, k)]));
  integrations.githubActions = top.integrations.githubActions;
  const platforms = [...new Set(all.flatMap((a) => a.platforms))].sort();
  const pkgName = (readJson(path.join(root, 'package.json')) || {}).name;
  return {
    ...top,
    name: pkgName ? top.name : parts[0].name,
    framework: [...new Set(parts.map((a) => a.framework))].join(' + '),
    platforms,
    integrations,
    auth: all.map((a) => a.auth).find(Boolean) || null,
    payments: [...new Set(all.flatMap((a) => a.payments))],
    apps: parts.map((a) => ({ path: a.path, framework: a.framework, platforms: a.platforms })),
  };
}
