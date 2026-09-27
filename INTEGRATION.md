# Olyxee Integration Guide

A practical guide for connecting **Olyxee Admin** (this app) with your
customer-facing **B2B website**.

> **Audience**: business owners + the developer building your public website.
> Read the "Big picture" section first, then jump to the relevant setup.

---

## 1. Big picture

Olyxee is split into **two systems** that talk to each other:

| System              | Who uses it     | What it does                                                                          |
| ------------------- | --------------- | ------------------------------------------------------------------------------------- |
| **Olyxee Admin**    | You + your team | Create customers, create orders, push status updates, manage branding.                |
| **Your website**    | Your customers  | Marketing pages **+ a tracking page** where customers paste/click their tracking ID.  |

```
   ┌────────────────────┐         pushes status         ┌─────────────────────┐
   │   OLYXEE ADMIN     │ ───────  + auto-email  ─────► │  CUSTOMER (inbox)   │
   │   (this app)       │                               └──────────┬──────────┘
   └─────────┬──────────┘                                          │ clicks link
             │                                                     ▼
             │                                          ┌─────────────────────┐
             │                                          │   YOUR WEBSITE      │
             │ ◄────────  reads order status   ─────────│   /track?code=XXX   │
             │            (public API call)             │   (you build this)  │
             └──────────────────────────────────────────┴─────────────────────┘
```

The admin app does **not** show anything to your end customers.
Customer-facing tracking lives on **your own website**, which you build (or already have).
Olyxee just powers the data behind it.

---

## 2. What Olyxee Admin gives you out of the box

Once you log in at `/admin` (or wherever you host this app), you can:

- **Customers** — add the people/companies you ship for.
- **Orders** — create an order for a customer. A unique **Tracking ID**
  (e.g. `OLY-7K3-9PQ4`) is generated automatically. You can also add your
  own internal **Order Reference**.
- **Status updates** — push the order through its lifecycle (Pending → Picked up →
  In transit → Out for delivery → Delivered, plus exception states like
  Delayed, Failed delivery, Returned, Cancelled). Each update can include
  a short message and a location, and it triggers an **email to the customer**
  automatically.
- **Branding** — set your business name, logo, favicon, brand colour, and
  **website URL**. The website URL is what gets used to build tracking links
  in the emails (see section 3).
- **Audit log** — every status change is recorded.
- **Dashboard** — KPIs, recent orders, delivery calendar and timeline.

You do **not** need to build any of this yourself — it's already done.

---

## 3. The single most important setting: your Website URL

Open **Settings → Business** in the admin and fill in **Website URL**, e.g.:

```
https://www.yourcompany.com
```

This is what Olyxee uses to build the tracking link inside every status email.
The link template is:

```
{websiteUrl}/track?code={trackingId}
```

So if your website URL is `https://acme-logistics.com` and the order
tracking ID is `OLY-7K3-9PQ4`, the email will contain a button linking to:

```
https://acme-logistics.com/track?code=OLY-7K3-9PQ4
```

➡ **You must build a page at `/track` on your website that reads `?code=…` and
shows the order status.** That page is described in section 4.

> If you leave the website URL blank, customers still get the email but
> without a clickable tracking button — they only see the tracking ID.

---

## 4. The page you need to build on your website

You need **one** new page on your customer-facing website:

### `GET /track`

**Inputs**

- Query string `?code=XXX` (the tracking ID Olyxee generated).
- Optionally, a search input so a customer who lost the link can paste a code.

**What it should show**

