import os
import subprocess
import webbrowser
import ctypes
import urllib.parse
from datetime import datetime
from core.db import get_db

try:
    import psutil
except ImportError:
    psutil = None

def book_appointment(customer_name: str, service: str, date: str, time: str) -> dict:
    """Books an appointment for a customer."""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id FROM appointments WHERE date = ? AND time = ?", (date, time))
    existing = cursor.fetchone()
    if existing:
        conn.close()
        return {
            "success": False,
            "message": f"Sorry, the slot on {date} at {time} is already booked. Please choose another time."
        }
        
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        "INSERT INTO appointments (customer_name, service, date, time, status, created_at) VALUES (?, ?, ?, ?, 'Confirmed', ?)",
        (customer_name, service, date, time, created_at)
    )
    appointment_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return {
        "success": True,
        "appointment_id": appointment_id,
        "message": f"Appointment booked successfully for {customer_name} on {date} at {time} for {service}."
    }

def track_lead(name: str, phone: str = "", email: str = "", interest: str = "") -> dict:
    """Records a new customer lead into the database."""
    conn = get_db()
    cursor = conn.cursor()
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    cursor.execute(
        "INSERT INTO leads (name, phone, email, interest, status, created_at) VALUES (?, ?, ?, ?, 'New', ?)",
        (name, phone, email, interest, created_at)
    )
    lead_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return {
        "success": True,
        "lead_id": lead_id,
        "message": f"Lead for {name} has been recorded in the CRM system."
    }

def get_emails_summary(filter_type: str = "all") -> dict:
    """Retrieves and summarizes inbox emails, highlighting urgent ones."""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM emails ORDER BY is_urgent DESC, id DESC")
    emails = [dict(row) for row in cursor.fetchall()]
    conn.close()
    
    urgent_emails = [e for e in emails if e.get("is_urgent") == 1]
    
    if filter_type == "urgent" or urgent_emails:
        urgent_details = "; ".join([f"{e['sender_name']} regarding '{e['subject']}' ({e['snippet']})" for e in urgent_emails])
        speech_text = f"Sir, you have {len(urgent_emails)} urgent emails requiring your attention: {urgent_details}."
    else:
        speech_text = f"Sir, you have {len(emails)} emails in your inbox, and none are marked urgent."
        
    return {
        "success": True,
        "total_emails": len(emails),
        "urgent_count": len(urgent_emails),
        "emails": emails,
        "spoken_summary": speech_text
    }

def get_business_info(topic: str = "all") -> dict:
    """Retrieves business facts, pricing, hours, or services."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM business_info")
    rows = cursor.fetchall()
    conn.close()
    
    info = {row["key"]: row["value"] for row in rows}
    return {
        "success": True,
        "business_info": info
    }

def get_executive_briefing() -> dict:
    """Generates a summary of today's appointments, recent leads, and urgent emails."""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT count(*) as total FROM leads")
    total_leads = cursor.fetchone()["total"]
    
    cursor.execute("SELECT customer_name, service, date, time FROM appointments WHERE status = 'Confirmed' ORDER BY date, time LIMIT 5")
    upcoming_appointments = [dict(row) for row in cursor.fetchall()]

    cursor.execute("SELECT count(*) as urgent_count FROM emails WHERE is_urgent = 1 AND status = 'Unread'")
    urgent_emails_count = cursor.fetchone()["urgent_count"]
    
    conn.close()
    
    return {
        "success": True,
        "total_leads": total_leads,
        "urgent_emails": urgent_emails_count,
        "upcoming_appointments": upcoming_appointments,
        "message": f"Good morning sir. You have {urgent_emails_count} urgent emails, {total_leads} total leads recorded, and {len(upcoming_appointments)} upcoming appointments scheduled."
    }

# ==========================================
# DESKTOP OS SYSTEM MANAGEMENT TOOLS
# ==========================================

APP_SHORTCUTS = {
    "calculator": "calc.exe",
    "calc": "calc.exe",
    "notepad": "notepad.exe",
    "notes": "notepad.exe",
    "spotify": "spotify:",
    "chrome": "chrome.exe",
    "browser": "chrome.exe",
    "vscode": "code",
    "vs code": "code",
    "code": "code",
    "explorer": "explorer.exe",
    "files": "explorer.exe",
    "file explorer": "explorer.exe",
    "terminal": "powershell.exe",
    "cmd": "cmd.exe",
    "paint": "mspaint.exe"
}

