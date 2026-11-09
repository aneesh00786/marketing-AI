# Lead ownership and access

Each lead has a **creator** and an **owner**, and can be **shared** with other members of the
workspace. Access is enforced on the server for every lead API; the Leads screen only shows
the actions a person is allowed to take.

## Who can do what

| Person | Sees | Edits, status, notes, AI advice | Deletes | Changes owner / shares |
|---|---|---|---|---|
| Workspace Owner / Admin ("lead admins") | every lead of the workspace | yes | yes | yes |
| Owner of the lead | the lead | yes | yes | no |
| Shared with **Manage** | the lead | yes | no | no |
| Shared with **View only** | the lead | no | no | no |
| Any other member | nothing (the lead is "not found") | — | — | — |

- The member's role still applies on top (for example, an Approver has no `leads.manage`, so cannot edit even their own lead).
- Unassigned leads (no owner) are visible to lead admins only.
- The platform admin viewing a workspace, and the voice agent tool, act as lead admins.
- A member removed from the workspace cannot sign in to it; their shares are deleted at once, and leads they owned stay with the admins to reassign (shown as "no longer a member").

## Where it is enforced

`backend/lib/leadAccess.js` is the single permission service:

- `visibleSql(ctx)`: the WHERE condition for lists, searches, exports, counts and dashboards.
- `requireLeadAccess(ctx, id, need)`: one lead at `view` / `manage` / `owner` / `admin` level. Without access the lead is reported as **404** (its existence is not revealed); with too little access, **403**.
- `allowedLeadIds(ctx, ids)`: filters lead ids sent by the browser (campaign audiences, lists, outreach, playbooks, budgets).
- `newLeadOwnership(ctx, source)`: creator and owner of every new lead, always from the session; ownership in a request body is ignored.

Covered: lead list, search, export, details, create, edit, delete, AI advice and "Rescore all", Excel import, the import's contact-list step, AI Lead Discovery import and live details, social inbox "create lead", the Leads dashboard counts, Command Center, campaign analytics, Mark's chat answers and briefing, email campaign lead picker and selection, Product Emails recipients and batches, contact lists (adding leads), outreach audiences, playbook sends, mail drafts linked to a lead, budget revenue linked to a lead, and the consent endpoint.

Not limited by person (system work, no person behind it): automations' triggers and the unsubscribe / suppression / delivery checks, which must see every lead of the workspace. Automation *actions* run with the access of the member who activated the workflow.

## Data model (migration `053_lead_ownership`)

- `leads.created_by_user_id`, `leads.owner_user_id` (FK users, `ON DELETE SET NULL`, indexed with `workspace_id`).
- `leads.lead_source`: `manual`, `import`, `discovery`, `social`, `phone`, `api`.
- `lead_user_access (workspace_id, lead_id, user_id, access_level 'view'|'manage', granted_by_user_id, created_at, updated_at)`, unique per lead and user, cascades when the lead, user or workspace is deleted.

Leads are never copied to share them. Owner transfers run in one transaction: the new owner's share (now redundant) is removed, and the previous owner keeps nothing, view or manage, as the admin chooses.

## Existing leads

The migration fills in the creator (and makes them the owner) **only from recorded evidence**:

1. the audit log entry `leads.created` for that lead;
2. AI Lead Discovery: the person who ran the search the lead was imported from;
3. a social inbox enquiry turned into a lead (`social.inbox.lead_created`).

Every other existing lead stays **Unassigned**: Excel imports (the old import did not record who imported each row), phone-call leads and anything else without evidence. No lead data is changed or removed.

**Admin review:** Leads → ownership filter **Unassigned** lists them. Tick the leads (or ☑ all shown) and use **Assign owner**. Until then, only Owners and Admins see them.

## Audit trail

`leads.created`, `leads.imported` (with the new lead ids), `leads.updated`, `leads.deleted`, `leads.owner_changed` (previous and new owner), `leads.access_granted`, `leads.access_changed` (previous and new level), `leads.access_revoked`, `leads.exported` (with the ownership filter used). Each entry records the workspace, the lead, who did it and when.
