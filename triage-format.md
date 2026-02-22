# Voice Task Triage Format

## Before the Call
Run: `node scripts/triage-tasks.js`

## The 5 D's — Decision Options:

| Decision | What It Means | Tag Changes |
|----------|---------------|-------------|
| **DO IT** | Schedule it this sprint, commit to doing it | Add `triaged-MMDD` |
| **DELEGATE** | Assign to Henry or someone else | Add `triaged-MMDD` |
| **DEFER** | No sure when it will be done - push to "someday" tag, remove date | REMOVE `standby`tag, ADD `triaged-MMDD` |
| **DELETE** | Based on Pauls instruction mark with either "delete" tag, or 'obsolete" tag | Do not delete - Paul will delete | ADD `triaged-MMDD` tag |
| **DETAIL** | Need more info, read the full tag title and if wanted the beginning of the note | Then ask about the options again

### ⚠️ VALID TAGS ONLY
The only valid triage tags are: `someday`, `obsolete`, `triaged-MMDD`
There is NO "deferred" tag. DEFER = add `someday` tag.
When adding `someday`, ALWAYS remove `standby` if present.


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
**vary speed based on need. Generally move quickly, unless Paul is thinking, then slow down in those moments.