def launch_application(app_name: str) -> dict:
    """Launches an application or tool on the user's desktop."""
    clean_name = app_name.lower().strip()
    target = APP_SHORTCUTS.get(clean_name, clean_name)
    try:
        if target.startswith("spotify:"):
            os.startfile(target)
        else:
            # Use subprocess to decouple process
            subprocess.Popen(target, shell=True)
        return {
            "success": True,
            "app": clean_name,
            "message": f"Opening {app_name} on your desktop right away, sir."
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Could not launch {app_name}: {str(e)}"
        }

def system_control(action: str) -> dict:
    """Executes system controls: lock, volume_up, volume_down, volume_mute."""
    action = action.lower().strip()
    try:
        user32 = ctypes.windll.user32
        if "lock" in action:
            user32.LockWorkStation()
            return {"success": True, "action": "lock", "message": "Workstation locked securely, sir."}
        elif "mute" in action:
            # VK_VOLUME_MUTE = 0xAD
            user32.keybd_event(0xAD, 0, 0, 0)
            user32.keybd_event(0xAD, 0, 2, 0)
            return {"success": True, "action": "mute", "message": "Master audio muted, sir."}
        elif "up" in action or "raise" in action:
            # VK_VOLUME_UP = 0xAF
            for _ in range(5):
                user32.keybd_event(0xAF, 0, 0, 0)
                user32.keybd_event(0xAF, 0, 2, 0)
            return {"success": True, "action": "volume_up", "message": "Volume increased, sir."}
        elif "down" in action or "lower" in action:
            # VK_VOLUME_DOWN = 0xAE
            for _ in range(5):
                user32.keybd_event(0xAE, 0, 0, 0)
                user32.keybd_event(0xAE, 0, 2, 0)
            return {"success": True, "action": "volume_down", "message": "Volume decreased, sir."}
        else:
            return {"success": False, "message": f"Unknown system action: {action}"}
    except Exception as e:
        return {"success": False, "message": f"System control error: {str(e)}"}

def get_system_stats() -> dict:
    """Retrieves live CPU usage %, RAM % and Battery status of the computer."""
    stats = {
        "cpu_percent": 0.0,
        "ram_percent": 0.0,
        "ram_used_gb": 0.0,
        "ram_total_gb": 0.0,
        "battery_percent": None,
        "battery_plugged": None,
        "speech_text": "System metrics retrieved."
    }
    try:
        if psutil:
            cpu = psutil.cpu_percent(interval=0.2)
            mem = psutil.virtual_memory()
            battery = psutil.sensors_battery()
            
            stats["cpu_percent"] = cpu
            stats["ram_percent"] = mem.percent
            stats["ram_used_gb"] = round(mem.used / (1024 ** 3), 1)
            stats["ram_total_gb"] = round(mem.total / (1024 ** 3), 1)
            
            battery_text = ""
            if battery:
                stats["battery_percent"] = battery.percent
                stats["battery_plugged"] = battery.power_plugged
                charging_str = "plugged in" if battery.power_plugged else "on battery"
                battery_text = f", and battery is at {battery.percent}% ({charging_str})"
            
            stats["speech_text"] = (
                f"Sir, system performance is optimal: CPU load is at {cpu}%, "
                f"RAM usage is at {mem.percent}% ({stats['ram_used_gb']} GB of {stats['ram_total_gb']} GB){battery_text}."
            )
            stats["success"] = True
            return stats
    except Exception as e:
        stats["speech_text"] = f"Unable to read system statistics: {str(e)}"
    return stats

def open_website(query_or_url: str) -> dict:
    """Opens a website URL or searches YouTube / Google."""
    target = query_or_url.strip()
    try:
        if target.startswith("http://") or target.startswith("https://"):
            url = target
        elif "." in target and " " not in target:
            url = f"https://{target}"
        elif "youtube" in target.lower():
            clean = target.lower().replace("youtube", "").replace("search", "").replace("for", "").strip()
            url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(clean)}"
        else:
            url = f"https://www.google.com/search?q={urllib.parse.quote(target)}"
            
        webbrowser.open(url)
        return {
            "success": True,
            "url": url,
            "message": f"Opening {target} in your browser, sir."
        }
    except Exception as e:
        return {"success": False, "message": f"Failed to open website: {str(e)}"}

