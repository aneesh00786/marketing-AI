import os
import requests
import socket
from datetime import datetime
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional

from core.db import init_db, get_db
import core.tools as tools

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "sk_f0d956ae277bf6725699d28296b9110bf380495c71635b2d")
AGENT_ID = "agent_0101m51y56p2er5tny5gxe8sha5x"

app = FastAPI(title="Jarvis Business Voice OS", version="1.0.0")

# Enable CORS for ElevenLabs webhooks and browser access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prevent browser from serving stale cached JavaScript
@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

@app.on_event("startup")
def on_startup():
    init_db()

# Signed URL endpoint for authenticated ElevenLabs Conversational AI
@app.get("/api/signed-url")
def api_get_signed_url():
    """Generates an authenticated signed WebSocket URL for the ElevenLabs Agent."""
    try:
        headers = {"xi-api-key": ELEVENLABS_API_KEY}
        url = f"https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id={AGENT_ID}"
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Request schemas for tool calls
class BookAppointmentRequest(BaseModel):
    customer_name: str
    service: str
    date: str
    time: str

class TrackLeadRequest(BaseModel):
    name: str
    phone: Optional[str] = ""
    email: Optional[str] = ""
    interest: Optional[str] = ""

class LaunchAppRequest(BaseModel):
    app_name: str

class SystemControlRequest(BaseModel):
    action: str

class OpenWebsiteRequest(BaseModel):
    target: str

# Tool Endpoints
@app.post("/api/tools/book_appointment")
async def api_book_appointment(req: BookAppointmentRequest):
    result = tools.book_appointment(req.customer_name, req.service, req.date, req.time)
    return JSONResponse(content=result)

@app.post("/api/tools/track_lead")
async def api_track_lead(req: TrackLeadRequest):
    result = tools.track_lead(req.name, req.phone, req.email, req.interest)
    return JSONResponse(content=result)

@app.get("/api/tools/get_emails")
@app.post("/api/tools/get_emails")
async def api_get_emails(filter: Optional[str] = "all"):
    result = tools.get_emails_summary(filter)
    return JSONResponse(content=result)

@app.get("/api/tools/get_business_info")
@app.post("/api/tools/get_business_info")
async def api_get_business_info():
    result = tools.get_business_info()
    return JSONResponse(content=result)

@app.get("/api/tools/get_briefing")
@app.post("/api/tools/get_briefing")
async def api_get_briefing():
    result = tools.get_executive_briefing()
    return JSONResponse(content=result)

@app.post("/api/tools/launch_app")
async def api_launch_app(req: LaunchAppRequest):
    result = tools.launch_application(req.app_name)
    return JSONResponse(content=result)

@app.post("/api/tools/system_control")
async def api_system_control(req: SystemControlRequest):
    result = tools.system_control(req.action)
    return JSONResponse(content=result)

@app.get("/api/tools/system_stats")
@app.post("/api/tools/system_stats")
async def api_system_stats():
    result = tools.get_system_stats()
    return JSONResponse(content=result)

@app.post("/api/tools/open_website")
async def api_open_website(req: OpenWebsiteRequest):
    result = tools.open_website(req.target)
    return JSONResponse(content=result)

# Dashboard Data Endpoints
@app.get("/api/leads")
async def api_get_leads():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM leads ORDER BY id DESC LIMIT 50")
    leads = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return {"leads": leads}

@app.get("/api/appointments")
async def api_get_appointments():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM appointments ORDER BY id DESC LIMIT 50")
    appointments = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return {"appointments": appointments}

@app.get("/api/emails")
async def api_get_all_emails():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM emails ORDER BY is_urgent DESC, id DESC LIMIT 50")
    emails = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return {"emails": emails}

def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

@app.get("/api/status")
async def api_status():
    lan_ip = get_lan_ip()
    return {
        "status": "online",
        "agent_name": "JARVIS Voice OS",
        "voice_engine": "ElevenLabs Conversational AI",
        "agent_id": AGENT_ID,
        "lan_ip": lan_ip,
        "mobile_url": f"http://{lan_ip}:8000"
    }

# Mount static folder
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def root():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "Jarvis API Online"}
