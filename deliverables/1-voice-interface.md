# Deliverable 1: Voice Interface Link

## Live voice interface

| Item | Link |
| --- | --- |
| Voice interface (browser, Vapi web SDK) | https://relaypay-support-agent-1.onrender.com |
| Voice backend (Vapi assistant webhook target) | https://relaypay-support-agent.onrender.com/vapi/webhook |
| Vapi assistant ID | `592d5d84-dc72-4ce4-9eb7-589e2f22634e` |

## How to use it

1. Open the voice interface link (backend is on Render's free tier: the first request after ~15 minutes idle needs a 30 to 60 second cold start, so open the page, send one chat message to warm it, then start the call).
2. Click **Start support call**. The assistant greets and accepts spoken input (Deepgram Nova-2 transcription, ElevenLabs "sarah" voice).
3. Try: *"Can you check transaction TXN-9001?"* or *"What fees does RelayPay charge for international payments?"*

## Phone calling

**Phone calling not supported on this account — left blank as permitted.**

The assistant is reachable through the web voice interface above (Vapi web SDK with microphone access). A PSTN phone number was not provisioned on the Vapi free tier.
