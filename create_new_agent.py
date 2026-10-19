import requests
import json

NEW_API_KEY = "sk_f0d956ae277bf6725699d28296b9110bf380495c71635b2d"
headers = {
    "xi-api-key": NEW_API_KEY,
    "Content-Type": "application/json"
}

# 1. Check available voices
voices_res = requests.get("https://api.elevenlabs.io/v1/voices", headers=headers)
voice_id = "JBFqnCBsd6RMkjVDRZzb" # Default British voice (George) or Adam
if voices_res.status_code == 200:
    voices = voices_res.json().get("voices", [])
    print(f"Total available voices: {len(voices)}")
    # Look for a classic Jarvis voice: George, Charlie, Brian, Daniel, or Adam
    for v in voices:
        if v["name"].lower() in ["george", "charlie", "brian", "daniel", "callum"]:
            voice_id = v["voice_id"]
            print(f"Selected Voice: {v['name']} ({voice_id})")
            break
    else:
        if voices:
            voice_id = voices[0]["voice_id"]
            print(f"Defaulting to Voice: {voices[0]['name']} ({voice_id})")

# 2. Define tools
tools = [
    {
        "type": "client",
        "name": "get_emails",
        "description": "Retrieves and summarizes the user's inbox emails, highlighting any urgent contract reviews, client messages, or alerts.",
        "parameters": {
            "type": "object",
            "properties": {
                "filter": {
                    "type": "string",
                    "description": "Filter emails: 'urgent', 'unread', or 'all'."
                }
            }
        },
        "expects_response": True
    },
    {
        "type": "client",
        "name": "get_leads",
        "description": "Fetches prospective clients and customer inquiries for School Bus Management, Web/Mobile Apps, and B2B Sales.",
        "parameters": {
            "type": "object",
            "properties": {}
        },
        "expects_response": True
    },
    {
        "type": "client",
        "name": "get_appointments",
        "description": "Checks the executive calendar for upcoming booked client meetings, product demos, and consultations.",
        "parameters": {
            "type": "object",
            "properties": {}
        },
        "expects_response": True
    },
    {
        "type": "client",
        "name": "launch_app",
        "description": "Launches an application or desktop tool on the user's computer, such as calculator, notepad, spotify, chrome, vscode, or explorer.",
        "parameters": {
            "type": "object",
            "properties": {
                "app_name": {
                    "type": "string",
                    "description": "Name of the application to launch (e.g., calc, notepad, spotify, chrome, vscode, files, terminal)."
                }
            },
            "required": ["app_name"]
        },
        "expects_response": True
    },
    {
        "type": "client",
        "name": "system_control",
        "description": "Executes hardware desktop controls: locking the computer screen, or controlling master speaker volume.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "The system control action: 'lock' (locks Windows workstation), 'volume_up' (raises volume), 'volume_down' (lowers volume), or 'volume_mute' (mutes audio)."
                }
            },
            "required": ["action"]
        },
        "expects_response": True
    },
    {
        "type": "client",
        "name": "get_system_stats",
        "description": "Retrieves real-time CPU utilization, RAM usage, and battery statistics of the user's computer.",
        "parameters": {
            "type": "object",
            "properties": {}
        },
        "expects_response": True
    },
    {
        "type": "client",
        "name": "open_website",
        "description": "Opens a website URL or searches Google or YouTube in the user's default browser.",
        "parameters": {
            "type": "object",
            "properties": {
                "query_or_url": {
                    "type": "string",
                    "description": "The URL or search phrase to open, e.g. 'youtube lo-fi study music', 'google.com', 'news'."
                }
            },
            "required": ["query_or_url"]
        },
        "expects_response": True
    }
]

