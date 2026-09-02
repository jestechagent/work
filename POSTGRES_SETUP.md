# PostgreSQL Setup for Render Deployment

## What Changed?

This version uses **PostgreSQL** instead of SQLite. This allows your data to persist permanently on Render (and other cloud platforms).

### Key Differences:
- ✅ Data persists after restarts/redeploys
- ✅ Free PostgreSQL tier on Render
- ✅ Better for production apps
- ✅ No file storage issues

---

## How to Deploy on Render

### Step 1: Create Render Account
Go to https://render.com and sign up (free)

### Step 2: Create PostgreSQL Database
1. Click **"New +"** → **"PostgreSQL"**
2. Configure:
   - Name: `rdr-db` (or whatever)
   - Database: `rdr`
   - User: `postgres`
   - Region: Pick closest to you
3. Click **"Create Database"**
4. Wait 2-3 minutes for database to be ready
5. Copy the **"Internal Database URL"** (starts with `postgres://...`)
   - Save this for Step 5 below

### Step 3: Push Code to GitHub
1. Make sure this updated code is pushed to your GitHub repo
2. Replace your old `server.js` with the new PostgreSQL version
3. Replace `package.json` with the new PostgreSQL version

```bash
git add .
git commit -m "feat: migrate from SQLite to PostgreSQL"
git push origin main
```

### Step 4: Create Web Service
1. Go to Render dashboard
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo (`proxy-forge`)
4. Configure:
   - Name: `rdr` (or your preferred name)
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Click **"Advanced"** → **"Add Environment Variable"**

### Step 5: Add Database URL Environment Variable
This is the CRITICAL step:

1. Click **"Add Environment Variable"**
2. Set:
   - **Key:** `DATABASE_URL`
   - **Value:** Paste the PostgreSQL Internal Database URL from Step 2
     - Should look like: `postgres://postgres:password@internal-db-host:5432/rdr`
3. Click **"Save"**

### Step 6: Deploy
1. Click **"Create Web Service"**
2. Wait 3-5 minutes for build and deployment
3. Once it shows **"Live"** with a checkmark ✅, your app is running!

---

## Local Development (Optional)

### Setup PostgreSQL Locally

#### Mac (with Homebrew):
```bash
brew install postgresql@15
brew services start postgresql@15
```

#### Ubuntu/Linux:
```bash
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql
```

#### Windows:
Download from https://www.postgresql.org/download/windows/

### Create Local Database

```bash
# Connect to PostgreSQL
psql postgres

# Create database
CREATE DATABASE rdr;

# Create user
CREATE USER rdr_user WITH PASSWORD 'your_password';

# Grant permissions
ALTER ROLE rdr_user SUPERUSER;

# Exit psql
\q
```

### Set Local Environment Variable

Create a `.env` file in your project root:

```
DATABASE_URL=postgres://rdr_user:your_password@localhost:5432/rdr
```

### Run Locally

```bash
npm install
npm start
```

Visit: http://localhost:3000

---

## Troubleshooting

### Error: "Cannot connect to database"
- Check that `DATABASE_URL` environment variable is set correctly on Render
- Make sure the PostgreSQL database is fully created (wait 5+ minutes)
- Check database URL has correct password and hostname

### Error: "Database connection failed after 30s"
- The internal database URL might be incorrect
- Use the **Internal Database URL**, not the External one
- Make sure it starts with `postgres://`

### Data Not Persisting
- This should NOT happen with PostgreSQL
- If it does, verify `DATABASE_URL` is actually being used
- Check the Render logs to see if database queries are executing

### Checking Logs on Render
1. Go to your Web Service on Render
2. Click **"Logs"** tab
3. Look for error messages
4. Copy errors and troubleshoot

---

## Important Notes

1. **The free tier on Render includes:**
   - 256 MB PostgreSQL database (plenty for small apps)
   - Auto-backup every 7 days
   - One free PostgreSQL database per account

2. **Data Retention:**
   - Free database resets every 90 days of inactivity
   - To keep forever: Connect to a web service or keep it active

3. **Performance:**
   - PostgreSQL is faster than SQLite for concurrent requests
   - Much better for production use

---

## Summary of Changes in Code

### What's Different:
1. Replaced `sqlite3` with `pg` (PostgreSQL client)
2. Changed all database queries to use PostgreSQL syntax ($1, $2 instead of ?)
3. Uses connection pooling for better performance
4. `datetime()` functions → PostgreSQL timestamp functions
5. Server now listens on `0.0.0.0` for cloud deployment

### No Changes to:
- API endpoints (same as before)
- Frontend (same HTML/CSS/JS)
- Business logic (all the same)

---

## Success!

Once deployed, visit your Render URL (like `https://rdr-xxxxx.onrender.com`) and:
1. Create a proxy
2. Check if it works
3. Data should persist even after restart! ✅

Questions? Check Render's documentation: https://docs.render.com
