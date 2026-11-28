// Local scans that need no network: secrets in shipped code, and the App
// Store rejection pre-scan (purpose strings, export compliance, external
// purchase links, account deletion, placeholder text).
import fs from 'node:fs';
import path from 'node:path';
import { featuresOf } from './profile.mjs';

const SKIP = new Set(['node_modules', '.git', '.liftoff', 'Pods', '.expo', '.gradle', 'DerivedData', '.turbo', '.vercel', 'coverage']);
const TEXT = /\.(m?[jt]sx?|cjs|json|html?|vue|svelte|astro|swift|kt|java|dart|plist|xml|ya?ml|map|txt|md)$/i;
// Build output that ends up on users' devices or in their browser.
const BUILD_DIRS = ['.next/static', 'dist', 'build', 'out', 'web-build', '.output/public'];

export function walk(root, { depth = 7, includeBuild = false, maxBytes = 2_000_000 } = {}) {
  const out = [];
  const visit = (dir, d) => {
    if (d > depth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (!includeBuild && BUILD_DIRS.some((b) => rel === b || rel === b.split('/')[0])) continue;
        visit(abs, d + 1);
      } else if (TEXT.test(e.name)) {
        try {
          if (fs.statSync(abs).size <= maxBytes) out.push(rel);
        } catch {}
      }
    }
  };
  visit(root, 0);
  return out;
}

function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
}

const SECRET_PATTERNS = [
  ['Stripe secret key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/],
  ['GitHub token', /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ['secret in a public env var', /\b(NEXT_PUBLIC|EXPO_PUBLIC|VITE|PUBLIC|REACT_APP)_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE)[A-Z0-9_]*\b/],
];

function serviceRoleJwt(text) {
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') return true;
    } catch {}
  }
  return false;
}

// Secrets in source or build output. `.env*` files are skipped (they should be
// git-ignored; `liftoff verify` flags them separately if git tracks them).
export function scanSecrets(root) {
  const files = walk(root, { includeBuild: true });
  const hits = [];
  for (const f of files) {
    if (/(^|\/)\.env/.test(f) || /(^|\/)(test|tests|__tests__|e2e)\//.test(f) || /\.(test|spec)\./.test(f)) continue;
    const text = read(root, f);
    for (const [kind, re] of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ file: f, kind });
    }
    if (serviceRoleJwt(text)) hits.push({ file: f, kind: 'Supabase service_role key' });
  }
  return hits;
}

// ---------- App Store pre-scan ----------

// Package (or native API) → Info.plist key it needs.
const PERMISSION_PACKAGES = {
  'expo-camera': ['NSCameraUsageDescription'],
  'react-native-vision-camera': ['NSCameraUsageDescription'],
  'expo-image-picker': ['NSPhotoLibraryUsageDescription', 'NSCameraUsageDescription'],
  'expo-media-library': ['NSPhotoLibraryUsageDescription'],
  'expo-location': ['NSLocationWhenInUseUsageDescription'],
  'react-native-geolocation-service': ['NSLocationWhenInUseUsageDescription'],
  'expo-contacts': ['NSContactsUsageDescription'],
  'expo-calendar': ['NSCalendarsUsageDescription'],
  'expo-av': ['NSMicrophoneUsageDescription'],
  'expo-audio': ['NSMicrophoneUsageDescription'],
  'expo-local-authentication': ['NSFaceIDUsageDescription'],
  'expo-tracking-transparency': ['NSUserTrackingUsageDescription'],
  'react-native-ble-plx': ['NSBluetoothAlwaysUsageDescription'],
};
const PERMISSION_APIS = [
  [/AVCaptureDevice|UIImagePickerController\(\)/, 'NSCameraUsageDescription'],
  [/PHPhotoLibrary|PhotosPicker/, 'NSPhotoLibraryUsageDescription'],
  [/CLLocationManager/, 'NSLocationWhenInUseUsageDescription'],
  [/CNContactStore/, 'NSContactsUsageDescription'],
  [/AVAudioRecorder|requestRecordPermission/, 'NSMicrophoneUsageDescription'],
  [/LAContext/, 'NSFaceIDUsageDescription'],
  [/ATTrackingManager/, 'NSUserTrackingUsageDescription'],
  [/EKEventStore/, 'NSCalendarsUsageDescription'],
];
// Expo config plugin option that sets each key.
const EXPO_PLUGIN_OPTION = {
  NSCameraUsageDescription: /cameraPermission/,
  NSPhotoLibraryUsageDescription: /photosPermission/,
  NSLocationWhenInUseUsageDescription: /locationWhenInUsePermission/,
  NSContactsUsageDescription: /contactsPermission/,
  NSCalendarsUsageDescription: /calendarPermission/,
  NSMicrophoneUsageDescription: /microphonePermission/,
  NSFaceIDUsageDescription: /faceIDPermission/,
  NSUserTrackingUsageDescription: /userTrackingPermission/,
};
const VAGUE = /^(allow \$\(PRODUCT_NAME\) to|this app (needs|uses|requires)|needed|required|access)\b/i;