1. The tracking ID (echo it back so they know they're looking at the right thing).
2. The current status with a friendly label and colour (e.g. "Out for delivery").
3. The full timeline of past status updates (date, status, optional message, optional location).
4. Estimated delivery date if set.
5. A short "what next?" line for terminal states (Delivered, Returned, Cancelled).

A simple, mobile-friendly page is enough. Most B2B clients ship this in an
afternoon. If your website is WordPress/Webflow/Wix, this is a custom HTML
block or a small embedded React/Vue widget.

### Recommended layout

```
┌─────────────────────────────────────────────┐
│  ACME LOGISTICS                  [search ▢] │
├─────────────────────────────────────────────┤
│  Tracking  OLY-7K3-9PQ4                     │
│                                             │
│  ● Out for delivery                         │
│    Est. delivery: 18 May 2026               │
├─────────────────────────────────────────────┤
│  Timeline                                   │
│   17 May, 09:12   Out for delivery          │
│                   Joburg Hub                │
│   16 May, 18:40   In transit                │
│   16 May, 08:00   Picked up                 │
│   15 May, 14:22   Order created             │
└─────────────────────────────────────────────┘
```

---

## 5. How your website talks to Olyxee (the data part)

> **Heads up — current limitation.** Today, every order endpoint in the
> Olyxee API requires an admin login. There is **no public tracking endpoint
> yet**. You have two clean options to bridge this. Pick one before going live.

### Option A — Add a public tracking endpoint (recommended)

Add a single read-only endpoint to the API:

```
GET /api/public/track/:trackingId
→ 200 { trackingId, currentStatus, estimatedDeliveryDate, events: [...] }
→ 404 if not found
```

- No login required.
- Returns only the safe fields a customer should see (status, timeline, ETA).
- Does **not** return the customer's full email/phone or internal notes.
- Rate-limit it (e.g. 60 req/min/IP) and cache responses for ~30 seconds.

Your website then calls this endpoint directly from the `/track` page,
either server-side (recommended) or client-side via `fetch()`.

This is the cleanest, most future-proof option. If you'd like, I can scaffold
this endpoint — it's a ~30-line addition to `artifacts/api-server/src/routes/orders.ts`.

### Option B — Use a server-to-server admin token

If you want a single shared service account:

1. Create a dedicated "website" admin user in Olyxee with a long-lived
   token (you'll need to add token-based auth — currently the admin uses
   cookies).
2. Your website's backend stores the token as a secret and calls
   `GET /api/orders?search={trackingId}` on the customer's behalf.
3. Your website strips out anything sensitive before rendering.

This works today with minor tweaks, but you should still build option A
eventually because B leaks more data than necessary and ties your website's
uptime to your admin auth system.

### CORS

Whichever option you pick, add your website's origin to the API's
`ALLOWED_ORIGINS` environment variable so browser requests aren't blocked:

```
ALLOWED_ORIGINS=https://www.yourcompany.com,https://admin.yourcompany.com
```

Multiple origins are comma-separated. Subdomains must be listed explicitly.

---

## 6. End-to-end example

Let's walk through a real shipment:

1. **Customer places an order** (via phone, email, or your website's order form
   — Olyxee doesn't care how it reaches you).
2. **You open Olyxee Admin → Orders → New Order**, pick the customer, optionally
   set an internal reference and ETA. Olyxee generates tracking ID `OLY-7K3-9PQ4`.
3. **Customer receives an email** with subject _"Order received — OLY-7K3-9PQ4"_
   and a button linking to `https://yourcompany.com/track?code=OLY-7K3-9PQ4`.
4. **Customer clicks the link** → lands on your `/track` page → sees status
   "Pending pickup" and an empty timeline.
5. **You collect the parcel**. You go to the order in Olyxee, hit
   **Update**, move the status forward (e.g. "In transit"), add a short
   message and location. Customer gets a fresh email.
6. **Customer refreshes your `/track` page** → sees the new status and a new
   timeline entry. No login, no account, no friction.
7. **Repeat** for In transit → Out for delivery → Delivered. The last email
   is the "delivered" confirmation.

---

## 7. Branding the emails

Emails automatically use:

- Your **business name** (Settings → Branding)
- Your **logo** (Settings → Branding → Logo)
- Your **brand colour** for the button (Settings → Branding → Brand colour)

There is nothing extra to configure. Make sure the logo's background works on
white (emails are rendered on a white background).

---

## 8. Going live checklist

- [ ] Filled in **Business name**, **Website URL**, **Logo**, **Favicon**,
      **Brand colour** in Settings.
- [ ] Built `/track?code=…` on your website.
- [ ] Picked **Option A** (public endpoint) or **Option B** (admin token)
      for fetching data, and wired your `/track` page to it.
- [ ] Added your website's origin to `ALLOWED_ORIGINS` on the API.
- [ ] Sent a test order to your own email and clicked the link end-to-end.
- [ ] Confirmed `robots.txt` on the admin disallows search engines (already
      shipped — admin is `noindex` by default).
- [ ] Trained your dispatcher on the **Update** sheet (status + message + location).

---

## 9. FAQ

**Can my customers log into the admin to see their orders?**
No. The admin is staff-only. Customers track via the public `/track` page
on your website using the tracking ID from their email.

**What if a customer loses the email?**
They can paste their tracking ID into a search box on your `/track` page.
Or your staff can resend the latest status email from the order detail page
in Olyxee.

**Can I customise the email copy per status?**
Yes. In the **Update** sheet, the message field controls the body of the
email. Suggested messages are pre-filled per status but you can rewrite them.

**Where does the customer's email get sent from?**
Olyxee uses Resend. The sender is configured via the `RESEND_API_KEY` and
`EMAIL_FROM_ADDRESS` environment variables on the API server. Use an address
on the Resend-verified `olyxee.com` domain, such as
`notifications@olyxee.com`. The `logistics.olyxee.com` hostname is for the app
deployment, not email sending. Each business supplies the sender display name
and Reply-To address; the platform sender address stays the same.

**Can I have more than one business / brand in one Olyxee install?**
Yes. Each authenticated business has its own customers, orders and email
branding while all businesses use the same verified platform sender domain.

---

## 10. Need help?

Ask in the project chat and I'll either explain or build it.
Common next requests:

- "Add the public tracking endpoint (Option A)."
- "Give me a starter `/track` page in React / plain HTML."
- "Embed tracking as a widget I can paste into Webflow."
