const { run, get, all } = require('../db/database');

const VIDEO_TEMPLATES = {
  school_bus: {
    title: "School Bus Safety & GPS Fleet Reel",
    aspectRatio: "9:16",
    scenes: [
      {
        sceneNumber: 1,
        headline: "Is Your School Bus Fleet Safe?",
        subtext: "Where is bus #14 right now?",
        badge: "SAFETY FIRST",
        gradient: "linear-gradient(135deg, #0b0f19 0%, #1e1b4b 100%)",
        accentColor: "#00f0ff",
        duration: 3
      },
      {
        sceneNumber: 2,
        headline: "Live GPS Fleet Tracking",
        subtext: "Sub-second live location on parents' mobile app",
        badge: "PARENTS APP",
        gradient: "linear-gradient(135deg, #111827 0%, #064e3b 100%)",
        accentColor: "#10b981",
        duration: 4
      },
      {
        sceneNumber: 3,
        headline: "RFID Student Check-In",
        subtext: "Automated instant SMS when child scans onto bus",
        badge: "RFID VERIFIED",
        gradient: "linear-gradient(135deg, #18181b 0%, #4c1d95 100%)",
        accentColor: "#a855f7",
        duration: 4
      },
      {
        sceneNumber: 4,
        headline: "Cut Fuel Costs by 20%",
        subtext: "Automated AI route optimization",
        badge: "COST REDUCTION",
        gradient: "linear-gradient(135deg, #0f172a 0%, #0e7490 100%)",
        accentColor: "#06b6d4",
        duration: 3
      },
      {
        sceneNumber: 5,
        headline: "Marketech.ai School Bus SaaS",
        subtext: "Book your school's 15-minute live demo today",
        badge: "BOOK DEMO",
        gradient: "linear-gradient(135deg, #090d16 0%, #312e81 100%)",
        accentColor: "#00f0ff",
        duration: 4
      }
    ]
  },
  web_mobile_apps: {
    title: "High-Speed App Engineering Promo Reel",
    aspectRatio: "9:16",
    scenes: [
      {
        sceneNumber: 1,
        headline: "Turn Your App Idea Into Reality",
        subtext: "Production-ready MVP in 4-8 weeks",
        badge: "RAPID DELIVERY",
        gradient: "linear-gradient(135deg, #0b0f19 0%, #312e81 100%)",
        accentColor: "#38bdf8",
        duration: 3
      },
      {
        sceneNumber: 2,
        headline: "Flutter + React + Cloud APIs",
        subtext: "Cross-platform iOS and Android with 60 FPS",
        badge: "MODERN TECH",
        gradient: "linear-gradient(135deg, #18181b 0%, #1e3a8a 100%)",
        accentColor: "#60a5fa",
        duration: 4
      },
      {
        sceneNumber: 3,
        headline: "Scale to Millions of Users",
        subtext: "Engineered with microservices & automated CI/CD",
        badge: "ENTERPRISE GRADE",
        gradient: "linear-gradient(135deg, #0f172a 0%, #581c87 100%)",
        accentColor: "#c084fc",
        duration: 4
      },
      {
        sceneNumber: 4,
        headline: "Build with Marketech.ai",
        subtext: "Get your free technical architecture scoping session",
        badge: "GET STARTED",
        gradient: "linear-gradient(135deg, #090d16 0%, #1e1b4b 100%)",
        accentColor: "#38bdf8",
        duration: 4
      }
    ]
  }
};

async function getVideoJobs(workspaceId = 1) {
  const jobs = await all('SELECT * FROM video_jobs WHERE workspace_id = ? ORDER BY id DESC', [workspaceId]);
  return jobs.map(j => ({
    ...j,
    scenes: j.scenes_json ? JSON.parse(j.scenes_json) : []
  }));
}

async function createVideoJob(workspaceId = 1, productKey = 'school_bus') {
  const template = VIDEO_TEMPLATES[productKey] || VIDEO_TEMPLATES.school_bus;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const script = template.scenes.map(s => `${s.headline}: ${s.subtext}`).join(' | ');

  const result = await run(
    `INSERT INTO video_jobs (
      workspace_id, title, aspect_ratio, script_text, scenes_json, output_video_path, status, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'ready', 'Completed', ?, ?)`,
    [workspaceId, template.title, template.aspectRatio, script, JSON.stringify(template.scenes), now, now]
  );

  return {
    id: result.lastID,
    workspaceId,
    title: template.title,
    aspectRatio: template.aspectRatio,
    scenes: template.scenes,
    status: 'Completed',
    createdAt: now
  };
}

module.exports = {
  getVideoJobs,
  createVideoJob,
  VIDEO_TEMPLATES
};
