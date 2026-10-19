import os
import json
from datetime import datetime
from core.db import get_db

TELNYX_API_KEY = os.getenv("TELNYX_API_KEY", "")
TELNYX_PHONE_NUMBER = os.getenv("TELNYX_PHONE_NUMBER", "+1 (800) 555-SAGE")

# Real-time Sales Dialogue Orchestrator for TradeSage AI
def generate_ai_reply(caller_text: str, call_history: list = None, workspace_id: int = 1) -> dict:
    """
    Processes caller speech and generates an authoritative marketing & sales response,
    identifying customer intent for School Bus Management, Web/Mobile Apps, or B2B Sales.
    """
    clean_text = caller_text.lower().strip()
    
    # 1. School Bus Management System inquiries
    if any(k in clean_text for k in ["bus", "school", "fleet", "student", "rfid", "tracking", "gps"]):
        reply = (
            "Our School Bus Management platform gives parents live GPS tracking on their phones, "
            "verifies student RFID boarding, and optimizes routes to cut fuel costs by 20%. "
            "How many buses are in your school's fleet, and would you like a 15-minute live dashboard walkthrough?"
        )
        detected_product = "School Bus Management System"
        
    # 2. Web & Mobile Application Development inquiries
    elif any(k in clean_text for k in ["app", "mobile", "ios", "android", "website", "web", "software", "flutter"]):
        reply = (
            "We build custom, production-grade web platforms and native iOS and Android apps "
            "using Flutter, React, and Python, tailored for high speed and scale. "
            "What type of application are you planning, and what is your target launch timeline?"
        )
        detected_product = "Custom Web & Mobile App Development"
        
    # 3. B2B Sales & Pipeline Automation inquiries
    elif any(k in clean_text for k in ["sale", "b2b", "lead", "pipeline", "outbound", "crm"]):
        reply = (
            "We automate high-ticket B2B sales pipelines and CRM outreach workflows to help your "
            "sales reps close more deals with less manual entry. "
            "What is your current team size, and what sales bottlenecks are you looking to solve?"
        )
        detected_product = "B2B Sales & Pipeline Automation"
        
    # 4. Pricing / Cost questions
    elif any(k in clean_text for k in ["price", "cost", "pricing", "quote", "rate", "fee"]):
        reply = (
            "For School Bus SaaS, we offer flexible fleet subscriptions starting around 15 to 30 dollars per bus per month. "
            "Custom mobile and web applications are scoped per project, and B2B solutions run on a retainer. "
            "May I have your name and email so our solutions director can send you a detailed proposal?"
        )
        detected_product = "General Pricing Inquiry"

    # 5. Booking / Demo intent
    elif any(k in clean_text for k in ["demo", "walkthrough", "book", "schedule", "meeting", "call"]):
        reply = (
            "I would be glad to reserve a live 15-minute walkthrough for you tomorrow. "
            "Could you please share your name and preferred phone number or email?"
        )
        detected_product = "Demo Walkthrough Request"
        
    # 6. Default polite executive response
    else:
        reply = (
            "Thank you for calling TradeSage AI. We specialize in School Bus Fleet Tracking, "
            "Custom Web and Mobile App Engineering, and B2B Sales Automation. "
            "Which of these solutions can I assist you with today?"
        )
        detected_product = "General Inquiry"

    return {
        "reply": reply,
        "product_intent": detected_product
    }

def handle_inbound_call(from_number: str, to_number: str, workspace_id: int = 1) -> str:
    """
    Generates initial Telnyx TeXML response for an incoming phone call.
    """
    greeting = (
        "Thank you for calling TradeSage Enterprise Solutions. "
        "I am your AI assistant. I can help you with our School Bus Management System, "
        "custom web and mobile app development, or B2B sales pipelines. "
        "How can I assist you today?"
    )
    
    # Telnyx TeXML with Speech Gathering
    texml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/telnyx/dialogue" method="POST">
        <Say voice="Polly.Brian-Neural">{greeting}</Say>
    </Gather>
    <Say voice="Polly.Brian-Neural">I did not catch that. Please stay on the line or call back anytime. Goodbye.</Say>
