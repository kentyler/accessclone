---
name: Bug Report
about: Report a bug or unexpected behavior
title: ''
labels: bug
assignees: ''
---

**Describe the bug**
A clear description of what went wrong.

**Steps to reproduce**
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened.

**Screenshots**
If applicable, add screenshots.

**Environment**
- OS: [e.g., Windows 11]
- Browser: [e.g., Chrome 120]
- Node.js version: [e.g., 20.x]
- PostgreSQL version: [e.g., 16.x]

**Server logs**
Any relevant output from the Node.js console.

**Event log**
If possible, check `shared.events` for related entries:
```
SELECT event_type, source, message, created_at
FROM shared.events
ORDER BY created_at DESC LIMIT 10;
```
