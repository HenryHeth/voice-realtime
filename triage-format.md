# Voice Task Triage Format

## Before the Call
Run: `node scripts/triage-tasks.js`

## The 5 D's — Decision Options:

| Decision | What It Means |
|----------|---------------|
| **DO IT** | Schedule it this sprint, commit to doing it |
| **DELEGATE** | Assign to Henry or someone else |
| **DEFER** | Push to someday/maybe, remove date |
| **DELETE** | Kill it, no longer relevant |
| **DETAIL** | Need more info, read the full note |

## DEFER (Someday) Criteria:

Based on GTD & PARA methodology research:

**Move to Someday when:**
- No urgency — no deadline, no one waiting
- Not aligned with current VVO/priorities  
- Nice-to-have but not essential
- Blocked externally — can't act until something else happens

**DELETE instead if:**
- Triggers guilt, not excitement
- You've mentally declined it 3+ times
- Can't remember why you added it

**Prevent Someday Graveyard:**
- **Joy Test** — excitement = keep, dread = delete
- **90-Day Rule** — untouched 90 days = purge or re-commit
- **Promote Weekly** — move 1+ item to active each week

## Phase 1 Mix (until treadmill cleared):
- 6 treadmill tasks (dated but bumping 3+ months)
- 2 standby >1yr tasks  
- 2 standby <1yr tasks

## Phase 2 Mix (after treadmill cleared):
- 5 standby >1yr tasks
- 5 standby <1yr tasks

## Current Pool:
- Treadmill: 83 tasks
- Standby >1yr: 252 tasks
- Standby <1yr: 0 tasks

## How to Run a Triage Session:
1. Voice Henry calls `triage_tasks` to get the list
2. Present tasks ONE AT A TIME
3. Read: title, age, due date, note preview
4. Ask: "Do it, delegate, defer, delete, or need detail?"
5. Execute the decision immediately
6. Move to next task