</Response>
"""
    # Log incoming call
    conn = get_db()
    cursor = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
    INSERT INTO call_records (workspace_id, direction, caller_number, transcript, call_outcome, created_at)
    VALUES (?, 'inbound', ?, 'Call connected. AI delivered greeting.', 'In Progress', ?)
    """, (workspace_id, from_number, now))
    conn.commit()
    conn.close()
    
    return texml

def handle_call_dialogue(speech_result: str, caller_number: str = "", workspace_id: int = 1) -> str:
    """
    Processes speech input from Telnyx and returns next TeXML turn.
    """
    analysis = generate_ai_reply(speech_result, workspace_id=workspace_id)
    reply_text = analysis["reply"]
    intent = analysis["product_intent"]
    
    # Save lead into CRM if caller shared contact details or showed specific product intent
    conn = get_db()
    cursor = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    cursor.execute("""
    INSERT INTO leads (workspace_id, name, phone, product_interest, status, notes, created_at)
    VALUES (?, 'Inbound Phone Caller', ?, ?, 'New', ?, ?)
    """, (workspace_id, caller_number, intent, f"Spoke via Telnyx Phone: '{speech_result}'", now))
    lead_id = cursor.lastrowid
    
    # Log usage (e.g. 1 Telnyx call minute = ~$0.05)
    cursor.execute("""
    INSERT INTO usage_ledger (workspace_id, category, quantity, unit, estimated_cost, created_at)
    VALUES (?, 'telnyx_voice_minute', 1.0, 'minute', 0.05, ?)
    """, (workspace_id, now))
    
    conn.commit()
    conn.close()
    
    # Next TeXML turn with continuous dialogue gather
    texml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/telnyx/dialogue" method="POST">
        <Say voice="Polly.Brian-Neural">{reply_text}</Say>
    </Gather>
    <Say voice="Polly.Brian-Neural">Thank you for speaking with TradeSage AI. A summary has been dispatched to our team. Have a wonderful day.</Say>
    <Hangup/>
</Response>
"""
    return texml

def simulate_telnyx_call(caller_speech: str, caller_phone: str = "+1 (555) 948-2041", workspace_id: int = 1) -> dict:
    """
    Simulates a complete Telnyx phone call locally for instant testing and dashboard demonstration.
    """
    analysis = generate_ai_reply(caller_speech, workspace_id=workspace_id)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    conn = get_db()
    cursor = conn.cursor()
    
    # 1. Record lead
    cursor.execute("""
    INSERT INTO leads (workspace_id, name, phone, product_interest, status, notes, created_at)
    VALUES (?, 'Phone Prospect', ?, ?, 'Qualified', ?, ?)
    """, (workspace_id, caller_phone, analysis["product_intent"], f"Phone Inquiry: '{caller_speech}'", now))
    lead_id = cursor.lastrowid
    
    # 2. Record call history
    cursor.execute("""
    INSERT INTO call_records (
        workspace_id, direction, caller_number, duration_seconds, transcript, summary, lead_id, call_outcome, created_at
    ) VALUES (
        ?, 'inbound', ?, 45, ?, ?, ?, 'Lead Qualified', ?
    )
    """, (
        workspace_id,
        caller_phone,
        f"CALLER: {caller_speech}\nAI: {analysis['reply']}",
        f"Caller inquired about {analysis['product_intent']}. AI pitched key benefits and captured lead.",
        lead_id,
        now
    ))
    
    # 3. Log usage ($0.05 / min)
    cursor.execute("""
    INSERT INTO usage_ledger (workspace_id, category, quantity, unit, estimated_cost, created_at)
    VALUES (?, 'telnyx_voice_minute', 0.75, 'minute', 0.038, ?)
    """, (workspace_id, now))
    
    conn.commit()
    conn.close()
    
    return {
        "success": True,
        "caller_said": caller_speech,
        "ai_reply": analysis["reply"],
        "detected_intent": analysis["product_intent"],
        "lead_id": lead_id,
        "cost_cents": 3.8
    }
