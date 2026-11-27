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

export function detectProject(dir) {
  const root = path.resolve(dir);
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const expoConfig = readJson(path.join(root, 'app.json'))?.expo;
  const pubspec = readText(path.join(root, 'pubspec.yaml'));

  const platforms = new Set();
  let framework = null;

  if (has('expo') || expoConfig || exists(root, 'app.config.js') || exists(root, 'app.config.ts')) {
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
  };

  return {
    root,
    name,
    slug,
    framework: framework || 'Unknown',
    platforms: [...platforms].sort(),
    integrations,
  };
}