function plistValue(text, key) {
  const m = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

export function storeScan(root, detected = {}) {
  const findings = [];
  const add = (id, ok, detail) => findings.push({ id, ok, detail });
  const pkg = (() => {
    try {
      return JSON.parse(read(root, 'package.json')) || {};
    } catch {
      return {};
    }
  })();
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const appJsonText = read(root, 'app.json');
  let expo = null;
  try {
    expo = JSON.parse(appJsonText)?.expo || null;
  } catch {}
  const files = walk(root);
  const plists = files.filter((f) => /Info\.plist$/.test(f) && !/Pods|Tests/.test(f));
  const plistText = plists.map((f) => read(root, f)).join('\n');
  const infoPlist = expo?.ios?.infoPlist || {};
  const valueOf = (key) => infoPlist[key] ?? plistValue(plistText, key);
  const sources = files.filter((f) => /\.(m?[jt]sx?|swift|kt|dart)$/.test(f) && !/(^|\/)(test|tests|__tests__|e2e)\//.test(f));
  const sourceText = new Map(sources.map((f) => [f, read(root, f)]));

  // Purpose strings.
  const needed = new Set();
  for (const [p, keys] of Object.entries(PERMISSION_PACKAGES)) if (deps[p]) keys.forEach((k) => needed.add(k));
  for (const [, text] of sourceText) for (const [re, key] of PERMISSION_APIS) if (re.test(text)) needed.add(key);
  const problems = [];
  for (const key of needed) {
    const v = valueOf(key);
    const viaPlugin = EXPO_PLUGIN_OPTION[key]?.test(appJsonText);
    if (!v && !viaPlugin) problems.push(`${key} missing`);
    else if (v && (VAGUE.test(v.trim()) || v.trim().length < 20)) problems.push(`${key} too vague ("${v}"): say what the app does with it`);
  }
  if (needed.size) add('ios-purpose', problems.length === 0, problems.length ? problems.join('; ') : `${needed.size} purpose string(s) set`);
  else add('ios-purpose', true, 'no permissions used');

  // Export compliance.
  const enc = expo?.ios?.config?.usesNonExemptEncryption ?? infoPlist.ITSAppUsesNonExemptEncryption ?? (/<key>ITSAppUsesNonExemptEncryption<\/key>/.test(plistText) ? true : undefined);
  add('ios-export', enc !== undefined, enc !== undefined ? 'export compliance declared' : 'set ITSAppUsesNonExemptEncryption (false if you only use HTTPS)');

  // External purchase links in the iOS app (guideline 3.1.1).
  const ext = [];
  for (const [f, text] of sourceText) {
    if (/\.web\.[jt]sx?$/.test(f) || /(^|\/)(api|server|pages\/api|app\/api)\//.test(f)) continue;
    if (/checkout\.stripe\.com|buy\.stripe\.com|redirectToCheckout/.test(text) && detected.platforms?.includes('ios') && !/Platform\.OS\s*[!=]==?\s*['"]web['"]/.test(text)) ext.push(f);
  }
  add('iap-links', ext.length === 0, ext.length ? `Stripe checkout reachable in the iOS app (${ext.slice(0, 3).join(', ')}): use in-app purchase on iOS` : 'no external purchase links');

  // Account deletion.
  const hasAuth = detected.integrations?.supabase || Object.keys(deps).some((d) => /clerk|auth0|next-auth|firebase|supabase/.test(d));
  if (hasAuth) {
    const del = [...sourceText.values()].some((t) => /delete[\s_-]?account|deleteAccount|deleteUser|delete_user/i.test(t));
    add('ios-delete', del, del ? 'account deletion found in code' : 'app has accounts but no account deletion');
  }

  // Placeholder content.
  const lorem = [...sourceText.entries()].filter(([, t]) => /lorem ipsum/i.test(t)).map(([f]) => f);
  add('placeholder', lorem.length === 0, lorem.length ? `placeholder text in ${lorem.slice(0, 3).join(', ')}` : 'no placeholder text');

  // Review notes, with a demo login when the app has sign-in.
  const notes = read(root, 'store/ios/review-notes.md');
  const signIn = detected.steps ? featuresOf(detected).accounts : true;
  const login = /password|demo|test account/i.test(notes);
  if (!notes) add('ios-review-notes', false, 'store/ios/review-notes.md missing');
  else if (!signIn) add('ios-review-notes', true, 'review notes written');
  else add('ios-review-notes', login, login ? 'review notes include a demo login' : 'review notes have no demo login');

  return findings;
}

// Write pre-scan findings into the checklist, the same way verify does:
// passing items are ticked as verified, failing ones are unticked.
export function applyScan(state, findings, at = new Date().toISOString()) {
  for (const f of findings) {
    const cur = state.checklist[f.id];
    if (!cur) continue;
    cur.verify = { ok: f.ok, detail: f.detail, at };
    if (f.ok) Object.assign(cur, { done: true, by: 'verified', at });
    else Object.assign(cur, { done: false, by: null, at: null });
  }
  state.lastScan = { at, findings };
  return state;
}
