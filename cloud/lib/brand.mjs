// What people see of the AI behind Liftoff Cloud. The assistant goes by a
// Liftoff name (Pilot unless LIFTOFF_ASSISTANT_NAME says otherwise), runs
// come in two modes instead of model names (MODELS in agent.mjs), and what
// runs use is counted in tokens, Liftoff's own unit, instead of dollars.
//
// Dollars stay on the server: Anthropic budgets sessions in dollars, the
// Launch Pass is a dollar charge on Stripe, and the admin-only run records
// keep the real cost. Everything a signed-in person sees goes through here.
export const DEFAULT_ASSISTANT = 'Pilot';
// 100 tokens for each dollar of model spend: one token is one cent.
export const DEFAULT_TOKENS_PER_USD = 100;

// Letters, digits, spaces and a little punctuation, so the name is safe in
// the system prompt, a page title and a Stripe description alike.
export function assistantName(value) {
  const name = String(value || '').replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return name || DEFAULT_ASSISTANT;
}

export function tokensPerUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOKENS_PER_USD;
}

// Dollars of model spend → tokens (whole tokens), and back.
export const toTokens = (usd, rate) => {
  if (usd === null || usd === undefined || usd === '') return null;
  const n = Number(usd);
  return Number.isFinite(n) ? Math.round(n * rate) : null;
};
export const fromTokens = (tokens, rate) => Number(tokens) / rate;

// "5,000 tokens", "1 token".
export const tokenWord = (n) => {
  const v = Math.round(Number(n) || 0);
  return `${v.toLocaleString('en-US')} token${v === 1 ? '' : 's'}`;
};
