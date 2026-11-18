# SAIL Branding Budget Tracker (Bharat Steel)

Tracks the SAIL branding budget earned from HR Coil and Structural lifting (tonnes × ₹100), the quarter lock
(Q1 lifting is spent in Q2, and so on), SAIL approvals, claims, the 25% gifting cap, and quarter-wise Excel reports.

Static page + 4 Vercel serverless routes, data in Neon Postgres. Live at **https://sail.bharatsteels.in**.

## Deploy

1. **Neon** – create a project (e.g. `sail-branding`, region Singapore) in the group Neon org and copy the
   pooled connection string (`postgresql://…-pooler…/neondb?sslmode=require`).
2. **Vercel** – *Add New → Project →* import `BSC23609/sail-branding`. Framework preset: **Other**. No build command.
3. **Environment variables** (Vercel → Settings → Environment Variables), then redeploy:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon connection string |
   | `SESSION_SECRET` | any long random text (32+ characters) – signs the login cookie |
   | `ADMIN_EMAIL` | email of the first admin, e.g. `ai@bharatsteels.in` |
   | `ADMIN_PASSWORD` | that admin's first password (change it after signing in) |

   Tables are created automatically on first load. The first admin is created only while there are no users.
4. **File storage (documents)** – Vercel → Storage → Create → **Blob**, choose **Private** access, and connect it
   to this project. That adds `BLOB_READ_WRITE_TOKEN` automatically; redeploy afterwards. Invoices, creatives,
   SAIL approvals and credit notes are uploaded straight from the browser (up to 100 MB each) and opened only
   through the app after sign-in (short-lived signed links). For a public store instead, set `BLOB_ACCESS=public`.
5. **Domain** – Vercel → Settings → Domains → add `sail.bharatsteels.in`. At your DNS provider add
   a **CNAME** record: name `sail`, value `cname.vercel-dns.com` (use the exact value Vercel shows).

## Roles

- **Admin** – everything, plus budget settings and users (Settings & users tab).
- **Editor** – enters lifting, SAIL release status and branding activities.
- **Viewer** – read only, can download reports.

Forgotten password: an admin resets it under Settings & users.

## Files

```
api/_lib.js   Neon connection, schema, passwords (scrypt), signed session cookie
api/auth.js   POST login | logout | me | change_password
api/data.js   GET  settings, lifting, activities
api/save.js   POST lifting | releases | config | activity | delete_activity
api/users.js  POST list | add | update | reset_password | delete   (admins)
api/upload.js POST upload token for direct browser → Vercel Blob uploads (editors)
api/files.js  GET ?id= open a document · POST register | delete
public/       index.html (the tracker), exceljs.min.js (Excel export), blob-client.js (upload helper), both bundled
```
