# Classroom Dashboard — New Mac Setup

## 1. Copy the Project

```bash
cp -r /Volumes/TheWiseFool/Transfers/classroom-dashboard ~/Projects/classroom-dashboard
```

**IMPORTANT:** Place in `~/Projects/`, NOT in `~/Desktop/` or `~/Documents/` — those are iCloud-synced and will cause issues with node_modules, build artifacts, and large files.

## 2. Restore Claude Memory (Optional)

If you want Claude Code to remember your project context:

```bash
mkdir -p ~/.claude/projects/-Users-$(whoami)/memory
cp ~/Projects/classroom-dashboard/claude-memory/* ~/.claude/projects/-Users-$(whoami)/memory/
```

## 3. Dependencies

This project is a single HTML file with no build tools or package managers. No `npm install` or `pip install` needed.

The only dependency is a simple HTTP server for local preview:

```bash
# Python's built-in server (already on macOS)
cd ~/Projects/classroom-dashboard
python3 -m http.server 8090
```

Then open `http://localhost:8090/dashboard.html` in your browser.

## 4. Claude Code Launch Config

The `.claude/launch.json` is already included. It configures a preview server on port 8090 using Python's HTTP server.

## 5. Verify It Works

1. Start the server: `python3 -m http.server 8090` from the project directory
2. Open `http://localhost:8090/dashboard.html`
3. You should see the AV Health Dashboard with Dallas campus, 21 classrooms, and 12 conference rooms
4. Click a room card to verify the detail view loads (camera controls, device cards, etc.)

## 6. GitHub

This project is **not yet a git repo**. To initialize and push:

```bash
cd ~/Projects/classroom-dashboard
git init
git add .
git commit -m "Initial commit — AV Health Dashboard"
# Then create a repo on GitHub and:
git remote add origin git@github.com:YOUR_USERNAME/classroom-dashboard.git
git push -u origin main
```

## 7. Project Status

- Phase 1 (Static UI) is complete with mock data
- All 33 Dallas rooms are mapped (21 classrooms + 12 conference rooms)
- Canon CR-N300 camera integration uses XC Protocol v011 (HTTP API, no SDK needed)
- Conference rooms use Logitech Rally Bar + Tap + Sight Triple
- 5 hybrid classrooms (CAC 201/202, Todd 216, WSC 333/334) have conference + classroom tech
- Next phases: device config system, live API integration, alert engine, multi-campus rollout

## Key Files

| File | Purpose |
|------|---------|
| `dashboard.html` | The entire dashboard — HTML, CSS, JS all embedded |
| `canon-xc-api-reference.md` | Canon XC Protocol endpoint reference |
| `.claude/launch.json` | Claude Code preview server config |
