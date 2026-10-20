const { get, all } = require('../db/database');

/**
 * Product context for AI generation. Only a product the caller explicitly selected, and
 * that belongs to the caller's workspace, is ever used; there is no "first product" or
 * name-based default.
 */
function productError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Returns null when nothing was selected; throws 400/404 for a malformed or foreign id. */
async function resolveSelectedProduct(workspaceId, productId) {
  if (productId === undefined || productId === null || productId === '') return null;
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw productError('Invalid product id.', 400, 'INVALID_PRODUCT');
  const product = await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, pid]);
  if (!product) throw productError('Product not found in this workspace.', 404, 'PRODUCT_NOT_FOUND');
  return product;
}

/**
 * For free-text commands (Mark chat): the workspace product whose full name appears in the
 * message. Returns null when none or more than one product matches.
 */
async function findProductNamedIn(workspaceId, text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  const products = await all('SELECT * FROM digital_products WHERE workspace_id = ?', [workspaceId]);
  const hits = products.filter(p => {
    const name = String(p.name || '').trim().toLowerCase();
    return name.length >= 3 && haystack.includes(name);
  });
  // "Pro Max" wins over "Pro"; two equally long matches (duplicate names) are ambiguous.
  const longest = Math.max(0, ...hits.map(p => p.name.trim().length));
  const best = hits.filter(p => p.name.trim().length === longest);
  return best.length === 1 ? best[0] : null;
}

module.exports = { resolveSelectedProduct, findProductNamedIn };
