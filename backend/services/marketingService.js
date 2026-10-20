const { run, get, all } = require('../db/database');
const aiEngine = require('./aiEngine');

/**
 * Templates for the core digital products to generate high-performing marketing assets
 */
const PRODUCT_TEMPLATES = {
  thrivewoo: [
    {
      title: "Eliminate Manual Wholesale Invoicing Errors Forever",
      captionText: "Are your field sales reps still scribbling wholesale orders on paper notebooks and phoning the warehouse at 6 PM? ThriveWoo gives your sales force an instant mobile B2B ordering terminal. Scan barcodes, apply negotiated customer tier discounts, verify live warehouse stock, and issue digital invoices in under 15 seconds.",
      hashtags: "#B2BWholesale #VanSales #SupplyChainTech #ERPIntegration #MobileInvoicing #ThriveWoo",
      callToAction: "Book a 15-Minute ThriveWoo Demo",
      platform: "LinkedIn"
    },
    {
      title: "Field Reps Booking Wholesale Orders in 10 Seconds Flat",
      captionText: "Paper order pads cost wholesalers 15+ hours of double-entry every week. With ThriveWoo, your field sales reps book orders, check real-time stock, and print Bluetooth receipts on the spot. Zero lag. 100% accuracy.",
      hashtags: "#Distribution #FieldSales #WholesaleApp #B2BCommerce",
      callToAction: "Try ThriveWoo Free for 14 Days",
      platform: "Twitter"
    },
    {
      title: "From Van to Warehouse: Complete B2B Sales Automation",
      captionText: "Every route delivery driver becomes a top-performing sales rep. Live inventory sync, customer credit limit alerts, instant invoice generation, and route GPS tracking in one seamless mobile application. Modernize your distribution business today.",
      hashtags: "#VanSalesApp #LogisticsTech #DistributionBusiness #WholesaleOrders #B2BSaaS",
      callToAction: "Watch Mobile App Walkthrough",
      platform: "Instagram"
    },
    {
      title: "How Top FMCG & Beverage Wholesalers Scale Route Operations",
      captionText: "Struggling with inventory discrepancies between your warehouse and delivery trucks? Discover how leading distribution companies use ThriveWoo to automate catalog sync, customer-specific pricing, and end-of-day cash reconciliation.",
      hashtags: "#FMCGDistribution #BeverageWholesale #InventoryControl #SaaSTechnology",
      callToAction: "Claim Your Free Route Audit",
      platform: "Facebook"
    }
  ],
  school_bus: [
    {
      title: "Is Your School Bus Fleet Still Operating on Manual Phone Calls?",
      captionText: "Every morning, hundreds of anxious parents wonder if their children reached school safely. Our School Bus Management System provides live GPS bus tracking on parent smartphones, RFID card tap verification on boarding, and instant arrival notifications. Give your school community true peace of mind while cutting fleet fuel costs by 20%.",
      hashtags: "#SchoolSafety #EdTech #SchoolBusTracking #StudentSafety #FleetManagement #TradeSageAI",
      callToAction: "Schedule a 15-Minute Live School Demo",
      platform: "LinkedIn"
    },
    {
      title: "Save Up To 20% on School Transportation Fuel Every Month",
      captionText: "Inefficient routes and idling buses drain school district budgets silently. With automated GPS route optimization, school academies and fleet operators reduce mileage, optimize pickup stops, and receive instant alerts on unauthorized speed. Request your free route audit today.",
      hashtags: "#SchoolTransport #FleetOptimization #SchoolAdministration #SmartFleet #EdTechSaaS",
      callToAction: "Request a Free Fleet Audit",
      platform: "Facebook"
    },
    {
      title: "RFID Student Boarding Alerts: The Gold Standard in School Safety",
      captionText: "The moment a student boards or steps off the school bus, an automated alert pings their parents' mobile app. No more missed stops, no more frantic calls to dispatch. Transform student safety in your school district.",
      hashtags: "#StudentSecurity #RFIDTracking #ParentPeaceOfMind #SchoolLogistics",
      callToAction: "Watch 60-Second Feature Reel",
      platform: "Instagram"
    }
  ],
  web_mobile_apps: [
    {
      title: "Need an MVP in 6 Weeks? Turn Your Product Vision into Production Code",
      captionText: "Stop waiting months for slow agencies. We build scalable, high-performance web applications and cross-platform mobile apps using Flutter, React, and Python FastAPI. Engineered from day one for enterprise security, clean UI/UX, and cloud scaling.",
      hashtags: "#AppDevelopment #FlutterDev #SoftwareEngineering #StartupMVP #CloudScale #TradeSage",
      callToAction: "Book a Technical Discovery Session",
      platform: "LinkedIn"
    },
    {
      title: "Native Mobile Performance with Cross-Platform Speed: Why We Build in Flutter",
      captionText: "Launch simultaneously on iOS and Android with 60 FPS performance, shared business logic, and unified design. Cut your app development and maintenance budget in half without sacrificing quality.",
      hashtags: "#MobileApps #iOSDevelopment #AndroidDev #FlutterAgency #TechInnovation",
      callToAction: "Explore Our Portfolio & Case Studies",
      platform: "Facebook"
    }
  ],
  b2b_sales: [
    {
      title: "Are Your Sales Reps Wasting 60% of Their Day on Data Entry?",
      captionText: "Automate outbound prospecting, email enrichment, and CRM pipeline synchronization. TradeSage AI sales automation agents qualify inbound prospects and book qualified decision-maker demos directly into your calendar.",
      hashtags: "#B2BSales #OutboundSales #SalesAutomation #LeadGeneration #PipelineGrowth",
      callToAction: "Calculate Your Pipeline ROI",
      platform: "LinkedIn"
    }
  ]
};

