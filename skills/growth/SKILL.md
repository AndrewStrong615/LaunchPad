---
name: growth
description: Build in the growth basics while Claude is already in the code - activation event, store review prompt, in-app feedback, email capture, and a launch kit (Product Hunt, X, Reddit, press kit). Used by the growth basics launch step and by next-action advice.
---

# Growth basics

Most launches fail on reach, not on setup. These are cheap to add now.

1. **Activation event.** Decide with the user what "got value" means for this app (first garden bed planned, first recipe cooked from the app…). Track it as `activated` in PostHog, once per user. Pulse uses it to measure how many new users get there.
2. **Review prompt (mobile).** After a success moment (not on first launch, not after an error), call `StoreReview.requestReview()` (`expo-store-review`), `SKStoreReviewController` or the Play In-App Review API. At most once every few months; the OS throttles it anyway.
3. **In-app feedback.** A "Send feedback" item in settings that opens an email to the support address with app version and user id prefilled, or a PostHog survey if analytics is set up.
4. **Email capture on the landing page.** A waitlist or "get updates" form that stores emails (Supabase table or Resend audience) with a clear consent line. Mobile apps before release: a sign-up for the TestFlight or Play test track beta.
5. **Launch kit** in `launch/` as markdown the user edits and posts themselves (never post for them):
   - `product-hunt.md`: name, 60-character tagline, description, first comment from the maker, 3–5 gallery image ideas from the store screenshots.
   - `posts.md`: an X/Threads thread (problem, demo, link), a Reddit post written for one specific subreddit's rules (name it), and a short LinkedIn version.
   - `press-kit.md`: one-paragraph description, founder line, links, icon and screenshots paths.
   - `launch-day.md`: a checklist with times (post, reply to every comment for the first 6 hours, email the waitlist).

Record: `liftoff step growth done`; tick `grow-activation`, `grow-review` (mobile), `grow-feedback`, `land-capture`, `grow-kit`.
