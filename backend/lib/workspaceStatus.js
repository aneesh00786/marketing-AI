/**
 * Workspaces that may be used. A deleted workspace (status 'Deleted', restorable for a while, then
 * 'Purged') is closed: nobody signs in to it and background work for it is not picked up.
 * ACTIVE_WORKSPACES is a sub-query for "workspace_id IN ..." filters in worker scans.
 */
const ACTIVE_WORKSPACES = "(SELECT id FROM workspaces WHERE status IS NULL OR status = 'Active')";
const isActiveStatus = status => status === null || status === undefined || status === 'Active';
module.exports = { ACTIVE_WORKSPACES, isActiveStatus };