const PLATFORM_KEYS = { linkedin: 'linkedin', twitter: 'x', x: 'x', instagram: 'instagram', facebook: 'facebook' };
const platformKey = (platform) => PLATFORM_KEYS[String(platform || '').toLowerCase()] || null;

async function getCampaigns(workspaceId = 1) {
  return await all('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id DESC', [workspaceId]);
}

async function createCampaign(workspaceId, campaignData) {
  const { name, objective, targetAudience, channels, briefText } = campaignData;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const result = await run(
    `INSERT INTO campaigns (workspace_id, name, objective, target_audience, channels, brief_text, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)`,
    [workspaceId, name, objective, targetAudience, channels || 'LinkedIn, Facebook', briefText, now]
  );
  return { id: result.lastID, ...campaignData, status: 'Active', createdAt: now };
}

async function getContentItems(workspaceId = 1, status = null) {
  if (status && status !== 'all') {
    return await all('SELECT * FROM content_items WHERE workspace_id = ? AND status = ? ORDER BY id DESC', [workspaceId, status]);
  }
  return await all('SELECT * FROM content_items WHERE workspace_id = ? ORDER BY id DESC', [workspaceId]);
}

async function generateProductPost(workspaceId = 1, campaignId = 1, productKey = 'school_bus') {
  const templates = PRODUCT_TEMPLATES[productKey] || PRODUCT_TEMPLATES.school_bus;
  const picked = templates[Math.floor(Math.random() * templates.length)];
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const result = await run(
    `INSERT INTO content_items (
      workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action, platform, platform_key, status, version, source, created_at
    ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, 'draft', 1, 'template', ?)`,
    [workspaceId, campaignId, picked.title, picked.captionText, picked.hashtags, picked.callToAction, picked.platform, platformKey(picked.platform), now]
  );

  return {
    id: result.lastID,
    workspaceId,
    campaignId,
    title: picked.title,
    captionText: picked.captionText,
    hashtags: picked.hashtags,
    callToAction: picked.callToAction,
    platform: picked.platform,
    status: 'draft',
    createdAt: now
  };
}

async function updateContentStatus(contentId, newStatus, workspaceId = 1) {
  const LEGACY_MAP = { 'Draft': 'draft', 'Pending Approval': 'review', 'Rejected': 'rejected' };
  const target = LEGACY_MAP[newStatus] || newStatus;
  if (!['draft', 'review', 'rejected', 'cancelled'].includes(target)) {
    const err = new Error('Approving, scheduling and publishing happen in Social Media Marketing so they are permission-checked, audited and confirmed by the platform.');
    err.status = 409;
    throw err;
  }
  await run(
    "UPDATE content_items SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status NOT IN ('scheduled', 'publishing', 'published')",
    [target, contentId, workspaceId]
  );

  return await get('SELECT * FROM content_items WHERE id = ?', [contentId]);
}

