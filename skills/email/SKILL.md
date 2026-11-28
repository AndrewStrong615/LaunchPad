---
name: email
description: Send transactional email (welcome, receipts, password reset, failed payment) from the app's own domain via Resend (or the SendGrid or Postmark the app already uses), with SPF and DKIM so it lands in the inbox. Used by the email launch step.
---

# Email

1. Pick the sending domain (usually `mail.<domain>` or the domain itself) and save it: `liftoff set email.domain <domain>`.
2. Add the domain in Resend via the API (`liftoff exec --only resend -- curl -sS -X POST https://api.resend.com/domains ...`) and give the user the exact DNS records it returns (SPF on `send.<domain>`, DKIM on `resend._domainkey.<domain>`, MX for bounces). Never change DNS without a yes; if the zone is on Cloudflare and the user agrees, set them through the Cloudflare API. Record `liftoff record email --resource resend:domain:<id>`.
3. Templates in the code (React Email if the app uses React, otherwise plain HTML), in the app's colours, with a plain-text version:
   - Welcome (after sign-up), with one link to the core action.
   - Receipt / "You're on Pro" (from the payments webhook).
   - Password reset: point the auth provider's SMTP at Resend so its emails come from the same domain.
   - Failed payment: "update your card" with a Billing Portal link (from `invoice.payment_failed`).
4. Send from a real address (`hello@`), set `reply-to` to the support address from the landing page.
5. Put `RESEND_API_KEY` in the host's server env vars only.

SendGrid or Postmark already in the app: keep it, with the same templates and domain. SendGrid: authenticate the domain under Sender Authentication (`POST /v3/whitelabel/domains`); verify then asks SendGrid whether it validated the records. Postmark: add the domain as a sender signature and set its DKIM record; Postmark sends from its own return path, so only DKIM is needed. For any other provider, save the DKIM selector it gives with `liftoff set email.dkim <selector>` so verify can find the record.

Check: `liftoff verify --only email-domain` passes once DNS is live (can take a few hours). Send each template to the user's address once.

Record: `liftoff step email done --provider resend`; tick `email-flows` after the test sends arrive. If DNS is waiting on the user: `liftoff task add "Add the email DNS records for <domain>" --blocks`.

## A service Liftoff doesn't list
If the user added the provider themselves (Liftoff Cloud: `customServices` in `liftoff_plan`), keep the goals above and get the how from its docs: read them with `liftoff_docs` (start at the link the user gave; `/llms.txt` or an OpenAPI file are quicker when they exist), call its API with `liftoff_call`, and have the app read the key from the env var named `keyName`. Use its test or sandbox mode. `liftoff verify` can't check it: tick the items you tested yourself (they show as reported), and record the service's name as the provider.