system_prompt = (
    "You are JARVIS, an autonomous AI Voice Operating System, Executive Assistant, and Strategic Marketing Consultant.\n\n"
    "YOUR ROLE & PURPOSE:\n"
    "You manage the user's desktop workstation, handle executive business operations, and act as a 24/7 Marketing & Sales Representative for the company's core software products:\n"
    "1. SCHOOL BUS MANAGEMENT SYSTEM:\n"
    "   - Features: Real-time GPS bus tracking, RFID student boarding verification, Parent mobile app with arrival ETA alerts, driver route optimization to reduce fuel costs, and school admin safety console with SOS triggers.\n"
    "   - Sales Goal: When prospects ask about school transport, explain how it enhances child safety and saves schools money. Qualify their fleet size and offer to schedule a live 15-minute dashboard walkthrough.\n\n"
    "2. WEB & MOBILE APPLICATION DEVELOPMENT:\n"
    "   - Features: Production-grade custom web platforms and native iOS/Android apps built with Flutter, React, Python, and scalable cloud backends.\n"
    "   - Sales Goal: Highlight high performance, rapid deployment, and enterprise UI/UX. Qualify their platform requirements (iOS/Android/Web) and schedule a technical discovery consultation.\n\n"
    "3. B2B SALES & ENTERPRISE AUTOMATION SOLUTIONS:\n"
    "   - Features: High-ticket B2B pipeline acceleration, automated CRM workflows, lead enrichment, and executive dashboards.\n"
    "   - Sales Goal: Pitch automated client acquisition and schedule an executive consultation.\n\n"
    "DESKTOP OS & HARDWARE CONTROLS:\n"
    "- To open any application (Calculator, Notepad, Spotify, Chrome, VS Code, etc.), call `launch_app(app_name)`.\n"
    "- To lock workstation, mute, or adjust volume, call `system_control(action)`.\n"
    "- To check CPU, RAM, or battery diagnostics, call `get_system_stats()`.\n"
    "- To search YouTube or the web, call `open_website(query_or_url)`.\n\n"
    "BUSINESS CRM & OPERATIONS:\n"
    "- To check emails or urgent inbox items, call `get_emails()`.\n"
    "- To inspect new prospective clients and marketing leads, call `get_leads()`.\n"
    "- To check scheduled meetings and demos, call `get_appointments()`.\n\n"
    "BEHAVIORAL RULES:\n"
    "- Address the user respectfully as 'Sir' or by their preference.\n"
    "- ALWAYS call the appropriate tool IMMEDIATELY before speaking when an action is requested.\n"
    "- Keep spoken responses crisp, professional, and natural. Never hallucinate food orders or unrelated actions."
)

first_message = "Greetings, sir. Jarvis online and connected to your business operating system. How may I assist you with our marketing products, leads, or system controls today?"

create_payload = {
    "name": "JARVIS Voice OS & Marketing Growth Agent",
    "conversation_config": {
        "agent": {
            "prompt": {
                "prompt": system_prompt,
                "llm": "gpt-4o-mini",
                "temperature": 0.2,
                "tools": tools
            },
            "first_message": first_message,
            "language": "en"
        },
        "tts": {
            "voice_id": voice_id
        },
        "turn": {
            "turn_timeout": 7.0,
            "mode": "turn"
        }
    }
}

print("Creating new ElevenLabs Conversational AI Agent...")
create_url = "https://api.elevenlabs.io/v1/convai/agents/create"
res = requests.post(create_url, headers=headers, json=create_payload)
print("Create Status:", res.status_code)

if res.status_code in [200, 201]:
    data = res.json()
    new_agent_id = data.get("agent_id")
    print("\n========================================================")
    print(" [✓] NEW AGENT CREATED SUCCESSFULLY!")
    print(f" [✓] Agent ID: {new_agent_id}")
    print(f" [✓] Voice ID: {voice_id}")
    print(f" [✓] Tools Configured: {len(tools)}")
    print("========================================================\n")
    with open("c:\\Users\\rgrak\\ai_product\\new_agent_info.json", "w") as f:
        json.dump(data, f, indent=2)
else:
    print("Error creating agent:", res.text)