async function generateAiSocialPost(workspaceId = 1, options = {}) {
  const { productId, productKey, platform = 'LinkedIn', customTopic = '', tone = 'High-Converting B2B', campaignId = null } = options;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  let product = null;
  if (productId) {
    product = await get('SELECT * FROM digital_products WHERE id = ?', [productId]);
  } else if (productKey) {
    const cleanKey = productKey.toLowerCase().replace(/_/g, ' ');
    product = await get('SELECT * FROM digital_products WHERE LOWER(name) LIKE ? OR LOWER(url) LIKE ?', [`%${cleanKey}%`, `%${cleanKey}%`]);
  }

  // Fallback to ThriveWoo if no product found
  if (!product) {
    product = await get("SELECT * FROM digital_products WHERE LOWER(name) LIKE '%thrivewoo%' LIMIT 1");
  }

  const productName = product?.name || 'ThriveWoo B2B Platform';
  const productTagline = product?.tagline || 'Mobile Wholesale Ordering & ERP Catalog Sync';
  const targetAudience = product?.target_audience || 'B2B Wholesalers & Distributors';

  // Construct platform-specific prompt
  const sysPrompt = `You are an elite B2B Social Media Growth Copywriter and Direct-Response Marketer.
Generate a high-converting social media post for ${platform}.
Product: ${productName} (${productTagline})
Target Audience: ${targetAudience}
Tone: ${tone}
${customTopic ? `Campaign Angle / Topic: ${customTopic}` : ''}

Output strictly in JSON format with exactly these keys:
{
  "title": "Short catchy internal title for the post (max 8 words)",
  "caption_text": "The full copy for the ${platform} post. ${platform === 'Twitter' ? 'Keep under 270 characters, punchy and viral.' : 'Include an engaging hook line, 2-3 value bullet points, and clean line spacing.'}",
  "hashtags": "3 to 6 relevant hashtags with hash symbol",
  "call_to_action": "Clear action button text (e.g. 'Book a 15-Minute Live Demo' or 'Claim 14-Day Free Pilot')"
}`;

  let parsed = null;
  try {
    const aiRes = await aiEngine.generateAiResponse(`Write a high-converting ${platform} post for ${productName}. Angle: ${customTopic || 'Accelerating B2B wholesale orders and mobile sales'}`, sysPrompt, workspaceId);
    if (aiRes && aiRes.text) {
      const match = aiRes.text.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    }
  } catch (e) {
    console.warn('generateAiSocialPost AI fallback:', e.message);
  }

  if (!parsed || !parsed.caption_text) {
    const err = new Error('No AI model produced a post. Configure an AI provider (e.g. GROQ_API_KEY) and try again.');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  const insertRes = await run(
    `INSERT INTO content_items (
      workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action, platform, platform_key, status, version, source, created_at
    ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, 'draft', 1, 'roger_chat', ?)`,
    [workspaceId, campaignId, parsed.title, parsed.caption_text, parsed.hashtags, parsed.call_to_action, platform, platformKey(platform), now]
  );

  return {
    id: insertRes.lastID,
    workspace_id: workspaceId,
    campaign_id: campaignId,
    content_type: 'post',
    title: parsed.title,
    caption_text: parsed.caption_text,
    hashtags: parsed.hashtags,
    call_to_action: parsed.call_to_action,
    platform: platform,
    status: 'draft',
    created_at: now,
    product_name: productName
  };
}

async function deleteContentItem(contentId, workspaceId = 1) {
  await run(
    "DELETE FROM content_items WHERE id = ? AND workspace_id = ? AND status NOT IN ('scheduled', 'publishing', 'published')",
    [contentId, workspaceId]
  );
  return { success: true, id: contentId };
}

module.exports = {
  getCampaigns,
  createCampaign,
  getContentItems,
  generateProductPost,
  generateAiSocialPost,
  updateContentStatus,
  deleteContentItem
};

